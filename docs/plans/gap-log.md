# Gap Log

Small, real defects found while dogfooding that are not worth interrupting the
current round for. The scheduled gap sweep reads this file every hour.

> 2026-11-08: this file is not on `origin/main` yet (local docs are blocked
> behind a history that has not been pushed), so the hourly Kin routine can read
> it only from a local checkout. Until the docs land upstream, keep the matching
> GitHub issue self-contained: the routine reads issues, not this file.

How an entry is written — ask first, so the sweep never has to guess:

- 期望行为是什么？具体到能写成一条测试。
- 有没有哪种做法是你明确不要的？
- 仓库里有没有已经做对的同类地方可以照抄？

An entry must carry the expected behavior and any settled trade-off. If a
question is still open, mark it 待定 and ask the person now; do not leave a
product decision for the sweep to discover later.

How an entry moves:

- **高** — older than 7 days with no issue: the sweep opens one.
- **中 / 低** — older than 14 days: the sweep leaves them for a human to batch.
- Every issue the sweep or a person opens gets `已开 issue #<number>` appended to
  the entry, so it is never opened twice.

Newest first. Dates are absolute (`YYYY-MM-DD`). One entry is one symptom a
person can see; the fix and its verification belong in the issue or the PR.

## Open

### 2026-11-08 · 高 · 手机上点“例行任务”看不到刚在 Mac 上建好的例行任务

在 iPad（Hub 客户端）点“例行任务”，列表是空的；同一时刻在 Mac 上由 Agent 建
好的例行任务（`OpenKin gap sweep (Kin dogfood)`，21:09 建）在 Mac 控制台
（`:7777`）里能看见，而且已经在按小时跑。这不是列表没刷新：Hub 的
`/api/routines` 用节点凭据直接返回 `[]`。

根因是 Hub 和节点各自有一份 `routines` 表：另一个会话里的 Agent 通过本机
`:7777` 的 `POST /api/routines` 建任务，写进了 Mac 节点的库；iPad 读的是 Hub
的库。两套控制面在 routines 上没有打通（tasks 有 `executing_device_id`，
routines 没有）。

期望：在任一客户端上能看到并管理“这台机器上在跑的”例行任务；如果产品决定
例行任务属于 Hub，那么 Agent 在节点上建任务也必须落到 Hub，并且运行要派发回
目标机器。

待定（记录时已问报告人）：两条路选一条——
A. 例行任务属于机器：Hub 通过现有的节点查询通道读取/代理该机器的 routines，
   节点继续自己调度。改动小，但手机上呈现为“某台机器的例行任务”。
B. 例行任务属于 Hub：routines 增加 `executing_device_id`，Hub 调度、节点执行，
   与 ADR 0022 的“Hub owns the scheduler”一致；要迁移已有的节点本地任务。
当前推荐 B（与长期模型一致），A 可作为更快的止血。

线索：`internal/api/routines.go`、`internal/routines/scheduler.go`（派发的
`task.CreateRequest` 没有 `ExecutingDeviceID`）、`internal/remote/worker/query.go`
（没有 routines 查询）、`internal/node/responder.go`、`internal/mcp/server.go`
（只有 `list_routines` / `run_routine`，没有创建）、`ui/src/pages/RoutinesPage.tsx`、
`ui/src/components/chat/CwdPicker.tsx`（RoutinesPage 的 cwd 选择没有 device，
在 Hub 上列的是 Hub 自己的文件系统）。验收：同一条 routine 在 iPad 与 Mac 两端
都可见；在 iPad 上 run-now 落到 Mac 执行。

### 2026-11-08 · 高 · 回车直接发送，写不了多行

在 iPad 的 iOS 客户端里，输入框的回车键直接发送消息。软键盘没有 Shift，
`Shift+Enter` 换行用不上，长消息只能一次写完；手一快就把半句话发了出去。
已定：所有键盘——软键盘、桌面、iPad 外接硬件键盘——回车都只换行，发送只走
发送键（输入框右侧的上箭头）。

线索：`ui/src/components/chat/Composer.tsx:712` 的
`if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }`
——换行完全依赖 textarea 的 `Shift+Enter` 默认行为，而软键盘拿不到 Shift。
同一处理函数里还有 IME 保护（`:619`）和 mention / slash 菜单的 Enter（`:656`、
`:679`）——菜单里的回车是选行，不是发送，保持不动；`⌘/Ctrl+Enter` 现在插入
换行（`:700`），要和图例一起改。注意 `Composer.slash.dom.test.tsx` 与
`Composer.files.dom.test.tsx` 都断言“回车发送”，行为整体反转后要一起改。
另外界面图例现在写的是 `⌘↵ 发送`，代码却把 `⌘/Ctrl+Enter` 当换行；实现时
按图例把 `⌘/Ctrl+Enter` 定为桌面的发送快捷键，两者对齐。

### 2026-11-08 · 高 · 新开会话选不了模型，选择控件各写各的（原生 select 仍在用）

