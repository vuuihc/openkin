# Gap Log

Small, real defects found while dogfooding that are not worth interrupting the
current round for. The scheduled gap sweep reads this file every hour, from
`origin/main` and from the primary checkout's local copy (merged by date +
title). This file is committed and pushed with the session that writes it —
an entry that exists only on local `main` still reaches the sweep through the
local copy, but pushing it is what makes it durable.

How an entry is written — ask first, so the sweep never has to guess:

- 期望行为是什么？具体到能写成一条测试。
- 有没有哪种做法是你明确不要的？
- 仓库里有没有已经做对的同类地方可以照抄？

An entry must carry the expected behavior and any settled trade-off. If a
question is still open, mark it 待定 and ask the person now; do not leave a
product decision for the sweep to discover later.

How an entry moves:

- The sweep reads `## Open` directly. It does **not** open, comment on, or
  close GitHub issues; an entry (date + title) is the unit of work.
- **高** — the next sweep run should fix it. **中 / 低** — the sweep may batch
  them, but they stay in the pool.
- When a fix lands, the sweep moves the entry to `## 已修` in the same PR, with
  the commit / PR and the verification it ran. That edit is what marks an entry
  done; a fixed entry never stays under `## Open`.
- A still-open product question stays under `## Open`, marked 待定, with one
  concrete question and who was asked.

Newest first. Dates are absolute (`YYYY-MM-DD`). One entry is one symptom a
person can see; the fix and its verification belong in the PR.

## Open

### 2026-11-17 · 中 · 同一个项目在对话列表里有两个名字（有对话时是文件夹名，空项目是项目名）

实测（390 手机列表与 1100 Mac 侧栏同屏）：`[seed] Project Alpha` / `Beta` 因为各有一条对话，
显示为 `alpha` / `beta`；`[seed] Project Gamma` 的唯一对话已归档、当前范围无行，反而显示
项目全名。同一个项目只要最后一条对话被归档，标题就会在文件夹名与项目名之间切换；项目改名也
不会反映到有对话的桶上。原因：有行的桶用 cwd 末段做 label
（`ui/src/lib/phoneSessionBuckets.ts:277`），空项目由 `seedProjects` 用 `project.name` 补
（`ui/src/components/sessions/SessionList.tsx:1266`）。

期望（可直接写成测试）：

- 桶的标题优先用 `/api/projects` 里该 cwd 对应项目的 `name`；解析不到项目时才退回 cwd 末段
  （现有 `tailOf`）。同一项目在「有对话 / 无对话 / 对话被归档」三种状态下标题一致。
- 项目改名后列表标题随之更新；「新建对话」、归档确认、项目菜单里的名字与标题一致
  （这些位置现在都读 `bucket.label`，`SessionList.tsx:936/950/1153/1160/1471/1565`）。

不要：把项目名改成文件夹名来「对齐」；隐藏没有对话的项目；只在手机改、Mac 侧栏仍两种名字；
用 cwd 全路径当标题。

线索：`ui/src/lib/phoneSessionBuckets.ts:215-289`（`bucketFor` 的 `label = tailOf(cwd)` 在
`:277`）、`ui/src/components/sessions/SessionList.tsx:444-462`（调用）、`:1250-1276`
（`seedProjects`，`label: project.name` 在 `:1266`）；测试
`ui/src/lib/phoneSessionBuckets.test.ts`。

验收：

- 单测：两个 name≠文件夹名的项目，一个有一条活跃对话、一个没有，桶标题都等于项目名；
  归档最后一条对话后标题不变。
- 390 与 1100 截图各一张；`./scripts/check.sh` 绿。

### 2026-11-15 · 高 · iPad 左栏长按进入多选后找不到退出，行菜单里也没有多选入口

iPad（视口 ≥768px、`pointer: coarse`）的左栏是 248px 侧栏，但列表仍走触屏路径：
长按对话行 500ms 进入多选。多选工具条在 248px 里放不下——三个批量动作的标签用
`hidden sm:inline` 按**视口**宽度显示（iPad 视口 ≥640px，标签全出来），四个按钮各自
`min-w-11`，加上「已选 N 项」和 padding，总宽约 400px；即使全部只留图标也有约
310px，超过 248px 侧栏扣掉 `px-1` 后的 240px。最右边的「取消」被推到可视区外，
只能横向滚动列表才够得到；键盘也没有 Escape 退出（`onListKeyDown` 只处理 ↑/↓）。
进入多选后行尾也没有更多按钮（`SessionRow` 在 `selectionMode` 时直接返回
`rowButton`），所以没有任何就地退出的入口。报告人的原话是「不知道怎么退出」。

