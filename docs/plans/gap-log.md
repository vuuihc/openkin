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

- 2026-11-21 · 高 · iPad 820×1180 分栏时，会话头的动作栏被压成一排单字碎片（`C [ 8 P… c τ l kin…`）— 820×1180（2× 截图，侧栏展开，会话列约 520 CSS px）里，`TaskHeader` 的桌面动作栏把宿主徽标、工作区、Pull Request、分享、归档、删除和项目名压成约 24–30 px 宽的竖条：`Pull Request` 的标签折到图标下面再截成「P…」，项目名只剩「kin…」，图标只剩半个字形；每个可点宽度都低于 44 px 触摸地板。桌面栏是 `hidden md:flex`，iPad 拿到的正是这一条，带 `⋯` 动作表的 `MobileHeader` 在 `md` 以上不显示；`TaskHeader.dom.test.tsx` 只断言 `min-w-cell` 和类名，量不到这件事。
  - **期望行为可写成测试**：820×1180、`hasTouch`、侧栏展开、标题为长句时，动作区每个控件 ≥44×44 CSS px，可见图标与标签完整（允许只显示图标，但不允许只显示半个字形），`Pull Request` 标签不换行；空间不够时压缩的是动作区自身的可见宽度（`scrollWidth > clientWidth`，子项保持 `flex-none`），或把这一组动词收进已有的 `⋯` 动作表（`TaskDetailPage.tsx:2453` 的 `sessionActions`；注意动作表现在只在 `!wide`（<768）挂载，iPad 分栏要复用它得先改 `TaskDetailPage.tsx:2537` 的挂载条件），二者选一。项目名保持 `max-w-[10rem]` 的省略号截断，不参与挤压。真实浏览器在 820×1180 量每个按钮的 `getBoundingClientRect()`、标签行数与图标裁切即可失败重现；把这条走动接进 iPad 旅程与合并门（见本日最后一条）。
  - **不要的做法**：不要只给动作区加 `overflow-x-auto` 就算修好——`ui/src/components/task/TaskHeader.tsx:235` 已经有了，flex 子项仍会先收缩，截图就是证据；不要把标签截成一个字后保留 24 px 的按钮；不要把「1100 截图全绿」当作平板验收（iPad 分栏后的会话列约 520 px，比 1100 窄一半）。
  - **照抄的同类**：`ui/src/components/task/TaskComposerDock.tsx:167,175` 的按钮用 `flex-none` 占住宽度；`SessionTabs` 给每个标签 `max-w-[220px]` 并让 strip 自己滚动；手机路径的 `MobileHeader` + `sessionActions` 动作表已经做对（`ui/src/pages/TaskDetailPage.tsx:2453`，但动作表只在 `<768` 挂载），iPad 窄栏复用时要先把挂载条件从视口宽度改成会话列宽度；仓库对 iPad 触摸的既有答案是 `useCoarsePointer()`（LESSONS 2026-11-10 / 2026-11-17），这里没有用。

- 2026-11-21 · 高 · 「有新进展」药丸浮在正文上，正好盖住 agent 回答表格的最后两行 — 820×1180 实机截图里，药丸固定在会话底部 `bottom-3`，压在状态表的「手机 Hub」第二行与「待发上游版」第一行上；读者要么点它跳走，要么滚到别处，眼前这两行读不到。代码注释写明这是有意的（「It floats over the last lines so the reading does not shift」），但代价是内容被遮挡，而这张表正是 RSI 进度表里「目前线上控制台健康」的那段话。
  - **期望行为可写成测试**：当 `unseen > 0` 且最后可见内容是一张表格时，`document.elementFromPoint` 命中每个可见单元格中心必须返回该单元格，而不是药丸或 composer；药丸出现时滚动区为它预留一条非内容通道（与 composer 的待审批条同一做法），或只在正文右侧留白上浮动。已定取舍：不遮挡优先于「阅读不位移」——需要位移就位移。
  - **不要的做法**：不要给药丸加半透明背景（仍然遮挡）；不要用「滚到底就消失」当解释（读者正是没滚到底才需要它）；不要把表格最后两行裁掉、或给滚动区加 `overflow:hidden` 掩盖。
  - **照抄的同类**：`ui/src/components/task/TaskComposerDock.tsx:149-178` 的待审批条用 `flex-none` 在 composer 上方占一行，不压正文；同文件注释明确「a decision, within reach of the composer」是加一行而不是浮层。药丸外层就是 `ui/src/pages/TaskDetailPage.tsx:2716` 的 `absolute bottom-3`。

