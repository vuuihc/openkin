# UX 整体统一：四区导航、共享外壳与 Astryx 交互底座

> **For the executing agent:** this is the design gate and programme plan, not permission to write product code. Do not begin Goal 1 until the consolidated Figma-first design review has been signed. Use an isolated worktree per internal landing and follow the repository completion gate.

## 现在的位置

| 项 | 状态 | 证据 / 下一步 |
|---|---|---|
| 方向：保留功能，统一导航、布局、交互、状态和动效 | 🟢 已与用户确定 | 2026-11-14 对话；§1 |
| 四区：对话 / 项目 / 例行任务 / 设置 | 🟢 已与用户确定 | B 方案；归档是对话筛选，Agent 运维归设置 |
| Mac / 手机：同一 IA，不同容器 | 🟢 已与用户确定 | Mac 侧栏双栏；手机四 Tab + 各自页面栈 |
| 视觉：继续 Kin，不换主题与品牌 | 🟢 已与用户确定 | `--kin-*` 与不变量测试继续使用 |
| 人工节点：总设计签字 + 整体交付验收 | 🟢 已与用户确定 | 两个 Goal 而不是八次逐区确认 |
| 单一总设计 Figma 审阅页 | 🔴 未制作、未签字 | **唯一挡住产品代码的事项**，见 Goal 0 |
| Astryx 固定接入成本 | 🟢 已实测 | [spike](2026-11-09-astryx-spike.md)：React 19 可构建，主题可映射，+83.9 kB raw / +25.1 kB gzip |
| Tailwind 4 兼容 | 🟡 已验证路径，未落地主线 | 现有 spike：6 个失败用例、4 个测试类型错误、无层级 CSS 要审计 |
| 当前故事与导航合同 | 🟡 存在明确冲突 | `NAVIGATION.md` D8 的旧四入口/推出模型；`KIN-PROJECT-001` 陈述的项目无独立列表 |
| 当前实现与规模 | 🟢 已测量 | 95 个非测试 TSX；5 个共享控件；298 个裸 `<button>` / 68 文件；页面 17,540 行 |
| Goal 1 整体重构 | ⚪ 等总设计签字 | 五批内部落地，无需逐批找人确认 |
| Goal 2 整体回归收口 | ⚪ 未开始 | 双端旅程、状态、视觉、性能与文档的最后验收 |

本计划以 `main` 起始提交 `c7c12cc6` 的实测为基线；实际开工先重新测量。该基线不是对未开始工作的完成声明。

---

## 0. 计划怎么执行

**两个 Goal，一次总设计签字，一次整体交付验收。**

- **Goal 0 · 总设计**：将所有受影响的 IA、页面、状态、转场与决策放在**同一份**审阅页；你一次确认。签字前不写产品代码。
- **Goal 1 · 整体重构**：自动完成五批内部落地，逐批测试、AI 复审、提交与集成；中途不请求逐页验收。只有发现会破坏功能或产生不可逆代价的未决问题才暂停提问。
- **Goal 2 · 整体收口**：一次完成跨区旅程、视觉、状态、键盘、包体与文档检查；你按完整产品而不是按控件做最终验收。

**冲突处理：** Goal 0 生成统一的体验合同，取代 `NAVIGATION.md` 的旧手机 D1–D8 推出模型和旧的“项目没有独立列表”决策，但**不删除既有故事的功能合同**。受影响的故事补充本次总设计的引用、更新 IA 行与验收映射；桌面升级、通知、对话行为等本计划未改的合同继续有效。

如果 Goal 0 无法同时满足“一份手机可读的完整 Figma 审阅页”和“清楚表达完整四区”，**停止并调整框架**，不能靠直接改代码绕过签字，也不能把签字拆成八次。

## 1. 保留功能，统一体验

### 1.1 最终结构