在 iPad 的 iOS 客户端上新开会话，底部运行设置只能选 Agent，模型一项看不到、
改不了；同一带的几个选择框形状也不一致，好几处还是浏览器原生 `<select>`
——在 iOS 上打开的是系统滚轮，样式和交互都不属于控制台。

期望：新开会话能选模型；所有“从一组里选一个”的地方复用同一个全局选择控件，
同一套触发器、同一套桌面浮层 / 手机 sheet 形态、同一套搜索与键盘行为，不再
出现原生 `<select>`。

线索：手机运行设置 `ui/src/components/chat/RunConfigSheet.tsx` 本应有
Agent / 模型 / 权限三行（模型行在 `:432`），模型清单来自
`ui/src/lib/agentModels.ts:19` 的 `modelsForAgent`（读 agent 上报的 `models`）。
先确认 iPad 实际走的断点与 Hub 提供的构建：`md` = 768px，iPad mini 竖屏
744px 走手机版，其余 iPad 走桌面条；再看是模型行没渲染，还是 agent 的
`models` 为空。原生 select 集中在 `ui/src/components/chat/DispatchSelector.tsx:279`、
`:294`、`:314`、`:327`、`:349`，`MachinePicker.tsx:33`、
`MachineBrowser.tsx:434`、`RoutineScheduleFields.tsx:194` / `:224`；设置页另见
`ProviderSettingsSection.tsx`、`RoutingSettings.tsx`、`SettingsPage.tsx` 等。
现有两个半成品可收敛为一个原语：`ui/src/components/ui/SearchSelect.tsx`
（桌面浮层 + 窄屏 sheet）与 `ui/src/components/ui/SheetSelect.tsx`（手机 Ionic
action sheet / 桌面锚定菜单），后者的顶部注释已经写明原生 select 在 iOS 上
为什么不对。验收：新开会话能改模型；全仓 `grep '<select'` 只剩合理用途；
桌面与 390px 宽度各有 DOM 测试。

### 2026-11-08 · 中 · iPad 新开会话底部控件太挤，排列没有层次

新开会话页在 iPad 上，底部的 Agent、权限模式、模型、项目文件夹、机器、分支、
分发、例程挤在一起：`md` 及以上是一条可横向滚动的 chip 条，窄一点的 iPad 走
手机 sheet 时又是九行等权卡片；“这次要跑什么”和“在哪里跑”混在同一层，第一眼
看不出该先看哪个。已定：参考 lody 重排——项目 / 文件夹（cwd）的选择挪到上方
对话 UI（新开会话的标题 / 项目区），底部只留一行、控件尽量少；机器 / 分支 /
分发 / 例程这类位置设置收进同一个设置面，同一宽度只出现一种排列，不并列两套。

线索：`ui/src/pages/NewChatPage.tsx:479` 的 `desktopStrip` 与 `:869` 的
`hidden md:flex ... overflow-x-auto` 横滚条；手机入口是 `Composer.tsx:1027`
的 `md:hidden` footer；设置面是 `ui/src/components/chat/RunConfigSheet.tsx` 的
`RunConfigSheetRow`（`:663`）与 `extraRows`（`:597`）；要上移的文件夹控件是
`ui/src/components/chat/CwdPicker.tsx`。参考形态就写在该文件顶部注释里：
footer 一行说清当前配置，sheet 拥有控件，行内展开而不是叠第二层 sheet。

### 2026-11-08 · 高 · 会话 cookie 不随使用滑动，约每 30 天要重登一次

Hub 的 `auth_sessions.expires_at` 会在每次使用时滑动（1 小时节流，180 天绝对
上限），但 `kin_session` cookie 的 `Expires` 只在登录时写一次；已认证请求不会
重新下发 `Set-Cookie`。表现：即使每天使用，登录约 30 天后控制台仍会要求重新
输入密码。壳层的 Keychain 副本存的是同一个过期时间，所以卸载重装也救不了。
期望：会话滑动成功时按同样的 1 小时节流重发 `Set-Cookie`（`Expires` 用滑动后
的值，仍受 180 天上限约束），并补一条测试：touch 之后的一次请求带新的
`Expires`；未到节流窗口的请求不重发。

线索：`internal/api/auth.go` 的 `setSessionCookie`（只在登录/兑换等端点调用）、
`internal/api/api.go` 的 `SetSessionLookup`、`internal/store/identity.go` 的
`AuthenticateSession`（返回滑动后的 `ExpiresAt`）、`internal/remote/auth.go`
的 cookie 解析。

### 2026-11-08 · 中 · iOS 壳启动只认构建期 Hub URL，不认配对时存下的地址

在连接页配对过的手机，重开应用后壳仍按构建期 `server.url` 启动；运行时的
`kin.hub_url` 只有连接页会读（用来预填输入框），启动路径没有任何地方用它，
这与 `mobile/capacitor.config.ts` 和插件注释里写的"运行时 origin 是事实、
壳在启动后把 webview 指过去"相反。表现：用通用构建（未烘 `KIN_HUB_URL`）
配对过的手机，每次重开都回到内置控制台，要多点一次连接；若构建期 URL 与
配对地址不同，即使会话 cookie 还在也会落到另一个 origin 上而显示未登录。

