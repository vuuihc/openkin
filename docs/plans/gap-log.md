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

### 2026-11-12 · 高 · 例行任务查不到 gap sweep，伴随 token 长度超过约 65530 的错误

例行任务页面查不到按小时读取本文件的 gap sweep 任务，同时显示「token 长度超过
65530」一类的错误。它可能使例行任务列表 / 详情或后续调度不可用，需要排查并修复，
而不是只重试或删掉报错任务。

期望：gap sweep 在例行任务中有可辨认、可打开、可手动运行的记录，历史运行与错误
能正常查看；token 超限错误消失，gap sweep 能读取 `docs/plans/gap-log.md` 并完成
一次真实调度。修复必须覆盖超限数据的真实读取和持久化路径：先保存原始报错、请求
大小与涉及的任务 / 运行记录，再区分是 SQLite 字段宽度、请求 / 代理限制、上游模型
上下文限制，还是列表查询错误地把超长 prompt / transcript 拼进去；不能凭「65530」
这个数字猜原因。若只是查询失败，任务本身和调度状态必须恢复；若任务确实不存在，
补充可追溯的创建 / 恢复流程，不能静默新建重复任务。

不要：为了绕过报错直接删除任务或历史、降低 / 截断 prompt 后继续累积超限内容、
只改报错文案，或只让页面隐藏错误而不恢复真实查询与调度。

待定：需要报告人保留并附上一条完整错误原文和发生时间，以定位是列表请求失败、
打开任务时报错，还是执行时报错。线索：`internal/api/routines.go`、
`internal/store/routines.go`、`internal/store/routine_dispatch.go`、
`internal/routines/scheduler.go`、`internal/node/routines.go`，
`ui/src/pages/RoutinesPage.tsx`，以及实际节点上的 gap sweep 任务定义与最近运行日志。
验收：用超过当前边界的 prompt / run 数据复现失败测试；修复后同一数据能读回并展示；
重启后 gap sweep 记录与调度仍存在；连续两次真实运行无重复任务、无 token 超限错误；
`./scripts/check.sh` 与 `./scripts/smoke.sh` 绿。

### 2026-11-12 · 高 · 手机端「划」没有过渡：返回硬切，行左划的动作条松手才出现

手机上滑动是「松手才动」的。左缘右滑返回时，手指已经划过 64px，屏幕上的页面
一动不动；松手后当前页瞬间消失，列表直接出现（新页只有 140ms 淡入，
`ui/src/index.css:344`），读起来是一次硬切。`useEdgeSwipeBack` 只判定阈值，
不暴露拖动距离（`ui/src/hooks/useEdgeSwipeBack.ts:19` 写明「没有跟手的
transform」），`AppShell` 那条 20px 的透明感应条也没有任何可见反馈
（`ui/src/components/layout/AppShell.tsx:524`）。

期望（可直接写成测试）：

- **拖动中**：当前页随手指水平右移（可加阻尼，上限约屏宽 1/3），列表在下层
  露出来；拖动位移 > 0 即可断言。
- **松手**：过阈值（64px 或右甩）继续滑完再落列表；不过阈值回弹到 0，位置和
  路由都不变；pointercancel 仍视为放弃并回弹，不提交。
- **`prefers-reduced-motion`**：不跟手，松手直接提交；沿用
  `ui/src/lib/swipeGesture.ts` 的 `prefersReducedMotion`。
- 页头返回按钮和系统返回不必跟手，但手势提交与按钮提交必须落同一页、走同一个
  返回实现（`lib/phoneBack.ts` 的 `goBackToList`），不能各写一份。

不要：只把新页的淡入从 140ms 拉长或换成位移动画来冒充跟手——手势的反馈必须
发生在手指移动期间。也不要把 `transform` 永久挂在 `.kin-main` 上：它会让容器内
的 fixed 后代改以它为包含块（`ui/src/index.css:337-352` 已写明这个约束，sheet、
浮层、命令面板都在里面）。手势期间用的位移层在结束后要清掉，或只包住没有 fixed
后代的页面内容。

举一反三（同一类：手势有判定、没有连续反馈）：