| 一级区域 | 拥有什么 | 不是什么 |
|---|---|---|
| 对话 | 全部 / 待处理 / 已归档的同一对话集合；搜索；设备 → 项目 → 对话；对话详情、新建 | 归档不是第五区；项目筛选不生成第二份对话列表 |
| 项目 | 项目集合、设备范围、搜索、项目封面及继续对话入口 | 不复制对话全文流；不建设另一套项目管理功能 |
| 例行任务 | 机器上下文、任务列表、创建/编辑/运行、远程运行详情 | 不把机器切换变成第六种导航 |
| 设置 | 运行默认值、机器上的 Agent、用量、导入与其他现有设置 | Agent 运维继续拥有自身内容，但入口归入设置 |

**平台差异：** Mac 是左侧四区导航 + 区域列表/内容 + 详情区；手机是四个真正的 Tab，每区保留自己的页面栈，详情/新建是该栈的推进页面。不能把桌面横向布局直接缩成手机，或把底部 Sheet 直接搬到 Mac。

### 1.2 “顺滑”的精确定义

1. 四区共享稳定的位置、图标、标题、选中规则与返回规则。
2. 四区切换不重建整个应用外壳，不整页白屏；保留区域自己的筛选、选中、滚动位置与未提交编辑。
3. 一级区域：短暂淡入 + 轻微位移；二级页面：方向对称的推进/返回。
4. 无横向 Tab 滑动：避免与文本、列表滑动、横向代码和系统手势冲突。
5. Mac 不进行手机式整页滑动；它更新对应内容区，保留侧栏和常驻面板。
6. `prefers-reduced-motion` 与系统设置必须取消非必要位移；隐藏页面和关闭浮层不响应键盘。
7. URL 描述当前区域、筛选与详情；历史返回先关浮层，再退栈，再切区域；冷启动详情的父级仍是该区域。
8. 离开未提交编辑时仍走 `leaveGuard`；系统返回、页头返回与左缘手势必须一致。

### 1.3 明确不做

- 不改 Go API、数据库、调度、provider、agent 流式协议或权限语义。
- 不改通知该在何时触发，不把通知变成另一个列表。
- 不删除导入、归档、远程例程、运行详情、终端、审批等功能来换取布局整齐。
- 不先自己实现一套 Button/Menu/Dialog，再与 Astryx 平行维护。
- 不照搬 Astryx 自带的 AppShell 导航假设；外壳由 Kin IA 决定。
- 不在同一工程同时换主题、换品牌、换字体或新增产品功能。

## 2. 组件与数据架构

| 层 | 谁负责 | 原则 |
|---|---|---|
| Token / 视觉 | `ui/src/design/`、`ui/src/index.css` | 色彩只能来自现有 token；Astryx 主题只是适配，不替代 token 不变量 |
| 交互 primitives | Astryx | Button、Field、Select、Menu、Dialog、Tabs、BottomSheet；需要平台形态时由 Kin 包装一次 |
| 应用外壳 | `AppShell.tsx`、`App.tsx`、现有 sidebar / mobile navigation 的替换实现 | 四区、页面栈、稳定导航、断线、审批与面板 |
| 领域组件 | `SessionList`、`ChatStream`、`Composer`、`RunConfigSheet` 等 | 保留数据、异步、业务状态；逐步移除手写 primitive |
| 数据 / URL | 现有 API、live resources、Zustand、React Router | 现有缓存与 WebSocket 保留；导航/筛选在地址中可恢复 |
| 规格与防回归 | `docs/product/`、story 验收、测试、ESLint | 文档写产品行为；测试与 lint 保护它 |

不为“未来可能需要”增加通用表格、图表、富文本或复合状态机。只有当前页面需要及设计稿明确要求的组件进入范围。

## Goal 0 · 一次性总设计与签字

**输入：** 本计划的已定决策，不再询问已确定的四区、平台、动效和视觉边界。

**Files:**

