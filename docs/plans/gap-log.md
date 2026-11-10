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

### 2026-11-10 · 中 · 历史会话从最早 50 条往后翻，最近的内容要翻很久才看得到

打开一个 Agent 历史会话（`/agent-sessions/:id`）时，首屏只取最早的 50 条，
「加载更多」在底部继续往后翻。一条几百轮的会话要翻很多次才能读到最近几轮，
而打开历史会话的人通常先看最近发生了什么。

期望：

- 首屏先显示**最后一段**（最近的消息），并停在底部。首屏预算是最近 200 条或
  正文合计约 1 MiB，先到者为准（已定，2026-11-10）。
- 向上滚到顶自动加载更早的一页；加载中必须在列表顶部给出可见提示，加载完成后
  提示消失。插到列表前面时视口锚定在原第一条消息上，读的人不会被弹走；没有
  更早内容时给出明确的到头状态。
- 第一页从完整消息开始：provider 会把一条消息拆成多个 chunk，
  `mergeAgentSessionMessageChunks` 只在已加载列表内合并，页边界落在 chunk
  中间会让首条消息只剩半句。
- 同一会话在本机和「配对机器转发」两条路径上返回同样的页大小与内容；现有
  `internal/api/agent_sessions.go` 的注释已经把这条当作契约。

明确不要：

- 不要在前端先拉完所有分页再截尾，也不要一次把整个源文件读进后端内存——
  这只是把「内容太多」的成本藏起来。
- 不要只改 Mac 前端：provider 历史的 `HistoryQuery` 只有向前 cursor
  （`internal/sessioncatalog/file.go:113` 起，cursor 是 JSONL 行号），
  从尾部读需要扩展 provider 契约，并把 node / worker 的同一条路径一起改，
  否则手机会和 Mac 翻出不同的页。

可以照抄：

- 例行任务的运行记录已经是「最新的先显示 + 加载更早」：
  `ui/src/lib/routineHistory.ts` 的 `ROUTINE_HISTORY_PAGE` / `pageCursor` /
  `ROUTINE_HISTORY_MAX`，`ui/src/pages/RoutinesPage.tsx` 的
  `loadOlderHistory`。差别是它用 daemon 的 `before`（ULID）向后翻，
  provider 历史还没有这个能力。

已定（2026-11-10，报告人）：

- 首屏预算：最近 200 条或正文约 1 MiB，先到者为准。
- 上翻方式：滚到顶部自动加载，不做成需要点击的「加载更多」；加载中要有可见
  提示，失败后保留已读内容并可重试。

线索：

- `ui/src/pages/AgentSessionDetailPage.tsx:107`（`limit: 50`）、`:109`（向后
  append）、`:286`（底部「加载更多」）、`:262`（滚动容器）
- `internal/api/agent_sessions.go:456` / `:521`（本机与远程同为默认 50）；
  `internal/remote/worker/query.go:373` 把单帧上限定在 100 条，所以 200 条的
  首屏要么拆成多页读，要么把预算改成字节数
- `internal/agent/sessions.go:43`（`HistoryQuery`）、
  `internal/sessioncatalog/file.go:113`（只能向前的 JSONL cursor）、
  `internal/node/sessions.go:184`
- `ui/src/lib/agentSessionHistory.ts:48`（chunk 合并只在已加载列表内）

验收：

- 打开一条 500 条以上的会话，首屏就是最后一段且停在底部；
- 上滚到顶会取到上一页；请求期间顶部有加载提示，完成后消失；prepend 后视口
  仍停在原第一条消息；
- 首屏不请求全部分页；本机与远程同一会话首屏条数一致；
- 首条可见消息是完整消息，不是 chunk 中间；
- 「加载更早」失败时不清空已读内容，可以重试。

### 2026-11-09 · 中 · routines 改为设备归属后的遗留项

routines 的跨设备主路径已按 2026-11-08 的决策落地（见 `## 已修`，`901821bf`）：
在任一客户端选中一台机器，就能看见并管理那台机器上的例行任务。同一决策下还有
几处没有跟上，都不影响主路径，但多设备下仍会露出本机视角。

期望：继续按「routines 属于 Device，Hub 只转发和鉴权」补齐：

- **项目页的 routine 仍写本机**：`ProjectDetailPage` 创建/列出 routine 时不带
  device，而 project 是 Hub 侧按 cwd 建的记录，节点并不认识它。多设备下这条
  路径要改成「按 cwd 找机器上的 routine」或收掉。
- **远程 run 的 task 详情 / transcript 打不开**：节点上的 task 只存在节点库里，
  Hub 没有查询通道；远程 run 的实时更新也不会经 Hub 的 WS 推过来，页面上一条
  运行中的 run 会一直停在旧状态，直到重新加载。
- **MCP 没有创建 routine 的工具**：`internal/mcp/server.go` 仍只有
  `list_routines` / `run_routine`。
- **旧 Hub 库的 routines 没有迁移**：升级后它们仍由 Hub 调度，而 Routines 页
  默认落在节点上，只有选「本机」才看得到。要不要禁用 / 迁移需要产品决定
  （待定，报告人）。

线索：`internal/api/routines.go`（大多数操作已带 `device`）、
`ui/src/pages/ProjectDetailPage.tsx`、`internal/mcp/server.go`、
`ui/src/pages/RoutinesPage.tsx`（「本机」选项与旧数据的提示）。
验收：项目页不再写 Hub 库；远程 run 能打开详情并实时更新；MCP 可创建；
旧数据有明确处置。

### 2026-11-08 · 中 · 侧栏看不出设备 → 项目 → 对话的层级

iPad 左侧对话栏里，设备、项目、对话三层看起来在同一个平面上，看不出谁包含谁，
也看不出哪些对话属于哪个项目。项目名用的是全大写小节标签的样式
（`kin-section-label`：`text-caption`、uppercase、muted），比对话标题还小还淡；
缩进也没有递进——在 248px 的桌面侧栏上量：设备名约 45px、项目名约 35px、对话
标题约 34px，项目和对话几乎同深，设备反而最深。

IA 已经定了对话列表是“设备 → 项目 → 对话”三级（`docs/product/IA.md`），这条
不是 IA 要改，是层级没有在视觉上成立。

期望：三层由缩进和字重一起表达，左边缘严格递进（设备 < 项目 < 对话），项目名
不再像小节标题；折叠箭头待在能看出它属于哪一级的位置；iPad 桌面侧栏和 390px
抽屉两种宽度都成立。

待定：具体形态要报告人定——缩进步长（建议 8/8px 或 12/12px）、项目行要不要
分组背景、要不要加一条竖线。没定之前不要只改颜色交差。

线索：`ui/src/components/layout/Sidebar.tsx:1082`（设备子层只有 `pl-1`，4px）、
`:1195`（项目行，`kin-section-label`，没有左内边距）、`:1315`（对话容器，没有
左内边距）、`:1488`（对话行 `px-2`）；`kin-section-label` 的定义在
`ui/src/index.css:538`。验收：iPad 与 390px 抽屉各一张截图，三层左边缘严格
递增；折叠/展开项目后层级不变。

## 已修

每条只留一行：症状、落地提交、PR。修复过程与验证在 PR 里，不再重复。

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
