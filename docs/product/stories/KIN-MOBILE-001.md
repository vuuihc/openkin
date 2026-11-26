# KIN-MOBILE-001 · 手机用 Expo/RN 客户端承接固定面

状态：approved
优先级：P0
旅程：J1、J2、J4
归属面：`IA.md`「手机（390 宽）」与 `KIN-CONTRACT-001` 的四个页面
面：手机

## 谁、什么时候、为什么

当我每天在 iPhone 上打开 Kin，想找回昨天的对话、读完一段回答、批准一次工具调用，我想这个入口是 T3 Code 那种原生的手机客户端，而不是把桌面控制台装进 WebView，以便打开、滚动和输入都像手机应用一样快，而不是像在手机上开一个网站。

这是 owner 2026-11-24 的决定：RN 手机客户端立刻开工，与 web 队列并行；web 手机壳的打磨暂停（`rsi/DECISIONS.md` 同日「RN phone client starts now」一条）。ADR 0035 已接受方向（`docs/adr/0035-mobile-rn-client-and-surface-reduction.md:51`），入口条件「最小契约已签」也已满足（`docs/product/stories/KIN-CONTRACT-001.md:3`）。本故事是执行合同：它不重新设计任何屏幕，只把已签的四个面搬到 Expo/RN。

## 现在

- 今天没有 `mobile-rn/`：仓库里的手机客户端是 Capacitor 壳（`mobile/package.json:4`），它加载的仍是 web 控制台。ADR 0035 记录了两条测量事实：手机上的体感问题没有归因到 web 栈，而最可疑的玻璃头 `backdrop-filter` 也没有被隔离（`docs/adr/0035-mobile-rn-client-and-surface-reduction.md` 的 Context）。
- 四个面的行为已经签过字：列表（`KIN-CONTINUE-002`、`003`、`004`、`007`）、对话读与发（`KIN-CONTRACT-001`、`KIN-CONTINUE-001`）、审批与提问（`KIN-CONTRACT-001`、`KIN-CONTINUE-003`）、provider/usage（`KIN-AGENTS-001`、`KIN-CONTRACT-001`）。RN 没有第二套产品决定可做。
- 没有任何检查在管 RN：`./scripts/check.sh --list` 的 14 个作业里没有 `mobile-rn`，所以第一块脚手架必须同时把它接进闸门（AGENTS.md 规则 12）。
- 共享逻辑今天只有 web 一份：`ui/src/components/chat/transcriptProjection.ts`、`ui/src/api/contract.ts`、`ui/src/api/generated/**`、`ui/src/i18n/locales/**`。RN 若复制一份，就是 ADR 0035 §4 说的缺陷。
- `ui/src/api/client.ts` 今天依赖浏览器：token 在 `localStorage`（`:58`、`:65`、`:70`）、relay cookie（`:105`）、URL/history（`:124`、`:158`、`:176-177`）、`credentials: "same-origin"`（`:296`、`:356`）。RN 需要一个同签名的传输适配器，而不是第二套接口。
- 没有手机端的原生能力：安全存储、推送、玻璃导航条、后台重连都还没有 RN 实现。

## 范围

