# R0 · 面审计与减法

状态：**R0a、R0b-2 已签字；R0b-1 已完成；R0b-2a、R0b-2b、R0b-2c 已完成；导入会话历史与冷启动观感修复已落地** · 2026-11-10
配套：[`IA.md`](../product/IA.md)、[`TASTE.md`](../product/TASTE.md)、[`stories/PLAN.md`](../product/stories/PLAN.md)、[`2026-11-08-design-system-middle-layer.md`](2026-11-08-design-system-middle-layer.md)、[`2026-11-09-astryx-spike.md`](2026-11-09-astryx-spike.md)
测量：`python3 scripts/ui_inventory.py`
评审页：[`2026-11-10-ui-surface-audit.review.html`](2026-11-10-ui-surface-audit.review.html)（390/1100 现状截图 + 每面决策卡；截图含本机真实数据，只在本机打开，不要外发）。如果页面里的截图显示「缺失」，用同目录的 `2026-11-10-ui-surface-audit.review.local.html`（截图已内嵌，gitignored）

## 现在的位置

| 项 | 状态 | 证据 |
|---|---|---|
| R0a 只读审计 | ✅ 已签字 2026-11-10 | 13 行决策：2 保留 / 3 合并 / 4 删除 / 4 补故事；评审页 `2026-11-10-ui-surface-audit.review.html`（截图缺失时看 `.review.local.html`） |
| R0b-1 只做减法 | ✅ 已完成（含复审） | `/design`、`/artifacts` + 详情已删；`ActionSheet` 取代 3 个 `IonActionSheet`，`@ionic/*` 移除；`AgentModelPicker` 已删；`check.sh` / build / smoke 全绿；390 截图存 `.playwright-mcp/r0/page/`（ignored）。嵌套 sheet 的一次 Esc / Back 只关一层，已用真实界面复验。复审无 blocker：`anyWidth` 移出打开/关闭 effect、Back 以历史条目自身 marker 判定归属、补 3 条嵌套测试与 1 条宽度策略测试；9 个 mutant 全红后落地（`148abdc` → `9fcded75` → `766c705d` → `ed164db9`），桌面已重建 |
| R0b-2 签字 | ✅ 已签 2026-11-10 | “同意，开干”；五个决定按建议执行，页面 `2026-11-10-ui-surface-audit-r0b2.review.html` |
| R0b-2a 收件箱替代 + 删除 | ✅ 已完成（含复审） | 行尾待批准计数（`PendingBadge`，approvals + questions 合并；Sidebar / SessionsPage 共用；文案不点名其中一类）；通知落 `/tasks/<id>?focus=<item>`，被点名卡片获得焦点并带可访问名称，Esc 交回对话；旧 pane、重复点击、旧快照三条竞态由测试钉住；桌面壳同步改到对话与 `/sessions`，`/inbox`、`/approvals` 重定向；`ApprovalsPage`、`inboxFocus`、`inboxKeyboard`、`RunningTaskCard`、`nav.inbox` 与入口已删。65 文件 / 新增 6 文件，+1,001 −1,417 行；全量 vitest 189 文件 1881 条、desktop 150 条、`check.sh` 全绿；17 个 mutant 全红；复审两轮无 blocker/major |
| R0b-2b 任务页减法 | ✅ 已完成 | 删 `SessionTabs`、`SessionSwitcherSheet`、`PullRequestPanel` 及入口；`TaskSessionHost` 只保留挂载缓存；`panels` / 图标 / i18n 清零；全量 vitest 188 文件 1898 条通过 |
| R0b-2c 导入会话收起 | ✅ 已完成（含复审） | 导入不再并入项目树：左栏每台设备末尾一个默认收起的「导入的会话（N）」，搜索时强制展开但不写偏好；手机列表每台机器末尾同组，搜索同样强制展开；行与原生对话同形（无彩色 rail、状态点、可用性徽标），新导入只改计数；左栏搜索会按行上实际显示的字（标题、项目、agent、ref）收窄导入。归档项目即使任务都不在当前页、只有导入会话命名它，仍保留可恢复的标题并计入归档数。详情页去掉状态 / 可用性 chip，来源 ID 移到时间戳行。8 个源文件 + 5 个测试文件（新增 `sessionImportedWiring.test.ts`），+685 −311 行；全量 vitest 190 文件 1897 条、desktop 150 条、`check.sh` / build / smoke 全绿；26 个 mutant 全红；复审两轮无 blocker/major；390 与 1280 的真实列表和详情已看过 |
| 导入会话历史 + 冷启动观感 | ✅ 已完成（含复审） | 历史页不再重扫整个目录：行里记录的 `source_uri` 作为提示走本地与设备两条路径，目录只认自己根内、非符号链接、未超大小上限、且文件自己声明的 ref 一致的那一个，否则回落到发现；本机实测单页：12MB 会话 5s → 0.56s，21.6MB 1.5s，125MB 6.8s（尾页本身要扫整个 JSONL，仍未索引化）。冷启动不再显示「正在重连」：`wsStatus` 从 `connecting` 开始，横幅只在真正断开后出现；慢连接提示改为 i18n。详情页在内容晚到（图片、长代码块）时保持贴底，读者上滑后停止跟随。11 个源文件 + 7 个测试文件，+782 −31 行；`check.sh` / build 全绿；17 个 mutant 全红 |
| R0b-2d 列表合并 + 项目 + dock | ⚪ 未开始 | 一套行与控制器；删 `/projects` 索引与 dock「项目」 |
| R0b-3 设置收口 | ⚪ 未开始 | 等 R0b-2 |
| 4 条故事 | ⚪ 未开始 | 只写合同，不写代码 |

