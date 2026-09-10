# DSH Desktop

[English](README.md) | 中文

`@deepseek-ai/dsh-desktop` 是签名 macOS 应用的私有 Electron 组装层。它沿用 `dsh web` 的客户端 bundle 图、React 组件、主题 token 和 Web UI 行为；该包通过 GitHub Releases 分发，而不发布到 npm。

## 运行时模型

Electron 主进程在固定 loopback 地址 `http://127.0.0.1:43121` 上启动已暂存的独立 `dsh web` 运行时，等待自己持有的子进程打印完全匹配的就绪行，再用加固的 `BrowserWindow` 打开该 URL。固定 origin 能让浏览器本地的草稿与外观状态在多次启动间保持稳定。端口冲突会使启动失败，不会连接到无关进程。每次启动还会创建新的 256-bit capability：Electron 把它注入发往该桌面专属 origin 的 HTTP 与 WebSocket 请求。Connection 在服务 index、分发 API 请求或打开 Gateway 的 `/api/remote.mux` WebSocket 前验证该值。桌面启动使用干净 URL，无需交换浏览器 token 或持久认证 cookie；普通 `dsh web` 保留自身的浏览器认证。

CLI 子进程把用户主目录作为初始工作目录。UI 中的 workspace 选择仍是指定项目目录的权威方式。桌面 bootstrap 会从私有匿名管道中一次性读取 capability、关闭该 descriptor，并在 Host 创建子进程前移除 Electron 的 Node 模式开关。退出应用会向子进程发送 `SIGTERM`，并在 CLI 的 5 秒关闭预算耗尽后升级为 `SIGKILL`；父进程 watchdog 还会在 Electron 异常退出后终止成为孤儿的 Host。

## 开发

启动 Electron 前先构建官方 Host 与 Web 产物：

```sh
pnpm run dev:desktop
```

使用以下命令构建未签名的本地 macOS 安装包：

```sh
pnpm run dist:desktop
```

`apps/desktop-runtime` 是打包 CLI 使用的私有 dependency-only 部署根目录。暂存脚本验证其运行时与平台闭包，通过 workspace 包注入和冻结的 lockfile 运行 pnpm 当前的生产 deploy，并把结果写入忽略提交的 `apps/desktop/runtime/` 目录。pnpm 依赖树可以保留内部 symlink，但暂存过程会拒绝每个断裂链接或指向该目录之外的目标。Electron Builder 把验证后的依赖树复制到应用 ASAR 之外，使原生工具保持可执行。

在 `hdiutil` 可用的普通 macOS 宿主上，该命令会把按架构区分的未签名 DMG 与 ZIP 写入 `apps/desktop/release/`。无法访问 `hdiutil` 设备的受限沙箱不能完成 DMG 目标；其中通过的 `.app` 或 ZIP 检查不代表已经生成 DMG。通过 Gatekeeper 分发和自动更新需要运行签名发布工作流。

### 打包应用启动检查

构建应用 bundle 后，运行匹配本机架构的启动检查：

```sh
pnpm --dir apps/desktop run verify:packaged-launch /path/to/DSH.app /path/to/new-evidence-directory
```

该检查启动真实 ASAR 主入口和已安装的 `electron-updater`，不填写 API key 即完成引导，并验证 Web UI、应用正常退出和后端端口释放。它使用临时主目录、日志和浏览器数据，阻止非 loopback 主机名解析，并保留 renderer sandbox 与 Content Security Policy。请先关闭其他 DSH 实例：`43121` 是产品固定端口，检查不会接管已有 listener。可选的证据目录保存截图和诊断文件，不覆盖已有文件。

发布工作流在提交 Apple 前检查已签名应用，并在创建草稿前检查最终更新 ZIP 中解压的应用。运行时覆盖范围是 runner 的原生架构；两个架构仍都会接受签名、公证与压缩包检查。无法初始化 macOS GUI 服务的宿主不能提供启动证据。独立的打包后端检查覆盖鉴权，但不执行 Electron 主入口或 updater 导入。

## 分发

桌面版本独立于 npm 的 `dsh-v*` 发布序列。版本与本包匹配的 `desktop-vX.Y.Z` tag 会启动 `.github/workflows/desktop-release.yml`；工作流对两个架构的构建执行签名与公证，并创建 GitHub Release 草稿。