- 做：
  - R1 脚手架：新建顶层 `mobile-rn/`（Expo SDK 58、TypeScript strict、expo-router）；Metro `watchFolders` + tsconfig `paths` 指向共享 TS；一份 shared-import 契约测试（闭包内不许出现 `window`/`document`/`localStorage`/`sessionStorage`/`react-dom`，别名目标必须写在 ADR 0036）；`scripts/check.sh` 增加 `mobile-rn` 作业。
  - R2 配对与登录：token 链接/扫码进入、`expo-secure-store` 保存、首次拉列表、未登录/过期状态。
  - R3 对话列表：设备 → 项目 → 对话，折叠沿用已签规则，820 一屏 ≥10 条，44pt 触控目标。
  - R4 对话读、流、composer、打断与排队：读用同一份 `transcriptProjection`，发与流走 RN 传输适配器。
  - R5 审批与提问：待批计数、批准/拒绝、回答问题、已处理状态。
  - R6 provider/usage sheet：provider 列表、用量窗口、模型与花费只读。
  - R7 原生模块：玻璃导航条/头部、滚动边缘、推送、后台重连；RN 弱的地方才写原生模块。
  - 四个面共用同一套 i18n：读写 `ui/src/i18n/locales/en.ts` 与 `zh.ts`，不新造字符串表。
  - 44pt 触控地板来自 RN 的 `minHeight`/`minWidth: 44`，不是 web 的宽度断点；键盘/读屏等价物用 accessibilityRole/accessibilityLabel。
  - 每个面都写 loading、空、错误、断线四种状态；流式时保留已收到内容。
  - ADR 0036 的依赖表：16 个 exact pin，全部发表于 2026-11-17 之前，只进 `mobile-rn/package.json`。
- 不做（各自去处）：
  - 除 provider/usage 以外的 Settings 页面（general、operations、routing、advanced、agents 安装检测）→ `KIN-SETTINGS-*`，留在桌面；RN 不做。
  - 例行任务 UI（列表、编辑、run-now、运行历史）→ `KIN-ROUTINE-*`，留在 web/桌面。
  - 桌面改动（Electron、Vite、`web/dist`、Go daemon、HTTP 接口）→ 没有故事，因为这一条一行都不改；ADR 0035 §2 已定。
  - 删除 `mobile/` Capacitor 壳 → 四个面 parity 后的独立 cutover 故事；本条不删。
  - web 手机壳的 820 列表扫描与 iPad 44px 打磨 → parked（`rsi/DECISIONS.md` 2026-11-24）；不在这条里恢复。
  - `/routines`、`/settings` 的 RN 版 → 不在四固定面里；要就另开 story。
  - 第二份 `transcriptProjection`、第二个 API 客户端或第二套 task-title/card schema → 不做；这是 ADR 0036 §5 的 kill criteria。
  - 新接口、新存储键、schema 或事件协议 → 不做；RN 只用现有端点与载荷。

## 每一步的预期

### 1. 定义：第一次打开，先完成配对

| 项 | 预期 |
|---|---|
| 起点 | 刚安装的 RN 客户端，没有 token；屏幕是登录/配对页，不是列表空态 |
| 动作 | 点「扫描二维码」或粘贴 `?token=` 链接；失败时可重试 |
| 立刻看到 | 按下后立刻出现进度；成功后直接落到对话列表，token 不再出现在 URL 或屏幕上 |
| 慢 / 空 / 失败 / 断线 | 慢：按钮转圈并写「正在连接这台设备」；空：没有 token 时只显示配对入口；失败：区分「链接过期」「设备离线」「网络不可达」并保留重试；断线：说明 token 已保存，恢复后自动重试 |
| 键盘与焦点 | 粘贴框可聚焦，键盘出现时配对按钮不被遮住；Enter 提交；失败后焦点回到输入框并读出错误 |
| 离开再回来 | token 存进 Keychain（`expo-secure-store`），杀掉应用再开仍已登录；过期的 token 不静默重试 |

### 2. 定位：在列表里找到昨天那条对话

