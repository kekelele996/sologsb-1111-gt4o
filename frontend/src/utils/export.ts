import { db, SCHEMA_VERSION } from './db';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';

export interface BackupPayload {
  app: string;
  schemaVersion: number;
  exportedAt: string;
  holes: unknown[];
  runs: unknown[];
  boxes: unknown[];
  lithos: unknown[];
  outbox: unknown[];
  conflicts: unknown[];
}

/** 汇总全部本地表为 JSON 备份（schema 迁移前先导出） */
export async function buildBackup(): Promise<BackupPayload> {
  const [holes, runs, boxes, lithos, outbox, conflicts] = await Promise.all([
    db.holes.toArray(),
    db.runs.toArray(),
    db.boxes.toArray(),
    db.lithos.toArray(),
    db.outbox.toArray(),
    db.conflicts.toArray(),
  ]);
  return {
    app: 'gbdrillcore',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    holes,
    runs,
    boxes,
    lithos,
    outbox,
    conflicts,
  };
}

export async function exportBackupJson(): Promise<string> {
  return JSON.stringify(await buildBackup(), null, 2);
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导出 CSV（岩芯编目表打印用） */
export function downloadCsv<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  columns: Array<{ key: keyof T; title: string }>,
): void {
  const header = columns.map((c) => `"${c.title}"`).join(',');
  const body = rows
    .map((row) => columns.map((c) => `"${String(row[c.key] ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  downloadText(filename, `﻿${header}\n${body}`, 'text/csv');
}

/** 旧版备份可能缺少版本戳，导入时补齐，保证同步冲突判定可用 */
function withRunVersion(row: unknown): DrillRun {
  const run = row as DrillRun;
  return {
    ...run,
    updatedAt: run.updatedAt || run.drilledAt || new Date().toISOString(),
    rev: typeof run.rev === 'number' ? run.rev : 1,
  };
}

function withBoxVersion(row: unknown): CoreBox {
  const box = row as CoreBox;
  return {
    ...box,
    updatedAt: box.updatedAt || box.boxedAt || new Date().toISOString(),
    rev: typeof box.rev === 'number' ? box.rev : 1,
  };
}

/** 恢复 JSON 备份 */
export async function importBackup(text: string): Promise<{ holes: number; runs: number; boxes: number; lithos: number }> {
  const payload = JSON.parse(text) as Partial<BackupPayload>;
  if (!payload || payload.app !== 'gbdrillcore') {
    throw new Error('备份文件格式不匹配（缺少 app=gbdrillcore 标记）');
  }
  const counts = {
    holes: payload.holes?.length ?? 0,
    runs: payload.runs?.length ?? 0,
    boxes: payload.boxes?.length ?? 0,
    lithos: payload.lithos?.length ?? 0,
  };
  await db.transaction('rw', [db.holes, db.runs, db.boxes, db.lithos, db.outbox, db.conflicts], async () => {
    await Promise.all([
      db.holes.clear(),
      db.runs.clear(),
      db.boxes.clear(),
      db.lithos.clear(),
      db.outbox.clear(),
      db.conflicts.clear(),
    ]);
    if (payload.holes?.length) await db.holes.bulkPut(payload.holes as never[]);
    if (payload.runs?.length) await db.runs.bulkPut(payload.runs.map(withRunVersion) as never[]);
    if (payload.boxes?.length) await db.boxes.bulkPut(payload.boxes.map(withBoxVersion) as never[]);
    if (payload.lithos?.length) await db.lithos.bulkPut(payload.lithos as never[]);
    if (payload.outbox?.length) await db.outbox.bulkPut(payload.outbox as never[]);
    if (payload.conflicts?.length) await db.conflicts.bulkPut(payload.conflicts as never[]);
  });
  return counts;
}
