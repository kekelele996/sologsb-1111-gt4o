import { useEffect, useState } from 'react';
import { Layout, Menu, Spin, Typography, App as AntApp, Button, Space, Tag, Badge, Switch, Tooltip } from 'antd';
import {
  CloudSyncOutlined,
  CompassOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  ProfileOutlined,
  BarsOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { seedIfEmpty } from './utils/seed';
import { downloadText, exportBackupJson } from './utils/export';
import { useHoleStore } from './stores/holeStore';
import { useRunStore } from './stores/runStore';
import { useBoxStore } from './stores/boxStore';
import { useLithoStore } from './stores/lithoStore';
import { useSyncStore } from './stores/syncStore';

const { Header, Sider, Content, Footer } = Layout;
const { Title, Text } = Typography;

const MENU_ITEMS = [
  { key: '/', icon: <CompassOutlined />, label: <Link to="/">工作台</Link> },
  { key: '/holes', icon: <DatabaseOutlined />, label: <Link to="/holes">钻孔台帐</Link> },
  { key: '/runs', icon: <BarsOutlined />, label: <Link to="/runs">回次记录</Link> },
  { key: '/boxes', icon: <ProfileOutlined />, label: <Link to="/boxes">岩芯箱</Link> },
  { key: '/lithology', icon: <ExperimentOutlined />, label: <Link to="/lithology">岩性编录</Link> },
  { key: '/sync', icon: <CloudSyncOutlined />, label: <Link to="/sync">同步中心</Link> },
];

/** 应用外壳：左侧导航 + 顶部网络状态与同步操作，负责一次性的本地数据装载 */
export default function App() {
  const { message } = AntApp.useApp();
  const [ready, setReady] = useState(false);
  const hydrateHoles = useHoleStore((s) => s.hydrate);
  const hydrateRuns = useRunStore((s) => s.hydrate);
  const hydrateBoxes = useBoxStore((s) => s.hydrate);
  const hydrateLithos = useLithoStore((s) => s.hydrate);
  const hydrateSync = useSyncStore((s) => s.hydrate);
  const online = useSyncStore((s) => s.online);
  const fieldMode = useSyncStore((s) => s.fieldMode);
  const setOnline = useSyncStore((s) => s.setOnline);
  const setFieldMode = useSyncStore((s) => s.setFieldMode);
  const pendingCount = useSyncStore((s) => s.outbox.length);
  const syncing = useSyncStore((s) => s.syncing);
  const sync = useSyncStore((s) => s.sync);
  const location = useLocation();
  const navigate = useNavigate();

  const offline = !online || fieldMode;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await seedIfEmpty();
        await Promise.all([hydrateHoles(), hydrateRuns(), hydrateBoxes(), hydrateLithos(), hydrateSync()]);
      } catch (error) {
        message.error(`本地数据装载失败：${(error as Error).message}`);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [hydrateHoles, hydrateRuns, hydrateBoxes, hydrateLithos, hydrateSync, message]);

  // 跟踪浏览器网络状态
  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setOnline]);

  // 网络恢复（或退出现场模式）后自动把待同步队列并入编目台
  useEffect(() => {
    if (!ready || offline) return;
    let alive = true;
    void sync().then((report) => {
      if (!alive || !report) return;
      const total = report.applied + report.merged + report.deleted;
      if (report.failed.length) {
        message.warning(`自动同步：${report.failed.length} 条并入失败，已留在队列中，请到同步中心重试`);
      } else if (total > 0) {
        message.success(`网络恢复，已自动同步：并入 ${report.applied} 条、冲突合并 ${report.merged} 条、删除 ${report.deleted} 条`);
      }
    });
    return () => {
      alive = false;
    };
  }, [ready, offline, sync, message]);

  const selectedKey =
    MENU_ITEMS.map((item) => item.key)
      .filter((key) => (key === '/' ? location.pathname === '/' : location.pathname.startsWith(key)))
      .sort((a, b) => b.length - a.length)[0] ?? '/';

  const handleExport = async () => {
    const json = await exportBackupJson();
    downloadText(`gbdrillcore-backup-${new Date().toISOString().slice(0, 10)}.json`, json);
    message.success('已导出 IndexedDB 全量 JSON 备份');
  };

  const handleSync = async () => {
    const report = await sync();
    if (!report) {
      message.warning('当前处于离线状态，网络恢复后再同步');
      return;
    }
    const total = report.applied + report.merged + report.deleted;
    if (report.failed.length) {
      message.warning(`同步完成：${report.failed.length} 条失败待重试（并入 ${report.applied} 条、冲突合并 ${report.merged} 条、删除 ${report.deleted} 条）`);
    } else if (total > 0) {
      message.success(`同步完成：并入 ${report.applied} 条、冲突合并 ${report.merged} 条、删除 ${report.deleted} 条`);
    } else {
      message.info('没有待同步的登记');
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
          <Space size={12}>
            <Text strong>矿区钻孔岩芯编目台</Text>
            {offline ? <Tag color="orange">离线 · 登记进入待同步队列</Tag> : <Tag color="green">在线</Tag>}
          </Space>
          <Space size={12}>
            <Tooltip title="模拟平板在孔口断网：开启后回次与岩芯箱登记进入待同步队列，关闭后自动同步">
              <Space size={4}>
                <Text type={fieldMode ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>现场模式</Text>
                <Switch size="small" checked={fieldMode} onChange={setFieldMode} />
              </Space>
            </Tooltip>
            <Badge count={pendingCount} size="small" offset={[-4, 4]}>
              <Button icon={<CloudSyncOutlined />} onClick={() => navigate('/sync')}>
                同步队列
              </Button>
            </Badge>
            <Button icon={<SyncOutlined />} loading={syncing} disabled={offline} onClick={handleSync}>
              立即同步
            </Button>
            <Button icon={<DownloadOutlined />} onClick={handleExport}>
              导出备份
            </Button>
          </Space>
        </Header>
        <Content style={{ padding: 16 }}>
          {ready ? (
            <Outlet />
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
              <Spin size="large" />
            </div>
          )}
        </Content>
        <Footer style={{ textAlign: 'center', color: '#8a99a5', padding: '12px 0' }}>
          数据保存在浏览器 IndexedDB（gbdrillcore-db），不依赖后端服务
        </Footer>
      </Layout>
    </Layout>
  );
}
