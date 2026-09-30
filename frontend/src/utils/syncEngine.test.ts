import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { mergeRunConflict, processOutbox } from './syncEngine';
import { compactOps, useSyncStore } from '../stores/syncStore';
import { useRunStore } from '../stores/runStore';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { PendingOp } from '../types/sync';

const T1 = '2026-09-20T08:00:00.000Z';
const T2 = '2026-09-20T09:00:00.000Z';

const makeRun = (over: Partial<DrillRun> = {}): DrillRun => ({
  id: 'run-1',
  runNo: '2401-01',
  holeId: 'hole-1',
  fromDepth: 0,
  toDepth: 5,
  footage: 5,
  coreLength: 4.5,
  recovery: 90,
  waterLevel: 12,
  shift: '甲班',
  drilledAt: T1,
  recorder: '高振华',
  updatedAt: T1,
  rev: 1,
  ...over,
});

const makeBox = (over: Partial<CoreBox> = {}): CoreBox => ({
  id: 'box-1',
  boxNo: 'X-2401-01',
  holeId: 'hole-1',
  fromDepth: 0,
  toDepth: 25,
  slots: 10,
  slotLength: 2.5,
  boxedAt: T1,
  shelfPos: 'A 区 1 架',
  damagedSlots: [],
  operator: '周明',
  updatedAt: T1,
  rev: 1,
  ...over,
});

const makeOp = (over: Partial<PendingOp> = {}): PendingOp => ({
  id: 'op-1',
  kind: 'run.upsert',
  entityId: 'run-1',
  holeId: 'hole-1',
  label: '2401-01',
  baseUpdatedAt: null,
  status: 'pending',
  attempts: 0,
  createdAt: T1,
  ...over,
});

beforeEach(async () => {
  await Promise.all([db.runs.clear(), db.boxes.clear(), db.outbox.clear(), db.conflicts.clear()]);
  vi.restoreAllMocks();
});

describe('mergeRunConflict：深度认现场、岩芯长度认复核', () => {
  it('深度区间与进尺取现场记录，岩芯长度取编目台复核值，采取率按合并结果重算', () => {
    const field = makeRun({ fromDepth: 10, toDepth: 16, footage: 6, coreLength: 9.9, recovery: 165 });
    const desk = makeRun({ fromDepth: 10, toDepth: 15, footage: 5, coreLength: 4.2, recovery: 84, rev: 3 });
    const merged = mergeRunConflict(field, desk);
    expect(merged.id).toBe(desk.id);
    expect(merged.fromDepth).toBe(10);
    expect(merged.toDepth).toBe(16);
    expect(merged.footage).toBe(6);
    expect(merged.coreLength).toBe(4.2);
    expect(merged.recovery).toBe(70);
    expect(merged.rev).toBe(4);
  });
});