| 项 | 预期 |
|---|---|
| 起点 | 已配对，落在对话列表；设备 → 项目 → 对话三层，项目默认折叠且只开最近一条对话所在的项目 |
| 动作 | 展开项目、滚动、搜索、点一条对话 |
| 立刻看到 | 行是两行式：标题一行、agent · 相对时间 · 状态一行；手指按下有可见反馈；点开在同一个栈里推出对话 |
| 慢 / 空 / 失败 / 断线 | 慢：列表头与搜索先可用，行区画骨架条（一条设备标题条 + 三行条；读屏读出「正在载入对话…」）；空：「还没有对话」+「点「新建对话」开始。」（该提示指向的入口不在本条，另立 start 故事，draft 待签）；失败：列表一行「读取失败，重试」（一次 `/api/tasks` 读，失败是全局的），已加载行不清空；断线：顶部横幅，已缓存的行仍可读 |
| 键盘与焦点 | 每行是一个可访问停点，读屏读出「标题 · agent · 时间 · 状态」；外接键盘 ↑↓ 移动、Enter 打开；返回时焦点回到那一行 |
| 离开再回来 | 折叠状态、滚动位置、搜索词保留；从对话返回不重新加载整页 |

### 3. 准备：打开一段对话，先看到已发生的事

| 项 | 预期 |
|---|---|
| 起点 | 列表里的一条对话，或推送/深链直接落到 `/tasks/:id` |
| 动作 | 点行；进入后先读最近一段，不自动滚到顶 |
| 立刻看到 | 对话头一行（返回 · 用量；标题按已签帧待补；文件与溢出菜单不在本条）；消息按现有投影分组成回答、工具调用和 meta 行；草稿为空时 composer 在底部 |
| 慢 / 空 / 失败 / 断线 | 慢：消息区骨架，头部与 composer 先可用；空：只有用户那条与「还没有回答」；失败：整页错误 + 重试，不显示假消息；断线：保留已读内容，一条重连说明，composer 禁用并说明原因 |
| 键盘与焦点 | 进入后焦点落在消息区顶部而不是 composer（先读再写）；VoiceOver 从对话标题开始；返回按钮是第一个停点 |
| 离开再回来 | 滚动位置与正在读的那条保留；后台回来不跳回顶部；深链进入后返回落到列表而不是空栈 |

### 4. 确认：读到流结束，看清状态

| 项 | 预期 |
|---|---|
| 起点 | 一条正在流式输出的回答，或刚打开的历史回答 |
| 动作 | 滚动阅读；等流结束；点工具调用行展开细节 |
| 立刻看到 | 文本逐步追加，不整段闪回；工具调用行显示名称与状态；流结束时状态从「运行中」变为「已完成」；markdown 表格在 390 宽内横向滚动而不是撑破页面 |
| 慢 / 空 / 失败 / 断线 | 慢：保留已收到文本并显示活动行；空：流开始前显示「正在准备」；失败：流中断时保留文本并给一行原因与重试；断线：已收到内容不丢，恢复后从断点续读，不重复整段 |
| 键盘与焦点 | 读屏在新增文本时不反复抢焦点；用户手动上滚后不被自动滚回底部；表格可聚焦并读出表头 |
| 离开再回来 | 后台回来重新订阅当前对话；已读位置保留；不重复播放已完成的状态 |

### 5. 执行：发下一句、排队、打断

| 项 | 预期 |
|---|---|
| 起点 | 对话底部 composer，agent 空闲或运行中 |
| 动作 | 输入、发送；运行中再发一条进入队列；点停止打断 |
| 立刻看到 | 发送后消息立刻入流、composer 清空并保持焦点；运行中显示停止按钮；排队时每条排队消息各占一行、标「排队中」并显示原文与「撤回」，条数即可见行数（复用 `ui/src/i18n/locales/zh.ts:394` 的 `chat.queued`，不另造计数串）；打断后出现一条 meta 行说明已停止 |
| 慢 / 空 / 失败 / 断线 | 慢：发送按钮转圈但草稿仍可编辑；空：composer 为空时发送禁用；失败：草稿留在 composer 并说明原因；断线：发送禁用并说明，恢复后草稿还在 |
| 键盘与焦点 | 键盘弹出时 composer 在键盘上方；回车键插入换行、发送是明确的「发送」按钮（RN 0.88.1 的 `TextInput` 只报 `key`、不报修饰键，Shift+Enter 与 Enter 无法区分，外接键盘 Enter 发送不在本故事内；`mobile-rn/package.json:21`）；发送后焦点留在 composer；停止按钮有 accessibilityLabel |
| 离开再回来 | 草稿、队列与滚动位置保留；不重复发送；后台回来仍能看到运行中的停止按钮 |