- **行左划露出操作**：`SwipeReveal` 只在 `open` 为真时才挂载动作条
  （`ui/src/components/mobile/SwipeReveal.tsx:160`）。拖动过程中行向左滑，后面
  是空的，松手动作条才「啪」地出现；收起时动作条又先瞬间消失、行再 180ms 滑回。
  期望：动作条从拖动开始就在，随行一起连续露出；未提交前不可聚焦、不可点
  （组件注释里已有「隐藏但可聚焦比没有更糟」的约束）。
- **点开对话 / 目的地**：故事写的是「整页推出」
  （`docs/product/stories/KIN-CONTINUE-002.md`），实际所有路由切换都只有
  140ms 淡入、没有退出动画。若要做方向性过渡，必须先解决上面 fixed 后代的
  问题；不做也要在交付里写明「推出」只是信息架构说法，不是动画承诺。
  （待定，报告人：点开是否也要滑入，还是只有手势要跟手。）

可以照抄的同类实现：`ui/src/components/mobile/Sheet.tsx:290-317`——跟手、阻尼、
过阈值后先走完 180ms 再卸载、不过阈值回弹、reduced-motion 直接关；阈值与甩动
速度共用 `lib/swipeGesture.ts`。

线索：`ui/src/hooks/useEdgeSwipeBack.ts`、
`ui/src/components/layout/AppShell.tsx:199,524`、
`ui/src/components/mobile/SwipeReveal.tsx`、`ui/src/index.css:337-356`、
`ui/src/components/mobile/Sheet.dom.test.tsx`（手势测试的写法）。

验收：

- `useEdgeSwipeBack.test.tsx`：拖动中位移 > 0；回弹归零；过阈值提交；取消回弹；
  reduced-motion 无位移但提交。
- `SwipeReveal.dom.test.tsx`：拖动未松手时动作条已在 DOM 且不可聚焦；收起过程中
  仍在，动画结束后才卸载（或等价的可观察状态）。
- 390px 浏览器连续截图或录屏：手指移动时页面跟着走，松手滑完落列表；行左划时
  操作随行露出。
- `./scripts/check.sh` 绿。

### 2026-11-09 · 中 · routines 改为设备归属后的遗留项

routines 的跨设备主路径已按 2026-11-08 的决策落地（见 `## 已修`，`901821bf`）：
在任一客户端选中一台机器，就能看见并管理那台机器上的例行任务。同一决策下还有
几处没有跟上，都不影响主路径，但多设备下仍会露出本机视角。

期望：继续按「routines 属于 Device，Hub 只转发和鉴权」补齐：

- **旧 Hub 库的 routines 没有迁移**：升级后它们仍由 Hub 调度，而 Routines 页
  默认落在节点上，只有选「本机」才看得到。要不要禁用 / 迁移需要产品决定
  （待定，2026-11-10 已问报告人）。

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

待定（2026-11-10 已问报告人）：具体形态要报告人定——缩进步长（建议 8/8px 或
12/12px）、项目行要不要分组背景、要不要加一条竖线。没定之前不要只改颜色交差。

线索：`ui/src/components/layout/Sidebar.tsx:1082`（设备子层只有 `pl-1`，4px）、
`:1195`（项目行，`kin-section-label`，没有左内边距）、`:1315`（对话容器，没有
左内边距）、`:1488`（对话行 `px-2`）；`kin-section-label` 的定义在
`ui/src/index.css:538`。验收：iPad 与 390px 抽屉各一张截图，三层左边缘严格
递增；折叠/展开项目后层级不变。

## 已修

每条只留一行：症状、落地提交、PR。修复过程与验证在 PR 里，不再重复。

- 2026-11-12 · 新建与继续对话发送后页面迟迟不变，缺少即时消息与回复等待态 — PR #45（发送时先入本地用户气泡与等待行：`pendingSend` 以「同文本 + 发送后 seq」在服务端消息落地后交还，失败撤回并由 Composer 恢复原文；新建对话在 create 在途时直接显示消息与宿主等待行；pendingSend/ChatStream/两页 DOM 测试共 16 passed，check.sh 全绿）
- 2026-11-12 · 应用启动骨架屏动效不好看，应改为品牌 icon 展示 — PR #44（`TaskDetailPage` 冷启动无缓存行时改为居中 `IconKin` 品牌块，180ms 单次淡入、reduced-motion 关闭；慢连接仍显示原提示，返回后立即卸载；cold-load 单测 6 passed，390×844 / 1440×900 静态渲染无溢出，check.sh 全绿）
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