期望（可直接写成测试）：

- 在 248px 侧栏和 390px 手机页两种宽度下，多选工具条自身不得横向溢出
  （`scrollWidth <= clientWidth`），「退出多选 / 取消」始终在可视区内、至少 44px
  可点；计数和置顶 / 归档 / 删除仍可用。窄容器应换行或收成图标，不得靠缩小字号或
  横向滚动。
- 键盘：多选状态下 Esc 退出并把焦点还给发起多选的那一行；Shift+Enter 进入多选的
  现有路径保留。
- 对话行尾的更多（⋯）菜单增加「多选」一项：点它进入多选并选中该行。触屏上现在
  只有滑动露出的动作条，没有行菜单；菜单沿用 `ActionSheet` / 项目 ⋯ 菜单的形态与
  焦点规则。多选状态下同一个菜单显示「退出多选」，点它清空选择并退出。
- 长按不再进入多选。拖动排序落地前，长按照 `KIN-MANAGE-001`（draft）的手机入口
  打开同一行菜单；拖动排序落地后由那条接管长按。无论如何，长按不得让人进入一个
  没有可见出口的状态。

不要：把「取消」留在横向滚动里；用更小的字号或省略号让工具条「看起来」放得下；
只给手机宽度做、在 248px 侧栏仍然溢出；让多选只能从长按进入；删掉批量置顶 / 归档 /
删除或 Shift+Enter 选择。

线索：`ui/src/components/sessions/SessionList.tsx` 的多选工具条（`selectionMode &&`，
约 1099 行）、`enterSelection` / `exitSelection`（约 699 / 722）、`SessionRow` 的
`if (selectionMode || !row.task) return rowButton;`（约 1923）；长按在
`ui/src/components/mobile/SwipeReveal.tsx`（`LONG_PRESS_MS = 500`）；`sm:` 是视口
断点，侧栏宽度见 `ui/tailwind.config.ts:177`（`sidebar: 248px`）和
`ui/src/components/layout/Sidebar.tsx:270`（`w-sidebar`）；可照抄的菜单：
`ui/src/components/ui/ActionSheet.tsx` 与 `SessionList` 里的 `projectSheet`
（约 1223 行）；i18n 用 `sessions.*` / `common.cancel` 同一层。
`ui/src/pages/sessionArchiveWiring.test.ts` 对工具条源码有字符串断言，改结构时要
同步改成行为断言。

验收：

- DOM：行菜单有「多选」；进入后该行选中；工具条有可访问名称为「退出多选 / 取消」的
  按钮且点击后退出；Esc 退出；Shift+Enter 仍进入；多选状态下行菜单仍有「退出多选」。
- 浏览器 248px 侧栏（iPad 1100×820 或直接 248px 容器）与 390px：工具条
  `scrollWidth <= clientWidth`；退出按钮可见、可点；截图。
- `./scripts/check.sh` 绿。

进展（2026-11-17）：退出路径与工具条溢出已修，见 PR #62（`695d053e`）——工具条换行、
图标按钮 44px、取消留在 248px 容器内、Esc 走同一退出路径，248px 与 390×844 实测
`scrollWidth == clientWidth`；行尾 `⋯` 菜单的「多选 / 退出多选」入口已修，见「已修」
PR #170（`R-selection-menu`）。长按手势改道（不再进入多选）仍待 `KIN-MANAGE-001`
（`registry.json` 中为 `draft`）及后续拖动排序 `R-drag-reorder` 落地，故本条保留在
Open。

### 2026-11-15 · 中 · 长按对话行不能拖动排序，列表顺序只能跟着最近活动走

对话行现在没有拖动排序：同一个项目里的行由 `phoneProjectBuckets` 按 `at` 降序排
（`ui/src/lib/phoneSessionBuckets.ts:356-358`），置顶只是把行提进「置顶」桶，桶内
仍按时间。长按被多选占用（见上一条），所以也没有可用的拖动手势。报告人希望长按后
直接拖动调整对话顺序，而不是进入多选。