## 0. 一句话

先决定哪些面还应该存在，再决定控件怎么统一。R0 只做归属、删除、Ionic 清尾和基线；不做视觉定稿，不写新组件，不迁 Astryx。

## 1. 为什么先做 R0

- 整站 UI 重构是 12–16 轮的事：98 个非测试 `.tsx`、313 个裸 `<button>`（71 文件）、14 个产品面、4 个页面超过 900 行。按仓库“一轮 ≤800 行 diff”的规则拆。
- 先删面再做组件层，避免把设计系统的力气花在即将删除的页面上。
- 每个面必须有一条六条故事认领；没有主人的面，要么补故事，要么删，不能靠“好像还有用”留着。

## 2. 已经定下的边界

1. **token 层不换。** `--kin-*` + `tokens.test.ts` + `TASTE.md` 是资产；任何设计系统只买行为和结构，不换视觉语言。
2. **如果采用 Astryx，只放在 `components/ui` façade 后面。** 页面永远 import Kin 自己的 `Button/Dialog/Select`；Astryx 是实现细节，0.7.x 升级只改包装层。
3. **R0 不出一版新 UI。** 人工评审物是“现状截图 + 决策卡”，不是重新设计的稿；目标线框只用于合并/改版提案，且标明“线框，不是定稿”。
4. **Ionic 在 R0 清掉。** 只剩 4 个文件、3 个 `IonActionSheet`；用现有 `Sheet` / `Menu` 替掉，删 `@ionic/*` 依赖。之后再做 React 19（Astryx 的前置）会更干净。
5. **改变用户流程的合并/改版不在 R0b-1 里做。** 那要回到对应故事的签字页，先画 Figma 帧，再动代码；R0b-2 开工前先补这一页。

## 3. 盘点（2026-11-10）

R0a 测量（做减法之前）：

| 指标 | 数值 |
|---|---:|
| 非测试 `.tsx` | 98 |
| 裸 `<button>` | 313 处 / 71 文件 |
| `components/ui/` 共享控件 | 3（SearchSelect、SessionFilters、SheetSelect） |
| `<input>` | 58 处 / 26 文件 |
| 原生 `<select>` | 0（设置页的 27 处已收口，TASTE 第 14 条） |
| `role="dialog"` | 14 处 / 8 文件 |
| `role="menu"` | 7 处 / 6 文件 |
| Ionic | 4 文件 / 3 个 `IonActionSheet` |
| 页面总行数 | 11,655；>900 行的 4 个：TaskDetail 2,269 / Settings 1,596 / Sessions 1,443 / Routines 1,366 |

