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
| Goal 0 · 总设计 | 🟡 已制作，待签字 | [审阅页](../product/stories/KIN-CONTINUE-003.review.html) + [合同](../product/stories/KIN-CONTINUE-003.md)；通知生命周期 / 项目刷新等复审问题已修正，独立复审无 blocker/major，尚无人为签字 |
| 手机文件修复（RESULT-002） | 🟡 独立小设计已复审，无 blocker/major；待人为签字，产品未改 | [审阅页](../product/stories/KIN-RESULT-002.review.html)：3 帧 / 3 套流程；390/1100 真浏览器通过。历史/OIDC/HTML 合同两轮修正后窄复审通过；范围仅文件/diff 返回、自包含 HTML 预览、source 深链；**不是 Goal 1 开工** |
| Astryx 固定接入成本 | 🟢 已实测并落地 | [spike](2026-11-09-astryx-spike.md) 的 +83.9 kB raw / +25.1 kB gzip 只是 Button/TextInput/Theme 三个入口的 spike 成本；F3 #80 `8fbe3fa3` 已接入主线，最终包体差值与测量方法见下方《验收说明（2026-11-17）》§4 |
| Tailwind 4 兼容 | 🟢 已落地主线 | F1 #67 `37f63772`：`tailwindcss@4` + `@tailwindcss/postcss` 替换 v3 管线，layer / 对比度 / 焦点环回归测试随迁移通过 |
| 当前故事与导航合同 | 🟢 已统一 | G2 #149 `49ddf5a0` 把 `NAVIGATION.md` 与 `IA.md` 改成四区 / 四入口合同；G2b #154 `2ea8e07b` 补齐组件契约。旧的「项目无独立列表」不再成立 |
| 当前实现与规模 | 🟢 已复测 | `fb0dd3eb`：116 个非测试 TSX；12 个共享控件；85 个裸 `<button>` / 42 文件（开工基线 299 / 69）；页面 18,490 行（同口径基线 17,540） |
| Goal 1 整体重构 | 🟢 五批已落地 | PR #59–#160；G1（lint 收口）#161 在 `fb0dd3eb` 测量之后以 `3ecae5d9` 落地，其 lint 禁令已在 `main`，但该次走查未复验，见验收说明「未验证项」 |
| Goal 2 整体回归收口 | 🟢 验收说明已填 | 见下方《验收说明（2026-11-17）》：J1–J7、红项、未验证项、包体与手写控件、UX 分数、证据 |

本计划以 `main` 起始提交 `c7c12cc6` 的实测为基线；实际开工先重新测量。该基线不是对未开始工作的完成声明。

## 验收说明（2026-11-17）

测量于 `fb0dd3eb0eb33417219186d3bcc805f9da570893`（`origin/main`，2026-11-17 05:53；C3b #158 合并后的树）。复走于 `9c651cf21b9f5451291a1bdced25071784e1065c`（`origin/main`，2026-11-17 18:43；走查 18:45–18:50）。§1 的 J1 / J2 / J3 / J5 / J7 行取这次复走；J4 / J6 的判定沿用 05:53 的结论（本轮同样 0 失败，截图在同目录）。下面每个数字都来自这棵树上的命令或本地 walk 输出；不能测的单独列出，不猜。

### 1. 先说哪些旅程已可用

`scripts/journeys-smoke.sh --out rsi/state/shots/journeys-reverify` 在一次性 state 目录里启动真实 daemon（临时 state、空闲端口，不碰 `:7777` / `~/.kin`），用公开 HTTP API 种子（12 个创建、1 个 skip：`routine-failed`），再按 `rsi/runtime/ux/journeys.json` 走 J1–J7：14 个「旅程 × 视口」组合、92 张截图、0 横向溢出、0 原生 `<select>`、0 个 <44px 触控目标、0 硬失败。J7 另在 `j7-fresh/` 单独复走 4 屏：主走查里 J1 已批准同一张卡，只有单独种子才能看到待批状态与「已聚焦」高亮。

