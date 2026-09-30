import { db } from './db';
import { uid } from './id';
import { footageOf, recoveryOf } from './recovery';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { PendingOp, SyncConflict, SyncReport } from '../types/sync';

/** 回次冲突合并策略：深度区间认现场记录，岩芯长度认地质组复核值 */
export const RUN_MERGE_STRATEGY =
  '深度区间取现场记录，岩芯长度取地质组复核值，进尺与采取率按合并结果重算，其余字段以现场记录为底；双方原始内容留存于本记录';

/** 岩芯箱冲突合并策略：以现场最新登记为底，编目台版本留档 */
export const BOX_MERGE_STRATEGY = '编目台在断网期间亦有改动，以现场最新登记为底并入；双方原始内容留存于本记录';

/** 现场删除与编目台更新冲突时的留档说明 */
export const DELETE_STRATEGY = '现场删除已执行；编目台在断网期间有更新，其版本留存于此，如需找回请从编目台重新登记';

type ApplyOutcome = 'applied' | 'merged' | 'deleted';

/**
 * 回次字段级合并：不整条覆盖。
 * 深度区间（fromDepth/toDepth）与进尺取现场记录；岩芯长度取编目台复核值；
 * 采取率按合并后的进尺与岩芯长度重算；其余字段以现场记录为底。
 */
export function mergeRunConflict(field: DrillRun, desk: DrillRun): DrillRun {
  const footage = footageOf(field.fromDepth, field.toDepth);
  return {
    ...field,
    id: desk.id,
    footage,
    coreLength: desk.coreLength,
    recovery: recoveryOf(desk.coreLength, footage),
    updatedAt: new Date().toISOString(),
    rev: desk.rev + 1,
  };
}

/** 编目台记录是否在断网期间被改动过（updatedAt 晚于现场编辑所基于的版本） */
function deskChangedSince(baseUpdatedAt: string | null, deskUpdatedAt: string): boolean {
  if (!baseUpdatedAt) return true;
  return deskUpdatedAt > baseUpdatedAt;
}

async function findDeskRun(op: PendingOp, field: DrillRun): Promise<DrillRun | undefined> {
  const byId = await db.runs.get(op.entityId);
  if (byId) return byId;
  // 同一回次可能两边各自新建（id 不同），按 孔 + 回次号 兜底匹配
  return db.runs
    .where('holeId')
    .equals(field.holeId)
    .filter((run) => run.runNo === field.runNo)
    .first();
}

async function applyRunUpsert(op: PendingOp): Promise<ApplyOutcome> {
  const field = op.payload as DrillRun;
  const desk = await findDeskRun(op, field);
  const now = new Date().toISOString();
  if (!desk) {
    // 编目台无此回次（含编目台已删除的情形）：按现场登记整条落库
    await db.runs.put(field);
    return 'applied';
  }
  if (!deskChangedSince(op.baseUpdatedAt, desk.updatedAt)) {
    // 编目台未动过：现场编辑整条生效
    await db.runs.put({ ...field, id: desk.id, updatedAt: now, rev: desk.rev + 1 });
    return 'applied';
  }
  // 两边几乎同时修改：字段级合并，双方版本留档
  const merged = mergeRunConflict(field, desk);
  await db.runs.put(merged);
  await db.conflicts.put({
    id: uid('conflict'),
    entityKind: 'run',
    entityId: desk.id,
    holeId: desk.holeId,
    label: desk.runNo,
    fieldVersion: field,
    deskVersion: desk,
    merged,
    strategy: RUN_MERGE_STRATEGY,
    createdAt: now,
  });
  return 'merged';
}

async function applyBoxUpsert(op: PendingOp): Promise<ApplyOutcome> {
  const field = op.payload as CoreBox;
  const byId = await db.boxes.get(op.entityId);
  const desk =
    byId ??
    (await db.boxes
      .where('holeId')
      .equals(field.holeId)
      .filter((box) => box.boxNo === field.boxNo)
      .first());
  const now = new Date().toISOString();
  if (!desk) {
    await db.boxes.put(field);
    return 'applied';
  }
  const next: CoreBox = { ...field, id: desk.id, updatedAt: now, rev: desk.rev + 1 };
  if (!deskChangedSince(op.baseUpdatedAt, desk.updatedAt)) {
    await db.boxes.put(next);
    return 'applied';
  }
  await db.boxes.put(next);
  await db.conflicts.put({
    id: uid('conflict'),
    entityKind: 'box',
    entityId: desk.id,
    holeId: desk.holeId,
    label: desk.boxNo,
    fieldVersion: field,
    deskVersion: desk,
    merged: next,
    strategy: BOX_MERGE_STRATEGY,
    createdAt: now,
  });
  return 'merged';
}

async function applyDelete(op: PendingOp, entityKind: 'run' | 'box'): Promise<ApplyOutcome> {
  const table = entityKind === 'run' ? db.runs : db.boxes;
  const desk = await table.get(op.entityId);
  if (!desk) return 'deleted';
  if (deskChangedSince(op.baseUpdatedAt, desk.updatedAt)) {
    // 删除照执行，但编目台在断网期间的更新版本留档，不丢数据
    const now = new Date().toISOString();
    await db.conflicts.put({
      id: uid('conflict'),
      entityKind,
      entityId: desk.id,
      holeId: desk.holeId,
      label: op.label,
      fieldVersion: null,
      deskVersion: desk,
      merged: null,
      strategy: DELETE_STRATEGY,
      createdAt: now,
    });
  }
  await table.delete(op.entityId);
  return 'deleted';
}

async function applyOp(op: PendingOp): Promise<ApplyOutcome> {
  switch (op.kind) {
    case 'run.upsert':
      return applyRunUpsert(op);
    case 'box.upsert':
      return applyBoxUpsert(op);
    case 'run.delete':
      return applyDelete(op, 'run');
    case 'box.delete':
      return applyDelete(op, 'box');
    default:
      throw new Error(`未知的待同步操作类型：${op.kind}`);
  }
}

/**
 * 依次并入待同步队列。每条操作各自包在一个事务里：
 * 要么整条落库（含冲突留档与出队），要么整体回滚留在队列中等待重试，
 * 不会留下写了一半的数据。单条失败不阻塞后续操作。
 */
export async function processOutbox(): Promise<SyncReport> {
  const ops = await db.outbox.orderBy('createdAt').toArray();
  const report: SyncReport = { applied: 0, merged: 0, deleted: 0, failed: [], syncedAt: new Date().toISOString() };

  for (const op of ops) {
    try {
      const outcome = await db.transaction('rw', [db.runs, db.boxes, db.outbox, db.conflicts], async () => {
        const result = await applyOp(op);
        await db.outbox.delete(op.id);
        return result;
      });
      if (outcome === 'merged') report.merged += 1;
      else if (outcome === 'deleted') report.deleted += 1;
      else report.applied += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed.push({ opId: op.id, label: op.label, error: message });
      // 失败的操作留在队列中，标记原因与次数，等待重试
      await db.outbox.update(op.id, { status: 'failed', attempts: op.attempts + 1, lastError: message });
    }
  }
  return report;
}
