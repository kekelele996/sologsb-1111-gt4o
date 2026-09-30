import React from 'react';
import { useEffect, useState } from 'react';
import { Layout, Menu, Spin, Typography, App as AntApp, Button, Space, Badge, Tag, Switch, Tooltip } from 'antd';
import {
  CompassOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  ProfileOutlined,
  BarsOutlined,
  CloudSyncOutlined,
  DisconnectOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { seedIfEmpty } from './utils/seed';
import { downloadText, exportBackupJson } from './utils/export';
import { useHoleStore } from './stores/holeStore';
import { useRunStore } from './stores/runStore';
import { useBoxStore } from './stores/boxStore';
import { useLithoStore } from './stores/lithoStore';
import { syncEngine, useSyncStore } from './sync/engine';

const { Header, Sider, Content, Footer } = Layout;
const { Title, Text } = Typography;

const MENU_ITEMS = [
  { key: '/', icon: <CompassOutlined />, label: <Link to="/">工作台</Link> },
  { key: '/holes', icon: <DatabaseOutlined />, label: <Link to="/holes">钻孔台帐</Link> },
  { key: '/runs', icon: <BarsOutlined />, label: <Link to="/runs">回次记录</Link> },
  { key: '/boxes', icon: <ProfileOutlined />, label: <Link to="/boxes">岩芯箱</Link> },
  { key: '/lithology', icon: <ExperimentOutlined />, label: <Link to="/lithology">岩性编录</Link> },
  { key: '/sync', icon: <CloudSyncOutlined />, label: <Link to="/sync">离线同步</Link> },
];

/** 应用外壳：左侧导航 + 顶部导出备份 / 在线状态 / 待办同步，负责一次性的本地数据装载 */
export default function App() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const hydrateHoles = useHoleStore((s) => s.hydrate);
  const hydrateRuns = useRunStore((s) => s.hydrate);
  const hydrateBoxes = useBoxStore((s) => s.hydrate);
  const hydrateLithos = useLithoStore((s) => s.hydrate);
  const { online, node, pendingCount, busy } = useSyncStore();
  const location = useLocation();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await seedIfEmpty();
        await Promise.all([hydrateHoles(), hydrateRuns(), hydrateBoxes(), hydrateLithos()]);
        syncEngine.init();
        void syncEngine.refreshUi();
      } catch (error) {
        message.error(`本地数据装载失败：${(error as Error).message}`);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
      syncEngine.dispose();
    };
  }, [hydrateHoles, hydrateRuns, hydrateBoxes, hydrateLithos, message]);

  const selectedKey =
    MENU_ITEMS.map((item) => item.key)
      .filter((key) => (key === '/' ? location.pathname === '/' : location.pathname.startsWith(key)))
      .sort((a, b) => b.length - a.length)[0] ?? '/';

  const handleExport = async () => {
    const json = await exportBackupJson();
    downloadText(`gbdrillcore-backup-${new Date().toISOString().slice(0, 10)}.json`, json);
    message.success('已导出 IndexedDB 全量 JSON 备份');
  };

  const handleSyncNow = async () => {
    try {
      const { sent } = await syncEngine.syncNow();
      if (sent > 0) message.success(`已推送 ${sent} 条待办，等待对端响应并入`);
      else message.info('没有待同步变更；已向对端发起同步请求');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="0" width={204} style={{ background: '#2b3a46' }}>
        <div style={{ padding: '16px 16px 8px' }}>
          <Title level={5} style={{ color: '#fff', margin: 0 }}>
            钻孔岩芯编目台
          </Title>
          <Text style={{ color: '#9fb4c2', fontSize: 12 }}>gbdrillcore · 纯前端本地存储</Text>
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={MENU_ITEMS} style={{ background: 'transparent' }} />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text strong>矿区钻孔岩芯编目台</Text>
          <Space size={12}>
            <Tooltip title={online ? '在线：恢复联网后待办自动并入' : '离线：登记照常保存在本机，联网后并入'}>
              <Tag icon={online ? <CloudSyncOutlined /> : <DisconnectOutlined />} color={online ? 'success' : 'error'}>
                {online ? '在线' : '离线'}
              </Tag>
            </Tooltip>
            <Tag color={node.role === 'field' ? 'orange' : 'blue'}>{node.label}</Tag>
            <Tooltip title="孔口无网络演示开关：手动断网/联网">
              <Switch
                size="small"
                checked={!online}
                checkedChildren="断网"
                unCheckedChildren="联网"
                onChange={(v) => syncEngine.setManualOffline(v)}
              />
            </Tooltip>
            <Badge count={pendingCount} size="small" offset={[-2, 2]} color="#3b6c8f">
              <Button size="small" icon={<CloudSyncOutlined />} onClick={() => navigate('/sync')}>
                待同步
              </Button>
            </Badge>
            <Button size="small" type="primary" ghost icon={<CloudSyncOutlined />} loading={busy} onClick={handleSyncNow} disabled={!online}>
              立即同步
            </Button>
            <Button icon={<DownloadOutlined />} onClick={handleExport}>
              导出备份
            </Button>
          </Space>
        </Header>
        <Content style={{ padding: 16 }}>
          {!online ? (
            <div
              style={{
                background: '#fff7e6',
                border: '1px solid #ffd591',
                borderRadius: 6,
                padding: '8px 12px',
                marginBottom: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <DisconnectOutlined style={{ color: '#d48806' }} />
              <Text type="warning">
                当前离线：回次与岩芯箱登记照常保存在本机，恢复联网后自动并入地质组编目台。
              </Text>
            </div>
          ) : null}
          {ready ? (
            <Outlet />
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
              <Spin size="large" />
            </div>
          )}
        </Content>
        <Footer style={{ textAlign: 'center', color: '#8a99a5', padding: '12px 0' }}>
          数据保存在浏览器 IndexedDB（gbdrillcore-db），不依赖后端服务 · 离线登记联网后自动同步
        </Footer>
      </Layout>
    </Layout>
  );
}