- Create: `docs/product/stories/KIN-CONTINUE-003.md`
- Create: `docs/product/stories/KIN-CONTINUE-003.figma/frames/*.svg`
- Create: `docs/product/stories/KIN-CONTINUE-003.review.html`
- Create: `docs/product/stories/ux-unification-story-map.md`
- Modify: `docs/product/stories/registry.json`
- Modify: `docs/product/stories/PLAN.md`
- Modify: `docs/product/IA.md`
- Modify: `docs/product/NAVIGATION.md`
- Modify: this plan's status section

`python3 scripts/stories.py new CONTINUE "四区导航与统一控制台" --journeys J1,J2,J3,J4,J5,J6,J7 --surfaces mac,phone` 用来生成实际编号与模板；如果编号不是 CONTINUE-003，全文同步为实际编号。story 的 intent 是**继续/在控制台中移动**，不是新功能。其余故事的功能与状态约束通过 map 引用，不复制成第二份合同。

**步骤：**

1. 功能保留矩阵：逐一登记 `/sessions`、`/tasks/:id`、`/new`、`/projects/:id`、项目集合、`/routines`、远程运行、`/agents`、`/settings`、导入会话、审批、终端和托盘。记录旧 URL → 新 URL → 父级 → 保留能力 → 对应测试。
2. 画四区根页面和详情页，共至少 Mac 1100×760 与手机 390×844 两组；每帧涵盖：起点、动作、立刻看到、慢/空/失败/断线、键盘与焦点、离开再回来。
3. 画状态板和导航行为板：Tab 切换、详情推进、关闭新建、通知深链、冷启动、断线、审批、未保存编辑、reduced-motion。
4. 在审阅页开头写 MECE：六条意图仍保留；四区不是第四种功能划分；其他故事管功能，总设计管共享面。说明将替换哪些旧决策。
5. 审阅页从 `_REVIEW.html` 建立；必须满足 `figma-flow-v1`、离线 SVG、390px 不整体横滚、no CDN、暗色、sticky TOC、可复制回复模板。所有数据用占位符。
6. 把所有已定决策标为「已定」，而不是重新提问；留下总设计一并签字的回复模板。
7. 运行 `python3 scripts/stories.py`；预期 draft 阶段可验证合同与骨架，**不把状态置 approved 直到真实用户签字**。
8. 文档作一次 `docs(product): unify the console navigation and experience contract` 提交。纯文档走自动自审/自动评审；不要求额外的人工关卡。

**完成：** 你一次确认总设计；计划表格将“总设计”标为绿，记录签字日期；Goal 1 才开始。

## Goal 1 · 整体重构

**执行方法：** 每个 batch 是一次独立的会话/落地，不为单个页面要求人工签字。每批先写能失败的验收测试，再实现；相关检查全绿后走同模型高级复审，修复 blocker / major，再提交与集成。若单批 diff 超过约 800 行，按**技术依赖**进一步细分提交，不增加人工验收节点。

### Batch A · 一次性解决兼容底座

**Files:**

- Modify: `ui/package.json`, lockfile, `ui/postcss.config.js`, `ui/tailwind.config.ts`, `ui/src/index.css`
- Modify: `ui/src/design/tokens.test.ts`, `ui/src/design/tailwind.test.ts`
- Modify: `ui/eslint.config.js`, `ui/eslint-rules/*` only where the v4 config reader requires it
- Create: `ui/src/design/AstryxProvider.tsx`, theme adapter + tests
- Create: `ui/src/pages/DesignSystemPage.tsx` and a development-only route
- Create: `docs/product/design/astryx-bridge.md`
- Test: existing UI suite and token tests, plus provider tests

**步骤：**