R0b-1 之后复测（同一脚本）：非测试 `.tsx` **95**；裸 `<button>` **309 / 70 文件**；
`components/ui/` **4**（新增 `ActionSheet`）；`<input>` **57 / 25**；**Ionic 0**；
页面总行数 **10,924**，最大的仍是 TaskDetail 2,254 / Settings 1,596 / Sessions 1,443 /
Routines 1,366（另有 Agents 921）。删除的页面：`/design`、`/artifacts`、`/artifacts/:id`；
删除的死组件：`AgentModelPicker.tsx`（151 行）。

R0b-2a 之后复测：非测试 `.tsx` **91**；裸 `<button>` **301 / 66 文件**；
`components/ui/` **5**（新增 `PendingBadge`）；`<input>` **57 / 25**；
页面总行数 **10,481**，最大的 TaskDetail 2,292 / Settings 1,596 / Sessions 1,468 /
Routines 1,366。删除：`ApprovalsPage.tsx`、`RunningTaskCard.tsx`、`inboxFocus.ts`、
`inboxKeyboard.ts` 及其测试；新增：`PendingBadge.tsx`、`pendingCounts.ts` 与 4 个测试。

注意：`2026-11-08-design-system-middle-layer.md` §2 里是 2026-11-08 的旧数字（311 / 61 / 27 个原生 select）。R0 用 2026-11-10 的新数字，并注明测量日期，不要手抄旧表。

粗扫只发现一个完全没被引用的组件：`ui/src/components/chat/AgentModelPicker.tsx`（151 行）。这是文本引用扫描，R0a 要确认它是否真的死代码，再决定删不删。

## 4. 评审物：UI 优先，不是文档优先

R0 的主评审物是 **`2026-11-10-ui-surface-audit.review.html`**，不是下面那张 Markdown 表。Markdown 是审计记录和给 agent 读的；HTML 是给人做决定的。

每张卡片的结构：

```text
[390 截图]  [1100 截图]
路由 / 页面 / 入口
归属故事：CONTINUE / START / RESULT / MANAGE / NOTIFY / SETTINGS / 无主
证据：测试 N 个 · API N 个 · i18n N 键 · 入链 N 处
建议：保留 | 合并到 ___ | 删除 | 补一条故事
理由：一句话
[ ] 保留  [ ] 合并  [ ] 删除  [ ] 待定
```

- 顶部实时汇总“保留 / 合并 / 删除 / 待定”的数量，勾选后立即更新。
- 对“合并/改版”的面，附一张低保真目标线框（现状 vs 目标），只画导航树、入口和页面骨架，不做视觉定稿。
- 390px 可读、深色模式、无 CDN、无横向页面滚动；格式对齐 [`stories/AUTHORING.md`](../product/stories/AUTHORING.md) 的签字页。
- 现状截图用当前真实界面（390 / 1100），不用 AI 重新想象的图。删除决定看的是“它现在占不占地方”，不是“它重新设计后会不会好看”。
- 截图如含真实数据，只放本地 ignored 路径，不入库；仓库里的决策记录不依赖截图。评审页可随时重建。

## 5. R0a · 只读审计

对 14 个产品面逐条收集证据，产出 `review.html` + 一张 `keep / merge / delete / 补故事` 表。每条至少查：

- 入口：侧栏 / ⌘K / 手机 K 面板 / 深层链接，有没有导航入口；
- 入链：`to="/..."`、`navigate("/...")`、文档里的地址；
- 测试：`*.dom.test.tsx`、wiring test、截图基线；
- API：页面调用的 endpoint，以及这些 endpoint 是否还有别的调用方；
- i18n：`en.ts` / `zh.ts` 里属于这个面的键有多少；
- 行为：删除后会不会让某个故事（CONTINUE / NOTIFY / START / RESULT / MANAGE / SETTINGS）缺一个面。

