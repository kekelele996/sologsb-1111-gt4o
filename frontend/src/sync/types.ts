/** 同步引擎相关类型定义 */

/** 可同步的实体类型 */
export type EntityType = 'hole' | 'run' | 'box' | 'litho';

/** 节点角色：现场班组平板 / 地质组编目台 */
export type NodeRole = 'field' | 'desk';

/** 本地变更日志（断网期间登记的每一条变更都先进 outbox 队列） */
export interface ChangeEntry {
  /** 变更 id */
  id: string;
  entityType: EntityType;
  entityId: string;
  /** 变更类型：写入 / 删除 */
  op: 'put' | 'delete';
  /** 写入的新记录（删除时为删除前快照） */
  record: unknown;
  /** 变更前的基线记录（三方合并用） */
  base: unknown;
  /** 变更时间（ms） */
  updatedAt: number;
  /** 变更节点 id */
  updatedBy: string;
  /** 变更节点角色（冗余，合并时按角色判定采用方） */
  nodeRole: NodeRole;
  /** 是否已并入对端 */
  synced: boolean;
  syncedAt?: number;
  /** 并入尝试次数（失败后累加，可重试） */
  attempts: number;
  /** 最近一次失败原因 */
  lastError?: string;
}

/** 字段级冲突记录：两边各持的值都保留 */
export interface SyncConflict {
  id: string;
  entityType: EntityType;
  entityId: string;
  /** 冲突字段名（'__all__' 表示整条记录的删除/修改冲突） */
  field: string;
  /** 基线值 */
  baseValue: unknown;
  /** 现场记录的值 */
  fieldValue: unknown;
  /** 地质组复核的值 */
  deskValue: unknown;
  /** 最终采用方 */
  adopted: 'field' | 'desk';
  at: number;
}

/** 每一条实体的最后同步状态（并入成功后更新） */
export interface SyncStateRow {
  entityId: string;
  entityType: EntityType;
  /** 并入后的记录（删除时为 null） */
  record: unknown;
  updatedAt: number;
  updatedBy: string;
}

/** 节点身份 */
export interface NodeInfo {
  nodeId: string;
  role: NodeRole;
  label: string;
}

/** 同步包（平板带回驻地 / 跨标签页并入） */
export interface SyncPackage {
  app: 'gbdrillcore-sync';
  version: 1;
  nodeId: string;
  nodeRole: NodeRole;
  exportedAt: string;
  changes: ChangeEntry[];
  /** 回执：本端已并入的对端变更 id（对端据此把 outbox 标记为已同步） */
  ackChangeIds?: string[];
}

/** 最近一次并入结果 */
export interface SyncResult {
  /** 收到的变更数 */
  received: number;
  /** 成功并入数 */
  merged: number;
  /** 冲突字段数 */
  conflicts: number;
  /** 失败数（失败时整条事务回滚，不留半套数据） */
  failed: number;
  errors: Array<{ changeId: string; error: string }>;
  /** 并入后重算的派生数据统计 */
  refreshed: {
    runs: number;
    /** 岩芯箱连续性断档数 */
    boxesWithGaps: number;
    /** 岩性区间重叠冲突数 */
    lithoConflicts: number;
    /** 未达设计待补勘钻孔数 */
    belowDesign: number;
    /** 采取率异常回次数 */
    anomalies: number;
  } | null;
}
