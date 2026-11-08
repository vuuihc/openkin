# Gap Log

Small, real defects found while dogfooding that are not worth interrupting the
current round for. The scheduled gap sweep reads this file every six hours.

How an entry moves:

- **高** — older than 7 days with no issue: the sweep opens one.
- **中 / 低** — older than 14 days: the sweep leaves them for a human to batch.
- Every issue the sweep or a person opens gets `已开 issue #<number>` appended to
  the entry, so it is never opened twice.

Newest first. Dates are absolute (`YYYY-MM-DD`). One entry is one symptom a
person can see; the fix and its verification belong in the issue or the PR.

## Open

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

已开 issue #3

### 2026-11-07 · 中 · 模型列表出现重名项且不显示来源

模型下拉里会出现同名或同 id 的重复条目（多个 agent / provider 提供同一个
模型），条目本身不显示它来自哪个 agent 或 provider，用户无法判断该选哪
一个。期望同一模型只出现一次；确实存在多个来源时，条目或分组要能看出处，
并且键盘选择行为不变。

线索：`ui/src/components/chat/ModelPicker.tsx`、
`ui/src/components/chat/AgentModelPicker.tsx` 的 `modelPickerOptions`，
模型清单由 Node 的 hello 上报（`internal/remote/worker/protocol.go`）。

已开 issue #2

### 2026-11-07 · 中 · 分享 / 分发按钮的气泡向左展开且内容被裁切

消息上的分享 / 分发按钮打开气泡时向左展开，超出视口后被裁切，右侧内容看
不全也点不到（手机宽度最明显）。期望气泡或弹层锚定在触发按钮附近，按视口
空间选择展开方向，任何宽度下完整可见、可操作、可关闭，且不产生横向滚动。

线索：`ui/src/components/chat/ChatStream.tsx` 的分享入口、
`ui/src/components/task/ShareDialog.tsx`，移动端弹层见
`ui/src/components/mobile/Sheet.tsx`。

已开 issue #1