**签核：表先给用户签，签完再动代码。** 删除是产品决定，不是 git 操作。

## 6. 产品面审计结果（已签字）

评审页：[`2026-11-10-ui-surface-audit.review.html`](2026-11-10-ui-surface-audit.review.html)。每张卡有 390/1100 现状截图、入口、测试、API、i18n 和决策勾选；签字结果为 2 保留 / 3 合并 / 4 删除 / 4 补故事。文件预览器不解析 `../../` 相对路径时，打开同目录的 `2026-11-10-ui-surface-audit.review.local.html`（26 张截图已内嵌，gitignored，含本机真实数据）。

| 面 | 页面 | 归属 | 已签 | 备注 |
|---|---|---|---|---|
| `/new` | NewChatPage | START | **补故事** | Mac 输入框下方的选择项太挤；设备、项目选择拆出去，另起一行或从对话初始化入口进入，不与模型、权限同排。 |
| `/sessions` | SessionsRoute / SessionsPage + Sidebar | CONTINUE / MANAGE | **合并** | 手机 `SessionsPage` 和 Mac `Sidebar` 是两套实现；合成一套功能与 UI，选简洁稳定方案。 |
| `/tasks/:id` | TaskSessionHost / TaskDetailPage | CONTINUE / RESULT | **合并** | 删顶部会话切换（与列表重复）；删「创建 PR」（当前无功能）。 |
| `/inbox` | ApprovalsPage | NOTIFY / CONTINUE | **删除** | 待批准改为对话列表行内 icon + 通知；先补替代行为，再删页。 |
| `/artifacts` | ArtifactsPage | RESULT | **删除** | 先删，后续再想。 |
| `/artifacts/:id` | ArtifactDetailPage | RESULT | **删除** | 同上；聊天里的「保存产物」一并移除。 |
| `/projects` | ProjectsPage | 待定 | **合并** | 第二份项目列表；保留 `/projects/:id`，列表收进侧栏 / 对话列表。 |
| `/projects/:id` | ProjectDetailPage | 待定 | **补故事** | 每日项目进展、打卡图、代码改动量、token 消耗；精不在多。 |
| `/agents` | AgentsPage | 无 | **补故事** | 未安装的 agent 收起；按设备展示已安装 agent 的 token 统计。 |
| `/routines` | RoutinesPage | 无 | **补故事** | 保留；按设备保存 / 管理定时任务，远端设备可查看管理，作为后续主动 agent 的入口。 |
| `/settings` | SettingsPage | SETTINGS | **保留** | 删远程、通知等，已改用原生方案。 |
| `/agent-sessions/:id` | AgentSessionDetailPage | CONTINUE | **保留** | 默认收起；与原生会话同样式，不加特殊标记。 |
| `/design` | DesignSystemPage | 无 | **删除** | 不在导航；生产移除。 |

签字汇总：**2 保留 / 3 合并 / 4 删除 / 4 补故事**（2026-11-10）。

签字后的三个硬发现：

1. **`/projects` 是第二份项目列表。** `ProjectsPage` 页头原文：「项目 = 你工作的目录 + 一页活封面。和侧栏按目录分组的『项目』是同一件事。」已签合并：列表收掉，只留 `/projects/:id`。
2. **`/routines` 默认落在离线机器。** 截图时默认机器是 `<device-id>`，桌面报 `node is not connected: ios-…`，手机显示 `Still connecting`。面保留，补故事，第一个缺陷是默认机器选择。
3. **`/design` 没有入口。** 不在 `PLACES`，不在侧栏，也不在手机 dock；只有直接访问 URL。已签删除，生产不保留。

其余证据：`/artifacts`、`/artifacts/:id`、`/projects`、`/agents` 没有直接页面测试；Ionic 只剩 4 个文件、3 个 `IonActionSheet`；`AgentModelPicker.tsx`（151 行）无引用。

