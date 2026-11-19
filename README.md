# Workitem 工单（x-hub 扩展）

把本地 **workitem**（Git 工单工具，`D:\TimeMachine\sr_workitem`）接进 x-hub：

- **x-hub 启动即自动拉起 workitem 服务**（探测 `http://127.0.0.1:4777/api/health`，没跑就用仓库里的 `workitems_ui/server.js` 拉起来）；
- 侧栏「Workitem 工单」点开，**工作区里直接显示 workitem 界面**（真前端，不是弹窗、不是精简版）；
- 界面左栏多一个 **全部** 页签：布局与个人视图一致，显示所有人的工单，可按执行人筛选（默认所有人），并隐藏「快捷 / 创建工单」；
- 面板里能看到服务状态、仓库路径、最近同步、Git 可用性，可查看启动日志、改仓库路径/端口/打开方式。

## 为什么是「同源副本」而不是内嵌网页

x-hub 给扩展页下发的 CSP 是 `frame-src 'none'`，并且宿主页面本身限制了 frame 导航：实测把扩展页 `location.replace` 到 `http://127.0.0.1:4777` 会被拦成「已阻止此内容」，iframe 更不用说。

所以改成**同源**方案：

1. 扩展后端把仓库里的 `workitems_ui/public/` 同步到扩展自己的 `web/` 目录（同源静态文件，CSP 允许）；
2. 同步时往 `web/index.html` 注入 `xhub-shim.js`（在 `app.js` 之前执行）；
3. shim 把前端对 `/api/*`、`/attachments/*` 的 `fetch` 改走 x-hub 桥 → 扩展后端 → `127.0.0.1:4777`；
   图片/视频的 `/attachments/*` 地址被换成 `blob:` URL；
4. 面板页确认服务在线后 `location.replace('../web/index.html')`——同源导航，宿主一定放行。

好处：界面就是 workitem 当前版本（每次进来自动同步一次），不改 workitem 仓库任何文件，也不需要把前端打进发布包（`web/` 是可再生的生成物）。

## 安装（源码直挂，改代码自动重载）

1. x-hub → 扩展中心 →「**我的扩展**」→ 添加本目录（须含 `manifest.json`）；
2. 打开**扩展详情 → 权限 → 允许「运行本地后端」**（service 扩展必需，否则后端不会启动）；
3. 像「粘贴库」那样把本扩展**固定到侧栏**（侧栏出现蓝色看板图标）；
4. 可选：打开「**随应用启动**」+「**常驻后台**」，让每次启动 x-hub 都先拉起后端。

> 实测 x-hub 0.9.10 启动时会自动拉起 service 后端（日志 `service 扩展已启动: com.mangrids.workitem`），所以「打开 x-hub 自动启动 workitem」默认就成立，不必额外配置。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `repoPath` | `D:\TimeMachine\sr_workitem` | workitem 仓库根（要有 `workitems_ui/server.js` 与 `manager_agent/node_modules`） |
| `uiPort` | `4777` | 网页服务端口 |
| `openMode` | `inline` | `inline` = 工作区同源副本；`window` = x-hub 内置浏览器窗口 |

面板「设置」里可直接改，也支持扩展设置里的 `config`。

## 「全部」页签怎么实现的

workitem 仓库一行没改，全部在扩展侧注入（`assets/xhub-allview.js`，同步时加进 `web/index.html` 末尾）：

- 在左栏「甘特」下面插一个 `全部` 入口，点它把 `state.activeModule` 切到个人视图、并重新拉全量数据；
- 覆盖 `isAssignedToActor`：在「全部」模式下按执行人下拉过滤（空 = 所有人），所以复用个人视图的整套分区/表格/排期渲染；
- 头部标题改「全部工单」，隐藏 `#qcEmbedBtn`（快捷）与 `#personalCreateBtn`（创建工单）；
- 加一个「执行人」下拉（默认所有人，选择记在 localStorage），被页面重渲染时自动补回；
- **每个分区首屏只渲染 30 行**，分区底部给「加载全部 N 条」，点开渲染整个分区；展开后可「收起」；
- 点回「个人 / 迭代 / 甘特」时用捕获阶段先退出「全部」，恢复标题与按钮。

> 只在扩展里生效；直接用浏览器开 `127.0.0.1:4777` 还是原来的三个页签。

