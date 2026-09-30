import { db } from '../utils/db';
import { uid } from '../utils/id';
import { getCurrentNode } from './node';
import type { EntityType } from './types';

/** 各实体对应的 Dexie 表 */
export function tableOf(entityType: EntityType) {
  switch (entityType) {
    case 'hole':
      return db.holes;
    case 'run':
      return db.runs;
    case 'box':
      return db.boxes;
    case 'litho':
      return db.lithos;
  }
}

/**
 * 本地写入（新增/更新）：先写业务表，再进 outbox 队列，同一实体的多条待办合并为一条净变更。
 * 业务表与 outbox 在同一事务内，避免写了业务数据却漏登记变更。
 */
export async function localPut(entityType: EntityType, record: { id: string }): Promise<void> {
  const node = getCurrentNode();
  await db.transaction('rw', [tableOf(entityType), db.outbox], async () => {
    const table = tableOf(entityType);
    const before = await table.get(record.id);
    await table.put(record as never);
    const existing = await db.outbox
      .where('[entityType+entityId]')
      .equals([entityType, record.id])
      .filter((c) => !c.synced)
      .first();
    if (existing) {
      // 合并多次离线改动：保留最初基线，记录取最新
      await db.outbox.put({
        ...existing,
        op: 'put',
        record,
        updatedAt: Date.now(),
        updatedBy: node.nodeId,
        nodeRole: node.role,
      });
    } else {
      await db.outbox.add({
        id: uid('chg'),
        entityType,
        entityId: record.id,
        op: 'put',
        record,
        base: before ? { ...before } : undefined,
        updatedAt: Date.now(),
        updatedBy: node.nodeId,
        nodeRole: node.role,
        synced: false,
        attempts: 0,
      });
    }
  });
}

/**
 * 本地删除：删业务表 + outbox 登记；若该实体是离线新建后又删除，则净变更为无（直接撤掉待办）。
 */
export async function localDelete(entityType: EntityType, id: string): Promise<void> {
  const node = getCurrentNode();
  await db.transaction('rw', [tableOf(entityType), db.outbox], async () => {
    const table = tableOf(entityType);
    const before = await table.get(id);
    await table.delete(id);
    const existing = await db.outbox
      .where('[entityType+entityId]')
      .equals([entityType, id])
      .filter((c) => !c.synced)
      .first();
    if (existing) {
      if (existing.op === 'put' && existing.base == null) {
        // 离线新建 → 离线删除：对端从未见过该实体，撤掉待办
        await db.outbox.delete(existing.id);
      } else {
        await db.outbox.put({
          ...existing,
          op: 'delete',
          record: before ? { ...before } : existing.record,
          base: existing.base ?? (before ? { ...before } : undefined),
          updatedAt: Date.now(),
          updatedBy: node.nodeId,
          nodeRole: node.role,
        });
      }
    } else {
      await db.outbox.add({
        id: uid('chg'),
        entityType,
        entityId: id,
        op: 'delete',
        record: before ? { ...before } : undefined,
        base: before ? { ...before } : undefined,
        updatedAt: Date.now(),
        updatedBy: node.nodeId,
        nodeRole: node.role,
        synced: false,
        attempts: 0,
      });
    }
  });
}