`electron-updater` 解析仓库范围的最新 GitHub Release，不会按 tag 前缀过滤。因此，只要更新仍从 `asherhancong/deepseek-harness` 发布，该 fork 的 Releases 就必须专用于 `desktop-v*` 版本；如需在此发布无关 Release，应先把 updater 迁移到专用发布仓库。

| 产物 | 消费方 |
|---|---|
| `DSH-<version>-arm64.dmg` / `DSH-<version>-x64.dmg` | 用户安装 |
| 与架构匹配的 ZIP 和 blockmap 文件 | `electron-updater` 载荷与差分元数据 |
| `latest-mac.yml` | 自动更新查找、架构选择与校验和 |

受保护的 `desktop-release` environment 需要 `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_API_KEY_P8`、`APPLE_API_KEY_ID` 和 `APPLE_API_ISSUER`。两个文件内容 secret 分别保存经 base64 编码的 Developer ID Application `.p12` 与 App Store Connect `.p8`。工作流会把 Release 保留为草稿；维护者发布后，自动更新客户端才能看到它。

workspace 为 `@electron/osx-sign@1.3.3` 应用补丁，使其串行扫描实际文件，不沿 pnpm symlink 访问目标。安装发布依赖时须保留该补丁；[桌面分发决策](../../.agents/notes/implemented/architecture/2026-08-27-macos-electron-desktop-distribution.zh.md)记录了补丁范围与移除条件。

### 恢复公证

工作流把已签名 ZIP 和每个架构独立的 Apple 提交回执保存为 Actions 产物，保留 30 天。每次运行对每个架构最多等待 5 分钟。摘要为“Waiting for Apple”的成功运行只保留这些恢复资料，不创建 Release；必须两个架构都获接受后才会完成打包。

要继续处理，请在同一个 `desktop-v*` tag 上手动启动一次新的桌面工作流，并在 `resume_run_id` 中填写原始构建的 Actions run ID。只有新构建才留空该输入。恢复过程先核对原始仓库、工作流、提交、版本、压缩包哈希和回执 ID，再联系 Apple。它恢复原始应用，不重新构建、签名或提交，随后附加已接受的公证票据，并重新生成 DMG、更新 ZIP、blockmap 和校验和。

不要使用 GitHub 的“Re-run jobs”操作：工作流拒绝重复运行同一任务，以防重复提交。产物缺失或过期、tag 已移动，以及提交中断后未保存回执，都会使恢复停止。维护者必须先调查这些情况，再决定是否重新提交。恢复需要手动启动；工作流不会安排后台轮询。

## 安全性

renderer 不启用 Node 集成，使用 context isolation 和 Chromium sandbox，并且只能在自己持有的 loopback origin 内导航。应用拒绝新窗口；HTTP 与 HTTPS 链接交给系统浏览器打开。除主 frame 写入 Web UI 复制操作所需的已清理剪贴板外，权限请求默认拒绝。桌面专用响应策略保留现有模块启动和动态 CSS 流水线所需的 inline script 与 style 权限。每次启动的 capability 由 Electron session 与 Host bootstrap 持有；它不会出现在 renderer JavaScript、进程参数、环境变量或磁盘中，并且启动管道会在 Host 子进程能够继承前关闭。capability 校验叠加在既有 Host／Origin 浏览器信任栅栏之上，因此其他本机进程不能只凭 loopback 可达性获得授权。

## 限制

renderer 的 Content Security Policy 不包含 `unsafe-eval`。正常 Web 启动不编译 Loader 表达式；需要将 JavaScript 字符串作为代码执行的 renderer 扩展仍不受支持。Host 侧 YAML `!!js` 配置保留其表达式语义。

首个 macOS 发行版通过 loopback 子进程使用 Web 载体，而不是 `file://` 加 IPC。[桌面分发决策](../../.agents/notes/implemented/architecture/2026-08-27-macos-electron-desktop-distribution.zh.md)记录了初始发行版为何保留现有插件 bundle、Typert 和双向事件传输。Electron 44 要求 macOS 13 或更高版本。固定端口意味着 `43121` 上的其他 listener 会阻止启动，运行 DSH Desktop 前必须先停止该 listener。
