import type { DrillRun } from './drill-run';
import type { CoreBox } from './core-box';

/** 待同步操作类型：回次 / 岩芯箱的登记（upsert）与删除 */
export type PendingOpKind = 'run.upsert' | 'run.delete' | 'box.upsert' | 'box.delete';

/** 断网期间登记、等待并入编目台的操作（现场平板离线队列） */
export interface PendingOp {
  id: string;
  kind: PendingOpKind;
  /** 目标记录 id（新建记录在登记时即预分配，保证重复同步幂等） */
  entityId: string;
  /** 所属钻孔 */
  holeId: string;
  /** 业务编号（回次号 / 箱号），队列展示用 */
  label: string;
  /** upsert 时携带完整记录（含现场测量值）；删除时为空 */
  payload?: DrillRun | CoreBox;
  /** 编辑所基于的编目台版本时间（updatedAt）；新建为 null */
  baseUpdatedAt: string | null;
  status: 'pending' | 'failed';
  /** 已尝试并入次数 */
  attempts: number;
  /** 最近一次失败原因 */
  lastError?: string;
  createdAt: string;
}

/**
 * 同步冲突留档：同一记录两边几乎同时改动时，按字段级规则合并，
 * 双方原始内容与合并结果都保留在此，不整条覆盖、不丢任何一边。
 */
export interface SyncConflict {
  id: string;
  entityKind: 'run' | 'box';
  /** 合并后入库记录的 id（以编目台既有记录为准） */
  entityId: string;
  holeId: string;
  /** 业务编号（回次号 / 箱号） */
  label: string;
  /** 现场（平板）登记版本；现场删除请求时为 null */
  fieldVersion: DrillRun | CoreBox | null;
  /** 编目台（地质组复核）版本 */
  deskVersion: DrillRun | CoreBox;
  /** 按字段级规则合并后的入库版本；删除类冲突为 null */
  merged: DrillRun | CoreBox | null;
  /** 合并策略说明 */
  strategy: string;
  createdAt: string;
}

/** 一次同步的结果汇总 */
export interface SyncReport {
  /** 直接并入条数（对端无改动） */
  applied: number;
  /** 冲突合并条数（字段级合并并留档） */
  merged: number;
  /** 删除条数 */
  deleted: number;
  /** 并入失败（留在队列中可重试，不落半套数据） */
  failed: Array<{ opId: string; label: string; error: string }>;
  syncedAt: string;
}

export const PENDING_OP_KIND_TEXT: Record<PendingOpKind, string> = {
  'run.upsert': '回次登记',
  'run.delete': '回次删除',
  'box.upsert': '岩芯箱登记',
  'box.delete': '岩芯箱删除',
};
