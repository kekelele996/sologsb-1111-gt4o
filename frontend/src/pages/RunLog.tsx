import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { Link } from 'react-router-dom';
import StatBadge from '../components/common/StatBadge';
import RecoveryBadge from '../components/common/RecoveryBadge';
import DepthRangeInput from '../components/common/DepthRangeInput';
import EmptyPanel from '../components/common/EmptyPanel';
import { useDepthCalc } from '../hooks/useDepthCalc';
import { useHoleStore } from '../stores/holeStore';
import { useSyncStore } from '../stores/syncStore';
import { SHIFTS } from '../types/drill-hole';
import type { DrillRun, RunShift } from '../types/drill-run';
import { footageOf, recoveryOf, validateRange } from '../utils/recovery';

const { Title, Paragraph, Text } = Typography;

/** 表格显示行：编目台记录叠加待同步标记 */
type DisplayRun = DrillRun & { pendingKind?: 'upsert' | 'delete' };

interface RunFormValues {
  runNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  coreLength: number;
  waterLevel: number;
  shift: RunShift;
  drilledAt: Dayjs;
  recorder: string;
  remark?: string;
}

/** 回次记录：起止深度自动算进尺与采取率 */
export default function RunLog() {
  const { message } = AntApp.useApp();
  const holes = useHoleStore((s) => s.holes);
  const currentHoleId = useHoleStore((s) => s.currentHoleId);
  const setCurrentHole = useHoleStore((s) => s.setCurrentHole);
  const saveRun = useSyncStore((s) => s.saveRun);
  const removeRun = useSyncStore((s) => s.removeRun);
  const outbox = useSyncStore((s) => s.outbox);
  const { runsOf, summarize } = useDepthCalc();

  const [form] = Form.useForm<RunFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<DrillRun | null>(null);
  /** 深度区间以本地 state 为唯一数据源：避免 Form.useWatch 在弹窗首次挂载前读不到值 */
  const [range, setRange] = useState<{ from: number; to: number }>({ from: 0, to: 0 });
  const [liveCore, setLiveCore] = useState(0);

  const holeOptions = holes.map((hole) => ({ label: `${hole.holeNo} · ${hole.rigNo}`, value: hole.id }));
  const activeHoleId = currentHoleId || holes[0]?.id || '';
  const summary = useMemo(() => summarize(activeHoleId), [summarize, activeHoleId]);

  /** 当前孔的待同步操作（断网期间在现场平板上登记的） */
  const holePendingOps = useMemo(
    () => outbox.filter((op) => op.kind.startsWith('run.') && op.holeId === activeHoleId),
    [outbox, activeHoleId],
  );

  /** 待同步的回次登记内容（断网连续登记时，默认深度与重叠提示也要算入） */
  const pendingHoleRuns = useMemo(
    () =>
      holePendingOps
        .filter((op) => op.kind === 'run.upsert' && op.payload)
        .map((op) => op.payload as DrillRun),
    [holePendingOps],
  );

  /** 编目台记录 + 待同步叠加：断网登记的内容即时可见，未入台的标「待同步」 */
  const tableRuns = useMemo<DisplayRun[]>(() => {
    const opByEntity = new Map(holePendingOps.map((op) => [op.entityId, op]));
    const deskRows: DisplayRun[] = summary.runs.map((run) => {
      const op = opByEntity.get(run.id);
      if (!op) return run;
      if (op.kind === 'run.delete') return { ...run, pendingKind: 'delete' };
      return { ...(op.payload as DrillRun), pendingKind: 'upsert' };
    });
    const deskIds = new Set(summary.runs.map((run) => run.id));
    const queuedCreates: DisplayRun[] = holePendingOps
      .filter((op) => op.kind === 'run.upsert' && !deskIds.has(op.entityId))
      .map((op) => ({ ...(op.payload as DrillRun), pendingKind: 'upsert' }));
    return [...deskRows, ...queuedCreates].sort((a, b) => b.fromDepth - a.fromDepth);
  }, [summary.runs, holePendingOps]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    const hole = holes.find((h) => h.id === activeHoleId);
    const pendingReached = pendingHoleRuns.reduce((max, run) => Math.max(max, run.toDepth), 0);
    const nextFrom = Number(Math.max(summary.reachedDepth, pendingReached).toFixed(2));
    const nextTo = Number((nextFrom + 5).toFixed(2));
    const prefix = (hole?.holeNo ?? 'ZK').replace(/^ZK-/, '');
    setRange({ from: nextFrom, to: nextTo });
    setLiveCore(Number((5 * 0.9).toFixed(2)));
    form.setFieldsValue({
      runNo: `${prefix}-${String(summary.runCount + pendingHoleRuns.length + 1).padStart(2, '0')}`,
      holeId: activeHoleId,
      fromDepth: nextFrom,
      toDepth: nextTo,
      coreLength: Number((5 * 0.9).toFixed(2)),
      waterLevel: 15,
      shift: hole?.shift === '甲班' || hole?.shift === '乙班' || hole?.shift === '丙班' ? hole.shift : '甲班',
      drilledAt: dayjs(),
      recorder: '高振华',
    } as unknown as RunFormValues);
    setOpen(true);
  };

  const openEdit = (record: DrillRun) => {
    setEditing(record);
    setRange({ from: record.fromDepth, to: record.toDepth });
    setLiveCore(record.coreLength);
    form.setFieldsValue({
      runNo: record.runNo,
      holeId: record.holeId,
      fromDepth: record.fromDepth,
      toDepth: record.toDepth,
      coreLength: record.coreLength,
      waterLevel: record.waterLevel,
      shift: record.shift,
      drilledAt: dayjs(record.drilledAt),
      recorder: record.recorder,
      remark: record.remark,
    } as unknown as RunFormValues);
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const rangeError = validateRange(range.from, range.to);
    if (rangeError) {
      message.error(rangeError);
      return;
    }
    const payload = {
      runNo: values.runNo,
      holeId: values.holeId,
      fromDepth: range.from,
      toDepth: range.to,
      coreLength: Number(values.coreLength) || 0,
      waterLevel: Number(values.waterLevel) || 0,
      shift: values.shift,
      drilledAt: values.drilledAt.toISOString(),
      recorder: values.recorder,
      remark: values.remark,
    };
    const footage = footageOf(payload.fromDepth, payload.toDepth);
    const recovery = recoveryOf(payload.coreLength, footage);
    const result = await saveRun(payload, editing?.id);
    if (result.queued) {
      message.info(`已登记回次 ${payload.runNo}（待同步）：断网期间保存在本机队列，网络恢复后自动并入编目台`);
    } else {
      message.success(`${editing ? '已更新' : '已录入'}回次 ${payload.runNo}，进尺 ${footage}m，采取率 ${recovery}%`);
    }
    setOpen(false);
  };

  const handleRemove = async (record: DrillRun) => {
    const result = await removeRun(record.id);
    if (result.queued) {
      message.info(`删除回次 ${record.runNo} 已记入待同步队列，网络恢复后生效`);
    } else {
      message.success('已删除');
    }
  };

  const columns: TableColumnsType<DisplayRun> = [
    { title: '回次号', dataIndex: 'runNo', width: 110, render: (v: string) => <Text strong>{v}</Text> },
    {
      title: '状态',
      width: 90,
      render: (_, row) =>
        row.pendingKind === 'delete' ? (
          <Tag color="red">待删除</Tag>
        ) : row.pendingKind === 'upsert' ? (
          <Tag color="orange">待同步</Tag>
        ) : (
          <Tag color="green">已入台</Tag>
        ),
    },
    { title: '深度区间(m)', width: 140, render: (_, row) => `${row.fromDepth}~${row.toDepth}` },
    { title: '进尺(m)', dataIndex: 'footage', width: 100, align: 'right' },
    { title: '岩芯长度(m)', dataIndex: 'coreLength', width: 120, align: 'right' },
    { title: '采取率', dataIndex: 'recovery', width: 140, render: (v: number) => <RecoveryBadge recovery={v} showAdvice /> },
    { title: '回次水位(m)', dataIndex: 'waterLevel', width: 120, align: 'right' },
    { title: '班次', dataIndex: 'shift', width: 80 },
    { title: '钻进日期', dataIndex: 'drilledAt', width: 120, render: (v: string) => dayjs(v).format('YYYY-MM-DD') },
    { title: '记录人', dataIndex: 'recorder', width: 90 },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (v?: string) => v ?? '-' },
    {
      title: '操作',
      width: 140,
      fixed: 'right',
      render: (_, record) =>
        record.pendingKind ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            同步后可改
          </Text>
        ) : (
          <Space size={2}>
            <Button size="small" type="link" onClick={() => openEdit(record)}>
              编辑
            </Button>
            <Popconfirm title={`确认删除回次 ${record.runNo}？`} onConfirm={handleRemove.bind(null, record)}>
              <Button size="small" type="link" danger>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
    },
  ];

  const previewFootage = footageOf(range.from, range.to);
  const previewRecovery = recoveryOf(liveCore, previewFootage);

  /** 深度区间输入的参照回次：编目台记录 + 待同步登记（待同步编辑覆盖同 id 记录） */
  const watchedHoleId = Form.useWatch('holeId', form) ?? activeHoleId;
  const referenceRuns = useMemo(() => {
    const desk = runsOf(watchedHoleId);
    const pending = outbox
      .filter((op) => op.kind === 'run.upsert' && op.holeId === watchedHoleId && op.payload)
      .map((op) => op.payload as DrillRun);
    const pendingIds = new Set(pending.map((run) => run.id));
    return [...desk.filter((run) => !pendingIds.has(run.id)), ...pending];
  }, [runsOf, watchedHoleId, outbox]);

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        回次记录
      </Title>
      <Paragraph type="secondary">录入起止深度与岩芯长度，系统自动计算进尺与采取率；采取率低于 75% 立即标红并进入异常清单。</Paragraph>

      <Space style={{ marginBottom: 12 }} wrap>
        <span style={{ color: '#6b7a86' }}>当前钻孔</span>
        <Select style={{ width: 200 }} value={activeHoleId} onChange={setCurrentHole} options={holeOptions} placeholder="选择钻孔" />
        <Button type="primary" onClick={openCreate} disabled={!activeHoleId}>
          录入回次
        </Button>
        <Text type="secondary">
          深度覆盖：{summary.coverage.length ? summary.coverage.map((r) => `${r.from}~${r.to}m`).join('、') : '尚无回次'}
        </Text>
      </Space>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <StatBadge label="回次数" value={summary.runCount} unit="个" />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="累计进尺" value={summary.totalFootage} unit="m" />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge
            label="加权平均采取率"
            value={summary.averageRecovery}
            unit="%"
            status={summary.averageRecovery >= 90 ? 'success' : summary.averageRecovery >= 75 ? 'default' : 'error'}
          />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="异常回次（<75%）" value={summary.anomalyCount} unit="个" status={summary.anomalyCount ? 'error' : 'success'} />
        </Col>
      </Row>

      {holePendingOps.length > 0 ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message={`${holePendingOps.length} 条回次登记待同步：断网期间保存在本机队列，网络恢复后自动并入编目台`}
          action={
            <Link to="/sync">
              <Button size="small">去同步中心</Button>
            </Link>
          }
        />
      ) : null}

      {tableRuns.length === 0 ? (
        <EmptyPanel description="该孔暂无回次记录" actionText="录入回次" onAction={openCreate} />
      ) : (
        <Card size="small">
          <Table rowKey="id" size="small" columns={columns} dataSource={tableRuns} pagination={{ pageSize: 10 }} scroll={{ x: 1390 }} />
        </Card>
      )}

      <Modal open={open} title={editing ? `编辑回次 · ${editing.runNo}` : '录入回次'} onCancel={() => setOpen(false)} onOk={submit} okText="保存" cancelText="取消" width={720}>
        <Form
          form={form}
          layout="vertical"
          onValuesChange={(changed) => {
            if ('coreLength' in changed) setLiveCore(Number(changed.coreLength) || 0);
          }}
        >
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="runNo" label="回次号" rules={[{ required: true, message: '请输入回次号' }]}>
              <Input style={{ width: 160 }} maxLength={20} placeholder="如：2401-32" />
            </Form.Item>
            <Form.Item name="holeId" label="钻孔" rules={[{ required: true, message: '请选择钻孔' }]}>
              <Select style={{ width: 200 }} options={holeOptions} />
            </Form.Item>
            <Form.Item name="shift" label="班次" rules={[{ required: true, message: '请选择班次' }]}>
              <Select style={{ width: 120 }} options={SHIFTS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
          </Space>

          <Form.Item label="深度区间" required>
            <DepthRangeInput
              fromDepth={range.from}
              toDepth={range.to}
              referenceRuns={referenceRuns}
              ignoreRunId={editing?.id}
              maxDepth={holes.find((h) => h.id === watchedHoleId)?.designDepth}
              onChange={(patch) => {
                setRange((prev) => ({ ...prev, ...patch }));
                form.setFieldsValue(patch as unknown as RunFormValues);
              }}
            />
          </Form.Item>

          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="coreLength" label="岩芯长度(m)" rules={[{ required: true, message: '请输入岩芯长度' }]}>
              <InputNumber min={0} step={0.1} style={{ width: 160 }} placeholder="岩芯长度" />
            </Form.Item>
            <Form.Item name="waterLevel" label="回次水位(m)" rules={[{ required: true, message: '请输入回次水位' }]}>
              <InputNumber min={0} step={0.1} style={{ width: 160 }} placeholder="回次水位" />
            </Form.Item>
            <Form.Item name="drilledAt" label="钻进日期" rules={[{ required: true, message: '请选择钻进日期' }]}>
              <DatePicker style={{ width: 170 }} />
            </Form.Item>
            <Form.Item name="recorder" label="记录人" rules={[{ required: true, message: '请输入记录人' }]}>
              <Input style={{ width: 130 }} maxLength={16} placeholder="记录人" />
            </Form.Item>
          </Space>

          <Alert
            type={previewRecovery >= 75 ? 'success' : 'error'}
            showIcon
            message={
              <Space size={8}>
                <span>
                  自动计算：进尺 {previewFootage} m，采取率 {previewRecovery}%
                </span>
                <RecoveryBadge recovery={previewRecovery} showAdvice />
              </Space>
            }
            description={previewRecovery < 75 ? '采取率低于 75%，保存后该回次将进入工作台异常清单' : '采取率达标'}
          />

          <Form.Item name="remark" label="备注" style={{ marginTop: 12 }}>
            <Input.TextArea rows={2} maxLength={60} placeholder="岩芯破碎情况等" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
