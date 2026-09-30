import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { processOutbox } from '../utils/syncEngine';
import { buildRunEntity, useRunStore, type RunInput } from './runStore';
import { buildBoxEntity, useBoxStore, type BoxInput } from './boxStore';
import type { PendingOp, PendingOpKind, SyncConflict, SyncReport } from '../types/sync';

interface SyncState {
  /** 浏览器实际网络状态 */
  online: boolean;
  /** 现场模式：平板在孔口强制走离线队列（模拟断网） */
  fieldMode: boolean;
  outbox: PendingOp[];
  conflicts: SyncConflict[];
  syncing: boolean;
  lastReport: SyncReport | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setOnline: (online: boolean) => void;
  setFieldMode: (on: boolean) => void;
  /** 是否处于离线登记状态（断网或现场模式）：登记进队列而不是直写编目台 */
  offlineMode: () => boolean;
  /** 保存回次：在线直写编目台，离线进入待同步队列 */
  saveRun: (input: RunInput, editingId?: string) => Promise<{ queued: boolean }>;
  /** 保存岩芯箱：在线直写编目台，离线进入待同步队列 */
  saveBox: (input: BoxInput, editingId?: string) => Promise<{ queued: boolean }>;
  removeRun: (id: string) => Promise<{ queued: boolean }>;
  removeBox: (id: string) => Promise<{ queued: boolean }>;
  /** 网络恢复后把队列并入编目台；离线时返回 null */
  sync: () => Promise<SyncReport | null>;
  /** 重试单条失败操作 */
  retryOp: (opId: string) => Promise<SyncReport | null>;
  /** 把失败操作全部重置为待同步后再同步 */
  retryAll: () => Promise<SyncReport | null>;
  /** 放弃一条未同步的登记 */
  discardOp: (opId: string) => Promise<void>;
}

/**
 * 入队压实：同一记录的连续操作合并为一条，避免队列膨胀与自我冲突。
 * - 登记后又登记 → 合并为一条（保留最早的基准版本与登记时间）
 * - 登记后又删除 → 未同步过的新建直接抵消；否则转为删除
 * - 删除后又登记 → 以最新登记为准
 */
export function compactOps(current: PendingOp[], op: PendingOp): PendingOp[] {
  const prior = current.find((o) => o.entityId === op.entityId);
  if (!prior) return [...current, op];
  const isUpsert = (kind: PendingOpKind) => kind.endsWith('.upsert');
  if (isUpsert(op.kind) && isUpsert(prior.kind)) {
    const merged: PendingOp = { ...prior, payload: op.payload, label: op.label, status: 'pending', lastError: undefined };
    return current.map((o) => (o.id === prior.id ? merged : o));
  }
  if (!isUpsert(op.kind) && isUpsert(prior.kind)) {
    if (prior.baseUpdatedAt === null) {
      // 断网期间新建又删除：两条都不必同步
      return current.filter((o) => o.id !== prior.id);
    }
    const toDelete: PendingOp = { ...op, id: prior.id, baseUpdatedAt: prior.baseUpdatedAt, createdAt: prior.createdAt };
    return current.map((o) => (o.id === prior.id ? toDelete : o));
  }
  if (isUpsert(op.kind) && !isUpsert(prior.kind)) {
    const reUpsert: PendingOp = { ...op, id: prior.id, createdAt: prior.createdAt };
    return current.map((o) => (o.id === prior.id ? reUpsert : o));
  }
  // 重复删除：忽略后一条
  return current;
}