- 2026-11-21 · 高 · RSI 的验收宽度里没有 iPad：820×1180 落在 390 与 1100 之间，RSI 用「线上控制台健康」结案，CEO 该为这个完成定义负责 — 这不是一条普通样式缺陷，是完成定义的问题。`rsi/runtime/ux/journeys.json:3` 的 viewport 只有 `phone: 390x844`、`mac: 1100x760`、`mac-wide: 1280x800`；`rsi/MANDATE.md:19` 的合并门第 5 条只要求 390/1100 截图。820（分栏后约 520）正好落在两个被验收宽度之间，于是两端都绿、中间是这张截图：动作栏压成单字，agent 表格被浮层盖住。截图里的 RSI 进度表写「目前线上控制台健康」，而同一屏上两处遮挡同时违反 LESSONS 2026-11-10「iPad 是桌面宽度、手指」和 44 px 触摸地板；同类问题已记到第三次。一个把「健康」建立在自己没有在设备上读完的界面上的 CEO，产出的就是这种界面——这不是能力正常，这是没有验收。
  - **期望行为可写成测试**：在 `journeys.json` 增加 `tablet: 820x1180`（`hasTouch`），新增一条 820×1180 的 walk：侧栏展开、长标题、回答含 ≥4 行 markdown 表；动作区每个控件 ≥44×44 且无半个字形，表格每个可见单元格中心命中自身，药丸/浮层不盖正文；真浏览器截图存入 `rsi/state/shots/<slug>/` 并在 PR body 链接。把 `rsi/MANDATE.md:19` 的「390/1100」改为「390/820/1100」，820 的截图必须包含一条长表格回答，不接受空状态或假数据；`scripts/check.sh` 要执行这条 walk（或明确接线到 `rsi/runtime/ux/walk.mjs`）。
  - **不要的做法**：不要再让 CEO 用「check.sh 全绿 / 390 与 1100 截图」证明平板健康；不要写没有截图链接的「线上控制台健康」；不要把这条降级成低优先级样式项——它记录的是验收缺口，修完上面两个症状也不会自动补上；不要用 `mac-wide: 1280` 冒充平板。
  - **照抄的同类**：F1 已经用 16 ms 真实采样证明「不消失、不骨架」；2026-11-15 的触屏拖动验收已经跑过 820×1180 + `hasTouch`（`rsi/runtime/ux/touch-drag.mjs`）；`journeys.json` 已经把 viewport 参数化，机制都在，只是没有把 iPad 宽度接进合并门。

- 2026-11-21 · 低 · 一个项目有两个根目录时，对话列表出现两个同名项目标题，其中一个永远为空 — `/api/projects` 里 `[seed] Project Alpha` 同时拥有 `alpha` 与 `aaa-config` 两个根目录；390×844 与 1100×760 的对话列表都渲染两个「[seed] Project Alpha」标题，一个 2 条对话、一个 0 条，两个标题各自都带项目级动作（新建对话；1100 上还有项目封面 / 置顶项目 / 从侧栏移除），人分不清它们是不是同一个项目。
  - **期望行为可写成测试**：`/api/projects` 中同一项目 id 的多个根目录下的对话，在对话列表中只出现一个项目标题，标题后的数量等于这些根目录下对话数之和；第二个根目录仍可从新建对话的目录选择器里选到。用带两个根的种子项目写一条列表测试（390 与 1100 各一次）即可失败重现。
  - **不要的做法**：不要按 cwd 分桶、再把两个桶的标题都改成项目名（现在就是这样：两个根 = 两个同名标题）；不要用「隐藏空标题」掩盖重复——空的那个根上还挂着项目级动作，且根目录仍是新建对话的可选项；也不要把两个根目录的对话混进同一个目录。
  - **照抄的同类**：没有同类可抄——标题已经按项目名（`ui/src/lib/phoneSessionBuckets.ts:314` 的 `headingFor` + `projectNameFor`），但分桶键仍是 cwd（`ui/src/lib/phoneSessionBuckets.ts:296` 的 `bucketKey`），仓库里没有按项目 id 合并多个根目录的实现。

- 2026-11-21 · 中 · 新建对话点「开始」后输入框从页面中部跳到任务页底部：`/new` 的 composer 居中/顶部对齐，任务页把它停靠到底部，同一个 `[data-kin-bottom-chrome]` 带在 390 宽移动 451 px、1100 宽移动 244 px（首个可见帧→最后一个可见帧 507.6 px / 428 px）。期望行为：人正要用的那个 composer 留在任务页放它的位置——照抄任务页已经做对的停靠（`TaskComposerDock`），把 `/new` 的 composer 也钉到底部，跨路由没有半屏位移；验收沿用 J3 `steady` 的同一选择器与两个视口，修好后把步进上界收紧到接近 0，不要靠放宽上界变绿。已定的取舍：布局修复是后续项，J3 `steady` 暂以每个 16 ms 采样步进 ≤ 460 px（两个视口）+ 0 absent / 0 skeleton 作为过渡上界。

