import { create } from 'zustand';
import { db, activateNode } from '../utils/db';
import { seedIfEmpty } from '../utils/seed';
import { uid } from '../utils/id';
import { getCurrentNode, getPeerNode, openPeerWindow, switchRole } from './node';
import { tableOf } from './outbox';
import { mergePuts, recomputeRun, toConflictRows } from './merge';
import { checkBoxContinuity, findConflicts, validateRange } from '../utils/recovery';
import { useHoleStore } from '../stores/holeStore';
import { useRunStore } from '../stores/runStore';
import { useBoxStore } from '../stores/boxStore';
import { useLithoStore } from '../stores/lithoStore';
import type { ChangeEntry, NodeInfo, SyncConflict, SyncPackage, SyncResult } from './types';

const CHANNEL_NAME = 'gbdrillcore-sync-v1';
const MANUAL_OFFLINE_KEY = 'gbdrillcore-manual-offline';
const FORCE_FAIL_KEY = 'gbdrillcore-force-sync-fail';

type ChannelMessage =
  | { app: 'gbdrillcore-sync'; type: 'sync-request'; nodeId: string }
  | { app: 'gbdrillcore-sync'; type: 'sync-package'; nodeId: string; pkg: SyncPackage };

/** 同步 UI 状态（供顶栏与同步面板绑定） */
interface SyncUiState {
  online: boolean;
  node: NodeInfo;
  pendingCount: number;
  busy: boolean;
  lastResult: SyncResult | null;
  conflicts: SyncConflict[];
  forceFail: boolean;
}

export const useSyncStore = create<SyncUiState>(() => ({
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  node: getCurrentNode(),
  pendingCount: 0,
  busy: false,
  lastResult: null,
  conflicts: [],
  forceFail: false,
}));

async function hydrateAll(): Promise<void> {
  await Promise.all([
    useHoleStore.getState().hydrate(),
    useRunStore.getState().hydrate(),
    useBoxStore.getState().hydrate(),
    useLithoStore.getState().hydrate(),
  ]);
}

/** 并入后重算派生数据：岩芯箱连续性、岩性区间重叠、工作台覆盖率/异常清单 */
function computeRefreshed(): SyncResult['refreshed'] {
  const runs = useRunStore.getState().runs;
  const boxes = useBoxStore.getState().boxes;
  const lithos = useLithoStore.getState().lithos;
  const holes = useHoleStore.getState().holes;
  const boxesWithGaps = boxes.filter((b) => !checkBoxContinuity(b, runs).covered).length;
  let lithoConflicts = 0;
  for (const log of lithos) {
    lithoConflicts += findConflicts(log, lithos).length;
  }
  lithoConflicts = Math.floor(lithoConflicts / 2); // 每对冲突被双方各计一次
  const belowDesign = holes.filter((h) => Boolean(h.endDate) && h.finalDepth > 0 && h.finalDepth < h.designDepth).length;
  const anomalies = runs.filter((r) => r.recovery < 75).length;
  return { runs: runs.length, boxesWithGaps, lithoConflicts, belowDesign, anomalies };
}

class SyncEngine {
  private channel: BroadcastChannel | null = null;
  private applying = false;
  /** 上次并入失败的包（重试时重新并入） */
  private lastPackage: SyncPackage | null = null;
  /** 已并入对端的变更 id（按对端节点分别记忆，并入回执用） */
  private ackMap = new Map<string, string[]>();

  /** 初始化：挂载广播通道与网络监听 */
  init(): void {
    this.setupChannel();
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
    void this.refreshUi();
  }

  dispose(): void {
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    this.channel?.close();
    this.channel = null;
  }

  isOnline(): boolean {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine && localStorage.getItem(MANUAL_OFFLINE_KEY) !== '1';
  }

  /** 手动断网/联网（演示孔口无网络场景）；恢复联网后自动并入 */
  setManualOffline(offline: boolean): void {
    if (offline) localStorage.setItem(MANUAL_OFFLINE_KEY, '1');
    else localStorage.removeItem(MANUAL_OFFLINE_KEY);
    useSyncStore.setState({ online: this.isOnline() });
    if (!offline) void this.syncNow();
  }

  isForceFail(): boolean {
    return localStorage.getItem(FORCE_FAIL_KEY) === '1';
  }

  setForceFail(on: boolean): void {
    if (on) localStorage.setItem(FORCE_FAIL_KEY, '1');
    else localStorage.removeItem(FORCE_FAIL_KEY);
    useSyncStore.setState({ forceFail: on });
  }

  private handleOnline = (): void => {
    useSyncStore.setState({ online: this.isOnline() });
    if (this.isOnline()) void this.syncNow();
  };

  private handleOffline = (): void => {
    useSyncStore.setState({ online: false });
  };