期望（可直接写成测试）：

- 触屏长按一行约 500ms（期间位移不超过现有 8px 容差）进入拖动：该行抬起、跟随手指
  纵向移动，经过同项目其它行时让位；松手落位并持久化；拖动期间不打开会话、不触发
  左滑动作、不进入多选。
- 松手前取消（pointercancel）或位移不足时回到原顺序；长按未达阈值前的纵向移动仍是
  正常滚动，横向仍是左滑；拖动开始后列表不滚动，松手后恢复滚动。
- 范围只在同一个项目（同一个 bucket）内：不能把行拖到别的项目或别的设备下——那会
  改变对话的归属，不是排序。导入的只读会话（没有 `row.task`）不参与拖动。
- 键盘等价路径：焦点在行上时 Alt+↑/↓ 上移/下移，顺序同样持久化（照抄
  `SessionTabs` 的 Alt+方向键重排与提示文案）。
- 顺序在重新加载、实时更新（新消息、状态变化）后不被打回时间序；搜索 / 筛选状态
  不提供拖动（避免「只重排当前结果」的歧义）。

待定（2026-11-15 已问报告人）：顺序模型按以下推荐执行，报告人确认或指出不同意的
一条——(1) 手动顺序只存本机（localStorage，和置顶同一层，不跨设备同步）；
(2) 手动顺序覆盖该项目的按时间排序，新对话进入时排最前，项目菜单提供「恢复按时间
排序」；(3) 「置顶」桶内也允许拖动。

不要：每次渲染都按 `at` 重排（拖完下一次实时更新就丢了）；用 HTML5 drag-and-drop
（触屏不触发）；为拖动引入重型依赖；在长按阈值前抢走纵向滚动或边缘返回手势；
把跨项目拖动实现成改 `cwd` / 设备。

线索：`ui/src/components/mobile/SwipeReveal.tsx`（现有指针、500ms 长按、8px 容差、
`touch-action: pan-y`；拖动开始后要阻止滚动，注意 CSS touch-action 在手势开始时
已决定，需要非被动 touchmove 或等价方案）；`ui/src/lib/phoneSessionBuckets.ts:356-358`
与 `withPinnedBucket`；持久化照 `ui/src/lib/taskPins.ts`（localStorage、失败不阻断）；
键盘重排照 `ui/src/components/layout/SessionTabs.tsx`（Alt+←/→）；手势测试照
`ui/src/components/mobile/SwipeReveal.dom.test.tsx`。
`docs/product/stories/KIN-MANAGE-001.md` 的「不做：拖拽排序」是 draft 里的旧范围，
落地时同步改掉。

验收：

- 手势：长按后移动触发重排；未移动不触发；阈值前移动取消长按；pointercancel 还原；
  拖动期间不导航、不左滑、不进入多选。
- 持久化：拖动后重新挂载 / 刷新，顺序保持；实时消息更新后不跳回时间序。
- 键盘：Alt+↑/↓ 移动并持久化。
- 浏览器 390px 与 iPad 侧栏：真手势拖动一次，刷新后顺序仍在；纵向滚动和左滑仍正常；
  截图或录屏。
- `./scripts/check.sh` 绿。

### 2026-11-14 · 高 · 对话把思考与过程叙述收进卡片；只有工具该进卡片

现在对话 URI（以及导入的 agent 会话）把连续的过程统一收进一张 `ProgressCard`：
`mergeProcessRuns` 把 reasoning、计划、进度叙述、子代理叙述和同一轮里非最终的
assistant 消息合并成一张卡
（`ui/src/components/chat/transcriptProjection.ts:1008-1115`），卡片默认折叠，只显示
「执行中 · N 个工具」和最近一条 note
（`ui/src/components/chat/ChatStream.tsx:1030-1209`）。agent 工作时，用户看到的是一张
摘要卡，思考与过程叙述被藏在卡里；过程文本和工具调用被当成同一种东西。

期望（可直接写成测试）：

- **运行中**：思考 / reasoning、进度叙述、计划行、子代理叙述都按事件顺序作为正文
  直接出现在对话列里，像普通消息一样流式增长；可以用更弱的字号 / 颜色区分，但不能
  折叠在卡片后面。390px 手机上可读、可滚动，长文本换行正常。
