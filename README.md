# 矿区钻孔岩芯编目台（gbdrillcore）

面向地质勘查钻探班组与地质编录员：登记钻孔台帐、回次进尺与采取率、岩芯箱箱位，并按深度区间编录岩性描述与样品。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

支持**离线登记与同步**：钻探班组把平板带到孔口，断网期间照常登记回次与岩芯箱（存入本机待同步队列），网络恢复后自动并入编目台；同一记录两边同时改动时按字段级规则合并，双方内容都留档。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21811>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | Ant Design 5 + @ant-design/icons |
| 路由 | React Router 6（6 条业务路由 + 404） |
| 状态 | Zustand（holeStore / runStore / boxStore / lithoStore / syncStore） |
| 存储 | IndexedDB（Dexie，库名 `gbdrillcore-db`） |
| 测试 | Vitest + fake-indexeddb（同步引擎行为测试） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21811
npm run build    # 类型检查 + 生产构建
npm test         # 同步引擎行为测试（合并规则 / 原子性 / 重试 / 队列压实）
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # drill-hole / drill-run / core-box / litho-log / sync
│       ├── stores/            # holeStore / runStore / boxStore / lithoStore / syncStore
│       ├── components/common/ # DepthRangeInput / RecoveryBadge / BoxGrid / LithoColumn / StatBadge / FilterBar / EmptyPanel
│       ├── hooks/             # useHoleFilter / useDepthCalc
│       ├── pages/             # HoleBoard / HoleList / RunLog / CoreBoxList / LithoEditor / SyncCenter
│       ├── router/index.tsx   # 路由表
│       └── utils/             # recovery.ts / db.ts / export.ts / syncEngine.ts（+ seed.ts / id.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 工作台 | 钻孔进度、设计达成率、未达设计待补勘清单、采取率异常清单（<75% 标红） |
| `/holes` | 钻孔台帐 | 建孔、坐标与孔口标高、设计/终孔深度、测斜数据、回次深度覆盖与岩芯箱数回显 |
| `/runs` | 回次记录 | 起止深度自动算进尺与采取率，低于 75% 立即标红并入异常清单；断网登记进待同步队列并即时可见 |
| `/boxes` | 岩芯箱编目 | 格位网格按深度填充、破损格标记、装箱深度连续性与格位容量校验；断网登记进待同步队列 |
| `/lithology` | 岩性编录 | 按深度区间编录岩性/蚀变/矿化/RQD/样品，区间重叠报冲突并高亮，SVG 岩性柱状图 |
| `/sync` | 同步中心 | 待同步队列（重试/移出）、失败原因、冲突留档（现场/编目台/入库三方版本对比） |

## 离线登记与同步

- **断网照登记**：浏览器离线（或顶栏开启「现场模式」模拟孔口断网）时，回次与岩芯箱的登记/删除进入本机 `outbox` 队列，列表中以「待同步」标记即时可见；同一记录的连续操作会压实为一条（新建后又删除则抵消）。
- **网络恢复自动同步**：监听浏览器 `online` 事件（或关闭现场模式）自动把队列并入编目台，也可在顶栏/同步中心手动「立即同步」。
- **冲突字段级合并**：同一回次两边几乎同时修改时——**深度区间取现场记录，岩芯长度取地质组复核值**，进尺与采取率按合并结果重算，其余字段以现场记录为底；岩芯箱以现场最新登记为底并入。双方原始版本与合并结果都写入 `conflicts` 留档，不整条覆盖。冲突判定基于每条记录的 `updatedAt` 版本戳与操作携带的基准版本。
- **失败可重试、不留半套数据**：每条操作在独立事务中并入（主表写入 + 冲突留档 + 出队同生共死），失败即整体回滚，操作留在队列中标记失败原因与次数，可单条或全部重试；单条失败不阻塞后续操作。
- **派生数据随同步刷新**：同步完成后自动重载回次与岩芯箱，岩芯箱深度连续性、岩性区间重叠提示、工作台覆盖率/达成率等派生数据一并刷新。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbdrillcore-db`），表：`holes`、`runs`、`boxes`、`lithos`、`outbox`、`conflicts`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为岩性表增加 `[holeId+fromDepth]` 复合索引并回填历史 RQD；`db.version(3).upgrade(...)` 新增 `outbox`/`conflicts` 表并为回次、岩芯箱回填 `updatedAt`/`rev` 版本戳。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入一批示例编目数据（`src/utils/seed.ts`，5 个钻孔 + 回次 + 岩芯箱 + 岩性区间）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。