1. 先跑 `cd ui && npm ci && npm run typecheck && npm test && npm run build && cd .. && ./scripts/check.sh`，记录主线现状。
2. 基于已完成 spike 的经验，安装 React 19、ReactDOM 19、Astryx core + neutral theme、StyleX 和 Tailwind 4/PostCSS 插件。**实际版本在安装时重新确认，不把 spike 的过时版本号当合同。**
3. 先增加 layer-order / body-background / token 编译测试；确认新 Tailwind 行为下失败，再迁移。
4. 重写 `resolveConfig` / v3 PostCSS 测试依赖，使用 v4 的编译 API；保留全部对比度、L*、焦点环等断言。必须为 v4 的单层化规则变化写回归。
5. 接入 Provider：65 个 Kin token 逐项映射或明确标为 Kin 扩展；`data-theme` 驱动 `color-scheme`；语言、控件文案走 `ui/src/i18n/`；触屏点按 ≥44px；reduced-motion。
6. `/dev/components` 展示所有被采用的控件、平台形态、默认/悬停/按下/焦点/禁用/加载/错误/IME/断线状态；生产构建不暴露该入口。
7. 390/1100 整站截图回归，不只拍 gallery；记录 body 背景、placeholder、outline、圆角等预期变化。
8. 验收：`npm run typecheck`、`npm test`、`npm run lint`、`npm run build`、全 token 测试；无意外旧页面基线破坏。

**提交：** `feat(ui): establish the Astryx and Tailwind compatibility layer`，以及源改变时同步的 `web/dist/index.html`。只提交 index，不提交 `web/dist/assets/`。

### Batch B · 四区外壳与统一导航

**Files:**

- Modify: `ui/src/App.tsx`, `ui/src/components/layout/AppShell.tsx`
- Replace/restructure: `ui/src/components/layout/Sidebar.tsx`, `PhoneFooter.tsx`, `MobileHeader.tsx`/`SessionsHeader.tsx` as the signed frames require
- Create: `ui/src/lib/areas.ts`, `ui/src/lib/areaNavigation.ts`, `ui/src/lib/areaTransition.ts` (split only if behavior needs it)
- Create: `ui/src/lib/areaNavigation.test.ts`, `ui/src/components/layout/AreaNavigation.dom.test.tsx`
- Modify: `ui/src/lib/phoneBack.ts`, `phoneNavigation.ts`, `phoneDeepLinkParent.ts`, `useEdgeSwipeBack.ts`, `leaveGuard.ts`
- Modify: `ui/src/pages/SessionsRoute.tsx`, `StartRoute.tsx`, `TaskSessionHost.tsx` and drawer/stack hosts required by the final frames
- Modify: `ui/src/components/CommandPalette.tsx`, `NotificationTaps.tsx`, `ui/src/lib/notificationRoute.ts`
- Modify: `ui/src/components/layout/PhoneNavigation.dom.test.tsx`, `PhonePushTargets.dom.test.tsx`, deep-link/back/edge tests

**步骤：**

1. 把旧合同改为测试中的红灯：四个同级目的地、当前区域高亮、Tab 切换留在当前区、父级不再是全局 `/sessions`。
2. 实现单一 area 定义表：id、i18n 名称、图标、根路径、Mac/手机导航归属、页面栈父级；不允许各组件独立推断当前区。
3. 建立四区路由与 URL 重定向，通知落点和命令面板改用新 area 路径；旧 `/agents` 默认重定向到设置内 Agent 分区，深链参数保留。
4. 手机四 Tab 的栈分别管理返回与滚动；详情/新建正确覆盖当前区域；左缘仍是返回，不增加跨 Tab 横滑。
5. Mac 侧栏选中区、列表与详情双栏共享稳定的页头与面板几何；保留 TaskSessionHost 缓存、终端、审批、连接门与托盘例外。
6. 统一转场与 reduced-motion；页面切区不重复获取全站数据，不令 WebSocket 或流式 session 卸载。
7. 验证四套区域各自首次进入/离开/回来、冷启动、通知、命令面板、浏览器 Back、编辑 guard、隐藏层热键隔离。
8. 验收：上述 DOM/history/gesture 测试 + `npm test`；390/1100 的四区切换与详情返回截图。