| 旅程 | 今天能做什么（一句话） | 证据（PR / SHA） | 最终截图 | 原型帧 | 判定 |
|---|---|---|---|---|---|
| J1 手机继续 + 批准 | 打开对话列表（设备 → 项目 → 对话）、按项目折叠、搜「week」、开筛选；点进「[seed] Approve the migration」看到真实对话正文与审批卡，点「批准」后卡片变为「已批准 · 在线决定」；本轮没有发送新消息（walk 无发送步骤） | #168 `6838703b`（种子会话）、#195 `90a89cce`（种子审批卡）、#142 `0a33d2f5`、#120 `c762a2b9`、#136 `fe4b18a5`、#158 `fb0dd3eb` | `rsi/state/shots/journeys-reverify/J1-phone-02-conversation.png`、`J1-phone-03-approval-card.png`、`J1-phone-04-approval.png`、`J1-phone-06-search.png`、`J1-phone-07-filters.png` | `rsi/state/ux-proto/final/p01-J1-chats.png`、`p03-J1-conversation-approval.png` | 一致（7 屏 0 失败；继续=进入对话已验证） |
| J2 Mac 继续 | 搜索、筛选、打开「[seed] Morning planning」看到真实对话正文；文件面板打开 notes.md 并显示 fake agent 追加的 `[seed] change` 行（Markdown 预览，不是 hunk diff）；新建页运行设置用键盘改权限（ArrowDown + Enter → 自动编辑），模型 / Agent 选择器可开可关 | #193 `fc991fd2`（真实 diff 种子）、#168 `6838703b`、#127 `6b4325b8`、#152 `4c8a21e9`、#129 `23567013`、#150 `b7037feb`、#158 `fb0dd3eb` | `rsi/state/shots/journeys-reverify/J2-mac-04-conversation.png`、`J2-mac-05-workspace-panel.png`、`J2-mac-06-workspace-diff.png`、`J2-mac-10-permission-keyboard-choice.png`（`J2-mac-wide-*` 同名） | `rsi/state/ux-proto/final/m03-J2-search.png`、`m04-J2-permission-popover-anchored.png` | 一致（2 视口各 13 屏 0 失败；变更面板是文件内容预览） |
| J3 新建（双端） | 选工作目录、输入草稿、开始按钮可用、权限 / 模型 / Agent 选择器可开可关、关闭后焦点回到触发按钮 | #159 `e8ac61fe`、#126 `bb38d5ef`、#140 `82dfb6d6`、#148 `9a5d7674`、#797e3dd2`（44px chip） | `rsi/state/shots/journeys-reverify/J3-phone-06-started.png`、`J3-mac-06-started.png` | `rsi/state/ux-proto/final/m10-J3-new-chat.png`、`p12-J3-new-chat.png` | 一致（双端各 12 屏 0 失败；手机 0 个 <44px 目标，05:53 为 18） |
| J4 项目 + 例行任务 | 三宽度完整走通：项目集合 → 项目封面；例行任务 → 新建例行任务 → 工作目录浏览器（打开、Tab、改手动输入、选定） | #147 `b282ee4b`、#138 `0737b79e`、#137 `cf4a252a`、#140 `82dfb6d6` | `rsi/state/ux/final-acceptance/J4-phone-02-project-cover.png`、`J4-mac-04-routine-editor.png` | `rsi/state/ux-proto/final/m12-J4-projects-cover.png`、`m13-J4-routines.png` | 一致（3 视口 21 屏 0 失败） |
| J5 行操作 | hover 行 / 点行尾「更多」打开行操作：手机是底部 Sheet、Mac 是菜单，含多选、置顶、归档、删除、取消；缺已签字故事要求的「改名」，运行中的对话也没有「正在运行」提示 | #131 `ca6afee0`、#62 `695d053e`、#190 `456a922f`、#205 `62a7dcb6`；缺口见红项 | `rsi/state/shots/journeys-reverify/J5-phone-02-row-actions.png`、`J5-mac-02-row-actions.png` | `rsi/state/ux-proto/final/m19-J5-row-actions.png` | 有差距（双端菜单可开，0 失败；缺「改名」） |
| J6 设置 + Agent 运维 | 双端设置根、`?tab=operations`、旧 `/agents` 落到同一运维分区；打开设置不隐式读取 Agent | #157 `110b05b0`、#156 `037ab687`、#123 `ac6b0b80` | `rsi/state/ux/final-acceptance/J6-phone-02-operations.png`、`J6-mac-03-legacy-agents-redirect.png` | `rsi/state/ux-proto/final/m14-J6-settings.png`、`m15-J6-agent-operations.png` | 一致（双端 6 屏 0 失败） |
| J7 通知深链 | 深链落到种子会话「[seed] Approve the migration」的审批卡：手机与 Mac 都显示待批卡、蓝边与「已聚焦」徽标；手机点返回回到列表，Mac 没有返回按钮（桌面用侧栏），该步 skip | #204 `72a37296`、#195 `90a89cce`、#168 `6838703b`、#76 `3206755c`、#149 `49ddf5a0` | `rsi/state/shots/journeys-reverify/j7-fresh/J7-phone-01-landing.png`、`j7-fresh/J7-phone-02-back.png`、`j7-fresh/J7-mac-01-landing.png` | `rsi/state/ux-proto/final/m18-J7-deeplink-highlights-card.png` | 一致（手机 2 屏 0 失败；Mac 落点 0 失败，返回 skip） |