describe('processOutbox：并入与冲突合并', () => {
  it('断网登记的新回次同步后入台，队列清空', async () => {
    await db.outbox.put(makeOp({ payload: makeRun() }));
    const report = await processOutbox();
    expect(report.applied).toBe(1);
    expect(await db.runs.get('run-1')).toMatchObject({ runNo: '2401-01', toDepth: 5 });
    expect(await db.outbox.count()).toBe(0);
  });

  it('编目台未改动时，现场编辑整条生效，不产生冲突留档', async () => {
    await db.runs.put(makeRun());
    const field = makeRun({ toDepth: 6, footage: 6, updatedAt: T2, rev: 2 });
    await db.outbox.put(makeOp({ payload: field, baseUpdatedAt: T1 }));
    const report = await processOutbox();
    expect(report.applied).toBe(1);
    expect(report.merged).toBe(0);
    expect((await db.runs.get('run-1'))?.toDepth).toBe(6);
    expect(await db.conflicts.count()).toBe(0);
  });

  it('两边几乎同时修改：字段级合并，双方版本都留档，不整条覆盖', async () => {
    // 编目台复核了岩芯长度（updatedAt 晚于现场编辑的基准版本）
    await db.runs.put(makeRun({ coreLength: 4.2, recovery: 84, updatedAt: T2, rev: 2 }));
    // 现场平板登记了新的止深度（基于 T1 版本）
    const field = makeRun({ toDepth: 6.5, footage: 6.5, coreLength: 9.9, updatedAt: T1, rev: 2 });
    await db.outbox.put(makeOp({ payload: field, baseUpdatedAt: T1 }));

    const report = await processOutbox();
    expect(report.merged).toBe(1);

    const merged = await db.runs.get('run-1');
    expect(merged).toMatchObject({ toDepth: 6.5, footage: 6.5, coreLength: 4.2, recovery: 64.6, rev: 3 });

    const conflicts = await db.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0];
    expect((c.fieldVersion as DrillRun).coreLength).toBe(9.9);
    expect((c.deskVersion as DrillRun).coreLength).toBe(4.2);
    expect((c.merged as DrillRun).toDepth).toBe(6.5);
    expect(await db.outbox.count()).toBe(0);
  });

  it('两边各自新建同一回次（编号相同、id 不同）：按回次号合并，不产生重复记录', async () => {
    await db.runs.put(makeRun({ id: 'run-desk', runNo: '2401-09', coreLength: 4.8, updatedAt: T2 }));
    const field = makeRun({ id: 'run-field', runNo: '2401-09', toDepth: 7, footage: 7, coreLength: 6.6 });
    await db.outbox.put(makeOp({ entityId: 'run-field', payload: field, baseUpdatedAt: null }));

    const report = await processOutbox();
    expect(report.merged).toBe(1);
    expect(await db.runs.count()).toBe(1);
    const merged = await db.runs.get('run-desk');
    expect(merged).toMatchObject({ toDepth: 7, coreLength: 4.8 });
    expect(await db.runs.get('run-field')).toBeUndefined();
  });

  it('现场删除时编目台有更新：删除照执行，编目台版本留档', async () => {
    await db.runs.put(makeRun({ updatedAt: T2, rev: 2 }));
    await db.outbox.put(makeOp({ kind: 'run.delete', payload: undefined, baseUpdatedAt: T1 }));

    const report = await processOutbox();
    expect(report.deleted).toBe(1);
    expect(await db.runs.get('run-1')).toBeUndefined();
    const conflicts = await db.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].fieldVersion).toBeNull();
    expect((conflicts[0].deskVersion as DrillRun).runNo).toBe('2401-01');
  });

  it('岩芯箱断网登记同步入台；两边同时改动时以现场为底并留档', async () => {
    await db.outbox.put(makeOp({ kind: 'box.upsert', entityId: 'box-1', label: 'X-2401-01', payload: makeBox() }));
    let report = await processOutbox();
    expect(report.applied).toBe(1);
    expect(await db.boxes.get('box-1')).toBeDefined();

    // 编目台改了库架位，现场改了破损格 → 冲突合并留档
    await db.boxes.update('box-1', { shelfPos: 'C 区 1 架', updatedAt: T2, rev: 2 });
    const field = makeBox({ damagedSlots: [3], updatedAt: T1, rev: 2 });
    await db.outbox.put(makeOp({ kind: 'box.upsert', entityId: 'box-1', label: 'X-2401-01', payload: field, baseUpdatedAt: T1 }));
    report = await processOutbox();
    expect(report.merged).toBe(1);
    const merged = await db.boxes.get('box-1');
    expect(merged?.damagedSlots).toEqual([3]);
    const conflicts = await db.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect((conflicts[0].deskVersion as CoreBox).shelfPos).toBe('C 区 1 架');
  });
});

describe('processOutbox：失败可重试，不留半套数据', () => {
  it('事务中途失败时整体回滚：主表不变、操作留在队列标记失败，修复后重试成功', async () => {
    await db.runs.put(makeRun({ coreLength: 4.2, updatedAt: T2, rev: 2 }));
    const field = makeRun({ toDepth: 6.5, footage: 6.5, updatedAt: T1, rev: 2 });
    await db.outbox.put(makeOp({ payload: field, baseUpdatedAt: T1 }));

    // 第一次同步：冲突留档写入失败 → 整个事务回滚
    vi.spyOn(db.conflicts, 'put').mockRejectedValueOnce(new Error('磁盘写入失败'));
    const report1 = await processOutbox();
    expect(report1.failed).toHaveLength(1);
    expect(report1.failed[0].error).toContain('磁盘写入失败');

    // 不留半套数据：主表仍是编目台原值，合并结果未写入
    expect((await db.runs.get('run-1'))?.toDepth).toBe(5);
    expect(await db.conflicts.count()).toBe(0);

    // 操作留在队列中，标记失败原因与次数
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ status: 'failed', attempts: 1, lastError: '磁盘写入失败' });

    // 故障恢复后重试：同一条操作成功并入
    const report2 = await processOutbox();
    expect(report2.merged).toBe(1);
    expect(report2.failed).toHaveLength(0);
    expect((await db.runs.get('run-1'))?.toDepth).toBe(6.5);
    expect(await db.outbox.count()).toBe(0);
  });

  it('单条失败不阻塞后续操作并入', async () => {
    await db.outbox.put(makeOp({ id: 'op-bad', kind: 'run.upsert', entityId: 'run-bad', payload: undefined }));
    await db.outbox.put(makeOp({ id: 'op-good', entityId: 'run-2', label: '2401-02', payload: makeRun({ id: 'run-2', runNo: '2401-02' }), createdAt: T2 }));
    const report = await processOutbox();
    expect(report.applied).toBe(1);
    expect(await db.runs.get('run-2')).toBeDefined();
  });
});