## 已修

每条只留一行：症状、落地提交、PR。修复过程与验证在 PR 里，不再重复。

- 2026-11-21 · 慢轮进行中先排队一条追问、再打断时，刷新后缺少「已打断上一轮」这一行 — `50d3ac96`（PR #526）：`transcriptProjection.ts` 的轮次生命周期由 `task_started` / `result` 掌管，排队中的追问不再清掉 `roundStarted`；测试 `ui/src/components/chat/ChatStream.interrupt.dom.test.tsx` 用例 `keeps the interrupt mark when a queued follow-up sits above it`
- 2026-11-21 · 另一条对话在等审批时，浮动审批卡压住本对话「这一轮改了什么」的文件行，点行中心会落到审批卡上 — `3c328fa7`（PR #504）：卡片与任一可见文件行相交时只渲染 strip（仍可打开被堵的那条对话），收起证据卡或把该行滚走卡片即回来；新增 `FloatingApproval.overlap.dom.test.tsx`，接线 pin `floatingApprovalWiring.test.ts`，1100×760 / 390×844 真 daemon 实测行中心 `elementFromPoint` 命中该行而非 `aside[aria-label="等待处理"]`
- 2026-11-21 · 打断后的记录里没有任何「已打断」痕迹，被切断的一轮看起来像 agent 没回 — `4f8829ce`（PR #505）：在被打断的那一轮末尾投影一条持久 `meta` 行「已打断」，位于打断它的消息之上，刷新 / 重进仍在；toast 保留；测试 `transcriptProjection.test.ts`、`ChatStream.interrupt.dom.test.tsx`
- 2026-11-21 · 同一个对象在界面里同时叫「对话」「会话」「任务」 — `5700a080`（PR #506）：项目行菜单、用量摘要、对话不存在的文案在 zh / en 都统一为「对话」/ conversation，例行任务仍叫「任务」；测试 `locales.test.ts`、`TaskUsageSummary.dom.test.tsx`，三套按英文菜单字面量断言的 DOM 测试随值更新