### 2. 红项

以下都是在本 SHA 上重新核对过的「还没做完」，不是历史摘抄。

- **中 · J5 行操作缺「改名」**（本轮 walk 新发现）。验证：`ui/src/components/sessions/SessionRow.tsx:270-327` 构造的行操作只有多选 / 置顶 / 归档 / 删除；手机 Sheet 与 Mac 菜单都能打开（`J5-phone-02-row-actions.png`、`J5-mac-02-row-actions.png`），但没有已签字故事 `docs/product/stories/KIN-MANAGE-001.md:57` 要求的「改名」，运行中的对话也没有该故事 `:58` 要求的「正在运行」提示。后果：标题相近的对话只能靠归档 / 删除整理，改不了名。需要单独切片补 KIN-MANAGE-001 的菜单项与本地改名（已记入 `rsi/state/needs-ceo.md`）。
- 已修（#165 `9d8fbffc` + #171 `e43b0b62`）思考与过程叙述被收进卡片 —— gap-log 2026-11-17 已移入「已修」。验证：`ui/src/components/chat/ChatStream.tsx:190-193` 在 `loading` 时以 `splitNotes` 把进行中的过程留在正文，结束的一轮收成一条带终态 / 工具数 / 时长的摘要行；测试见 `ui/src/components/chat/transcriptProjection.test.ts`、`ChatStream.prose.dom.test.tsx`、`ChatStream.summary.dom.test.tsx`。
- 已修（#205 `62a7dcb6`）长按对话行不能拖动排序 —— 验证：`ui/src/lib/taskOrder.ts` 持久化手动顺序，`ui/src/lib/phoneSessionBuckets.ts:421` 用 `applyTaskOrder` 覆盖桶内排序，`ui/src/components/mobile/SwipeReveal.tsx:244-253` 把完成的长按交给 `reorder`；测试见 `ui/src/lib/taskOrder.test.ts` 与 `ui/src/components/sessions/SessionList.drag.dom.test.tsx`。`docs/plans/gap-log.md:37` 的条目尚未移入「已修」，待随下一次 gap-log 维护同步。本轮 walk 不模拟指针手势，没有手势录像。
- 已修（#797e3dd2）手机新建页 <44px 触控目标 —— `ProjectSummaryCard.tsx` 的封面 chip 加 `inline-flex min-h-11`；本轮复走 J3/phone 12 屏 `smallTapTargets` 汇总 0（05:53 为 18）。gap-log 2026-11-17 已移入「已修」。
- 已修（#168 `6838703b` + #195 `90a89cce` + #204 `72a37296`）J7 通知深链的 `404 /api/tasks/demo-task` —— 种子现在创建真实会话与审批卡并打印 `j7 target`，walker 用它替换 `demo-task`；本轮 `j7-fresh` 双端 landing 都落在「[seed] Approve the migration」的待批卡上（已聚焦、蓝边），0 硬失败。原条目是 harness 缺口，不是页面回归。
- 已修（#61 `cf7ba2bd`）新建对话发送后整页骨架屏 —— gap-log 待随之移入「已修」。验证：`ui/src/pages/TaskDetailPage.tsx:1556-1575` 冷启动改为品牌等待块，`ui/src/pages/TaskSessionHost.tsx:104-125` 以种子行 / handoff 判定就绪；#61 的提交信息与测试正是这条。
- 已修（#62 `695d053e`）iPad 多选无法退出 —— gap-log 待移。验证：`ui/src/components/sessions/SessionToolbar.tsx:132` 工具栏 `flex-wrap` + `min-h-12`、`:182` 显式退出；`ui/src/components/sessions/SessionList.tsx:997-1007` 的 Escape 走同一路径。
- 已修（#63 `1c572b20`）手机边缘返回不跟手 —— gap-log 待移。验证：`ui/src/hooks/useEdgeSwipeBack.ts:70-71` 暴露 `dragging` 与位移，`ui/src/components/layout/AppShell.tsx:704-707` 渲染 `--page-swipe-x` / `data-kin-swiping`；行左划部分此前 #50 已修。
- 已修（#52）例行任务 655361 bytes —— `## 已修` 已有记录；`## Open` 里同标题是重复旧条目，应删除。
- 已修（#164 `91929db1`）`main.kin-main` 双 route slot（`rsi/state/followups.md` 观察项）—— `ui/src/App.tsx:185` 的 `<TaskSessionHost />` 与 `:188` 的 `<AreaRoute>` 仍是 `.kin-main` 的直接子级、各自 `flex-1`（`ui/src/pages/TaskSessionHost.tsx:221`、`ui/src/components/layout/AreaRoute.tsx:39`），但在 `/tasks/:id` 上空路由不再占位：`AreaRoute.tsx:39` 的 `empty:hidden` 与 `ui/src/index.css:544` 的 `.kin-route:empty { display: none; }` 会把 wrapper 折叠。该缺陷在 C3b 截图时观察到，且在 C3b 之前就存在。

