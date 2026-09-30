import Dexie, { type Table } from 'dexie';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { LithoLog } from '../types/litho-log';
import type { ChangeEntry, NodeInfo, SyncConflict, SyncStateRow } from '../sync/types';
import { getCurrentNode } from '../sync/node';

/** IndexedDB 库名前缀（浏览器本地存储，无后端） */
export const DB_NAME = 'gbdrillcore-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

/** 按节点分库：地质组台用主库名，现场平板用独立库名（两台设备数据物理隔离） */
export function dbNameFor(node: NodeInfo): string {
  return node.role === 'desk' ? DB_NAME : `${DB_NAME}-${node.nodeId}`;
}

class DrillCoreDB extends Dexie {
  holes!: Table<DrillHole, string>;
  runs!: Table<DrillRun, string>;
  boxes!: Table<CoreBox, string>;
  lithos!: Table<LithoLog, string>;
  meta!: Table<{ key: string; value: string }, string>;
  /** 本地变更日志（断网期间的登记队列） */
  outbox!: Table<ChangeEntry, string>;
  /** 各实体最后同步状态 */
  syncState!: Table<SyncStateRow, string>;
  /** 字段级冲突记录（两边各持的值都保留） */
  syncConflicts!: Table<SyncConflict, string>;

  constructor(name: string) {
    super(name);

    // v1：建表声明索引
    this.version(1).stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, lithology',
      meta: 'key',
    });

    // v2：岩性表增加 [holeId+fromDepth] 复合索引；回填历史 rqd 缺省值。
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

    // v3：离线同步队列 + 同步状态 + 冲突记录
    this.version(3).stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
      meta: 'key',
      outbox: 'id, entityType, entityId, updatedAt, synced, [entityType+entityId]',
      syncState: 'entityId, entityType',
      syncConflicts: 'id, entityType, entityId, at',
    });
  }
}

function buildDb(node: NodeInfo): DrillCoreDB {
  return new DrillCoreDB(dbNameFor(node));
}

/** 当前节点的数据库实例（切换节点时替换） */
let activeDb: DrillCoreDB = buildDb(getCurrentNode());

export function getActiveDb(): DrillCoreDB {
  return activeDb;
}

/** 切换节点：关闭旧库、打开新库（新库为空时由 seedIfEmpty 写入示例数据） */
export async function activateNode(node: NodeInfo): Promise<void> {
  const next = buildDb(node);
  await next.open();
  const prev = activeDb;
  activeDb = next;
  try {
    await prev.close();
  } catch {
    /* 旧库关闭失败不影响新库使用 */
  }
}

/**
 * 数据库代理：store 与同步引擎统一面向当前节点的库。
 * 方法绑定到 activeDb，避免切换节点后 this 指向代理造成转发死循环。
 */
export const db = new Proxy({} as DrillCoreDB, {
  get(_target, prop) {
    const value = Reflect.get(activeDb, prop);
    return typeof value === 'function' ? value.bind(activeDb) : value;
  },
}) as DrillCoreDB;

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
