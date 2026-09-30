import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Input,
  Modal,
  Row,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { TableColumnsType, UploadProps } from 'antd';
import {
  ApiOutlined,
  CloudDownloadOutlined,
  CloudSyncOutlined,
  CloudUploadOutlined,
  DisconnectOutlined,
  ExportOutlined,
  ImportOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { syncEngine, useSyncStore } from '../sync/engine';
import type { ChangeEntry, SyncConflict, SyncResult } from '../sync/types';

const { Title, Paragraph, Text } = Typography;
const { TextArea } = Input;

const ENTITY_LABEL: Record<string, string> = { hole: '钻孔', run: '回次', box: '岩芯箱', litho: '岩性区间' };

/** 离线同步：断网登记、恢复联网并入、字段级冲突按规则合并、失败重试 */
export default function SyncPanel() {
  const { message, modal } = AntApp.useApp();
  const { online, node, pendingCount, busy, lastResult, conflicts, forceFail } = useSyncStore();
  const [pending, setPending] = useState<ChangeEntry[]>([]);
  const [importText, setImportText] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    await syncEngine.refreshUi();
    const rows = await syncEngine.buildPackage();
    setPending(rows.changes);
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [online, node.role]);

  const handleSyncNow = async () => {
    try {
      const { sent } = await syncEngine.syncNow();
      if (sent > 0) message.success(`已推送 ${sent} 条待办，等待对端响应并入`);
      else message.info('没有待同步变更；已向对端发起同步请求');
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const handleExport = async () => {
    const count = await syncEngine.exportPackage();
    message.success(`已导出同步包（${count} 条待办），请在驻地编目台导入`);
  };

  const handleImportFile: UploadProps['beforeUpload'] = (file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const result = await syncEngine.importPackageText(String(reader.result));
        reportResult(result);
        setImportOpen(false);
        setImportText('');
        await refresh();
      } catch (e) {
        message.error((e as Error).message);
      }
    };
    reader.readAsText(file);
    return false;
  };

  const handleImportText = async () => {
    if (!importText.trim()) {
      message.warning('请粘贴同步包 JSON 内容');
      return;
    }
    try {
      const result = await syncEngine.importPackageText(importText);
      reportResult(result);
      setImportOpen(false);
      setImportText('');
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const reportResult = (result: SyncResult) => {
    if (result.failed > 0) {
      modal.error({
        title: '并入失败，未写入任何数据',
        content: (
          <div>
            <Paragraph>
              {result.received} 条变更全部未并入（事务回滚，不留半套数据）。请修正后重试。
            </Paragraph>
            {result.errors.map((e) => (
              <Alert key={e.changeId} type="error" showIcon message={`变更 ${e.changeId}`} description={e.error} style={{ marginBottom: 8 }} />
            ))}
          </div>
        ),
        okText: '知道了',
      });
    } else {
      message.success(`并入成功：${result.merged} 条变更，字段级冲突 ${result.conflicts} 处（两边内容均已保留）`);
    }
  };

  const handleRetry = async () => {
    try {
      const result = await syncEngine.retryLast();
      reportResult(result);
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const handleSwitch = async (role: 'field' | 'desk') => {
    if (role === node.role) return;
    setSwitching(true);
    try {
      await syncEngine.switchNode(role);
      message.success(`已切换到${role === 'field' ? '现场班组平板' : '地质组编目台'}（独立数据副本）`);
      await refresh();
    } finally {
      setSwitching(false);
    }
  };

  const pendingColumns: TableColumnsType<ChangeEntry> = [
    { title: '类型', width: 90, render: (_, row) => ENTITY_LABEL[row.entityType] ?? row.entityType },
    { title: '记录 id', dataIndex: 'entityId', width: 200, ellipsis: true },
    {
      title: '操作',
      width: 90,
      render: (_, row) => (row.op === 'delete' ? <Tag color="red">删除</Tag> : <Tag color="blue">写入</Tag>),
    },
    { title: '时间', width: 170, render: (_, row) => dayjs(row.updatedAt).format('YYYY-MM-DD HH:mm:ss') },
    { title: '节点', width: 160, ellipsis: true, render: (_, row) => row.nodeRole === 'field' ? '现场平板' : '地质组台' },
    { title: '尝试', width: 70, dataIndex: 'attempts', align: 'right' },
    {
      title: '最近错误',
      ellipsis: true,
      render: (_, row) => (row.lastError ? <Text type="danger">{row.lastError}</Text> : <Text type="secondary">—</Text>),
    },
  ];

  const conflictColumns: TableColumnsType<SyncConflict> = [
    { title: '时间', width: 170, render: (_, row) => dayjs(row.at).format('YYYY-MM-DD HH:mm:ss') },
    { title: '类型', width: 90, render: (_, row) => ENTITY_LABEL[row.entityType] ?? row.entityType },
    { title: '记录 id', dataIndex: 'entityId', width: 180, ellipsis: true },
    { title: '冲突字段', dataIndex: 'field', width: 120, render: (v: string) => (v === '__all__' ? '整条记录' : v) },
    {
      title: '现场记录值',
      width: 160,
      ellipsis: true,
      render: (_, row) => (row.fieldValue == null ? '—' : String(row.fieldValue)),
    },
    {
      title: '地质组复核值',
      width: 160,
      ellipsis: true,
      render: (_, row) => (row.deskValue == null ? '—' : String(row.deskValue)),
    },
    {
      title: '采用规则',
      width: 170,
      render: (_, row) =>
        row.field === '__all__' ? (
          <Tag color="orange">修改优先于删除</Tag>
        ) : row.adopted === 'field' ? (
          <Tag color="green">深度区间认现场</Tag>
        ) : (
          <Tag color="purple">岩芯长度认复核</Tag>
        ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        离线同步
      </Title>
      <Paragraph type="secondary">
        孔口无网络时，回次与岩芯箱登记照常保存在本机（IndexedDB）；恢复联网后自动并入。同一条回次两边几乎同时修改时，深度区间认现场记录、岩芯长度认地质组复核值，字段级合并、两边内容都保留；并入失败可重试，事务回滚不留半套数据。
      </Paragraph>

      {!online ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          icon={<DisconnectOutlined />}
          message="当前处于离线状态"
          description="登记、编辑操作照常保存在本机，待办变更将在恢复联网后自动并入地质组编目台。"
        />
      ) : null}

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={12}>
          <Card size="small" title="网络与节点">
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="网络状态">
                <Space>
                  <Badge status={online ? 'success' : 'error'} text={online ? '在线' : '离线'} />
                  <Switch
                    size="small"
                    checked={!online}
                    checkedChildren="断网演示"
                    unCheckedChildren="联网"
                    onChange={(v) => syncEngine.setManualOffline(v)}
                  />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    （演示孔口无网络场景）
                  </Text>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="当前节点">
                <Space>
                  <Tag color={node.role === 'field' ? 'orange' : 'blue'}>{node.label}</Tag>
                  <Text code style={{ fontSize: 12 }}>
                    {node.nodeId}
                  </Text>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="待同步变更">
                <Badge count={pendingCount} showZero color="#3b6c8f" />
              </Descriptions.Item>
            </Descriptions>
            <Space wrap style={{ marginTop: 8 }}>
              <Button
                size="small"
                type={node.role === 'desk' ? 'primary' : 'default'}
                onClick={() => handleSwitch('desk')}
                loading={switching && node.role !== 'desk'}
              >
                地质组编目台
              </Button>
              <Button
                size="small"
                type={node.role === 'field' ? 'primary' : 'default'}
                onClick={() => handleSwitch('field')}
                loading={switching && node.role !== 'field'}
              >
                切换到现场平板
              </Button>
              <Button size="small" icon={<ApiOutlined />} onClick={() => syncEngine.openPeer(node.role === 'field' ? 'desk' : 'field')}>
                打开对端设备窗口
              </Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="同步操作">
            <Space wrap>
              <Button type="primary" icon={<CloudSyncOutlined />} onClick={handleSyncNow} loading={busy} disabled={!online}>
                立即同步
              </Button>
              <Button icon={<ExportOutlined />} onClick={handleExport} disabled={pendingCount === 0}>
                导出同步包
              </Button>
              <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
                导入同步包
              </Button>
              {lastResult && lastResult.failed > 0 ? (
                <Button danger icon={<ReloadOutlined />} onClick={handleRetry}>
                  重试并入
                </Button>
              ) : null}
            </Space>
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              「立即同步」通过浏览器通道与对端设备窗口实时并入；也可导出 JSON 同步包，在驻地编目台导入。
            </Paragraph>
          </Card>
        </Col>
      </Row>

      {lastResult && lastResult.failed === 0 && lastResult.merged > 0 ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="success"
          showIcon
          icon={<CloudDownloadOutlined />}
          message={`上次并入成功：${lastResult.merged} 条变更，字段级冲突 ${lastResult.conflicts} 处`}
          description={
            lastResult.refreshed ? (
              <Space wrap size={16}>
                <Text>回次 {lastResult.refreshed.runs} 条（进尺/采取率已重算）</Text>
                <Text type={lastResult.refreshed.boxesWithGaps ? 'warning' : 'secondary'}>
                  岩芯箱连续性断档 {lastResult.refreshed.boxesWithGaps} 个
                </Text>
                <Text type={lastResult.refreshed.lithoConflicts ? 'danger' : 'secondary'}>
                  岩性区间重叠 {lastResult.refreshed.lithoConflicts} 处
                </Text>
                <Text type={lastResult.refreshed.belowDesign ? 'danger' : 'secondary'}>
                  未达设计待补勘 {lastResult.refreshed.belowDesign} 孔
                </Text>
                <Text type={lastResult.refreshed.anomalies ? 'danger' : 'secondary'}>
                  采取率异常 {lastResult.refreshed.anomalies} 条
                </Text>
              </Space>
            ) : undefined
          }
        />
      ) : null}

      <Card
        size="small"
        title={`待同步变更（${pending.length}）`}
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              同一实体的多次离线改动已合并为一条净变更
            </Text>
          </Space>
        }
      >
        <Table
          rowKey="id"
          size="small"
          columns={pendingColumns}
          dataSource={pending}
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
          locale={{ emptyText: '没有待同步变更' }}
        />
      </Card>

      <Card size="small" title="字段级冲突记录（两边各持的值均保留）" style={{ marginBottom: 16 }}>
        <Table
          rowKey="id"
          size="small"
          columns={conflictColumns}
          dataSource={conflicts}
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
          locale={{ emptyText: '暂无冲突记录' }}
        />
      </Card>

      <Card size="small" title="演示与故障注入">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space>
            <Switch checked={forceFail} onChange={(v) => syncEngine.setForceFail(v)} />
            <Text>下次并入故意失败（模拟事务写入失败）</Text>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            开启后导入/同步会返回失败且不写入任何数据（可重试）；关闭后重试即成功，用于验证「并入失败可重试、不留半套数据」。
          </Text>
        </Space>
      </Card>

      <Modal
        title="导入同步包"
        open={importOpen}
        onCancel={() => {
          setImportOpen(false);
          setImportText('');
        }}
        onOk={handleImportText}
        okText="并入"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Upload beforeUpload={handleImportFile} accept="application/json,.json" showUploadList={false}>
            <Button icon={<CloudUploadOutlined />}>选择同步包 JSON 文件</Button>
          </Upload>
          <Text type="secondary" style={{ fontSize: 12 }}>
            或将同步包 JSON 内容粘贴到下方：
          </Text>
          <TextArea rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"app":"gbdrillcore-sync", ...}' />
        </Space>
      </Modal>

      <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} />
    </div>
  );
}