### 3. 未验证项

- **发送新消息（J1 / J2「继续」里的发送动作）**：walk 只做 fill / click / key，没有发送步骤；本轮验证到对话正文、composer 与审批卡，没有真的发出新消息。
- **J2「看 diff」只到文件内容**：walk 打开 notes.md 后停在 Markdown 预览（能看到 fake agent 追加的行），没有切到查看器里的「差异」视图；产品有该切换（`ui/src/i18n/locales/zh.ts` 的 `viewer.diff`），本轮没有走。
- **J7/Mac 的「返回」步骤**：桌面布局没有手机上的返回按钮（Mac 用侧栏回到列表），walk 记为 skipped（not visible），不是失败；手机的同一步已走通（回到 `/sessions`）。
- **手机手势**（左缘返回跟手、行左划、拖动排序）：walk 不模拟指针手势；拖动排序已有 #205 的代码与单测，本轮没有真机 / 浏览器手势录像。
- **Electron 桌面外壳**：本轮只走浏览器 console（headless Chrome），没有重建或操作 Electron 壳。
- **包体基线口径**：基线是 pre-F1 `162fdf74`（`37f63772^`），不是程序开始前的 `c7c12cc6`；F1 之前已合并的 N1 / R1 / Q3a 等也在这条基线里。因此 §4 的差值是「新栈引入的成本」，不是整个程序相对开工日的总成本。

