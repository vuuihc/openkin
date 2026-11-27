# KIN-MOBILE-002 · RN 手机端的视觉系统与五屏重画

状态：approved
优先级：P0
旅程：J1、J2、J4
归属面：`IA.md`「手机（390 宽）」
面：手机

## 谁、什么时候、为什么

当我把 RN 版 Kin 装上手机开始 dogfood，我想它看起来像一个认真设计的手机应用，而不是一堆默认样式的文本行，以便我愿意每天打开它，把会话从 Mac 上接着走。

owner 2026-11-27 实测原话：「体验了下确实太初级了，建议用 opendesign 或者 mobiledesign 的 Skill 做一下设计」。本条是把那次设计落到合同：视觉系统(token)加五个屏的重画，不改 KIN-MOBILE-001 已签的行为。

## 现在

- RN 客户端的四个面已按 parity 上线（KIN-MOBILE-001），但没有任何视觉系统：`mobile-rn/` 里没有 token 模块，颜色字面量 113 处散落在组件里；整体是浅色固定样式，而 `app.json` 声明了 `userInterfaceStyle: automatic`——暗色模式下界面是错的。
- 列表是白底卡片式行，不遵循 iOS 分组列表；对话页 markdown 不渲染，列表显示成 `- ` 原文，表格溢出；composer 是裸输入框；审批是平铺文本。
- 桌面控制台已有一套量过对比度的 token（`ui/src/design/theme.css`，每个值都有 L* 与对比度注释），手机端一个也没用。
- owner 的基准是「追上 T3 Code 的体验」；T3 Code 的手机端是暗色优先、密实、原生活动的。

## 范围

- 做：
  - R1 token 层：`mobile-rn/src/theme/tokens.ts`（DOM-free TS），端口 `ui/src/design/theme.css` 明暗两套全部色值、字阶、间距、圆角；`useColorScheme` 选套；一条 parity 测试读 `theme.css` 原文，断言 RN token 与之一致，web 改色手机端立刻红。
  - R2 连接/登录页：大标题 + 分段「Hub 账号 / 直连这台设备」；表单按 iOS 规范（标签在框上、44pt 高、密码可显示）；局域网 http 显式「不安全 / 凭据明文传输」确认，按 origin 记住一次，地址变化重新确认（解除 parity 版连不上局域网 Hub 的阻塞，见 `mobile-rn/src/auth/hub.ts:100`）。这是凭据传输安全边界的变更：R2 的实现 PR 必须先写局域网 http 凭据 ADR，并在 PR 上打 `needs-ceo` 留给 owner 批准，不得由循环自行合并（`rsi/MANDATE.md` 红线；`rsi/runtime/merge.sh` 的红线路径表不覆盖 `mobile-rn/src/auth/`）。
  - R3 列表重画：iOS 分组列表——设备分区头、项目折叠、行两行式、inset hairline；状态点形状+颜色双编码；待批计数红 pill；搜索进导航条。
  - R4 对话重画：活动脊 + markdown 渲染（段落/标题/列表/代码块/表格横滚/引用）；用户气泡右对齐蓝色；工具行折叠成 mono 一行；轮末 meta 行。
  - R5 composer 与审批：composer 玻璃底胶囊、发送圆形按钮、运行中变停止；排队消息行带撤回；审批卡浮在 composer 上方——命令 mono、批准实心/拒绝描边，一屏一个实心主按钮；批准/拒绝 expo-haptics 反馈。
  - R6 用量 sheet：底部 sheet、抓握条、分段 本周/30天/90天、provider 行带身份色与占比条。
  - markdown 渲染用自绘精简渲染器，复用 shared 解析，不引新库（决定 D4，见审阅页；要全量 markdown 再议）。
  - 新依赖三个，都是 expo 官方包：`expo-haptics`、`expo-symbols`（SF Symbols）、`expo-glass-effect`（iOS 26 液态玻璃,旧系统回落 BlurView）；第一个使用它们的实现 PR 必须同步更新 ADR 0036 的依赖表与签名测试。
  - 空/加载/失败/断线四态按帧重画（骨架条、断线横幅、空态文案）。
