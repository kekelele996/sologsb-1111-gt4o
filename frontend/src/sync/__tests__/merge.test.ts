import { mergePuts, recomputeRun } from '../merge';
import type { ChangeEntry } from '../types';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function makeChange(over: Partial<ChangeEntry>): ChangeEntry {
  return {
    id: 'chg-1',
    entityType: 'run',
    entityId: 'run-001',
    op: 'put',
    record: {},
    base: {},
    updatedAt: 1000,
    updatedBy: 'node-a',
    nodeRole: 'field',
    synced: false,
    attempts: 0,
    ...over,
  };
}

console.log('场景1：同一条回次两边几乎同时改深度 → 深度认现场，岩芯长度认复核');
{
  const base = { id: 'run-001', runNo: '2401-01', fromDepth: 10, toDepth: 15, coreLength: 4.5, recorder: '高振华' };
  const fieldChange = makeChange({
    nodeRole: 'field',
    record: { ...base, fromDepth: 10.5, toDepth: 15.5, coreLength: 4.6 },
    base: { ...base },
    updatedAt: 2000,
  });
  const deskChange = makeChange({
    id: 'chg-2',
    nodeRole: 'desk',
    record: { ...base, fromDepth: 10.2, toDepth: 15.2, coreLength: 4.8 },
    base: { ...base },
    updatedAt: 2100,
    updatedBy: 'node-b',
  });
  const outcome = mergePuts(fieldChange, deskChange, base, 'field', 'desk');
  const r = outcome.record!;
  assert(Number(r.fromDepth) === 10.5, `起深度取现场值 10.5（实际 ${r.fromDepth}）`);
  assert(Number(r.toDepth) === 15.5, `止深度取现场值 15.5（实际 ${r.toDepth}）`);
  assert(Number(r.coreLength) === 4.8, `岩芯长度取地质组复核值 4.8（实际 ${r.coreLength}）`);
  assert(r.recorder === '高振华', `未冲突字段保留基线（实际 ${r.recorder}）`);
  assert(outcome.conflicts.some((c) => c.field === 'fromDepth' && c.adopted === 'field'), '起深度冲突标记为现场采用');
  assert(outcome.conflicts.some((c) => c.field === 'toDepth' && c.adopted === 'field'), '止深度冲突标记为现场采用');
  assert(outcome.conflicts.some((c) => c.field === 'coreLength' && c.adopted === 'desk'), '岩芯长度冲突标记为地质组采用');
  assert(outcome.conflicts.length === 3, `共 3 处字段冲突（深度2 + 岩芯1），实际 ${outcome.conflicts.length}`);
}

console.log('场景2：只有现场改深度、只有地质组改岩芯长度 → 两边内容都留下');
{
  const base = { id: 'run-001', fromDepth: 10, toDepth: 15, coreLength: 4.5, remark: '原始' };
  const fieldChange = makeChange({
    nodeRole: 'field',
    record: { ...base, fromDepth: 11, toDepth: 16 },
    base: { ...base },
  });
  const deskChange = makeChange({
    id: 'chg-2',
    nodeRole: 'desk',
    record: { ...base, coreLength: 4.9, remark: '复核' },
    base: { ...base },
    updatedAt: 2000,
    updatedBy: 'node-b',
  });
  const outcome = mergePuts(fieldChange, deskChange, base, 'field', 'desk');
  const r = outcome.record!;
  assert(Number(r.fromDepth) === 11, `现场改的深度保留（实际 ${r.fromDepth}）`);
  assert(Number(r.toDepth) === 16, `现场改的止深度保留（实际 ${r.toDepth}）`);
  assert(Number(r.coreLength) === 4.9, `地质组改的岩芯长度保留（实际 ${r.coreLength}）`);
  assert(r.remark === '复核', `地质组改的备注保留（实际 ${r.remark}）`);
  assert(outcome.conflicts.length === 0, `无两边同时改的字段，无冲突（实际 ${outcome.conflicts.length}）`);
}

console.log('场景3：两边改得一致 → 直接采用，不记冲突');
{
  const base = { id: 'run-001', fromDepth: 10, toDepth: 15, coreLength: 4.5 };
  const fieldChange = makeChange({ nodeRole: 'field', record: { ...base, coreLength: 5.0 }, base: { ...base } });
  const deskChange = makeChange({
    id: 'chg-2', nodeRole: 'desk', record: { ...base, coreLength: 5.0 }, base: { ...base },
    updatedAt: 2000, updatedBy: 'node-b',
  });
  const outcome = mergePuts(fieldChange, deskChange, base, 'field', 'desk');
  assert(Number(outcome.record!.coreLength) === 5.0, `岩芯长度 5.0（实际 ${outcome.record!.coreLength}）`);
  assert(outcome.conflicts.length === 0, `无冲突（实际 ${outcome.conflicts.length}）`);
}

console.log('场景4：对端删除、本端修改 → 修改优先，记录保留');
{
  const base = { id: 'run-001', fromDepth: 10, toDepth: 15, coreLength: 4.5 };
  const remoteDelete = makeChange({ op: 'delete', record: { ...base }, base: { ...base }, nodeRole: 'desk' });
  const localModify = makeChange({
    id: 'chg-2', nodeRole: 'field', record: { ...base, coreLength: 4.2 }, base: { ...base },
    updatedAt: 2000, updatedBy: 'node-b',
  });
  const outcome = mergePuts(remoteDelete, localModify, base, 'desk', 'field');
  assert(outcome.op === 'put', `采用修改（实际 op=${outcome.op}）`);
  assert(Number(outcome.record!.coreLength) === 4.2, `保留修改后的岩芯长度（实际 ${outcome.record!.coreLength}）`);
  assert(outcome.conflicts.some((c) => c.field === '__all__'), '整条冲突已登记');
}

console.log('场景5：回次并入后重算进尺与采取率');
{
  const merged = recomputeRun({ id: 'run-001', fromDepth: 10, toDepth: 15, coreLength: 4.5 });
  assert(Number(merged.footage) === 5, `进尺 = 15-10 = 5（实际 ${merged.footage}）`);
  assert(Number(merged.recovery) === 90, `采取率 = 4.5/5 = 90%（实际 ${merged.recovery}）`);
  const merged2 = recomputeRun({ id: 'run-001', fromDepth: 10.5, toDepth: 15.5, coreLength: 4.0 });
  assert(Number(merged2.footage) === 5, `进尺 = 5（实际 ${merged2.footage}）`);
  assert(Number(merged2.recovery) === 80, `采取率 = 4.0/5 = 80%（实际 ${merged2.recovery}）`);
}

console.log('场景6：只有对端改、本端无待办 → 字段级覆盖到本端现有值上');
{
  const localCurrent = { id: 'run-001', fromDepth: 10, toDepth: 15, coreLength: 4.5, remark: '本端已有备注' };
  const remoteChange = makeChange({
    nodeRole: 'field',
    record: { ...localCurrent, fromDepth: 12, toDepth: 17 },
    base: { ...localCurrent },
  });
  const outcome = mergePuts(remoteChange, undefined, localCurrent, 'field', 'desk');
  const r = outcome.record!;
  assert(Number(r.fromDepth) === 12, `深度取对端 12（实际 ${r.fromDepth}）`);
  assert(r.remark === '本端已有备注', `本端已有备注保留（实际 ${r.remark}）`);
  assert(Number(r.coreLength) === 4.5, `本端岩芯长度保留（实际 ${r.coreLength}）`);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