### 4. 包体与手写控件

| 指标 | 基线（pre-F1 `162fdf74`） | 现在（`fb0dd3eb`） | 差值 |
|---|---:|---:|---:|
| 入口 JS raw | 1,360.9 kB | 1,802.9 kB | +442.0 kB |
| 入口 JS gzip | 385.7 kB | 529.2 kB | +143.5 kB |
| 全部 JS raw | 17,141.6 kB | 17,584.9 kB | +443.2 kB |
| 全部 JS gzip | 4,388.2 kB | 4,532.4 kB | +144.2 kB |
| CSS raw | 207.8 kB | 517.9 kB | +310.1 kB |
| CSS gzip | 35.2 kB | 81.7 kB | +46.6 kB |

方法：基线在 `git worktree add /tmp/kin-acceptance-base 162fdf74` 的独立树里 `rm -rf node_modules && npm ci && npm run build`（用它自己的 lockfile；Node v22.23.4）；现在树在 `fb0dd3eb` 上 `cd ui && npm run build`。入口 = `web/dist/index.html` 指名的 `index-*.js`；全部 = `web/dist/assets/*.js` / `*.css` 求和；gzip = `gzip -9 -c`；kB = 1,000 bytes。`docs/plans/2026-11-09-astryx-spike.md` §3.5 的 +83.9 kB raw / +25.1 kB gzip 只覆盖 Button / TextInput / Theme 三个入口，且是 2026-11-09 的另一棵树；今天全量采用（React 19、Tailwind 4、Astryx primitives 与全部入口样式）后的入口增量约为该 spike 估算的 5.7 倍（gzip +143.5 kB），CSS 的 +310.1 kB raw / +46.6 kB gzip 主要是 Astryx / StyleX 生成的样式。

`python3 scripts/ui_inventory.py` 的 18 项与 `scripts/ui-inventory-baseline.json` 逐项一致：

| 指标 | 出现次数 | 文件数 | 基线文件 | 变化 |
|---|---:|---:|---:|---:|
| 裸 `<button` | 85 | 42 | 85 / 42 | 0 |
| `kin-btn` 类 | 1 | 1 | 1 / 1 | 0 |
| `<input` | 53 | 26 | 53 / 26 | 0 |
| `kin-input` 类 | 20 | 6 | 20 / 6 | 0 |
| `<textarea` | 7 | 6 | 7 / 6 | 0 |
| 原生 `<select` | 0 | 0 | 0 / 0 | 0 |
| `<label` | 40 | 15 | 40 / 15 | 0 |
| `role="menu"` | 2 | 2 | 2 / 2 | 0 |
| `role="listbox"` | 9 | 6 | 9 / 6 | 0 |
| `role="dialog"` | 13 | 8 | 13 / 8 | 0 |
| `role="tab"` | 4 | 4 | 4 / 4 | 0 |
| `role="status"` | 32 | 20 | 32 / 20 | 0 |
| `role="alert"` | 26 | 12 | 26 / 12 | 0 |
| `useAnchoredPanel` | 5 | 2 | 5 / 2 | 0 |
| `createPortal` | 8 | 4 | 8 / 4 | 0 |
| `pushToast` | 134 | 17 | 134 / 17 | 0 |
| `rounded-* + border` 表面 | 120 | 50 | 120 / 50 | 0 |
| `z-[n]` 数字层级 | 4 | 4 | 4 / 4 | 0 |

