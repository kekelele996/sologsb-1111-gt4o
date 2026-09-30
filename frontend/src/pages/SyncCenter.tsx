import { useMemo } from 'react';
import { Alert, App as AntApp, Button, Card, Col, Popconfirm, Row, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { CloudSyncOutlined, RedoOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import { useHoleStore } from '../stores/holeStore';
import { useSyncStore } from '../stores/syncStore';
import { PENDING_OP_KIND_TEXT, type PendingOp, type SyncConflict } from '../types/sync';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';

const { Title, Paragraph, Text } = Typography;

const fmtTime = (iso: string) => dayjs(iso).format('MM-DD HH:mm:ss');

/** 冲突三方版本对比行 */
interface CompareRow {
  key: string;
  label: string;
  field: string;
  desk: string;
  merged: string;
  /** 入库值取自哪一边 */
  source?: 'field' | 'desk';
}

function runCompareRows(conflict: SyncConflict): CompareRow[] {
  const field = conflict.fieldVersion as DrillRun | null;
  const desk = conflict.deskVersion as DrillRun;
  const merged = conflict.merged as DrillRun | null;
  const f = (fn: (r: DrillRun) => string | number) => (field ? String(fn(field)) : '—（现场删除）');
  const m = (fn: (r: DrillRun) => string | number) => (merged ? String(fn(merged)) : '—（已删除）');
  return [
    { key: 'range', label: '深度区间(m)', field: f((r) => `${r.fromDepth}~${r.toDepth}`), desk: `${desk.fromDepth}~${desk.toDepth}`, merged: m((r) => `${r.fromDepth}~${r.toDepth}`), source: merged ? 'field' : undefined },
    { key: 'footage', label: '进尺(m)', field: f((r) => r.footage), desk: String(desk.footage), merged: m((r) => r.footage), source: merged ? 'field' : undefined },
    { key: 'core', label: '岩芯长度(m)', field: f((r) => r.coreLength), desk: String(desk.coreLength), merged: m((r) => r.coreLength), source: merged ? 'desk' : undefined },
    { key: 'recovery', label: '采取率(%)', field: f((r) => r.recovery), desk: String(desk.recovery), merged: m((r) => r.recovery), source: merged ? 'desk' : undefined },
    { key: 'water', label: '回次水位(m)', field: f((r) => r.waterLevel), desk: String(desk.waterLevel), merged: m((r) => r.waterLevel), source: merged ? 'field' : undefined },
    { key: 'shift', label: '班次', field: f((r) => r.shift), desk: desk.shift, merged: m((r) => r.shift), source: merged ? 'field' : undefined },
    { key: 'recorder', label: '记录人', field: f((r) => r.recorder), desk: desk.recorder, merged: m((r) => r.recorder), source: merged ? 'field' : undefined },
    { key: 'remark', label: '备注', field: f((r) => r.remark ?? '-'), desk: desk.remark ?? '-', merged: m((r) => r.remark ?? '-'), source: merged ? 'field' : undefined },
  ];
}

function boxCompareRows(conflict: SyncConflict): CompareRow[] {
  const field = conflict.fieldVersion as CoreBox | null;
  const desk = conflict.deskVersion as CoreBox;
  const merged = conflict.merged as CoreBox | null;
  const f = (fn: (b: CoreBox) => string | number) => (field ? String(fn(field)) : '—（现场删除）');
  const m = (fn: (b: CoreBox) => string | number) => (merged ? String(fn(merged)) : '—（已删除）');
  const src = merged ? ('field' as const) : undefined;
  return [
    { key: 'range', label: '深度区间(m)', field: f((b) => `${b.fromDepth}~${b.toDepth}`), desk: `${desk.fromDepth}~${desk.toDepth}`, merged: m((b) => `${b.fromDepth}~${b.toDepth}`), source: src },
    { key: 'slots', label: '格数 × 每格长', field: f((b) => `${b.slots} × ${b.slotLength}m`), desk: `${desk.slots} × ${desk.slotLength}m`, merged: m((b) => `${b.slots} × ${b.slotLength}m`), source: src },
    { key: 'shelf', label: '库架位', field: f((b) => b.shelfPos), desk: desk.shelfPos, merged: m((b) => b.shelfPos), source: src },
    { key: 'damaged', label: '破损格', field: f((b) => (b.damagedSlots.length ? b.damagedSlots.join(',') : '无')), desk: desk.damagedSlots.length ? desk.damagedSlots.join(',') : '无', merged: m((b) => (b.damagedSlots.length ? b.damagedSlots.join(',') : '无')), source: src },
    { key: 'operator', label: '装箱人', field: f((b) => b.operator), desk: desk.operator, merged: m((b) => b.operator), source: src },
    { key: 'remark', label: '备注', field: f((b) => b.remark ?? '-'), desk: desk.remark ?? '-', merged: m((b) => b.remark ?? '-'), source: src },
  ];
}

const compareColumns: TableColumnsType<CompareRow> = [
  { title: '字段', dataIndex: 'label', width: 110 },
  { title: '现场记录（平板）', dataIndex: 'field', width: 170 },
  { title: '编目台（地质组复核）', dataIndex: 'desk', width: 170 },
  {
    title: '入库结果（合并）',
    dataIndex: 'merged',
    render: (v: string, row) => (
      <Space size={6}>
        <Text strong>{v}</Text>
        {row.source === 'field' ? <Tag color="orange">取现场</Tag> : null}
        {row.source === 'desk' ? <Tag color="blue">取复核</Tag> : null}
      </Space>
    ),
  },
];

/** 同步中心：待同步队列、失败重试与冲突留档 */
export default function SyncCenter() {
  const { message } = AntApp.useApp();
  const holes = useHoleStore((s) => s.holes);
  const online = useSyncStore((s) => s.online);
  const fieldMode = useSyncStore((s) => s.fieldMode);
  const outbox = useSyncStore((s) => s.outbox);
  const conflicts = useSyncStore((s) => s.conflicts);
  const syncing = useSyncStore((s) => s.syncing);
  const lastReport = useSyncStore((s) => s.lastReport);
  const sync = useSyncStore((s) => s.sync);
  const retryOp = useSyncStore((s) => s.retryOp);
  const retryAll = useSyncStore((s) => s.retryAll);
  const discardOp = useSyncStore((s) => s.discardOp);

  const offline = !online || fieldMode;
  const holeNoOf = useMemo(() => {
    const map = new Map(holes.map((h) => [h.id, h.holeNo]));
    return (holeId: string) => map.get(holeId) ?? '未知孔';
  }, [holes]);

  const failedCount = outbox.filter((op) => op.status === 'failed').length;

  const notifyReport = (report: Awaited<ReturnType<typeof sync>>) => {
    if (!report) {
      message.warning('当前处于离线状态，网络恢复后再同步');
      return;
    }
    const total = report.applied + report.merged + report.deleted;
    if (report.failed.length) {
      message.warning(`同步完成：并入 ${report.applied} 条、冲突合并 ${report.merged} 条、删除 ${report.deleted} 条；${report.failed.length} 条失败，已留在队列中可重试`);
    } else if (total > 0) {
      message.success(`同步完成：并入 ${report.applied} 条、冲突合并 ${report.merged} 条、删除 ${report.deleted} 条`);
    } else {
      message.info('没有待同步的登记');
    }
  };

  const queueColumns: TableColumnsType<PendingOp> = [
    { title: '类型', width: 110, render: (_, op) => <Tag color={op.kind.endsWith('delete') ? 'red' : 'geekblue'}>{PENDING_OP_KIND_TEXT[op.kind]}</Tag> },
    { title: '编号', dataIndex: 'label', width: 120, render: (v: string) => <Text strong>{v}</Text> },
    { title: '钻孔', width: 100, render: (_, op) => holeNoOf(op.holeId) },
    {
      title: '深度区间(m)',
      width: 120,
      render: (_, op) => {
        const payload = op.payload;
        return payload ? `${payload.fromDepth}~${payload.toDepth}` : '—';
      },
    },
    { title: '登记时间', dataIndex: 'createdAt', width: 140, render: fmtTime },
    {
      title: '状态',
      width: 200,
      render: (_, op) =>
        op.status === 'failed' ? (
          <Space size={4} wrap>
            <Tag color="red">并入失败</Tag>
            <Text type="danger" style={{ fontSize: 12 }}>{op.lastError}</Text>
          </Space>
        ) : (
          <Tag color="orange">待同步</Tag>
        ),
    },
    { title: '已试次数', dataIndex: 'attempts', width: 90, align: 'right' },
    {
      title: '操作',
      width: 150,
      fixed: 'right',
      render: (_, op) => (
        <Space size={2}>
          <Button size="small" type="link" disabled={offline || syncing} onClick={() => retryOp(op.id).then(notifyReport)}>
            重试
          </Button>
          <Popconfirm title={`确认把 ${op.label} 移出待同步队列？该登记将不会并入编目台`} onConfirm={() => discardOp(op.id).then(() => message.success('已移出队列'))}>
            <Button size="small" type="link" danger>
              移出
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const conflictColumns: TableColumnsType<SyncConflict> = [
    { title: '合并时间', dataIndex: 'createdAt', width: 140, render: fmtTime },
    { title: '类型', width: 90, render: (_, c) => (c.entityKind === 'run' ? '回次' : '岩芯箱') },
    { title: '编号', dataIndex: 'label', width: 120, render: (v: string) => <Text strong>{v}</Text> },
    { title: '钻孔', width: 100, render: (_, c) => holeNoOf(c.holeId) },
    { title: '合并策略', dataIndex: 'strategy', ellipsis: true },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        同步中心
      </Title>
      <Paragraph type="secondary">
        钻探班组在孔口断网期间登记的回次与岩芯箱先存入本机队列，网络恢复后并入编目台；同一记录两边同时改动时按字段级规则合并，双方内容都留档，不整条覆盖。
      </Paragraph>

      <Alert
        style={{ marginBottom: 12 }}
        type={offline ? 'warning' : 'info'}
        showIcon
        message={offline ? '当前离线：登记会进入待同步队列，网络恢复后自动并入' : '当前在线：队列会自动并入编目台，也可手动立即同步'}
        description="回次冲突合并规则：深度区间取现场记录，岩芯长度取地质组复核值，进尺与采取率按合并结果重算；岩芯箱以现场最新登记为底并入。并入失败的操作留在队列中，可重试，不会留下半套数据。"
        action={
          <Space>
            {failedCount > 0 ? (
              <Button size="small" icon={<RedoOutlined />} disabled={offline || syncing} onClick={() => retryAll().then(notifyReport)}>
                失败全部重试
              </Button>
            ) : null}
            <Button size="small" type="primary" icon={<CloudSyncOutlined />} loading={syncing} disabled={offline} onClick={() => sync().then(notifyReport)}>
              立即同步
            </Button>
          </Space>
        }
      />

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <StatBadge label="待同步" value={outbox.length - failedCount} unit="条" status={outbox.length - failedCount ? 'warning' : 'success'} />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="并入失败" value={failedCount} unit="条" status={failedCount ? 'error' : 'success'} hint="留在队列中，可重试" />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="冲突留档" value={conflicts.length} unit="条" status={conflicts.length ? 'warning' : 'default'} hint="双方版本均保留" />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="上次同步" value={lastReport ? fmtTime(lastReport.syncedAt) : '—'} />
        </Col>
      </Row>

      <Card size="small" title={`待同步队列（${outbox.length}）`} style={{ marginBottom: 16 }}>
        {outbox.length === 0 ? (
          <EmptyPanel description="队列已清空：断网期间的登记都已并入编目台" />
        ) : (
          <Table rowKey="id" size="small" columns={queueColumns} dataSource={outbox} pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 1050 }} />
        )}
      </Card>

      <Card size="small" title={`冲突留档（${conflicts.length}）· 两边内容都保留，未整条覆盖`}>
        {conflicts.length === 0 ? (
          <EmptyPanel description="暂无冲突：尚未出现同一记录两边同时修改的情况" />
        ) : (
          <Table
            rowKey="id"
            size="small"
            columns={conflictColumns}
            dataSource={[...conflicts].reverse()}
            pagination={{ pageSize: 6, hideOnSinglePage: true }}
            scroll={{ x: 800 }}
            expandable={{
              expandedRowRender: (conflict) => (
                <Table
                  rowKey="key"
                  size="small"
                  columns={compareColumns}
                  dataSource={conflict.entityKind === 'run' ? runCompareRows(conflict) : boxCompareRows(conflict)}
                  pagination={false}
                />
              ),
            }}
          />
        )}
      </Card>
    </div>
  );
}