## 为什么列表不再卡（0.4.2）

| 问题 | 处理 |
|---|---|
| `/api/workitems?limit=20000` 一次 7.3 MB，过桥后页面要 5 秒 | 后端对超过 128 KB 的文本响应 gzip + base64，包体 8.2 MB → 1.0 MB，页面用 `DecompressionStream` 还原 |
| 每次进「全部」都重拉 | `GET /api/workitems*` 缓存 20 秒；后端启动后预热一次 |
| 来回切视图又拉一遍 | 「全部」视图 30 秒内复用内存里的全量数据 |

实测：冷调用约 2.1 s（workitem 自己冷启动那一次），命中缓存 18–95 ms。
## 同步为什么不触发宿主热重载循环

`web/` 在扩展目录里，宿主会监控开发目录做热重载。所以同步改成**只在内容变化时写盘**：

- 用 `.data/site-manifest.json` 记录源文件 size/mtime，未变就跳过；
- `index.html` 由源文件 + 注入标签**生成后与现有内容比对**，相同就不写；
- shim / allview 两个脚本也按内容比对。

这样重复进入扩展只做 stat，不写文件，不会出现「写入 → 热重载 → 再写入」的循环。

## 工作原理

```
x-hub 启动
  └─ 宿主拉起 service/index.js
       ├─ GET http://127.0.0.1:4777/api/health
       │    ├─ 通  → 复用（你自己开的服务也一样）
       │    └─ 不通 → spawn(node workitems_ui/server.js, detached, WORKITEMS_UI_NO_OPEN=1)
       └─ 同步 <repo>/workitems_ui/public → <扩展>/web，并注入 shim
点侧栏图标
  └─ 面板 ensure + /api/sync → location.replace('../web/index.html')
       └─ 页面里的 fetch('/api/…') 经 shim → 后端 /api/proxy → 4777
```

- workitem 服务是 **detached** 独立进程：x-hub 退出后继续跑，下次启动直接复用；扩展后端重启不会杀掉它。
- 后端拉起时必须覆盖 `WORKITEMS_UI_PORT` 并清掉宿主注入的 `PORT`（`server.js` 会读 `process.env.PORT`）。
- `web/` 是**生成物**：可随时删除，下次进入自动重建。发布打包前建议删掉，避免把 1.3MB 前端副本打进去。

## 接口（扩展内部用）

| 路径 | 说明 |
|---|---|
| `GET /healthz` | 宿主健康检查 |
| `GET /api/status` | 探测 + 当前快照（状态/地址/仓库/健康/前端副本信息） |
| `POST /api/ensure` | 触发一次「确保在跑」，立即返回，页面轮询 status |
| `POST /api/sync` | 同步 `workitems_ui/public` → `web/`，注入 shim 与「全部」脚本 |
| `POST /api/proxy` | 代理 `/api/*`、`/attachments/*` 到 4777（文本 utf8 / 二进制 base64） |
| `GET /api/logs` | workitem 服务 stdout/stderr 尾部 |

## 排错

1. 扩展后端没起来：看 `<数据根>\logs\service\com.mangrids.workitem.log`（本机 `D:\x-hub-0.9.7-win-x64`）。
2. workitem 服务起不来：面板「查看日志」，或 `<扩展目录>/.data/logs/workitems-ui.err.log`。
3. 端口被占：`/api/status` 会明说「端口 4777 已被其它进程占用，但不是可用的 workitem 服务」。
4. 依赖缺失：`manager_agent/node_modules` 不存在时后端直接报错，去仓库根执行 `npm install`。
5. 工作区里界面空白/报「无法连接工单服务」：多半是同源副本页没拿到桥，会自动退回 `?nobridge=1` 改窗口打开；把现象反馈给作者。

## 已知边界

- 只代理 `/api/*` 与 `/attachments/*`；workitem 的导出下载类链接在 x-hub 里可能打不开（宿主拦截新窗口）。
- 附件图片走 base64 过桥，大图首次显示比浏览器里慢一点。
- 同步是「按需 + 启动时」，workitem 前端更新后重新进一次（或点「重新同步并打开」）即可。
- 侧栏入口固定、顺序由你在 x-hub 里调；本扩展不改宿主配置。