/** 离线登记与同步：断网入队、恢复后并入、冲突字段级合并 */
export const useSyncStore = create<SyncState>()((set, get) => {
  const enqueue = async (op: PendingOp) => {
    const next = compactOps(get().outbox, op);
    await db.transaction('rw', db.outbox, async () => {
      await db.outbox.clear();
      if (next.length) await db.outbox.bulkPut(next);
    });
    set({ outbox: next });
  };

  return {
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    fieldMode: false,
    outbox: [],
    conflicts: [],
    syncing: false,
    lastReport: null,
    hydrated: false,

    hydrate: async () => {
      const [outbox, conflicts] = await Promise.all([
        db.outbox.orderBy('createdAt').toArray(),
        db.conflicts.orderBy('createdAt').toArray(),
      ]);
      set({ outbox, conflicts, hydrated: true });
    },

    setOnline: (online) => set({ online }),
    setFieldMode: (on) => set({ fieldMode: on }),

    offlineMode: () => !get().online || get().fieldMode,

    saveRun: async (input, editingId) => {
      if (!get().offlineMode()) {
        if (editingId) await useRunStore.getState().updateRun(editingId, input);
        else await useRunStore.getState().addRun(input);
        return { queued: false };
      }
      const existing = editingId ? useRunStore.getState().runs.find((r) => r.id === editingId) : undefined;
      const entity = buildRunEntity(input, editingId ?? uid('run'), (existing?.rev ?? 0) + 1);
      await enqueue({
        id: uid('op'),
        kind: 'run.upsert',
        entityId: entity.id,
        holeId: entity.holeId,
        label: entity.runNo,
        payload: entity,
        baseUpdatedAt: existing?.updatedAt ?? null,
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
      });
      return { queued: true };
    },

    saveBox: async (input, editingId) => {
      if (!get().offlineMode()) {
        if (editingId) await useBoxStore.getState().updateBox(editingId, input);
        else await useBoxStore.getState().addBox(input);
        return { queued: false };
      }
      const existing = editingId ? useBoxStore.getState().boxes.find((b) => b.id === editingId) : undefined;
      const entity = buildBoxEntity(input, editingId ?? uid('box'), (existing?.rev ?? 0) + 1);
      await enqueue({
        id: uid('op'),
        kind: 'box.upsert',
        entityId: entity.id,
        holeId: entity.holeId,
        label: entity.boxNo,
        payload: entity,
        baseUpdatedAt: existing?.updatedAt ?? null,
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
      });
      return { queued: true };
    },

    removeRun: async (id) => {
      if (!get().offlineMode()) {
        await useRunStore.getState().removeRun(id);
        return { queued: false };
      }
      const run = useRunStore.getState().runs.find((r) => r.id === id);
      await enqueue({
        id: uid('op'),
        kind: 'run.delete',
        entityId: id,
        holeId: run?.holeId ?? '',
        label: run?.runNo ?? id,
        baseUpdatedAt: run?.updatedAt ?? null,
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
      });
      return { queued: true };
    },

    removeBox: async (id) => {
      if (!get().offlineMode()) {
        await useBoxStore.getState().removeBox(id);
        return { queued: false };
      }
      const box = useBoxStore.getState().boxes.find((b) => b.id === id);
      await enqueue({
        id: uid('op'),
        kind: 'box.delete',
        entityId: id,
        holeId: box?.holeId ?? '',
        label: box?.boxNo ?? id,
        baseUpdatedAt: box?.updatedAt ?? null,
        status: 'pending',
        attempts: 0,
        createdAt: new Date().toISOString(),
      });
      return { queued: true };
    },

    sync: async () => {
      if (get().syncing || get().offlineMode()) return null;
      set({ syncing: true });
      try {
        const report = await processOutbox();
        // 重新装载回次与岩芯箱：岩芯箱连续性、岩性区间重叠提示、工作台覆盖率等派生数据随之刷新
        await Promise.all([useRunStore.getState().hydrate(), useBoxStore.getState().hydrate()]);
        const [outbox, conflicts] = await Promise.all([
          db.outbox.orderBy('createdAt').toArray(),
          db.conflicts.orderBy('createdAt').toArray(),
        ]);
        set({ outbox, conflicts, lastReport: report, syncing: false });
        return report;
      } catch (error) {
        set({ syncing: false });
        throw error;
      }
    },

    retryOp: async (opId) => {
      const op = get().outbox.find((o) => o.id === opId);
      if (!op) return null;
      const next: PendingOp = { ...op, status: 'pending', lastError: undefined };
      await db.outbox.put(next);
      set({ outbox: get().outbox.map((o) => (o.id === opId ? next : o)) });
      return get().sync();
    },

    retryAll: async () => {
      const next = get().outbox.map((o) => (o.status === 'failed' ? { ...o, status: 'pending' as const, lastError: undefined } : o));
      await db.transaction('rw', db.outbox, async () => {
        await db.outbox.clear();
        if (next.length) await db.outbox.bulkPut(next);
      });
      set({ outbox: next });
      return get().sync();
    },

    discardOp: async (opId) => {
      await db.outbox.delete(opId);
      set({ outbox: get().outbox.filter((o) => o.id !== opId) });
    },
  };
});