  private setupChannel(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
      const msg = event.data;
      if (!msg || msg.app !== 'gbdrillcore-sync') return;
      if (msg.nodeId === getCurrentNode().nodeId) return; // 忽略自己的消息
      void this.handleChannelMessage(msg);
    };
  }

  private async handleChannelMessage(msg: ChannelMessage): Promise<void> {
    if (msg.type === 'sync-request') {
      // 对端请求同步：把本端待办发过去
      const pkg = await this.buildPackage();
      this.channel?.postMessage({ app: 'gbdrillcore-sync', type: 'sync-package', nodeId: getCurrentNode().nodeId, pkg });
      return;
    }
    // 收到对端同步包：并入后回发本端包（含回执）
    const result = await this.applyPackage(msg.pkg);
    const pkg = await this.buildPackage();
    this.channel?.postMessage({ app: 'gbdrillcore-sync', type: 'sync-package', nodeId: getCurrentNode().nodeId, pkg });
    useSyncStore.setState({ lastResult: result });
  }

  /** 组装本端待同步包 */
  async buildPackage(): Promise<SyncPackage> {
    const node = getCurrentNode();
    const changes = await db.outbox.filter((c) => !c.synced).toArray();
    return {
      app: 'gbdrillcore-sync',
      version: 1,
      nodeId: node.nodeId,
      nodeRole: node.role,
      exportedAt: new Date().toISOString(),
      changes,
      ackChangeIds: this.ackMap.get('*') ?? [],
    };
  }

  /** 立即同步：广播同步请求并推送本端待办（对端响应由通道事件驱动并入） */
  async syncNow(): Promise<{ sent: number }> {
    if (!this.isOnline()) throw new Error('当前处于离线状态，请先恢复网络后再同步');
    const node = getCurrentNode();
    const pkg = await this.buildPackage();
    this.channel?.postMessage({ app: 'gbdrillcore-sync', type: 'sync-request', nodeId: node.nodeId });
    if (pkg.changes.length > 0) {
      this.channel?.postMessage({ app: 'gbdrillcore-sync', type: 'sync-package', nodeId: node.nodeId, pkg });
    }
    await this.refreshUi();
    return { sent: pkg.changes.length };
  }

  /** 导出同步包（JSON 文件，平板带回驻地后导入） */
  async exportPackage(): Promise<number> {
    const pkg = await this.buildPackage();
    const node = getCurrentNode();
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gbdrillcore-sync-${node.nodeId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return pkg.changes.length;
  }

  /** 导入同步包（JSON 文本）并并入 */
  async importPackageText(text: string): Promise<SyncResult> {
    let pkg: SyncPackage;
    try {
      pkg = JSON.parse(text) as SyncPackage;
    } catch {
      throw new Error('同步包不是合法 JSON 文件');
    }
    return this.applyPackage(pkg);
  }

  /** 重试上次失败的并入 */
  async retryLast(): Promise<SyncResult> {
    if (!this.lastPackage) throw new Error('没有可重试的失败记录');
    return this.applyPackage(this.lastPackage);
  }

  /**
   * 并入同步包：先在内存里完成字段级合并与校验（pre-flight），
   * 全部通过后再在一个 Dexie 事务里原子写入——失败则整条事务回滚，不留半套数据。
   */
  async applyPackage(pkg: SyncPackage): Promise<SyncResult> {
    if (this.applying) throw new Error('正在并入中，请稍候');
    this.applying = true;
    useSyncStore.setState({ busy: true });
    const result: SyncResult = { received: pkg.changes.length, merged: 0, conflicts: 0, failed: 0, errors: [], refreshed: null };
    try {
      if (!pkg || pkg.app !== 'gbdrillcore-sync') throw new Error('同步包格式不匹配（缺少 app=gbdrillcore-sync 标记）');
      if (pkg.version !== 1) throw new Error(`同步包版本不支持：v${pkg.version}`);

      const localRole = getCurrentNode().role;
      const remoteRole = pkg.nodeRole;

      // ---- 1. pre-flight：纯内存合并与校验，不写库 ----
      const localPendings = await db.outbox.filter((c) => !c.synced).toArray();
      const localByEntity = new Map(localPendings.map((c) => [`${c.entityType}:${c.entityId}`, c]));
      const packageHoleIds = new Set(
        pkg.changes.filter((c) => c.entityType === 'hole' && c.op === 'put').map((c) => (c.record as { id: string }).id),
      );

      const planned: Array<{ change: ChangeEntry; op: 'put' | 'delete'; record?: Record<string, unknown> }> = [];
      const conflictRows: SyncConflict[] = [];
      const errors: Array<{ changeId: string; error: string }> = [];

      for (const change of pkg.changes) {
        try {
          const local = localByEntity.get(`${change.entityType}:${change.entityId}`);
          const localCurrent = await tableOf(change.entityType).get(change.entityId);
          const outcome = mergePuts(change, local, localCurrent, remoteRole, localRole);
          if (outcome.op === 'delete') {
            planned.push({ change, op: 'delete' });
          } else {
            let record = outcome.record!;
            if (change.entityType === 'run') record = recomputeRun(record);
            // 校验：深度区间、钻孔引用
            if (change.entityType === 'run' || change.entityType === 'box' || change.entityType === 'litho') {
              const r = record as { fromDepth?: number; toDepth?: number; holeId?: string };
              if (r.fromDepth == null || r.toDepth == null) throw new Error('深度区间缺失');
              const rangeError = validateRange(Number(r.fromDepth), Number(r.toDepth));
              if (rangeError) throw new Error(rangeError);
              if (!packageHoleIds.has(r.holeId!) && !(await db.holes.get(r.holeId!))) {
                throw new Error(`引用的钻孔不存在：${r.holeId}`);
              }
            }
            planned.push({ change, op: 'put', record });
          }
          conflictRows.push(...toConflictRows(outcome.conflicts, change.entityType, change.entityId, Date.now(), () => uid('cf')));
        } catch (e) {
          errors.push({ changeId: change.id, error: (e as Error).message });
        }
      }

      if (this.isForceFail()) {
        errors.push({ changeId: pkg.changes[0]?.id ?? 'force', error: '演示故障注入：并入事务写入失败（未写入任何数据，可重试）' });
      }

      if (errors.length > 0) {
        // 失败：不写任何业务数据；记录本端相关待办的失败次数，可重试
        await this.markFailure(pkg.changes, errors.map((e) => e.error).join('；'));
        this.lastPackage = pkg;
        result.failed = pkg.changes.length;
        result.errors = errors;
        useSyncStore.setState({ lastResult: result });
        return result;
      }

      // ---- 2. 原子写入：一个事务内完成业务表 + outbox + syncState + 冲突记录 ----
      await db.transaction(
        'rw',
        [db.holes, db.runs, db.boxes, db.lithos, db.outbox, db.syncState, db.syncConflicts],
        async () => {
          for (const { change, op, record } of planned) {
            const table = tableOf(change.entityType);
            if (op === 'delete') {
              await table.delete(change.entityId);
            } else {
              await table.put(record as never);
            }
            // 本端待办标记已同步
            const local = localByEntity.get(`${change.entityType}:${change.entityId}`);
            if (local) {
              await db.outbox.put({ ...local, synced: true, syncedAt: Date.now() });
            }
            // 同步状态
            await db.syncState.put({
              entityId: change.entityId,
              entityType: change.entityType,
              record: op === 'delete' ? null : record,
              updatedAt: Date.now(),
              updatedBy: change.updatedBy,
            });
          }
          if (conflictRows.length > 0) await db.syncConflicts.bulkPut(conflictRows);
          // 处理对端回执：确认本端已并入的变更
          if (pkg.ackChangeIds && pkg.ackChangeIds.length > 0) {
            const acked = await db.outbox.where('id').anyOf(pkg.ackChangeIds).toArray();
            await db.outbox.bulkPut(acked.map((c) => ({ ...c, synced: true, syncedAt: Date.now() })));
          }
        },
      );

      // ---- 3. 并入成功：刷新全部 store，派生数据（箱连续性 / 岩性重叠 / 工作台覆盖）跟着重算 ----
      await hydrateAll();
      this.lastPackage = null;
      if (pkg.nodeId) this.ackMap.set('*', pkg.changes.map((c) => c.id));
      result.merged = planned.length;
      result.conflicts = conflictRows.length;
      result.refreshed = computeRefreshed();
      useSyncStore.setState({ lastResult: result });
      await this.refreshUi();
      return result;
    } finally {
      this.applying = false;
      useSyncStore.setState({ busy: false });
    }
  }

  /** 并入失败：记录本端相关待办的失败次数与原因（业务数据零写入） */
  private async markFailure(changes: ChangeEntry[], error: string): Promise<void> {
    const entityKeys = new Set(changes.map((c) => `${c.entityType}:${c.entityId}`));
    const locals = await db.outbox
      .filter((c) => !c.synced && entityKeys.has(`${c.entityType}:${c.entityId}`))
      .toArray();
    if (locals.length > 0) {
      await db.outbox.bulkPut(locals.map((c) => ({ ...c, attempts: (c.attempts ?? 0) + 1, lastError: error })));
    }
    await this.refreshUi();
  }

  /** 切换节点角色（地质组台 / 现场平板）：换库 → 补种子数据 → 重载 */
  async switchNode(role: 'field' | 'desk'): Promise<void> {
    const node = switchRole(role);
    await activateNode(node);
    await seedIfEmpty();
    await hydrateAll();
    useSyncStore.setState({ node, lastResult: null });
    await this.refreshUi();
  }

  /** 打开对端设备窗口（独立标签页、独立库） */
  openPeer(role: 'field' | 'desk'): void {
    openPeerWindow(role);
  }

  /** 刷新 UI 状态（待办数 / 冲突数） */
  async refreshUi(): Promise<void> {
    const [pendingCount, conflicts] = await Promise.all([
      db.outbox.filter((c) => !c.synced).count(),
      db.syncConflicts.orderBy('at').reverse().limit(50).toArray(),
    ]);
    useSyncStore.setState({
      online: this.isOnline(),
      node: getCurrentNode(),
      pendingCount,
      conflicts,
      forceFail: this.isForceFail(),
    });
  }
}

export const syncEngine = new SyncEngine();
export { getPeerNode };
