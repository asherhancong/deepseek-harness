# Agent Note: macOS Electron 桌面分发

Status: implemented

[English](2026-08-27-macos-electron-desktop-distribution.md) | 中文

## 问题

DSH 需要一个可安装的 macOS 客户端：它沿用 Web 产品的 UI 与客户端插件行为，无需终端即可启动完整的本地 Host，并且能够接收签名更新。现有浏览器组合把客户端 bundle 发现、HTML 启动注入、Typert Remote 调用和多路复用 WebSocket 绑定到 `dsh-host-webserver`；如果首个桌面安装包必须先替换每一种载体，安装包交付就会依赖第二套协议实现。

npm 发布序列把应用包视为公开且版本锁定的产物，而 DMG 应用需要独立版本、签名凭据、公证、架构产物和 GitHub 更新元数据。

## 决策

`apps/desktop` 是 npm DSH 发布序列之外的私有 pnpm workspace 应用。它拥有独立版本和 `desktop-v*` GitHub Release 工作流。仓库仍把它视为官方运行时，因此禁止实验性运行时依赖的常规规则继续生效。

Electron 主进程持有一个运行于 `127.0.0.1:43121` 的 `dsh web` 子进程。它通过进入 Node 模式的 Electron 可执行文件启动已构建 CLI，只接受该子进程完全匹配的 URL 就绪通知，然后在 `BrowserWindow` 中加载该 URL。固定 origin 保留由 localStorage 支持的草稿和外观状态。端口已有 listener 时会明确启动失败；应用绝不探测并接管现有服务器。

Loopback 可达性不是桌面授权边界。主进程每次启动都会生成新的 256-bit capability，并只把它交给后端 bootstrap 与 Electron session。它通过私有的一次性管道跨越进程边界，而不进入 argv、环境变量或磁盘。桌面专用 Cordis overlay 配置 Connection Host，让它在 HTML 入口、自己持有的每条 HTTP route 与 Gateway WebSocket upgrade 上要求该 capability。桌面就绪通知使用干净的 loopback URL，不在 URL 或日志中包含浏览器登录 token。Electron 的请求层会在发往准确桌面 origin 的请求上以可信值替换 renderer 提供的任何同名 header，从而同时覆盖 `/api` 与专用 Connection RPC route；capability 从不进入页面 JavaScript。普通 `dsh web` 不应用该 overlay，并保留上游的一次性浏览器登录与 session cookie 鉴权。

`apps/desktop-runtime` 是仅用作桌面部署根目录的私有 dependency-only pnpm workspace。它的 manifest 提供 CLI 以及每个已发布 agent preset 所需的 workspace 依赖；平台 manifest 选择 macOS arm64 与 x64 的原生变体。运行时闭包验证会拒绝该根目录无法提供的 workspace 运行时依赖或必需对等依赖（peer dependency）。

`prepare-runtime.mjs` 使用 pnpm 当前的 `deploy --prod --frozen-lockfile`，启用 `inject-workspace-packages`，把隔离的生产依赖树暂存到忽略提交的 `apps/desktop/runtime/` 目录。暂存检查只允许每个链接都解析到该目录内的 pnpm 内部 symlink；断裂或越出目录的链接会使构建失败。Electron Builder 把验证后的依赖树复制到 ASAR 外的 `Contents/Resources/dsh-runtime`，使原生可执行文件与 addon 保持可执行，并让 pnpm 依赖布局继续可解析。

workspace 为 Electron Builder 所用的 `@electron/osx-sign@1.3.3` 文件扫描逻辑应用补丁，覆盖该包分发的两种 JavaScript 格式。扫描逻辑使用 `lstat` 并串行遍历，跳过 symlink，同时继续发现实际二进制文件以及嵌套的 `.app` 和 `.framework` 目录。这避免了重复遍历 pnpm 链接，以及无限并发打开文件导致的 `EMFILE`。暂存过程仍验证链接；签名仍覆盖链接指向的实际目标。只有兼容的签名依赖同时提供这两项行为并通过桌面扫描回归测试后，才能移除补丁。

此桌面发行版是 [Web 启动与传输分层决策](2026-07-24-web-config-tree-boot-and-transport-layering.zh.md)中 IPC 方向的明确例外。它复用现有 Web 载体，因此同一套启动图、动态客户端 bundle、通用 Typert route、一元 API 验证、WebSocket 流、主题和 React 组件能够原样运行。现有客户端传输钩子仍允许未来实现 IPC 载体，但已发布的桌面应用不包含该实现。

窗口禁用 Node 集成和 WebView 附加，启用 context isolation、Chromium sandbox 与 Web 安全，并把顶层导航限制在自己持有的准确 origin。应用拒绝新窗口；只有 HTTP 和 HTTPS 目标可以交给系统浏览器。renderer 权限默认拒绝，唯一例外是该 origin 主 frame 的已清理剪贴板写入。桌面响应策略保留 inline script 与 style 执行，因为当前 HTML 启动注入和客户端 bundle CSS 需要它们。Host／Origin 检查仍是在桌面 capability 校验之下独立工作的 DNS rebinding 与跨站栅栏。

