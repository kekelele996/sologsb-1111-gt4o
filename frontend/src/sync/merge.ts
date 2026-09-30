import type { ChangeEntry, EntityType, NodeRole, SyncConflict } from './types';
import { footageOf, recoveryOf } from '../utils/recovery';

/** 字段级冲突：两边各持的值都保留 */
export interface FieldConflict {
  field: string;
  baseValue: unknown;
  fieldValue: unknown;
  deskValue: unknown;
  adopted: 'field' | 'desk';
}

export interface MergeOutcome {
  op: 'put' | 'delete';
  record?: Record<string, unknown>;
  conflicts: FieldConflict[];
}

/**
 * 冲突规则（仅对回次生效）：
 * - 深度区间（起/止深度）认现场记录
 * - 岩芯长度认地质组复核值
 * 其余字段两边几乎同时修改时，按变更时间 newer 优先（字段级 LWW）。
 */
const FIELD_WINS: Record<string, true> = { fromDepth: true, toDepth: true };
const DESK_WINS: Record<string, true> = { coreLength: true };

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      return a.every((v, i) => deepEqual(v, b[i]));
    }
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * 字段级三方合并：
 * - 只有一边改过的字段，采用该边（两边内容都留下，不整条覆盖）；
 * - 两边都改过且不一致时，按冲突规则采用，并登记冲突（两边的值都写入冲突记录）；
 * - 两边都没改的字段，取基线值。
 */
export function mergePuts(
  remote: ChangeEntry,
  local: ChangeEntry | undefined,
  localCurrent: unknown,
  remoteRole: NodeRole,
  localRole: NodeRole,
): MergeOutcome {
  const remoteRecord = asRecord(remote.record);
  const localRecord = asRecord(local?.record ?? localCurrent);
  const remoteBase = asRecord(remote.base);
  const localBase = asRecord(local?.base ?? remote.base);

  // 删除 vs 修改：修改优先（记录保留），整条冲突登记
  if (remote.op === 'delete' || local?.op === 'delete') {
    const remoteDeleted = remote.op === 'delete';
    const localDeleted = local?.op === 'delete';
    if (remoteDeleted && localDeleted) {
      return { op: 'delete', conflicts: [] };
    }
    if (remoteDeleted) {
      // 对端删除、本端修改：保留本端修改
      return {
        op: 'put',
        record: localRecord,
        conflicts: [
          {
            field: '__all__',
            baseValue: remoteBase,
            fieldValue: localRole === 'field' ? '保留修改' : '删除',
            deskValue: remoteRole === 'desk' ? '删除' : '保留修改',
            adopted: 'field',
          },
        ],
      };
    }
    // 本端删除、对端修改：保留对端修改
    return {
      op: 'put',
      record: remoteRecord,
      conflicts: [
        {
          field: '__all__',
          baseValue: localBase,
          fieldValue: remoteRole === 'field' ? '保留修改' : '删除',
          deskValue: localRole === 'desk' ? '删除' : '保留修改',
          adopted: 'desk',
        },
      ],
    };
  }

  const fields = new Set<string>([
    ...Object.keys(remoteRecord),
    ...Object.keys(localRecord),
    ...Object.keys(remoteBase),
    ...Object.keys(localBase),
  ]);

  const out: Record<string, unknown> = {};
  const conflicts: FieldConflict[] = [];

  for (const field of fields) {
    const rChanged = !deepEqual(remoteRecord[field], remoteBase[field]);
    const lChanged = local ? !deepEqual(localRecord[field], localBase[field]) : false;

    if (rChanged && lChanged) {
      if (deepEqual(remoteRecord[field], localRecord[field])) {
        // 两边改得一致，直接采用
        out[field] = remoteRecord[field];
        continue;
      }
      // 两边都改了同一字段且不一致：按规则采用
      let adoptedRole: NodeRole;
      if (remote.entityType === 'run' && FIELD_WINS[field]) {
        adoptedRole = 'field';
      } else if (remote.entityType === 'run' && DESK_WINS[field]) {
        adoptedRole = 'desk';
      } else {
        // 其余字段：变更时间 newer 优先
        adoptedRole = remote.updatedAt >= (local?.updatedAt ?? 0) ? remoteRole : localRole;
      }
      const adoptedValue = adoptedRole === remoteRole ? remoteRecord[field] : localRecord[field];
      out[field] = adoptedValue;
      conflicts.push({
        field,
        baseValue: remoteBase[field] ?? localBase[field],
        fieldValue: remoteRole === 'field' ? remoteRecord[field] : localRecord[field],
        deskValue: remoteRole === 'desk' ? remoteRecord[field] : localRecord[field],
        adopted: adoptedRole,
      });
    } else if (rChanged) {
      out[field] = remoteRecord[field];
    } else if (lChanged) {
      out[field] = localRecord[field];
    } else {
      // 两边都没改：取基线（本端现有值优先，保留已并入的本地改动）
      out[field] = Object.prototype.hasOwnProperty.call(localRecord, field) ? localRecord[field] : remoteRecord[field];
    }
  }

  return { op: 'put', record: out, conflicts };
}

/** 回次深度/岩芯长度并入后重算进尺与采取率（深度改动后派生数据跟着刷新） */
export function recomputeRun(record: Record<string, unknown>): Record<string, unknown> {
  const fromDepth = Number(record.fromDepth) || 0;
  const toDepth = Number(record.toDepth) || 0;
  const footage = footageOf(fromDepth, toDepth);
  const coreLength = Number(record.coreLength) || 0;
  return { ...record, footage, recovery: recoveryOf(coreLength, footage) };
}

/** 字段冲突转持久化记录 */
export function toConflictRows(
  conflicts: FieldConflict[],
  entityType: EntityType,
  entityId: string,
  at: number,
  idOf: () => string,
): SyncConflict[] {
  return conflicts.map((c) => ({
    id: idOf(),
    entityType,
    entityId,
    field: c.field,
    baseValue: c.baseValue,
    fieldValue: c.fieldValue,
    deskValue: c.deskValue,
    adopted: c.adopted,
    at,
  }));
}