另有 `/` 回到上次对话或 `/new`，`/approvals`、`/usage` 两条重定向和 `*` 兜底，已收口。

## 7. R0b · 执行

签字后的 13 行不能装进一次 ≤800 行的 diff；按「有没有替代行为」拆，不按页面拆。每一轮都独立跑 check / build / smoke，独立提交。

### R0b-1 · 只做减法

只删没有替代行为的面和小控件，不新增交互：

1. `/design`：删路由、页面、import；删 `tokens.test.ts` 里只服务于画廊的断言；更新 `colors.ts` / `type.ts` / `theme.css` 中提到 `/design` 的注释。
2. `/artifacts` + `/artifacts/:id`：删路由、两个页面、入口；删聊天消息上的「保存产物」和 `TaskDetailPage` 的 `onSaveArtifact`；删项目详情里的相关产物区块；删只被这些面使用的 API helper、i18n 键和测试。
3. Ionic 清尾：`main.tsx`、`Sidebar.tsx`、`SheetSelect.tsx`、`TaskDetailPage.tsx` 里的 `@ionic/react`；3 个 `IonActionSheet` 收敛成一个 `components/ui/ActionSheet`（基于现有 `Sheet`）；删 `@ionic/core` / `@ionic/react`。`Sheet` 同时补两件事：`anyWidth`（宽屏粗指针平板上仍显示）和嵌套层栈（一个 Esc / Back 只关最上面一层）。
4. 确认 `AgentModelPicker.tsx` 无引用后删除。
5. 文档同步：`IA.md`、`stories/PLAN.md`、`docs/product/components/README.md`（如删共享控件）、本文件开头的「现在的位置」；重跑 `python3 scripts/ui_inventory.py`，把前后数字写进本文件。

### R0b-2 · 对话列表合并 + 收件箱替代

这一轮改变用户流程，**先补签字页再动代码**：

1. `/sessions` 合并：手机 `SessionsPage` 与 Mac `Sidebar` 的列表收敛到一套数据、搜索、过滤、行操作和 UI 原语；宽度只决定壳（侧栏 / 整页），不再决定功能。同时删 `/projects` 列表和手机 dock 的「项目」tab，项目收进对话列表；`ProjectDetailPage` 的冷启动返回落到 `/sessions`。
2. `/inbox` 删除：待批准在对话行上以 icon 提示；通知落到那一行；删 `ApprovalsPage`、`inboxFocus` 及其测试和 i18n。先补上 icon + 通知落点，再删页。
3. `/tasks/:id`：删顶部 `SessionTabs` 和手机 `SessionSwitcherSheet` / header 按钮；删 `PullRequestPanel` 和入口；保留 `TaskSessionHost` 的会话保活。
4. `/agent-sessions/:id`：导入会话在列表里默认收起，行样式与原生会话一致，去掉彩色 rail / 可用性徽标等特殊标记；详情页头部也收敛到原生对话的样式。
5. 更新 `KIN-CONTINUE-001`、`KIN-NOTIFY-001` 和 `IA.md` 的对应行。

### R0b-3 · 设置收口

只保留用户在用的设置；删远程 / 通知两块 tab 及其状态、handler、i18n 和测试，更新 `KIN-SETTINGS-001` / `KIN-NOTIFY-001`。`SettingsPage.tsx` 1,596 行，单独一轮。

### 故事（只写合同，不写代码）

`/new`、`/projects/:id`、`/agents`、`/routines` 四条先按 `docs/product/stories/AUTHORING.md` 写合同和签字页；签完再排交付。`/new` 的重点是设备 / 项目选择离开输入框下方那一条，不与模型 / 权限同排。

## 8. R0c · 收口