### 6. 监控：审批、提问与待处理

| 项 | 预期 |
|---|---|
| 起点 | 对话里出现一次审批或提问；列表行显示待批计数 |
| 动作 | 点审批卡；批准或拒绝；回答一个问题 |
| 立刻看到 | 卡片展开显示命令/参数与允许范围；按下后按钮进入等待态；成功后卡片变为已处理并留一行结果；列表行的待批计数同步减少 |
| 慢 / 空 / 失败 / 断线 | 慢：提交中禁用重复点击；空：没有待处理时不显示空卡；失败：卡片恢复可操作并说明原因；断线：禁用提交并说明，已读的审批不消失 |
| 键盘与焦点 | 批准/拒绝是明确的按钮，读屏读出动作与对象；危险动作不只靠颜色；提交后焦点留在结果行 |
| 离开再回来 | 已处理状态从服务端重读，不靠本地记忆；推送点开落到同一条审批；处理完不再提醒 |

### 7. 修改：provider/usage 与设置边界

| 项 | 预期 |
|---|---|
| 起点 | 对话头「用量」打开 provider/usage sheet |
| 动作 | 切 7/30/90 天窗口；读 provider 的可用性与花费；关闭 sheet |
| 立刻看到 | sheet 从底部推出，玻璃背景；数字先出缓存值，再按窗口刷新；关闭后回到原对话，滚动位置不变 |
| 慢 / 空 / 失败 / 断线 | 慢：sheet 骨架，关闭始终可用；空：「这台设备还没有用量」；失败：保留上次数字并标记「刚刚更新失败」；断线：显示已缓存值并说明可能过期 |
| 键盘与焦点 | sheet 是模态，读屏焦点进入标题；下拉关闭与按钮关闭都可用；关闭后焦点回到打开它的「用量」 |
| 离开再回来 | 窗口选择在本次会话内保留；不写新的本地存储键；不把 provider 配置的编辑带进 RN |

### 8. 收尾：后台、断线与回来

| 项 | 预期 |
|---|---|
| 起点 | 应用在后台，或有推送到达；网络从 Wi-Fi 切到蜂窝 |
| 动作 | 从推送点开；或切回前台；或等重连 |
| 立刻看到 | 推送落到对应对话/审批；前台恢复时先显示已缓存内容，再静默刷新；重连后运行中的对话继续追加 |
| 慢 / 空 / 失败 / 断线 | 慢：重连期间顶部一条「正在重新连接」，不清空页面；空：没有缓存时显示加载态而不是错误；失败：重连失败给一次手动重试；断线：已读内容与草稿保留 |
| 键盘与焦点 | 推送进入后焦点落在对话标题；恢复时不抢走用户正在输入的 composer 焦点 |
| 离开再回来 | 未读数与待批计数以服务端为准；不重复弹同一条推送；R7 的后台重连只补事件，不重放已处理的审批 |

## 各面差异

| 面 | 这一面怎么呈现 | 为什么不同 |
|---|---|---|
| Mac | 没有：本条不交付 Mac 客户端。Mac 仍是 Electron + Vite（ADR 0035 §2）；设置、例行任务和桌面壳升级留在 web/桌面故事里 | 手机是唯一目标面；把桌面一起搬会扩大交付并触发 web 闸门，而 web 没有任何行为变化 |
| 手机 | 390×844 单列；对话栈（无底部导航：本条只有四个固定面，没有第二页可放）；44pt 最小触控；玻璃头部/导航条走原生模块；键盘与安全区按 iPhone 处理；820 粗指针按 `KIN-CONTINUE-007` 的 304px 左栏规则，不另画一张皮 | 手指需要更大目标、键盘会占半屏，且 RN 的强项是原生导航与滚动；这些是 web 壳今天最贵的地方 |