基线文件在程序中被逐步下调，而不是停在开工值：裸 `<button>` 299 / 69 → 85 / 42，`role="menu"` 7 / 6 → 2 / 2，`role="listbox"` 12 / 7 → 9 / 6，`role="dialog"` 16 / 10 → 13 / 8，`useAnchoredPanel` 22 / 6 → 5 / 2，`createPortal` 17 / 8 → 8 / 4，`rounded-* + border` 154 / 52 → 120 / 50，`z-[n]` 5 / 5 → 4 / 4。少数指标上调且有记录：`<input` 文件 25 → 26（C1c2b 把搜索框移进 Menu）、`role="status"` 31 / 18 → 32 / 20、`role="alert"` 文件 11 → 12、`pushToast` 132 → 134、独立 `kin-btn` 0 → 1（受控适配层）、`rounded-* + border` 在 #158 由 119 / 49 调到 120 / 50（C3b 的新活动 pill / 审批 dock，随 PR 记录）。所以这张表的正确读法是「实测等于已随迁移下调的棘轮」，不是「低于开工基线」；进一步收紧由 G1 的 lint 收口（#161）承接，它已在 `fb0dd3eb` 测量之后以 `3ecae5d9` 落地、禁令在 `main`，但该次走查未复验。

### 5. 各区最后一次 UX gate 分数

分数取自 `rsi/state/ux/<slug>/scores.json` 的 clarity / density / consistency / feedback / keyboard 五个键（各 1–5），mean 为五项均值；PR 号由 `rsi/state/merged.log` 解析。六个区的最后合并 PR 都落在程序内，没有停留在程序前。

| 区 | 最后合并 PR | clarity（清晰） | density（密度） | consistency（一致） | feedback（反馈） | keyboard（键盘） | mean | 判定 |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 对话（sessions / conversation） | #158 `fb0dd3eb` | 4 | 4 | 4 | 3 | 4 | 3.8 | PASS |
| 项目 | #147 `b282ee4b` | 4 | 4 | 4 | 4 | 4 | 4.0 | PASS |
| 例行任务 | #137 `cf4a252a` | 4 | 4 | 4 | 4 | 4 | 4.0 | PASS |
| Agent 运维 | #157 `110b05b0` | 4 | 4 | 4 | 4 | 4 | 4.0 | PASS |
| 设置 | #156 `037ab687` | 4 | 4 | 4 | 4 | 3 | 3.8 | PASS |
| 外壳 / 导航 | #146 `47ddcbde` | 3 | 4 | 4 | 4 | 4 | 3.8 | PASS |

六个区的 clarity 都 ≥3；唯一 clarity = 3 的是外壳 / 导航（#146），与区域转场首帧的判断一致。

### 6. 截图与证据

- 走查输出：`rsi/state/ux/final-acceptance/` —— 89 张 PNG、同名 `.aria.txt`、`walk.json`、`seed.log`；汇总命令 `python3 scripts/journeys_smoke.py --walk-json rsi/state/ux/final-acceptance/walk.json --proto rsi/state/ux-proto/final`。
- 复走输出（`9c651cf2`）：`rsi/state/shots/journeys-reverify/` —— 92 张 PNG、同名 `.aria.txt`、`walk.json`、`seed.log`；J7 单独种子另在 `j7-fresh/`（4 张）。命令 `scripts/journeys-smoke.sh --out rsi/state/shots/journeys-reverify`，J7 复跑用 `--journeys J7 --no-build --out rsi/state/shots/journeys-reverify/j7-fresh`；汇总命令 `python3 scripts/journeys_smoke.py --walk-json rsi/state/shots/journeys-reverify/walk.json --proto rsi/state/ux-proto/final`。
- G1 #161 lint 禁令复验：`ui/eslint.config.js` 的 `kin/no-legacy-class` / `kin/no-raw-overlay-role` 对 `src/**/*.{ts,tsx}`（facade / 测试除外）为 `error`；`cd ui && npx eslint .` 退出 0（38 warning / 0 error）。
- PR 范围：<https://github.com/vuuihc/openkin/pull/59> … <https://github.com/vuuihc/openkin/pull/160>；G1 仍是 <https://github.com/vuuihc/openkin/pull/161>。
- 原型：`rsi/ux-proto/index.html`（tracked）；已签字的帧在 `rsi/state/ux-proto/final/`（APPROVED 2026-11-15 12:27 SGT）。
- 程序前基线截图：`rsi/state/shots/baseline/`。
- UX 分数：`rsi/state/ux/<slug>/scores.json`；合并映射：`rsi/state/merged.log`。
- 本计划：`docs/plans/2026-11-14-ux-unification.md`；包体方法先例：`docs/plans/2026-11-09-astryx-spike.md` §3.5。

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
7. 运行 `python3 scripts/stories.py`。`KIN-CONTINUE-003` 以 draft 排入 registry，未来测试路径留在合同和本计划，不新造 registry 字段；`tests: []` 只表示无产品覆盖。正式批准前，先让导航验收测试存在并证明它在旧导航上失败，再将有编号、有断言的测试路径登记为正式 `tests`。
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
- Create: a development-only `DesignSystemPage.tsx` gallery (the existing gallery path is the contract)
- Create: `docs/product/design/astryx-bridge.md`
- Test: existing UI suite and token tests, plus provider tests

