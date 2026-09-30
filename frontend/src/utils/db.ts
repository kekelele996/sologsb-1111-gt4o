import Dexie, { type Table } from 'dexie';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { LithoLog } from '../types/litho-log';
import type { PendingOp, SyncConflict } from '../types/sync';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbdrillcore-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

class DrillCoreDB extends Dexie {
  holes!: Table<DrillHole, string>;
  runs!: Table<DrillRun, string>;
  boxes!: Table<CoreBox, string>;
  lithos!: Table<LithoLog, string>;
  meta!: Table<{ key: string; value: string }, string>;
  /** 断网期间登记的待同步操作队列 */
  outbox!: Table<PendingOp, string>;
  /** 同步冲突留档（双方版本 + 合并结果） */
  conflicts!: Table<SyncConflict, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, lithology',
      meta: 'key',
    });

    // v2：岩性表增加 (holeId+fromDepth) 复合索引，按深度区间查询更快；并回填历史 rqd 缺省值。
    // 升级前请在顶栏「导出备份」导出 JSON。
    this.version(2)
      .stores({
        holes: 'id, holeNo, rigNo, shift, startDate',
        runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
        boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
        lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('lithos')
          .toCollection()
          .modify((row: LithoLog) => {
            if (typeof row.rqd !== 'number') {
              row.rqd = 0;
            }
          });
      });

    // v3：新增 outbox（离线待同步队列）与 conflicts（冲突留档）；
    // 回次 / 岩芯箱回填 updatedAt 与 rev，用于同步时的冲突判定。
    this.version(3)
      .stores({
        holes: 'id, holeNo, rigNo, shift, startDate',
        runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
        boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
        lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
        meta: 'key',
        outbox: 'id, kind, entityId, status, createdAt',
        conflicts: 'id, entityKind, entityId, createdAt',
      })
      .upgrade(async (tx) => {
        const now = new Date().toISOString();
        await tx
          .table('runs')
          .toCollection()
          .modify((row: DrillRun) => {
            if (typeof row.rev !== 'number') row.rev = 1;
            if (!row.updatedAt) row.updatedAt = row.drilledAt || now;
          });
        await tx
          .table('boxes')
          .toCollection()
          .modify((row: CoreBox) => {
            if (typeof row.rev !== 'number') row.rev = 1;
            if (!row.updatedAt) row.updatedAt = row.boxedAt || now;
          });
      });
  }
}

export const db = new DrillCoreDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