describe('compactOps：同一记录的连续操作合并为一条', () => {
  const upsert = (over: Partial<PendingOp>) => makeOp({ kind: 'run.upsert', payload: makeRun(), ...over });

  it('登记后又登记：保留最早基准版本，内容以最新为准', () => {
    const first = upsert({ id: 'op-1', baseUpdatedAt: T1, createdAt: T1 });
    const second = upsert({ id: 'op-2', payload: makeRun({ toDepth: 9 }), baseUpdatedAt: T2, createdAt: T2 });
    const next = compactOps([first], second);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('op-1');
    expect(next[0].baseUpdatedAt).toBe(T1);
    expect((next[0].payload as DrillRun).toDepth).toBe(9);
  });

  it('断网期间新建又删除：两条抵消，不需要同步', () => {
    const created = upsert({ id: 'op-1', baseUpdatedAt: null });
    const next = compactOps([created], makeOp({ id: 'op-2', kind: 'run.delete', baseUpdatedAt: null }));
    expect(next).toHaveLength(0);
  });

  it('编辑后又删除：转为删除操作，保留原基准版本', () => {
    const edited = upsert({ id: 'op-1', baseUpdatedAt: T1 });
    const next = compactOps([edited], makeOp({ id: 'op-2', kind: 'run.delete', baseUpdatedAt: T1 }));
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe('run.delete');
    expect(next[0].baseUpdatedAt).toBe(T1);
  });

  it('删除后又登记：以最新登记为准', () => {
    const deleted = makeOp({ id: 'op-1', kind: 'run.delete', baseUpdatedAt: T1 });
    const next = compactOps([deleted], upsert({ id: 'op-2', payload: makeRun({ toDepth: 8 }) }));
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe('run.upsert');
    expect((next[0].payload as DrillRun).toDepth).toBe(8);
  });
});

describe('端到端：现场断网登记 → 编目台复核 → 网络恢复同步', () => {
  it('字段级合并后 store 一并刷新，派生数据拿到最新回次', async () => {
    // 编目台已有回次 2401-77（0~5m）
    await db.runs.put(makeRun({ id: 'run-e2e', runNo: '2401-77', updatedAt: T1, rev: 1 }));
    await useRunStore.getState().hydrate();
    await useSyncStore.getState().hydrate();

    // 现场模式（断网）：平板编辑止深度 → 进入待同步队列，主表不动
    useSyncStore.getState().setFieldMode(true);
    const saved = await useSyncStore.getState().saveRun(
      {
        runNo: '2401-77',
        holeId: 'hole-1',
        fromDepth: 0,
        toDepth: 6.5,
        coreLength: 9.9,
        waterLevel: 12,
        shift: '甲班',
        drilledAt: T1,
        recorder: '高振华',
      },
      'run-e2e',
    );
    expect(saved.queued).toBe(true);
    expect(useSyncStore.getState().outbox).toHaveLength(1);
    expect((await db.runs.get('run-e2e'))?.toDepth).toBe(5);

    // 编目台复核了岩芯长度（直写主表，updatedAt 晚于现场基准版本）
    await useRunStore.getState().updateRun('run-e2e', { coreLength: 4.2 });

    // 网络恢复 → 自动同步：深度取现场、岩芯长度取复核
    useSyncStore.getState().setFieldMode(false);
    const report = await useSyncStore.getState().sync();
    expect(report?.merged).toBe(1);

    const run = useRunStore.getState().runs.find((r) => r.id === 'run-e2e');
    expect(run).toMatchObject({ toDepth: 6.5, footage: 6.5, coreLength: 4.2, recovery: 64.6 });
    expect(useSyncStore.getState().outbox).toHaveLength(0);
    expect(useSyncStore.getState().conflicts).toHaveLength(1);
    useSyncStore.getState().setFieldMode(false);
  });
});