- 不做：
  - 行为变化：KIN-MOBILE-001 已签的交互、状态、流程一格不动；本条只换皮与补 token。唯一例外是 D3 的局域网 http 确认（见 R2），它按 MANDATE 走 ADR + `needs-ceo`。
  - 底部 tab bar：RN 只有列表一个一级页；例行任务/运维进 RN 时另开故事。
  - 新建对话入口、推送、设置其余页面：各有去处，不在本条。
  - Android 适配：`app.json` 的 android 块是空的；帧按 iOS 画，Android 另开故事。
  - web/桌面改动：一行不动。

## 每一步的预期

### 1. 定义：token 层立起来，全 App 换肤

| 项 | 预期 |
|---|---|
| 起点 | RN 组件里 113 处颜色字面量，无 token 模块 |
| 动作 | 建 `theme/tokens.ts` 与 `useTheme()`；逐组件替换字面量 |
| 立刻看到 | 暗色模式下图标/文字/底色全部正确；浅色同样成立 |
| 慢 / 空 / 失败 / 断线 | 不适用（编译期保证） |
| 键盘与焦点 | 焦点环用 token 的 focus-ring 色，粗指针/键盘导航可见 |
| 离开再回来 | 系统切换明暗时界面跟随，不闪错色 |

### 2. 定位：列表一眼看出哪条要我动手

| 项 | 预期 |
|---|---|
| 起点 | 已登录，落在列表 |
| 动作 | 扫行、展开项目、搜索 |
| 立刻看到 | 分组列表：待批的行橙三角+红计数 pill 最先被看到；运行中蓝点；行间距与 hairline 对齐 iOS 习惯 |
| 慢 / 空 / 失败 / 断线 | 骨架条按帧 06 的中间小图；空态「还没有对话」居中两行；断线横幅橙色但不挡行 |
| 键盘与焦点 | 行高 ≥54pt、触控区整行；VoiceOver 读出标题+状态 |
| 离开再回来 | 折叠/滚动/搜索词保留（行为不变） |

### 3. 确认：对话能读——markdown、脊、工具行

| 项 | 预期 |
|---|---|
| 起点 | 打开一条对话 |
| 动作 | 滚动阅读，展开工具行 |
| 立刻看到 | 每轮左缘状态脊；markdown 正常渲染（标题/列表/代码/表格横滚不出屏）；用户气泡蓝底白字靠右 |
| 慢 / 空 / 失败 / 断线 | 流式时脊为蓝、活动行「运行中 · 已用 N Token」；断线内容不丢（行为不变） |
| 键盘与焦点 | 表格可聚焦读表头；新增文本不抢焦点（行为不变） |
| 离开再回来 | 阅读位置保留（行为不变） |

### 4. 执行：发送、排队、批准

| 项 | 预期 |
|---|---|
| 起点 | composer 在底部 |
| 动作 | 输入发送；运行中排队；批准一条审批 |
| 立刻看到 | composer 玻璃底胶囊；发送按钮圆形实心仅在有草稿时；审批卡浮在 composer 上方，命令 mono 可读；批准后 success 触感一次 |
| 慢 / 空 / 失败 / 断线 | 提交中禁用（行为不变）；失败卡片恢复并说明（行为不变） |
| 键盘与焦点 | 键盘弹出时 composer 贴键盘上方（行为不变）；批准/拒绝读屏读出动作与对象 |
| 离开再回来 | 草稿保留（行为不变） |

### 5. 收尾：用量 sheet

| 项 | 预期 |
|---|---|
| 起点 | 对话头「用量」 |
| 动作 | 打开 sheet、切窗口、下拉关闭 |
| 立刻看到 | sheet 圆角 20、抓握条；provider 行身份色圆点+占比条+金额，数字 tabular figures |
| 慢 / 空 / 失败 / 断线 | 骨架、空态、失败标记按已签行为 |
| 键盘与焦点 | 焦点进 sheet 标题，关闭回到「用量」（行为不变） |
| 离开再回来 | 窗口选择保留（行为不变） |

## 各面差异

| 面 | 这一面怎么呈现 | 为什么不同 |
|---|---|---|
| Mac | 没有：本条只动 `mobile-rn/`；桌面 token 早已在 `theme.css`，本条是把它端口到手机，不是反向改桌面 | 桌面视觉系统已签已量，不需要重画 |
| 手机 | 390×844 单列;iPad 820 沿用同 token,布局走已签规则;明暗两套都按帧的 token 表实现 | token 与 platform 习惯是手机特有的缺口 |

