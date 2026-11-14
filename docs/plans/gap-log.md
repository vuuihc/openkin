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

### 2026-11-14 · 高 · 新建对话发送后，进入对话 URI 时仍插入整页骨架屏

新建对话在 `/new` 发送后，用户消息与宿主等待行已经立即出现（#45）。但
`POST /api/tasks` 返回、路由切到 `/tasks/:id` 时，对话页既没有 detail、也不一定有
会话宿主持有的列表行，`TaskDetailPage` 走 `loading && !task` 分支画出整页骨架屏
（`ui/src/pages/TaskDetailPage.tsx:1492`）：页头、标题、输入框和刚显示的用户气泡一起
消失，等 detail 返回后才重新出现。读起来是「消息 → 骨架屏 → 同一条消息」，乐观更新
在路由边界被拆掉，只做了一半。

期望（可直接写成测试）：从 `/new` 触发发送，到新建对话 URI 的第一条真实事件到达，
同一条用户消息（同一文本）与宿主等待行必须持续留在屏幕上：不出现整页骨架屏、不出现
空白内容区、页头 / 标题 / 输入框不卸载、消息不闪回也不重复。创建响应里的 task 行要
同时种进对话页的 detail（不能只更新任务列表）；在途的 pending 消息要跨路由交给对话页
（按新建 task id 存到共享 store 或路由 state），使 `/tasks/:id` 的第一帧就画出同一个
气泡与等待行；服务端的用户事件到达后，由现有 `settlePendingSends` 交还，气泡位置不跳、
不重复。深链 / 冷启动且没有任何 task 行时仍按 #44 显示品牌等待态（#44 已在 `c7c12cc6`
合并中被回退成骨架屏，修复时一并恢复）；控制台自己刚创建的对话不允许经过这个状态。
detail 请求失败时保留用户气泡并显示现有错误横幅与重试，不能把消息丢掉。

不要：靠「detail 很快就回来」掩盖；在乐观气泡与真实 transcript 之间保留 loading /
骨架屏内容区；路由切换时清空 pending 消息、再等服务端事件重建；本地气泡与服务端事件
同时显示。

线索：`ui/src/pages/NewChatPage.tsx:520-554`（`setPendingSend` 是本页 state，
`applyTaskSnapshot` 后立即 navigate）、`ui/src/pages/TaskDetailPage.tsx:187-204`
（`task = detail.data.task ?? fallbackTask`、`loading = !detail.loaded`）、
`:1492-1516`（整页骨架屏；`git blame` 显示 `c7c12cc6` 把 #44 的品牌等待态退回
`SkeletonLine`，冷启动回归要一起修）、`:2013-2034`（ChatStream 的 `loading` 与
`fallbackUserPrompt`）、`ui/src/api/liveResources.ts:351-354,681-715`
（`applyTaskSnapshot` 只更新 `tasksById`，不创建 `taskDetails` 条目）、
`ui/src/pages/TaskSessionHost.tsx:104-125,245-253`（fallback 行来自任务列表）、
`ui/src/lib/pendingSend.ts`。现有测试：`NewChatPage.pendingSend.dom.test.tsx`、
`TaskDetailPage.coldLoad.dom.test.tsx`、`TaskDetailPage.pendingSend.dom.test.tsx`。

验收：一条 DOM 测试串起 `/new` → 发送 → resolve create → `/tasks/:id`，断言 pending
气泡与等待行在导航前后都挂载、整页骨架屏从未出现，服务端用户事件到达后只剩一个气泡；
一条测试让 detail 失败，断言气泡仍在且错误横幅 / 重试可见；390px 手机录屏从发送到
第一条回复无骨架屏 / 空白帧；继续发送路径不回归；`./scripts/check.sh` 绿。

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

进展（2026-11-14）：行左划的动作条部分已修，见「已修」PR #50。边缘右滑返回的
跟手部分未动：`useEdgeSwipeBack` / `phoneBack` 只存在于本地未提交的工作树，
`origin/main` 尚无该手势，等本地 WIP 推送后再修。

## 已修

每条只留一行：症状、落地提交、PR。修复过程与验证在 PR 里，不再重复。

- 2026-11-12 · 例行任务查不到 gap sweep，伴随 token 长度超过约 65530 的错误 — PR #52（`?runs=1&runs_limit=80` 的运行流不再拼进每次运行十几 KB 的 prompt：本机实测 1,200,074 → 约 94 KB，落在机器中继 `worker.MaxRoutineResponse` 655,360 字节内，页面不再整页失败；红测还原修复后 1,245,269 字节超限、恢复后通过，`go test ./internal/api/`、`./scripts/check.sh` 14 项、`./scripts/smoke.sh` 全绿；报告人原始报错原文仍未取得，若同一报错再现请附原文）
- 2026-11-09 · routines 改为设备归属后的遗留项（旧 Hub 库的 routines 没迁移、只有选「本机」才看得到）— PR #51（显示其他机器时提示「本机还有 N 个例行任务」并可一键切到本机；禁用 / 迁移 2026-11-10 已问报告人、超 48 小时无回答，按 §4 执行可回退默认值：不改数据只让现状可见，禁用 / 迁移仍待方向；3 条新 DOM 测试，check.sh 除已知 PanelSurface 抖动外全绿）

- 2026-11-12 · 手机端「划」没有过渡（行左划的动作条部分）— PR #50（拖动第一次位移即挂载动作条，未提交前 inert + aria-hidden + pointer-events:none，收起保留到 180ms 滑回结束；SwipeReveal DOM 测试 10 passed、还原组件后 4 failed，check.sh 除并发构建下的 5s 超时抖动外全绿）
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