## 设计

设计稿：`KIN-MOBILE-001.review.html`（Figma 帧为主体，每屏六段用户流程）。帧不重画：它引用已签故事的既有帧——`KIN-CONTINUE-007.figma/frames/04-phone-390-list.svg`、`KIN-CONTRACT-001.figma/frames/02-phone-reading.svg`、`KIN-START-001.figma/frames/03-phone-composer.svg`、`KIN-CONTINUE-002.figma/frames/02-phone-conversation.svg`、`KIN-AGENTS-001.figma/frames/02-phone-agents.svg`、`KIN-CONTINUE-002.figma/frames/04-phone-states.svg`。RN 的差异只在呈现层（原生导航、玻璃、键盘与安全区），不改已签的屏幕内容。所引帧画的是 web 壳：RN 面不画底部导航、不画 ＋新建 行、不画头部 文件/⋯（2026-11-26 裁定，见 `rsi/DECISIONS.md`「RN contract cells settled」），这些行不在本条范围。

必须画到的状态：默认列表、空列表、加载中、读取失败、断线横幅、未配对/过期、运行中流式、等待批准、已处理、provider/usage 空与失败。

## Do not

- 不许在 `mobile-rn/` 之外新建第二个手机客户端，也不许在 RN 里用 WebView 加载 web 控制台。
- 不许复制 `transcriptProjection`、`contract.ts`、generated 类型或 locale 字符串；共享模块只能 import，DOM 依赖只能走 ADR 0036 的两个适配器。
- 不许改 `ui/package.json`、`ui/src/**` 的行为或 `go.mod`；RN 不加新接口、新存储键、schema 或事件协议。
- 不许在 cutover 故事之前删除或修改 `mobile/`。
- 不许把 Settings 其余页面、例行任务 UI 或桌面能力塞进 RN。
- 不许把触控目标缩到 44pt 以下，也不许只靠颜色表达状态。
- 不许重画已签帧、改别的故事的 registry 行或改 `docs/product/IA.md`。
- 不许在帧或测试夹具里放真实数据、截图、主机名、设备 id 或 token。

## 验收