- 2026-11-19 · 进入对话详情时的等待面是 K 品牌块（#382 的选择），owner 要求改为 iOS 转圈 — 分支 `rsi/entry-spinner`（owner 2026-11-19：「用 iOS 转圈的 loading 吧，别用这种」；正文等待换成标准 12 辐条 iOS 指示器：12 步 tick、reduced-motion 停转但保留轮盘；列表行 `entryWait` 与无行冷进入两条路径同用，测试 `IosSpinner.dom.test.tsx`、`TaskDetailPage.entryWait.dom.test.tsx`、`TaskDetailPage.coldLoad.dom.test.tsx`；390×844 / 1100×760 真 daemon 截图见 `rsi/state/shots/entry-spinner/`）
- 2026-11-19 · 从对话列表进入详情时正文区白屏（无任何等待面）；启动 / 冷进入的蓝色转圈与品牌色不搭 — 分支 `rsi/entry-wait`（再报 #43 / #44 / #61：此前只证明过无缓存行的路径。列表行让 `fallbackTask` 为真时，正文区在 detail 到达前渲染与开机页同一个 K 品牌块，`role="status"` + `common.loading`，detail 到达 / 失败即换回 transcript / 错误；测试 `TaskDetailPage.entryWait.dom.test.tsx`、`BrandMark.dom.test.tsx`，并更新 `TaskDetailPage.coldLoad.dom.test.tsx`；390×844 / 1100×760 真 daemon 前后截图见 `rsi/state/shots/entry-wait/`）
- 2026-11-17 · 对话把思考与过程叙述收进卡片；只有工具该进卡片 — 运行中过程按事件顺序进正文 PR #165（`9d8fbffc`），结束一轮收成一条带终态、工具数与时长的已收摘要行 PR #171（`e43b0b62`）；测试见 `transcriptProjection.test.ts` 与 `ChatStream.{prose,summary,find}.dom.test.tsx`，390/1100 截图见 `rsi/state/shots/live-process-prose/`、`rsi/state/shots/process-summary/`；取消沿用既有「cancel noise 不算失败」约定，摘要行不单列取消态（待定：是否需要独立的「取消」终态；若要单列，另开条目并写清文案与可点动作）
- 2026-11-17 · 手机新建页「打开封面」入口小于 44px（`ProjectSummaryCard.tsx:60` 的 chip 无 `min-h`，且 inline 盒使 `min-height` 不生效）— `797e3dd2`（`Link` 加 `inline-flex min-h-11 sm:min-h-0`，390×844 实测 chip 74×27.9 → 74×44.0，1100×760 保持 74×27.9；新增 `ProjectSummaryCard.dom.test.tsx`，旧 class 与「有 `min-h-11` 但无非 inline 显示盒」两处变异均转红；J3/phone `smallTapTargets` 12 → 0，`check.sh` 全绿）
- 2026-11-17 · 同一个项目在对话列表里有两个名字（有对话时是文件夹名，空项目是项目名）— 分支 `rsi/project-name-bucket-label`（期望：桶标题优先用 `/api/projects` 里该 cwd 对应项目的 `name`，解析不到才退回 cwd 末段，有对话 / 无对话 / 最后一条对话归档三种状态一致。`phoneProjectBuckets` 新增可选 `projectNameFor` 查询，`SessionList` 用 `useMemo([projects])` 建 cwd→name 映射（同一 root 先到先得），归档范围里的远端副本也按 cwd 查名；`seedProjects` 仍用 `project.name`，两条路径现在得到同一标题。单测 5 项先红（`expected 'alpha' to be 'Project Alpha'`）后绿，新增 `SessionList.projectNames.dom.test.tsx` 覆盖 page / sidebar 两种壳与「最后一条对话归档后标题不变」，`phoneSessionBuckets` + sessions + Sidebar 套件 125 passed，`tsc` / `npm run build` / `check-ui-inventory.py` / `check.sh` 绿；390×844 与 1100×760 截图见 `rsi/state/shots/project-name-bucket-label/`）
- 2026-11-15 · 中 · 长按对话行不能拖动排序，列表顺序只能跟着最近活动走 — 期望（保留原文）：触屏长按一行约 500ms（期间位移不超过现有 8px 容差）进入拖动：该行抬起、跟随手指纵向移动，经过同项目其它行时让位；松手落位并持久化；拖动期间不打开会话、不触发左滑动作、不进入多选。松手前取消（pointercancel）或位移不足时回到原顺序；长按未达阈值前的纵向移动仍是正常滚动，横向仍是左滑；拖动开始后列表不滚动，松手后恢复滚动。范围只在同一个项目（同一个 bucket）内：不能把行拖到别的项目或别的设备下——那会改变对话的归属，不是排序；导入的只读会话（没有 `row.task`）不参与拖动。键盘等价路径：焦点在行上时 Alt+↑/↓ 上移/下移，顺序同样持久化。顺序在重新加载、实时更新（新消息、状态变化）后不被打回时间序；搜索 / 筛选状态不提供拖动。待定已按推荐落地：顺序只存本机 `kin_task_order`（`ui/src/lib/taskOrder.ts`）、覆盖桶内时间序、新对话仍排最前、项目菜单提供「恢复按时间排序」、置顶桶内也可拖动。落地：键盘重排与持久化 PR #192（`dfbac705`）、恢复时间序与提示 PR #198（`78fbbe7b`）、触屏长按拖动 PR #205（`62a7dcb6`）。真浏览器验收（2026-11-17，`rsi/runtime/ux/touch-drag.mjs`，CDP `Input.dispatchTouchEvent`，`pointerdown` 实测 `pointerType=touch`）：390×844 与 820×1180（iPad 侧栏，`hasTouch`）各走长按 → 拖动 → 整页重载，55 项断言全过——抬起的行带 `[data-reordering]`、随手指位移 14.3px、不弹动作条；拖动中 6/6 `touchmove` 被拖动取消（列表不滚动）、不改路由；松手写入 `kin_task_order`，重载后仍是被拖后的顺序；200ms 轻点不抬起且照常打开会话；500ms 前移动 >8px 取消长按且 0/6 `touchmove` 被取消；拖到桶底不越过项目标题；左滑仍以 `translateX(-228px)` 打开动作条。纵向滚动因种子列表短于视口未能实测滚动位移，以「拖动中 6/6 取消、阈值前 0/6 取消」为等价证据。截图：`rsi/state/shots/drag-verify/390-{before,lifted,after-reload}.png`、`820-{before,lifted,after-reload}.png`。jsdom 只作回归，本条以真浏览器为准（LESSONS 2026-10-30）。
- 2026-11-15 · iPad 左栏长按进入多选后找不到退出，行菜单里也没有多选入口 — 工具条换行与 Esc 退出 PR #62（`695d053e`）、行菜单「多选 / 退出多选」PR #170（`SessionRow` 对可选择行提供 `多选` 入口并在多选态保留 `⋯` 触发器显示 `退出多选`，复用 `SessionList` 同一退出与焦点归还路径；`SessionRow` / `SessionList.selection` 两套 DOM 测试 28 passed，390×844 / 1100×760 截图验证，check.sh 全绿）、长按改道打开行菜单 PR #190（`456a922f`）；长按已交给拖动排序：PR #205（`62a7dcb6`）把长按从多选改为拖动排序
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