期望：壳在首个页面加载前把存储的 Hub origin 作为启动地址（存储地址不可达时
退回内置控制台，即配置注释里写的 fallback），并补一条模拟器验证。

线索：`mobile/ios/App/App/KinHubConfigPlugin.swift` 的 `storedHubURL` /
`launchHost` / `startSessionKeeper`，`mobile/ios/App/App/KinBridgeViewController.swift`
的 `capacitorDidLoad`，`ui/src/lib/hubConfig.ts`、`ui/src/components/ConnectScreen.tsx`。

### 2026-11-07 · 中 · Agent / 模型选择气泡的展开方向不一致

同一个输入框工具栏里的选择器，弹出面板的方向不一致：Agent 选择器和模型
选择器有的向上、有的向下，权限模式选择器又是另一种；窄屏下还会出现面板
贴边或被裁切。期望同一工具栏的选择器共用一套 placement 规则，空间不足时
统一翻转，并补一条覆盖桌面与 390px 宽度的 DOM 测试。

线索：`ui/src/components/chat/AgentModelPicker.tsx`、
`ui/src/components/chat/ModelPicker.tsx`、`ui/src/components/chat/PermissionModePicker.tsx`，
翻转逻辑在 `ui/src/components/ui/SearchSelect.tsx`。

2026-11-08 复现（首日 dogfooding）：同一行工具栏里 Agent 与模型的方向就不一致。
现在实际有三套：`AgentModelPicker.tsx:96`、`:128` 和 `ModelPicker.tsx:109` 固定
`placement="top"`（`SearchSelect` 自己的翻转）；`PermissionModePicker.tsx:181`
用 `useAnchoredPanel` 的 `above`；新建会话的 `RunConfigSheet.tsx:369` 又是 Agent
`below`、模型与权限 `above`。窄屏下 `SearchSelect` 还会换成 `Sheet`，和
`useAnchoredPanel` 的浮层不是同一种形态，所以“统一 placement”要连形态一起定。

已开 issue #3

### 2026-11-07 · 中 · 模型列表出现重名项且不显示来源

模型下拉里会出现同名或同 id 的重复条目（多个 agent / provider 提供同一个
模型），条目本身不显示它来自哪个 agent 或 provider，用户无法判断该选哪
一个。期望同一模型只出现一次；确实存在多个来源时，条目或分组要能看出处，
并且键盘选择行为不变。

线索：`ui/src/components/chat/ModelPicker.tsx`、
`ui/src/components/chat/AgentModelPicker.tsx` 的 `modelPickerOptions`，
模型清单由 Node 的 hello 上报（`internal/remote/worker/protocol.go`）。

2026-11-08 复现（首日 dogfooding，实测运行中的 node）：`claude-code` 上报 59 个
模型，其中 6 个都叫 GLM 5.3（DashScope / Volcengine / Baidu / Tencent / Zhipu /
裸 `glm-5.3`），看起来就是一串重名。根因在分组：`ui/src/lib/agentModels.ts:58`
取 id 的第一段当组名，`volcengine-gw/dashscope/glm-5.3[1m]` 全被归到
`volcengine-gw`，于是 59 行落在同一个组头下；真正的来源在第二段
（dashscope/volcengine/baidu/tencent/zhipu），却只以不同位置的前缀混在标签里。
裸 `volcengine-gw/glm-5.3[1m]` 和 `volcengine-gw/volcengine/glm-5.3[1m]` 还可能是
同一条上游路由的两种写法，需要 provider 侧确认后再决定是否合并。

已开 issue #2

### 2026-11-07 · 中 · 分发按钮的气泡向左展开且内容被裁切

输入框工具栏的分发按钮打开气泡时向左展开，超出视口后被裁切，右侧内容看
不全也点不到（手机宽度最明显）。期望气泡或弹层锚定在触发按钮附近，按视口
空间选择展开方向，任何宽度下完整可见、可操作、可关闭，且不产生横向滚动。

线索：`ui/src/components/chat/DispatchSelector.tsx`（气泡本体），
定位/夹取可参考 `ui/src/components/ui/SearchSelect.tsx` 与
`ui/src/hooks/useAnchoredPanel.ts`；消息上的分享入口与
`ui/src/components/task/ShareDialog.tsx` 是另一条路径，不要混在一起修。

2026-11-08 复现（首日 dogfooding）：触发点确认是输入框工具栏的 **分发**
（`ui/src/components/chat/DispatchSelector.tsx`），不是消息上的分享；
`ShareDialog` 是居中的 portal 弹层，不受影响。气泡在 `DispatchSelector.tsx:245`：
`absolute bottom-full right-0 sm:left-0 sm:right-auto` 加固定 `w-popover`，
既不 portal 也不按视口夹取，只按断点选左/右锚点；祖先一旦有 `overflow` 就被整块
裁掉，窄屏最明显。修法应和 issue #3 共用同一套测量/夹取逻辑，而不是再写一套。

已开 issue #1