- **工具**：只有工具调用进卡片 / 工具行。相邻工具可以共用一张卡或一组行；每个工具
  仍可展开看输入 / 输出（保留今天卡片里的能力），运行 / 完成 / 失败状态与耗时仍在。
- **顺序**：正文与工具卡严格按发生顺序交错（文本 → 工具 → 文本 → 工具）；工具不能
  把前后的过程文本一起拖进卡里。
- **结束后**：本轮除最后一条最终回答外的所有过程（正文 + 工具卡）折叠成一条紧凑的
  摘要行，默认收起；摘要行显示终态（完成 / 失败 / 取消）与步数 / 工具数，点开按原
  顺序看到完整过程。最后一条最终回答保持正文可见，就是这一轮的结论。结束时没有最终
  回答的轮次（只有过程 / 错误 / 取消）不得凭空造结论：保留摘要行与错误态。
- 用户发出下一条消息即开始新一轮；上一轮的折叠状态不影响新一轮的运行中展示。
- 会话内查找仍能命中折叠区里的过程文本（沿用现有的命中自动展开），键盘 / 焦点行为
  不变；只有空白的 reasoning 不渲染空行或空摘要。

不要：运行中就把过程藏进折叠卡（用户要能读到 agent 正在做什么）；把所有内容都留在
卡片里、只把卡片标题改个名字；为了折叠丢掉工具的输入 / 输出；展开后与正文重复显示
同一段文字；只改样式不改编排（过程仍在卡内）。

待定（2026-11-14 已问报告人）：结束后的摘要行具体形态。建议：一行、默认收起、点击
展开，显示状态、步数 / 工具数、耗时。若报告人希望结束后只保留结论、过程完全不再
显示（不可展开），请指出；未答复前按可展开实现。

线索：`transcriptProjection.ts` 的 `buildChatItems` / `pushNote` /
`mergeProcessRuns` / `mergeProcessRun` / `summarizeProgressDetails` /
`summarizeProgressStatus`；`ChatStream.tsx` 的 `AgentTurn` / `ProgressCard` /
`ToolStepRow` / `NoteStepRow` / `ThinkingRow`；锁定旧行为的测试
`transcriptProjection.test.ts`（如 "keeps reasoning, tools, and progress narration
in one process card"）与 `ChatStream.find.dom.test.tsx`（"find inside a process
card"）需要按新契约改写；i18n `chat.progress.*` en / zh 同步。

验收：一条投影测试：运行中的 reasoning / note 是正文项、工具是卡，顺序与事件一致；
轮次结束后只剩最后回答 + 一条折叠摘要；展开摘要能按顺序看到全部过程。一条渲染测试
断言运行中过程文本在卡片之外可见、能被 find 命中；折叠后按现有可访问性约定隐藏。
390px 截图：运行中能连续读到思考 / 过程文本与工具卡交错；结束后只剩结论与一行摘要。
`./scripts/check.sh` 绿。

进展（2026-11-17）：运行中的思考与过程叙述按正文展示已修，见 PR #165（`9d8fbffc`）。
剩余的一半「结束后折叠成一条摘要行」由 PR #171（`R-process-summary`）在合并门禁中，
尚未合并。

## 已修

每条只留一行：症状、落地提交、PR。修复过程与验证在 PR 里，不再重复。

- 2026-11-17 · 手机新建页「打开封面」入口小于 44px（`ProjectSummaryCard.tsx:60` 的 chip 无 `min-h`，且 inline 盒使 `min-height` 不生效）— `797e3dd2`（`Link` 加 `inline-flex min-h-11 sm:min-h-0`，390×844 实测 chip 74×27.9 → 74×44.0，1100×760 保持 74×27.9；新增 `ProjectSummaryCard.dom.test.tsx`，旧 class 与「有 `min-h-11` 但无非 inline 显示盒」两处变异均转红；J3/phone `smallTapTargets` 12 → 0，`check.sh` 全绿）