应用关闭时向自己持有的子进程发送 `SIGTERM`，并在 5 秒后升级为 `SIGKILL`。bootstrap 会同步读取并关闭私有启动管道，移除 `ELECTRON_RUN_AS_NODE`，然后才导入 CLI，因此 Host 子进程既不会继承该 descriptor，也不会继承 Electron 的 Node 模式开关。它的父进程 watchdog 会在 Electron 未执行正常关闭便消失时退出后端。应用把启动失败和就绪后的异常退出报告为原生错误，不会让 Web 客户端的重连循环持续连接已经停止的 Host。子进程把用户主目录作为明确的初始工作目录；项目选择仍由 Web workspace UI 持有。

Electron Builder 为 arm64 和 x64 分别生成 DMG 与 ZIP 目标。DMG 是安装产物；ZIP、blockmap 和 `latest-mac.yml` 与它一同发布，供 `electron-updater` 使用。受保护的 macOS 工作流要求 Developer ID 签名与 App Store Connect team key 公证，验证应用 bundle 和更新产物，并创建 Release 草稿。发布该草稿是自动更新可见性的边界。

签名与公证分成可持久恢复的阶段。Electron Builder 先生成包含 updater 配置的已签名 ZIP，不隐式执行公证。在提交 Apple 之前，工作流保留两个 ZIP 及绑定哈希的检查点；每次提交意图以排他方式创建，返回的回执分别上传。每个架构每次等待 Apple 的时间限制为 5 分钟。新启动的手动运行只有在仓库、工作流、提交、tag、版本、哈希与提交身份全部匹配时，才能恢复原始运行的产物。回执缺失时会停止，不会自动重新提交。

两个提交均获接受后，工作流解压这些原始应用、验证签名、附加并验证公证票据，再使用不重新签名的 prepackaged 目标重新生成安装包与更新压缩包。各架构输出在合并更新清单前保持隔离，保留每个 blockmap 字段和 x64 旧式查找信息。公证仍在等待时只生成恢复摘要，不生成 Release 草稿。

GitHub updater provider 会解析仓库范围的最新 Release，不会按 `desktop-v*` 过滤。在 fork `asherhancong/deepseek-harness` 仍作为更新仓库期间，其 Releases 因而专用于桌面发布序列。若要在该仓库发布其他序列，必须先把桌面更新迁移到专用仓库。

Loader 只在调用 `evaluate()` 时创建并缓存表达式求值器，而不在模块加载时创建。这让 Web 入口可以在桌面策略下初始化，无需添加 `unsafe-eval`。Host 侧 YAML 表达式保留上下文查找、返回值和错误传播；显式编译 JavaScript 字符串的 renderer 功能仍受 CSP 约束。

ESM 主入口通过 CommonJS 默认导出导入 `electron-updater`，再读取 `autoUpdater`。该依赖使用 getter 暴露此属性，Node 的具名导出检测无法识别。生命周期 mock 不能证明原生模块链接兼容性。

## 验证

updater 互操作回归测试在原生 Node ESM 中把源码中的导入连接到真实依赖，不调用仅限 Electron 的初始化。打包启动检查执行真实 ASAR 主入口，完成全新且无需 key 的引导，观察已渲染 Web UI 与 renderer 错误，并要求进程正常退出且后端端口释放。仅对子进程生效的临时主目录、日志、DSH 状态和浏览器数据隔离用户文件；启动前阻止非 loopback 主机名解析，防止下载更新。检查不削弱 renderer 安全，也不替换 updater。发布 CI 在提交 Apple 前检查原生架构的已签名应用，在创建草稿前检查最终原生架构 ZIP；另一架构保留静态签名与压缩包验证，不声称具有运行时覆盖。

启动路径回归测试解析实际文件系统目标，接受 macOS 别名，同时拒绝不存在的路径和越界 symlink。主入口生命周期回归测试分别控制 Electron 就绪与后端完成：退出会阻止迟到的后端创建、窗口和更新检查；关闭引起的就绪拒绝保持静默，真实启动失败仍会报告错误。这些检查覆盖启动与退出，不调用模型，也不改变录制会话。

桌面 Loader 回归测试在隔离的 JavaScript realm 中执行真实源码。测试检查禁用字符串代码生成时的初始化与字面量插值、该限制下实际表达式求值被拒绝，以及不受此限制的类 Host realm 中的表达式行为。

桌面签名回归测试通过 Electron Builder 解析并执行已安装的文件扫描逻辑。测试覆盖实际二进制文件发现、嵌套 bundle 顺序、symlink 排除、遗留 `.cstemp` 清理、文件系统错误，以及包含 1,024 个文件时元数据与二进制检测始终各自最多执行一个操作。这些检查不需要签名凭据，在发布工作流准备凭据之前运行。