**提交：** `refactor(ui): share four-area navigation across desktop and phone`。若本批与 A 的累计 diff 已过大，先拆路由合同、再拆视图，禁止为了“整体感”把未测试的行为一起改。

### Batch C · 对话与新建：最高频路径

**Files:**

- Modify: `ui/src/pages/SessionsPage.tsx`, `SessionsRoute.tsx`, `StartRoute.tsx`, `NewChatPage.tsx`, `TaskSessionHost.tsx`, `TaskDetailPage.tsx`
- Modify: `ui/src/components/sessions/SessionList.tsx`, `SessionFilters.tsx` under `components/ui/`
- Modify: `ui/src/components/mobile/SessionsSearch.tsx`, `MobileList.tsx`, `SessionRowActions.tsx`
- Modify: `ui/src/components/chat/Composer.tsx`, `ChatStream.tsx`, `RunConfigSheet.tsx`, `PermissionModePicker.tsx`, `ModelPicker.tsx` as needed for layout/primitives only
- Create: `ui/src/components/sessions/ConversationScopeFilter.tsx` **only if** `SessionFilters` cannot express the signed selected/archive treatment
- Modify: associated DOM/wiring tests and `docs/product/components/session-filters.md`

**步骤：**

1. 为“归档是同一集合的范围、不是导航目的地”写红灯；为唯一列表、唯一搜索、设备 → 项目 → 对话保持写回归。
2. ​​把范围筛选、搜索和选中项接到 URL / 区域状态；从详情返回恢复原筛选与滚动。
3. 按帧重排列表与新建页密度：手机单一内容栏与详情栈，Mac 利用详情区而不是一条窄栏。
4. 以 Astryx 替换该路径按钮、输入、菜单和弹层；焦点、IME、Escape、未发送草稿、权限桌面菜单与手机 Sheet 契约保留。
5. 不重写流式、轮次、审批、终端和数据获取；通过旧 `TaskDetailPage` / `Composer` 测试证明只是外层与 primitive 变化。
6. 验收：J1/J2/J3、pin/archive/delete、通知定位、模型/权限、pending send、断线和 focus 测试；390/1100 前后截图。

**提交：** `refactor(ui): unify conversation navigation and composition`，测试一并交付。

### Batch D · 项目与例行任务

**Files:**

- Modify: `ui/src/pages/ProjectDetailPage.tsx`, `RoutinesPage.tsx`, `MachineTaskPage.tsx`, `ui/src/App.tsx`
- Create: `ui/src/pages/ProjectsPage.tsx` or the exact collection host specified in the signed frames
- Create: `ui/src/lib/projectCollection.ts` only if existing `projectChats.ts` cannot own the derived collection
- Modify: `ui/src/lib/projectChats.ts`, `projectScroll.ts`, routine `routineDevice.ts`, `routineEdit.ts`, `routineConversation.ts`
- Modify: `ui/src/components/settings/RoutingSettings.tsx` only where device context is actually shared
- Modify: `ProjectDetailPage.dom.test.tsx`, `RoutinesPage*.test.tsx`, `projectChats*.test.ts`, `routine*.test.ts`

**步骤：**

1. 为项目区根集合、slug/ID 深链、从列表到项目封面、返回到原机器/搜索/滚动写红灯。
2. 项目列表与对话列表分别拥有自己的用途；项目封面的最近对话不复制第二份对话列表。
3. 保留 One-Pager、当前焦点、两周热力图、最近活动、项目例程独立失败/保留旧数据的语义。
4. 例程继续以所拥有机器为数据源：最近选择、离线/加载失败、badge 和远程运行详情不能被重新布局改变。
5. 表单与按钮切到 Astryx；Mac 桌面面板、手机 Sheet 保持不同形态。
6. 验收：J4、项目返回、远程运行选择、创建/编辑保护、空/失败/断线、标题与滚动恢复。

**提交：** `refactor(ui): give projects and routines a consistent workspace`。

### Batch E · 设置、Agent 与全局控件收敛

**Files:**