- `./scripts/check.sh`
- `cd ui && npm run build`
- `./scripts/smoke.sh`
- 390 / 1100 各一组存活面的截图（存 ignored 路径，不入库；作为 R1 的 before 基线）
- 高模型 review（按 `docs/product/LESSONS.md` 的协议：冻结树、mutants、一份报告、一次修复）
- Conventional Commit（`refactor(ui): ...` 或 `chore(ui): ...`），合入 `main`
- `./scripts/desktop-rebuild.sh`（UI 改了，必须重建；该脚本会重启 `:7777` 节点）

## 9. 签字后仍开放的问题（R0b 要给出答案）

1. `/projects` 合并到哪个列表：侧栏的设备→项目→对话，还是 `/sessions`？R0b-2 的签字页定。
2. `/inbox` 删除后，待批准 icon 放在行首还是行尾？通知落到对话还是行？R0b-2 的签字页定。
3. `/sessions` 合并后，Mac 左栏和手机整页是否共用同一个行组件，只换壳？R0b-2 的签字页定。
4. `/settings` 的「远程 / 通知」删到哪一层：只删 tab，还是连 Cloudflare relay / APNs 状态机和 API 一起删？R0b-3 定。
5. `/agent-sessions/:id` 的「默认收起」指列表里的导入会话收起，还是详情页历史收起？R0b-2 的签字页定。
6. `AgentModelPicker` 已确认无引用，R0b-1 删除。

## 10. 不要做

- 不要在 R0b-1 里删有替代行为的面（`/inbox`、`/sessions` 合并、`/settings` 远程 / 通知）；那些在 R0b-2 / R0b-3，先补签字页。
- 不要在 R0 里开始 G0.5 / Astryx 迁移；那是下一轮。
- 不要把“整理 UI”做成一次整站重写；diff >800 行就拆轮次。
- 不要用通用设计系统的整页模板替代 Kin 的 IA（设备 → 项目 → 对话；Mac/手机两种形态）。
- 不要让页面直接 import Astryx（如果以后采用）；只允许 `components/ui` 内部 import。
- 不要提交 `web/dist/assets/`。
- 不要凭印象删面；一切以 R0a 的证据表为准。

## 11. 下一会话

R0a 已签字（2026-11-10），**R0b-1、R0b-2a、R0b-2b、R0b-2c 已完成并落地**：`/design`、`/artifacts` + 详情、`AgentModelPicker`、`/inbox`、`SessionTabs`、`SessionSwitcherSheet`、`PullRequestPanel` 已删；待批准回到对话行尾，通知直接打开对话并聚焦被点名的卡片；导入会话收进每台机器末尾的默认收起组，行与原生对话同形。手机试用后的三个问题已处理：抽屉与列表分离是 R0b-2d 的范围（尚未开始）；冷启动的「正在重连」与骨架改为只在真正断开时显示横幅；大会话打开慢的原因是每读一页都重扫全部 provider 文件，改为用行里记录的源文件路径做提示，单页从约 5s 降到约 0.5s。下一轮是 **R0b-2d**（手机与 Mac 列表合并、`/projects` 索引与 dock「项目」收口）。R0b-3 的设置收口单独一轮。四条「补故事」的面只写合同，不写代码。

R0b-2a 复审留下一条已知边角，交给 R0b-2d：收件箱删除后，等待项的唯一信号是「它所在的那一行」的计数；行被收起、被搜索过滤、或在更早的分页里时没有信号。列表合并时决定是否在收起的项目/设备标题上给一个汇总计数（不要为它恢复独立页面）。待批准有浮动卡片兜底，待回答的问题没有。

## 12. 阅读顺序

1. `AGENTS.md`（工作流、round 规则、完成门禁）
2. `docs/product/IA.md`（面归属和已签字决定）
3. `docs/product/TASTE.md`（16 条界面规则）
4. `docs/product/stories/PLAN.md`（六条故事）
5. `docs/plans/2026-11-08-design-system-middle-layer.md`（G0–G18、G0.5 决策门）
6. `docs/plans/2026-11-09-astryx-spike.md`（Astryx 实测，别重复调研）
7. `docs/product/components/README.md`（共享控件文档格式）
8. `scripts/ui_inventory.py`（测量口径）