发布状态回归测试拒绝来源不符的运行、变化的压缩包、缺失或不匹配的回执、不确定的重复提交、未知 Apple 状态和无效更新清单。基于真实文件系统的测试模拟一次等待运行，以及随后同一组回执 ID 获接受的响应。工作流测试要求提交前保留检查点，并在生成每项最终产物及草稿前要求两个架构均获接受；负向对照确认移除接受条件会使测试失败。真实 Apple 接受与最终 DMG 验证仍由 macOS CI 持有。

单元测试固定了分片就绪解析、近似 URL 拒绝、启动超时与提前退出诊断、有界子进程关闭、父进程丢失处理、启动环境清理、桌面 capability 验证与路由拒绝、准确 origin 导航和外部 scheme 过滤。workspace 约束测试固定了私有桌面应用位于 npm 发布之外，同时保留官方运行时依赖限制。运行时检查固定已声明的 preset／平台闭包，并拒绝暂存依赖树中的断裂或越界 symlink。本地未签名检查覆盖暂存闭包、应用组装、经过鉴权的打包后端启动与 ZIP 产物。本机沙箱无法为 `hdiutil` 提供创建 DMG 所需的设备访问权限，因此本地证据不声称完成了 DMG 组装；tag 工作流持有 DMG 创建、Developer ID、Gatekeeper、stapling、架构、updater 配置与更新清单检查。

`0.1.2-rc.1` 升级使用未签名 arm64 应用验证新的 Gateway 端点与需要鉴权的 HTML 入口。本地沙箱中，即使对空临时目录单独创建原生 watcher 也会报 `EMFILE`；这些启动与 profile 重载检查使用 `CHOKIDAR_USEPOLLING=true`。该设置仅用于测试，不改变已发布应用的默认 watcher，也不能证明沙箱外的原生 watcher 行为。

## 考虑过的替代方案

**通过 `file://` 加载 Web 分发，并经 IPC 承载 API 流量。** 当桌面专属能力足以证明该传输值得实现时，这仍是目标。当前 Host 侧仍把模块发现与 Web route、通用 Typert 注册与 HTTP 适配器，以及 Gateway 事件多路复用与其 WebSocket 绑定在一起。此时交付 IPC 会在安装包行为具备独立价值前复制或拆分所有这些机制。

**每次启动时选择随机 loopback 端口。** 这能避免冲突，却会改变浏览器 origin，使 localStorage 支持的草稿与展示状态在多次启动间丢失。稳定客户端应当选择清晰的冲突错误，而不是静默丢失状态。

**在 Electron 主进程内运行 Host 组合。** 进程内启动可以移除一个子进程，却会把 Host 崩溃、全局信号处理和长时间资源清理与窗口进程耦合。子进程为桌面持有方提供有界生命周期，同时保留已安装 CLI 的真实组装路径。

**发布一个 universal 应用。** 运行时闭包包含原生可执行文件和 addon。分别输出 arm64 与 x64 能让首个发行版保持可审计，并避免合并不兼容的原生 slice；完整闭包具备架构覆盖后，可以改用 universal 目标。

**提高打开文件数限制，或将运行时排除在签名之外。** 提高限制不会消除重复遍历 symlink 的问题，而排除运行时会遗漏原生签名目标。扫描补丁让完整的实际运行时保持在签名范围内。直接覆盖为 `@electron/osx-sign` 2.x 与 Electron Builder 26 使用的 CommonJS `signAsync` API 不兼容。

**始终占用一个 runner 等待，或每次超时后重新构建。** Apple 排队时间可能超过 runner 预算，导致临时签名应用丢失并引发重复提交。持久检查点把 Apple 队列与 runner 生命周期分离。恢复要求原始产物仍在 30 天保留期内；若提交确认丢失，则需要人工调查。

**把桌面包纳入 npm 应用发布序列。** npm 发布不能分发签名 `.app`、DMG、公证 ticket 或 updater 元数据。独立桌面 tag 避免安装包发布被迫与 CLI 和 Web 包共享版本。

## 结果

首个桌面客户端是持有完整 Web 产品的轻量原生进程，因此 UI 行为和客户端插件兼容性只有一套实现。进程隔离让启动与关闭可观察且有界，DMG 安装和签名 GitHub 更新也拥有专用发布路径。

应用运行期间仍存在 loopback 服务器，但其他本机进程必须拿到当前启动的 capability 才能访问控制 API。端口 `43121` 成为应用需要的本地资源，renderer 也继续依赖 Web 传输的 inline 启动代码和 WebSocket 行为。IPC 传输预留尚未实现；迁移到 IPC 需要单独决策，并保留通用 RPC、流取消、客户端 bundle 加载、安全检查和更新兼容性。