- Modify: `ui/src/pages/SettingsPage.tsx`, `AgentsPage.tsx`, `AgentSessionDetailPage.tsx`
- Move/split: Agents body into `ui/src/components/settings/AgentOperationsSection.tsx` or smaller domain pieces dictated by the signed frames; old `/agents` becomes redirect, not a second view
- Modify: `ui/src/components/settings/SettingsPrimitives.tsx`, `ProviderSettingsSection.tsx`, `LocalAgentSettingsSection.tsx`, `AccountSection.tsx`
- Modify: `ui/src/components/ui/*.tsx`, mobile `Sheet.tsx`, `useAnchoredPanel.ts` wrappers required to adopt Astryx once
- Modify: `ui/eslint.config.js` with targeted legacy primitive restrictions
- Modify: `docs/product/components/*.md`, `ui/src/i18n/locales/en.ts`, `zh.ts`

**步骤：**

1. 设置根与 Agent 分区的路由、标题、返回、深链和离开保护先红后绿。
2. 保留本地 agent 发现、明确确认接入、导入、机器/用量视图与失败隔离；禁止因 tabs 切换触发秘密或第三方读取。
3. 表单 label/hint/error/`aria-describedby`、按钮、浮层统一；手机原生键盘与 Mac 焦点归还重测。
4. 清除这批已迁移的 `kin-btn` / 裸 menu/dialog 写法；能禁止的 lint 禁掉，不能禁止的必须有可定位原因。
5. 验收：J6、J7 控制台落点、导入与 agent 目录、设置离开保护、键盘/IME、权限面板平台差异、中英与双尺寸截图。

**提交：** `refactor(ui): converge settings and agent controls on shared primitives`。

### Goal 1 自动质量门

每个 Batch：

1. `python3 scripts/ui_inventory.py` 将结果写入该批工作记录，不手抄旧数。
2. `cd ui && npm run typecheck && npm test && npm run lint && npm run build`。
3. 根目录 `./scripts/check.sh`；后端若未改动，不为“看起来完整”去改 Go。
4. `python3 scripts/stories.py` 验证 registry 与故事/测试映射。
5. 高模型同模型 subagent 审查完整 diff 与调用点；修复 blocker / major，复审到无重大项。修复遵守红验证。
6. 原子 Conventional Commit + 集成到 `main`；UI 源变更同步 `web/dist/index.html`，不提交 assets。
7. 需要桌面新外壳时运行 `./scripts/desktop-rebuild.sh`；不绕过仓库脚本。
8. 更新本计划“现在的位置”和 §5 实测表，下一轮无需依赖会话记忆。

## Goal 2 · 整体回归收口（唯一最终人工验收）

### Task 1 · 端到端旅程

| 旅程 | 必须证明 |
|---|---|
| J1 手机继续 | 启动进入对话，按项目/设备定位、归档恢复、继续、批准；Tab 返回保持筛选与滚动 |
| J2 Mac 继续 | 搜索、继续、模型/权限、diff、快捷键归当前层、外壳不整页刷新 |
| J3 新建 | 双端新建、设备/项目/模型/权限、草稿保护、开始与返回 |
| J4 项目/例程 | 项目集合与封面、远程机器例程、运行详情不出现路由孤岛 |
| J5 管理 | pin/rename/archive/delete 未因新布局丢失 |
| J6 设置与 Agent | Agent 归设置；远程/离线/未授权与导入行为保持 |
| J7 通知 | 通知点到正确对话/卡片，返回正确区域；不新增批准列表 |

每条在 390×844、1100×760 做完整操作与截图；额外 1280×800 检查 Mac 密度。优先真实本地 binary（`./scripts/smoke.sh`）与可用的浏览器工具，不用“jsdom 通过”冒充视觉验收。

### Task 2 · 全局状态与回归