- 2026-11-15 · iPad 左栏长按进入多选后找不到退出，行菜单里也没有多选入口（行菜单部分）— PR #170（`SessionRow` 对可选择行提供 `多选` 入口并在多选态保留 `⋯` 触发器显示 `退出多选`，复用 `SessionList` 同一退出与焦点归还路径；`SessionRow` / `SessionList.selection` 两套 DOM 测试 28 passed，390×844 / 1100×760 截图验证，check.sh 全绿；长按改道仍待 `KIN-MANAGE-001`）
- 2026-11-14 · 新建对话发送后，进入对话 URI 时仍插入整页骨架屏 — PR #61（`cf7ba2bd`；就绪条件改为接受已种入的列表行或草稿交接，真正冷启动的深链改画有签名的品牌等待态（`IconKin` + `role="status"` + 慢连接提示）而不是整页骨架屏；新增 `TaskSessionHost.handoff.dom.test.tsx` 覆盖创建交接、切出页、冷进入、404 带缓存行，连同 coldLoad / pendingSend 共 5 文件 25 项通过，`tsc` 与 `npm run build` 绿；还原就绪条件与冷启动分支后 4 项按预期转红）
- 2026-11-12 · 例行任务查不到 gap sweep，伴随 token 长度超过约 65530 的错误 — PR #52（`?runs=1&runs_limit=80` 的运行流不再拼进每次运行十几 KB 的 prompt：本机实测 1,200,074 → 约 94 KB，落在机器中继 `worker.MaxRoutineResponse` 655,360 字节内，页面不再整页失败；红测还原修复后 1,245,269 字节超限、恢复后通过，`go test ./internal/api/`、`./scripts/check.sh` 14 项、`./scripts/smoke.sh` 全绿；报告人原始报错原文仍未取得，若同一报错再现请附原文）
- 2026-11-09 · routines 改为设备归属后的遗留项（旧 Hub 库的 routines 没迁移、只有选「本机」才看得到）— PR #51（显示其他机器时提示「本机还有 N 个例行任务」并可一键切到本机；禁用 / 迁移 2026-11-10 已问报告人、超 48 小时无回答，按 §4 执行可回退默认值：不改数据只让现状可见，禁用 / 迁移仍待方向；3 条新 DOM 测试，check.sh 除已知 PanelSurface 抖动外全绿）

- 2026-11-12 · 手机端「划」没有过渡（行左划的动作条部分）— PR #50（拖动第一次位移即挂载动作条，未提交前 inert + aria-hidden + pointer-events:none，收起保留到 180ms 滑回结束；SwipeReveal DOM 测试 10 passed、还原组件后 4 failed，check.sh 除并发构建下的 5s 超时抖动外全绿）
- 2026-11-12 · 手机端「划」没有过渡（边缘右滑返回的跟手部分；行左划的动作条部分见 PR #50）— PR #63（`1c572b20`；`useEdgeSwipeBack` 暴露跟手的 React offset，上限视口 1/3，取消 / 未过阈值 / 禁用 / 提交时归零，reduced-motion 不位移但仍只提交一次，translate 仅在 offset > 0 时存在以免重锚 fixed 后代；`useEdgeSwipeBack.test.tsx` 13 项通过、相关 shell 套件 74 项通过，两处 mutant 先红后恢复，`./scripts/check.sh` 16 项全绿；390×844 真浏览器拖动读到 `matrix(1, 0, 0, 1, 116, 0)`、松手落列表后 `transform: none`）
- 2026-11-08 · 侧栏看不出设备 → 项目 → 对话的层级 — PR #47（每层一个 16px 缩进步长并嵌套相加，字重随深度递减：设备 semibold / 项目 body medium / 会话 regular，项目行不再用 `kin-section-label`；2026-11-10 的产品提问超过 48 小时无回答，按 §4 执行可回退的推荐默认值：16px 等步长、无分组背景、无竖线；Sidebar DOM 测试 16 passed、lint 0 error、check.sh 除既有负载抖动外全绿）