**步骤：**

1. 先跑 `cd ui && npm ci && npm run typecheck && npm test && npm run build && cd .. && ./scripts/check.sh`，记录主线现状。
2. 基于已完成 spike 的经验，安装 React 19、ReactDOM 19、Astryx core + neutral theme、StyleX 和 Tailwind 4/PostCSS 插件。**实际版本在安装时重新确认，不把 spike 的过时版本号当合同。**
3. 先增加 layer-order / body-background / token 编译测试；确认新 Tailwind 行为下失败，再迁移。
4. 重写 `resolveConfig` / v3 PostCSS 测试依赖，使用 v4 的编译 API；保留全部对比度、L*、焦点环等断言。必须为 v4 的单层化规则变化写回归。
5. 接入 Provider：接 `design/colors.ts` 的实际完整 Kin token 清单，逐项映射或明确标为 Kin 扩展；`data-theme` 驱动 `color-scheme`；语言、控件文案走 `ui/src/i18n/`；触屏点按 ≥44px；reduced-motion。
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

- Modify: `ui/src/pages/SessionsPage.tsx`, `SessionsRoute.tsx`, `StartRoute.tsx`, `NewChatPage.tsx`, `TaskSessionHost.tsx`, `TaskDetailPage.tsx`, `AgentSessionDetailPage.tsx`
- Modify: `ui/src/components/sessions/SessionList.tsx`, `SessionFilters.tsx` in that same `sessions/` directory
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