- 加载、空、错误、断线、运行中、等待批准、等待回答均按该面真实需要覆盖，不是强行给每页八种状态。
- 安全区、输入法、焦点与键盘、reduced-motion、长标题、中文、窄宽度、触控目标。
- 跨四区切换时 WebSocket、终端、未发送草稿、进行中的流式与远程数据不中断。
- 验证 Bundle：与开工基线比 raw/gzip、CSS、首次加载和路由切换；若超过 spike 的大小预期给出原因和实测，而非假定 tree-shaking 已成功。
- `go test ./...` 或脚本匹配的后端范围，确认没有误改 API；`make test` 或 `./scripts/check.sh --all`、smoke、UI build/lint/test、desktop tests 全跑。

### Task 3 · 采用率与文档

以开工复测为基线，而非只盯 2026-11-14 的绝对数：

| 指标 | 基线 | 方向 / 完成目标 |
|---|---:|---|
| 裸 `<button>` 文件 | 68 | `<25`，或每个例外都有原因 |
| `kin-btn` 作为页面 API | 15 文件 / 49 处 | 仅能出现在受控适配层 |
| 手写 menu / dialog / tab | 6 / 10 / 4 文件 | 收进各自单项实现 |
| 共享控件具备契约文档 | 5 | 所有跨页 primitive 都有 |
| 四区导航测试 | 旧模型 | 全部改为新的 URL/父级/栈/动效合同 |

- 删除或重写 `NAVIGATION.md` 的旧入口/推出叙述，更新 `IA.md` 与所有受影响 story。
- 更新 `TASTE.md`：四区、各栈状态保留、转场与 Astryx 的采用边界；能测试才留下。
- 组件文档写实际行为、键盘、平台差异，不抄 Astryx 宣传。
- 最终 `git status`、diff、秘密与真实基础设施扫描；未提交的他人改动不混入。

### Task 4 · 最终验收材料

一份简短验收说明放在计划状态后：**先说哪些旅程已可用，再列红项、未验证项和包体变化，最后给截图/证据与本计划链接。** 只需要你做一次集中走查，不要求读提交历史。

任一功能缺失、导航死路、键盘陷阱、真实页面严重回归属于未完成；不将其降格为 polish。

## 3. 测量与实际回填

| 阶段 | 文件数 / 源码行 / 测试行 | 测试变化 | 包体变化 | 决策 / 阻塞 | 结果 |
|---|---|---|---|---|---|
| Goal 0 | 待实际 | 合同检查 | 无 | 总设计签字 | 未开始 |
| Batch A | 待实际 | 6 个已知失败用例 + Provider / CSS | 以实测为准 | 上游版本复核 | 未开始 |
| Batch B | 待实际 | 导航 / deep-link / history | 待测 | 项目集合 URL | 未开始 |
| Batch C | 待实际 | 列表 / 对话 / 新建 | 待测 | 无新增功能 | 未开始 |
| Batch D | 待实际 | 项目 / 例程 | 待测 | 不复制合同 | 未开始 |
| Batch E | 待实际 | 设置 / Agent / primitive | 待测 | 秘密不被隐式读取 | 未开始 |
| Goal 2 | 待实际 | 全旅程 / smoke / full suite | 最终差值 | 总体验收 | 未开始 |

**规模陈述：** 已知范围是 95 个非测试 TSX、17,540 行页面、37,797 行 components（含测试）、四个一级区域、五个内部批次。没有足够依据将它写成具体完工天数；实施者每轮回填文件、行数、测试和阻塞，而不是预测“几个小时”。

## 4. 唯一的常规暂停条件

减少干预不等于擅自扩大范围。只在以下情况暂停问人：

1. 必须改变既有功能或真实数据语义；
2. 必须采用会引入持久损失/对外发布的动作；
3. 总设计签字的决策彼此无法同时实现；
4. Astryx 0.7.x 的实测行为迫使重新改变已确定的平台模型，需给出哪种行为、哪些页面及具体选项。

其余布局、实现、测试修复、依赖 spike 已验证事项、常规 bug 修复和可逆提交自主完成。