- 2026-11-12 · 新建与继续对话发送后页面迟迟不变，缺少即时消息与回复等待态 — PR #45（发送时先入本地用户气泡与等待行：`pendingSend` 以「同文本 + 发送后 seq」在服务端消息落地后交还，失败撤回并由 Composer 恢复原文；新建对话在 create 在途时直接显示消息与宿主等待行；pendingSend/ChatStream/两页 DOM 测试共 16 passed，check.sh 全绿；只覆盖到创建请求在途，跨路由交接仍断，见 2026-11-14 条目）
- 2026-11-12 · 应用启动骨架屏动效不好看，应改为品牌 icon 展示 — PR #44（`TaskDetailPage` 冷启动无缓存行时改为居中 `IconKin` 品牌块，180ms 单次淡入、reduced-motion 关闭；慢连接仍显示原提示，返回后立即卸载；cold-load 单测 6 passed，390×844 / 1440×900 静态渲染无溢出，check.sh 全绿；`c7c12cc6` 合并又把该分支退回骨架屏，见 2026-11-14 条目）
- 2026-11-12 · 对话内容加载时整片空白，缺少等待反馈 — PR #43（detail 返回前在内容区居中显示 `IconSpinner`，`role="status"` + `common.loading`，reduced-motion 停转；成功 / 失败后卸载并保留原错误状态；cold-load 单测 5 passed，check.sh 除已知 PanelSurface 抖动外全绿）
- 2026-11-12 · 手机新建对话时 Agent 与模型名称被截断，无法确认当前选择 — PR #42（运行设置 face 改为两行：Agent 名称 + 模型 · 权限；face、选择面板当前值和选项都不再截断，长名称换行完整显示；320/390/1100px 截图与长名称无横向溢出验证，check.sh 全绿）
- 2026-11-12 · 大对话首屏仍预取 200 条 / 1 MiB，打开慢 — PR #41（首屏按最近 3 轮预算，256 KiB / 6 页兜底，「加载更早」先用暂存消息；50 轮 / 2 轮 / 工具密集测试通过；check.sh 全绿）
- 2026-11-09 · 远程 run 的 task 详情 / transcript 打不开 — PR #39（Hub 转发 task 详情与 events，只读详情页增量轮询；check.sh 全绿）
- 2026-11-09 · 项目页的 routine 仍写本机 — PR #38（按 cwd 选中拥有该项目目录的机器，列表/创建都发给它；check.sh 全绿）
- 2026-11-09 · MCP 没有创建 routine 的工具 — PR #37（抽出 `routines.Create` 复用 REST 的校验与默认值；check.sh 全绿）
- 2026-11-10 · 历史会话从最早 50 条往后翻，最近的内容要翻很久才看得到 — PR #36（尾部优先 + 到顶自动加载；预算 200 条 / 约 1 MiB；check.sh 全绿）
- 2026-11-08 · 新开会话选不了模型，选择控件各写各的（原生 select 仍在用） — `90fe9232`（PR #35）
- 2026-11-10 · 侧栏「例行任务」未读角标只读本机，多设备下一直是 0 — `3f3ebe2e`（PR #34）
- 2026-11-09 · 手机端会话列表里，手机发起的同一条对话出现两行 — `e0599e8f`（PR #17）
- 2026-11-09 · YOLO 会话的 plan worker 仍会弹一张 ExitPlanMode 审批卡 — `c84d9da0`（PR #19）
- 2026-11-09 · iOS 端没有边缘侧滑导航，对话列表只能点按钮 — `07e93b98`（PR #25）
- 2026-11-09 · 无缓存进入会话时整页骨架，顶栏和输入框一起消失 — `d61ab6cb`（PR #21）
- 2026-11-08 · iPad 全屏后最上面的 UI 压在系统状态栏下面 — `669c3d4b`（PR #23）
- 2026-11-08 · iPad 上点对话、点项目的加号，第一次点击不生效 — `2d73fad0`（PR #15）
- 2026-11-08 · 手机上点“例行任务”看不到刚在 Mac 上建好的例行任务 — `901821bf`
- 2026-11-08 · 回车直接发送，写不了多行 — `caef7f2e`（PR #11）
- 2026-11-08 · 会话 cookie 不随使用滑动，约每 30 天要重登一次 — `8f50cd6c`（PR #13）
- 2026-11-08 · iOS 壳启动只认构建期 Hub URL，不认配对时存下的地址 — `75da0a1f`（PR #28）
- 2026-11-08 · iPad 新开会话底部控件太挤，排列没有层次 — `e88cd470`（PR #32）
- 2026-11-07 · Agent / 模型选择气泡的展开方向不一致 — `6be2a57c`（PR #8）
- 2026-11-07 · 模型列表出现重名项且不显示来源 — `8ef2d939`（PR #6）
- 2026-11-07 · 分发按钮的气泡向左展开且内容被裁切 — `9f4ea708`（PR #5）