## 设计

设计稿：`KIN-MOBILE-002.figma/frames/`（6 帧：01 连接、02 列表、03 对话、04 composer+审批、05 用量 sheet、06 状态三联）与 `KIN-MOBILE-002.review.html`。设计系统全文在 `mobile-rn/DESIGN.md`。

必须画到的状态：默认列表、空列表、加载骨架、断线横幅、运行中流式、等待批准、排队、用量默认。错误态沿用 KIN-MOBILE-001 帧，本条不重复画。

## Do not

- 不许改 KIN-MOBILE-001 已签的行为、状态机、接口或 shared 逻辑；本条是视觉交付。
- 不许再出现颜色字面量：全部颜色走 `theme/tokens.ts`；lint 或测试兜底。
- 不许引 markdown 渲染库（决定 D4）；三个 expo 包之外不加依赖。
- 不许把 tab bar、新建入口、推送塞进本条。
- 不许关闭 `allowFontScaling`，不许把触控目标缩到 44pt 以下。
- 不许在帧或夹具里放真实数据、主机名、token。

## 验收

| 层级 | 位置 | Given / When / Then |
|---|---|---|
| token parity | `mobile-rn/src/theme/tokens.parity.test.ts`（新） | Given `ui/src/design/theme.css` 原文 When 解析 Then RN tokens 的每个色值与之一致；Given web 改一个色 When 跑 Then 红 |
| 字面量 guard | `mobile-rn/src/theme/noLiterals.test.ts`（新） | Given `mobile-rn/src` 与 `app` 源文件 When 扫 hex/rgb 字面量 Then 为零（token 模块自身与测试夹具除外） |
| 明暗两套 | `mobile-rn/src/theme/theme.test.ts`（新） | Given 系统暗/亮 When 渲染列表与对话 Then 关键元素的色值取自对应 scheme；对比度抽样 ≥4.5:1 |
| R2 连接页 | `mobile-rn/src/screens/pair.visual.test.tsx` | Given 局域网 http 地址 When 提交 Then 先出「不安全 / 凭据明文传输」确认，确认后才连；Given 拒绝 Then 不连接且不记住确认；Given 同一 origin 已确认 When 重连 Then 不重复询问；Given 地址变化 When 提交 Then 重新确认；https 直接连 |
| R3 列表 | `mobile-rn/src/screens/ConversationList.visual.test.tsx` | Given 三种状态行 When 渲染 Then 状态点形状+颜色、待批 pill、分组头与折叠在 |
| R4 对话 | `mobile-rn/src/screens/Conversation.visual.test.tsx` | Given 含标题/列表/代码/表格的回答 When 渲染 Then 各元素按类型渲染、表格可横滚、脊色随状态 |
| R5 审批 | `mobile-rn/src/screens/Approvals.visual.test.tsx` | Given 待批 When 渲染 Then 批准是唯一实心主按钮；Given 批准成功 Then haptics 被调一次 |
| 视觉 | 390×844 与 820×1180 截图，明暗各一组 | 对照 6 帧逐屏核对 |

测试文件里必须出现 `KIN-MOBILE-002`。

## 证据

- 之前：`rsi/state/shots/rn-evidence-refresh/390-list.png`、`390-conversation.png`（白底卡片行、markdown 原文、裸输入框）；颜色字面量统计 `rg -n "#[0-9a-fA-F]{6}" mobile-rn/src mobile-rn/app` 共 113 处（2026-11-27，`bea7329e`）。
- 之后：交付时补截图与 dogfood 记录。

## 变更记录

- 2026-11-27 创建（draft）。owner dogfood 后要求按 mobile-design/open-design 的方法做正经设计;设计流程按 `~/.agents/skills/mobile-design` 执行,token 端口 astryx neutral 已在桌面落地的同一套（`ui/src/design/theme.css`）。
- 2026-11-27 · CEO 受托签字 `approved`：D1–D5 全部按推荐通过；按顾问指出的最大风险，把 D3 收紧为「明确凭据明文传输、按 origin 记住一次、地址变化重新确认、拒绝/确认/重连均有测试」，并把 D5 的「实现 PR 同步更新 ADR 0036 依赖表与签名测试」写进范围（决策见 `rsi/DECISIONS.md` 同日）。
