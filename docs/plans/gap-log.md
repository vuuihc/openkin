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

### 2026-11-09 · 中 · routines 改为设备归属后的遗留项

routines 的跨设备主路径已按 2026-11-08 的决策落地（见 `## 已修`，`901821bf`）：
在任一客户端选中一台机器，就能看见并管理那台机器上的例行任务。同一决策下还有
几处没有跟上，都不影响主路径，但多设备下仍会露出本机视角。

期望：继续按「routines 属于 Device，Hub 只转发和鉴权」补齐：

- **旧 Hub 库的 routines 没有迁移**：升级后它们仍由 Hub 调度，而 Routines 页
  默认落在节点上，只有选「本机」才看得到。要不要禁用 / 迁移需要产品决定
  （待定，报告人）。

线索：`internal/api/routines.go`（大多数操作已带 `device`）、
`internal/mcp/server.go`、`ui/src/pages/RoutinesPage.tsx`（「本机」选项与旧数据的提示）。
验收：旧数据有明确处置。

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