- Modify: `ui/src/pages/SettingsPage.tsx`, `AgentsPage.tsx` (AgentSessionDetail belongs to C, the conversation area, not this settings batch)
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
| Goal 0 | 26 文件；3 份文字合同合计 324 行；20 SVG；共 +392 / -9 | `stories.py` 通过；`check.sh` 14 项通过；20 SVG / 22 六拍流程 / 390+1100px 实际浏览器通过；并非产品覆盖 | 无 | 独立复审两项 major 已修、窄复审无 blocker/major；仍待总设计签字 | 文档已生成，产品实现未开始 |
| Batch A | 47 个不同文件（71 次改动）；源码 +3,948 / −1,247；测试 +2,803 / −64 | 14 个测试文件；兼容层 / Provider / token / gallery 套件；最终套件见 Goal 2 行 | 见验收说明 §4 | Astryx 优先与 F1–F3 依赖白名单（`rsi/DECISIONS.md` 2026-11-15）；上游版本安装时复核 | 兼容底座与 facade 落地；PR #59–#117；2026-11-15 15:10 → 2026-11-16 14:40（23 小时 30 分） |
| Batch B | 62 个不同文件（85 次改动）；源码 +1,842 / −565；测试 +2,651 / −279 | 28 个测试文件；导航 / deep-link / history / 手势；最终套件见 Goal 2 行 | 见验收说明 §4 | N3 退役、S2 吸收每区返回（`rsi/DECISIONS.md` 2026-11-15）；手机无项目入口（`NAVIGATION.md` §5） | 四区外壳与手机四入口落地；PR #68–#146；2026-11-15 13:34 → 2026-11-17 00:34（35 小时 0 分） |
| Batch C | 96 个不同文件（160 次改动）；源码 +4,357 / −3,526；测试 +6,353 / −269 | 49 个测试文件；列表 / 对话 / 新建 / 选择器；C3b 由 #158 `fb0dd3eb` 落地；最终套件见 Goal 2 行 | 见验收说明 §4 | C5b 拆 C5b/C5d、T3 拆 T3a–c、L2 只交工具栏（`rsi/state/decisions-pending.md`） | 对话与新建路径收口；PR #66–#159；2026-11-15 15:50 → 2026-11-17 05:53（38 小时 3 分） |
| Batch D | 25 个不同文件（44 次改动）；源码 +1,176 / −878；测试 +1,329 / −86 | 12 个测试文件；项目 / 例程；最终套件见 Goal 2 行 | 见验收说明 §4 | P1 只交 One-Pager、P1b/P3 拆出（`rsi/DECISIONS.md` 2026-11-16） | 项目集合与例行任务落位；PR #69–#147；2026-11-15 13:55 → 2026-11-17 02:34（36 小时 39 分） |
| Batch E | 46 个不同文件（57 次改动）；源码 +2,835 / −2,740；测试 +2,336 / −94 | 21 个测试文件；设置 / Agent / primitive；最终套件见 Goal 2 行 | 见验收说明 §4 | 打开设置不隐式读 Agent（N4 决策，`rsi/state/decisions-pending.md` 2026-11-16 14:38）；E4 拆 a/b/c | 设置与 Agent 运维收敛；PR #132–#157；2026-11-16 20:32 → 2026-11-17 05:30（8 小时 58 分） |
| Goal 2 | 11 个不同文件（11 次改动）；源码 +819 / −78；测试 +303 / −0 | 2 个测试文件（`navigationContract.test.ts` 与 G3 的 smoke 测试）；最终套件 `./scripts/check.sh` 16 项通过、退出 0 | 入口 gzip +143.5 kB、CSS gzip +46.6 kB（pre-F1 → 现在，见验收说明 §4） | G1 #161（`3ecae5d9`）在 `fb0dd3eb` 测量之后落地、其 lint 禁令未被该次走查复验；本行只覆盖 G2 / G2b / G3 / G4 | 旅程脚本、导航与组件合同、验收说明落地；PR #149–#160；2026-11-17 02:00 → 2026-11-17 05:12（3 小时 12 分） |

统计口径：按 `rsi/state/merged.log` 的 item 列归批；不含循环基础设施行（`R-*`）与未列入五批的一次性行（G1b `cf7ba2bd`、G2a `695d053e`、G3a `1c572b20`、V1 `d6e9ba70`、UX-GATE `5c515262`、CI-FORMAT `35755618`）。N3 已退役（`rsi/DECISIONS.md` 2026-11-15），不再单列。

**规模陈述：** 开工范围是 95 个非测试 TSX、17,540 行页面、37,797 行 components（含测试）；收口时 `fb0dd3eb` 是 116 个非测试 TSX、18,490 行页面（同口径含测试）、55,087 行 components（含测试，其中非测试 30,934 行）——增量主要是新测试与提取拆分的文件。四个一级区域、五个内部批次不变。没有足够依据将它写成具体完工天数；实施者每轮回填文件、行数、测试和阻塞，而不是预测“几个小时”。

## 4. 唯一的常规暂停条件

减少干预不等于擅自扩大范围。只在以下情况暂停问人：

1. 必须改变既有功能或真实数据语义；
2. 必须采用会引入持久损失/对外发布的动作；
3. 总设计签字的决策彼此无法同时实现；
4. Astryx 0.7.x 的实测行为迫使重新改变已确定的平台模型，需给出哪种行为、哪些页面及具体选项。

其余布局、实现、测试修复、依赖 spike 已验证事项、常规 bug 修复和可逆提交自主完成。