| 层级 | 位置 | Given / When / Then |
|---|---|---|
| 签字守卫 | `ui/src/lib/surfacesContract.KIN-MOBILE-001.test.ts`（本 PR 创建） | Given 合同与 registry When 读状态 Then 都是 `approved` 且一致；Given `rsi/DECISIONS.md` When 找 CEO call Then 有一行点名 `KIN-MOBILE-001`；Given 审阅页 When 找待拍板决定 Then 与记录一致；Given ADR 0036 的依赖表 When 解析 Then 每行是 exact pin 且日期不晚于 2026-11-17；Given 审阅页引用的 SVG When 检查磁盘 Then 每个都存在 |
| R1 脚手架 | `mobile-rn/src/shared/importContract.test.ts`（新） | Given RN 的共享导入闭包 When 扫描 Then 没有 `window`/`document`/`localStorage`/`sessionStorage`/`react-dom`；Given Metro 别名 When 读配置 Then 每个目标都在 ADR 0036 里，且被别名的共享模块正好是有 DOM 引用的那些 |
| R1 闸门 | `mobile-rn/src/gate/checkJob.test.ts`（新） | Given `scripts/check.sh` When 读作业表 Then 有 `mobile-rn` 作业并执行 `tsc --noEmit` 与 `jest`；Given 删掉该行 When 跑测试 Then 红 |
| R2 配对 | `mobile-rn/src/auth/pairing.test.ts`（新） | Given 没有 token When 打开应用 Then 只显示配对入口；Given 有效 token When 提交 Then 存进 secure store 并落到列表；Given 过期 token When 恢复 Then 说明已过期且不静默重试；Given token When 成功 Then 不出现在 URL 或日志里 |
| R3 列表 | `mobile-rn/src/screens/ConversationList.test.tsx`（新） | Given 设备/项目/对话数据 When 渲染 Then 三层结构、项目默认折叠；Given 820×1180 粗指针 When 数一屏 Then ≥10 条完整行；Given 每行 When 量触控目标 Then ≥44pt；Given 空/失败/断线 Then 各自状态可见且已加载行不清空 |
| R4 对话 | `mobile-rn/src/screens/Conversation.test.tsx`（新） | Given 一段历史 When 打开 Then 用共享投影分组且滚动位置保留；Given 流式回答 When 追加 Then 已收到文本不重画、结束后状态变为已完成；Given 运行中 When 发送 Then 进入队列；Given 运行中 When 点停止 Then 出现持久 meta 行；Given 断线 Then 文本不丢、composer 禁用并说明 |
| R5 审批 | `mobile-rn/src/screens/Approvals.test.tsx`（新） | Given 一条待批 When 点批准 Then 按钮进入等待态、成功后卡片已处理、列表计数减一；Given 失败 Then 卡片恢复可操作并说明；Given 断线 Then 提交禁用且已读审批不消失；Given 读屏 When 聚焦 Then 读出动作与对象 |
| R6 provider/usage | `mobile-rn/src/screens/ProviderUsage.test.tsx`（新） | Given 打开 sheet When 切 7/30/90 天 Then 数字按窗口刷新；Given 空 Then 「这台设备还没有用量」；Given 刷新失败 Then 保留上次数字并标记过期；Given 关闭 Then 回到原对话且滚动位置不变 |
| R7 原生 | `mobile-rn/src/native/reconnect.test.ts`（新） | Given 应用进后台再回来 When 重连 Then 只补新事件、不重放已处理审批；Given 推送点开 Then 落到对应对话/审批；Given 重连失败 Then 一次手动重试且已读内容保留 |

测试文件里必须出现 `KIN-MOBILE-001`。`mobile-rn/` 下的测试文件由 R1–R7 各自创建，本 PR 只创建签字守卫 `ui/src/lib/surfacesContract.KIN-MOBILE-001.test.ts`，并按 `KIN-CONTINUE-007` 的签字先例把它登记进 registry；在上述文件存在之前，`mobile-rn/` 的验收行保持 `planned`，不翻 `covered`。

## 证据

- 之前：`mobile-rn/` 不存在（`test ! -d mobile-rn`），手机入口是 `mobile/` Capacitor 壳（`mobile/package.json:4`）；web 手机壳的 820/390 现状见 `rsi/state/shots/` 与 `KIN-CONTINUE-007` 的测量。
- 之后：R1–R7 各自的 PR 补 `tsc`/`jest` 输出、390×844 / 820×1180 截图与真机体感记录；本条在四个面 parity 且真机验收后才翻 `covered`。

## 变更记录

- 2026-11-24 创建（draft）。把 ADR 0035 的 RN 方向落成可交付的 parity 合同；不重画已签屏幕。
- 2026-11-24 · CEO 代签 `approved`（owner 授权，见 `rsi/DECISIONS.md` 2026-11-24「RN phone client starts now」）。签字依据：ADR 0036 固定布局、in-place 共享 TS、轻闸门与依赖豁免；审阅页无待拍板决定。签字后 R1 才建 `mobile-rn/`。
- 2026-11-26 · CEO 定：§2「底部导航」「新建入口」、§3「文件 · ⋯」与 §2「该项目下一行」四处按 RN 的实际面改写（对话头今天只画返回 · 用量，标题按已签帧待补；见 `rsi/DECISIONS.md` 2026-11-26「RN contract cells settled」）；新建入口另立 start 故事（draft，待签）。验收表与 做/不做 未动。
