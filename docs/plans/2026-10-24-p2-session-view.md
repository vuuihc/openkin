# P2 — 会话视图升级

上游：`docs/plans/2026-10-23-lody-parity.md` §6 P2（七项交付，依赖 P1，大小 L）。
上游验收句是**「连续用一周，不再需要打开终端看 diff；subagent 跑起来时不用猜它在干什么」**，
而真实验收在手机上。本文件记录这一层的形状、顺序、守卫与证据。

行号基准：`main` 合入 P1 之后的树（2026-10-24）。写这份文档时逐条核过——
15 条关键引用全部落在所述构造上，其中 UI 的几条是在 P1 的 Prettier 全树格式化
**之后**核的（格式化会让行号漂移，所以这一句本身就是证据的一部分）。

## 1. 目的与验收

上游七项交付，按「手机上不做会怎样」重排后的可验证形态：

| # | 交付 | 在手机上怎么算过 |
|---|---|---|
| 1 | 运行中发消息 = 排队，不打断 | 跑到一半补一句，当前轮跑完、审批没被拒，agent 接着答 |
| 2 | 审批在输入框位置回答 | 不用先打字再发现底下有个审批 |
| 3 | 活动分组（思考 ≠ 叙述） | 折叠卡能看出哪段是思考、哪段是回答 |
| 4 | 逐轮 diff 证据卡 | 「这一轮改了什么」在聊天里能看到，不回落终端 |
| 5 | 居中栏 + 宽度档位 | 窄屏不溢出、宽屏不是一条拉到头的行 |
| 6 | subagent 面板 | 主聊天能看出子代理在干什么 |
| 7 | 聊天内代码高亮 | 围栏代码块不再是纯文本 |

顺序不按实现难度，按**「今天就在损坏用户数据」**排。第 1 项是唯一一条：
今天运行中补一句话的代价是**打断当前轮 + 拒掉所有待批审批 + 代答所有待回问题**。

## 2. 现状实测

### 2.1 三项交付今天拿不到数据

先做 UI 必返工，所以它们排进 S1（数据面切片，无 UI）：

- **subagent 活动**：事件在源头被标成 `VisibilityTaskOnly()`
  （`internal/task/orchestrate.go:1041-1058` → `internal/task/event_meta.go:56-58`），
  控制台再按 `visibility.user` 丢掉（`ui/src/components/chat/transcriptProjection.ts:461-465,491-493`）。
  属性字段 `execution` 已经解出来没人用（`ui/src/components/chat/eventMeta.ts:161-171`）。
  今天订阅方式是 250ms REST 轮询 `GET /api/tasks/{id}/workers`：只有终态、没有工具细节。

  **S1b 核过之后这条要改口**：数据不是没有，是没人说清哪块面料归谁。见 §3.6。
  端点名也写错了，是 `GET /api/tasks/{id}/worker-steps`（`internal/api/worker_steps.go:13`），
  而且它只服务**计划表**，不是活动。
- **逐轮 diff 的锚**：投影里 `ToolStep`/`NoteStep`/`ProgressItem` 没有 `seq`
  （`transcriptProjection.ts:7-37`），只有 message 有；`groupIntoTurns`
  （`:792-824`）不给轮边界。所以「这一轮的 diff」今天**算不出来**。
  上游还是有损的：kinagent 截到 8000 字节（`internal/adapter/kinagent/loop.go:570-573`），
  ACP 截到 64KB 并把结构化 `diff` 拍平成 `---/+++` 文本
  （`internal/adapter/acp/update.go:43,297-318`）。
- **审批锚点**：`Approval` 没有 `seq`（`api/openapi.yaml:2511-2521`），唯一的定位痕迹
  是投影里 `ar-${ev.seq}` 那个 meta 标记（`transcriptProjection.ts:606-615`）。

### 2.2 两项共用同一条今天会毁掉东西的调用

运行中发消息走 `interruptAndFollowUp`（`internal/task/approvals.go:458-478`）。
它不只是「发送」——它做三件事：`e.canceled[id]=true`、`h.Cancel()`、
**拒掉所有待批审批并代答所有待回问题**。队列和「审批顶替输入框」都压在这条路径上，
所以 S1a 必须先把它拆开。

好消息是缝已经在了：`runLoop` 在进程退出时读 `e.pendingFollowUp[id]` 并重排
（`internal/task/engine.go:2533-2540`），打断只是**另外**加的那三步。
所以「队列」= 把**单槽改成有序列** + 让排队这条路**不碰**那三步。
今天 `pendingFollowUp` 是纯内存（`internal/task/engine.go:183`），
**服务重启即丢**——手机上你在聊天里看得见自己那句话、agent 永远不会回答它。

### 2.3 顺手挖出来的死面（清点副产品）

- `ui/src/components/Transcript.tsx`：298 行，**零引用**（全仓 grep 只剩
  `api/sessionSync.ts:74` 注释里一个同形词），硬编码英文，自带一套 `buildRows`。
  上游 parity plan 点的「两种风格并存」风险就是它。
- `ApprovalCard.previewLines`（`ui/src/components/cards/ApprovalCard.tsx:15,92-110`）：
  两个调用点（`TaskDetailPage.tsx:989`、`ApprovalsPage.tsx:170`）都没传，从没渲染过。
- 三个写好了没接线的 i18n key：`chat.progress.collapsed`（`en.ts:297`）、
  `chat.progress.step`（`:307`）、`task.roundBusy`——`src/` 里零引用。
- `NoteStepRow`（`ChatStream.tsx:656-679`）既不画 `speaker` 也不画 `model`，
  虽然投影留着它们（`transcriptProjection.ts:245-252`）；每种 note 都用
  `chat.progress.note` 当标签（`:671-673`）。

## 3. 目标形状

### 3.1 队列由服务端持有

手机大部分时间是关着的。客户端队列等于丢消息。所以：有序列 + 持久化。

落点两选一（S1a 里定）：**任务行上一个 JSON 列**，或一张镜像 `ListPendingForTask`
的小表。判据是**服务重启后队列必须还在**。

已经把迁移的形状核清楚了，不是猜的：`tasks` 表在 `internal/store/migrate.go:179`
的 `migration001` 里建，当前 `schemaVersion = 38`（`:10`），而**给 `tasks` 加列的
house style 是守卫式 `ALTER`**——`PRAGMA user_version` 推到 39，列用
`pragma_table_info` 存在性守卫后 `ALTER TABLE tasks ADD COLUMN`
（`:1209-1219` 就是 routine 那四列的形状，`:1105-1127` 是 approvals 的同款）。
空库（`migration001` 建表 → 守卫补列）和满库（守卫补列）走的是同一条路，
所以 AGENTS.md 要的「空库 + 满库」两种覆盖天然成立，不用另写一条重建路径。

选 JSON 列还是镜像表，判据是**要不要按序查询**：队列只需要「取该任务的全部、按序」，
JSON 列就够；一旦要跨任务查（例如「所有排队中的任务」）就该是表。

### 3.2 拆 `interruptAndFollowUp`：队列是它的补集，不是它的替代

`FollowUp`（`internal/task/approvals.go:440-456`）按状态分岔，这条分岔就是答案：

- 终态（Succeeded / Failed / Canceled）→ `applyFollowUp(..., interrupted=false)`：
  **不 cancel、不拒审批、不代答**。这条路今天已经是对的。
- 非终态（Running / WaitingApproval / WaitingInput / Queued）→ `interruptAndFollowUp`。

`interruptAndFollowUp`（`:458-540`）按序做八件事，其中三件是破坏性的：
拒掉所有待批审批（注释写明是为了**让 MCP 的 waiter 解锁**，因为进程马上要被杀）、
代答所有待回问题、`e.canceled[id]=true` + `h.Cancel()`。
但它还做了一件**队列也必须做**的事：`appendUserGuideEvent`（`:509`）
**立刻**把用户那句话写进聊天——注释原话是"so the chat is not locked waiting for
process death"。排队这条路要照抄这一条，否则手机上发完什么都不显示。

**别把它和 `e.queue` 搞混**：`e.queue` 是**任务级调度队列**（哪些 task 等着开跑），
不是消息队列；`interruptAndFollowUp` 里那段"如果还只在 queue 里就摘下来立即应用"
（`:485-501`）处理的是"任务还没起跑"这个竞态，与消息队列无关。
P2 的队列是**每个任务**下的一条**待发消息**有序列，两者共存、互不替代。

所以 S1a 的形状是**加一条支路**，不是改一条：非终态时先写队列 + 发 user-guide 事件，
不碰那三步；轮末在已有的缝上（`runLoop` 读 `pendingFollowUp`，`engine.go:2533-2540`）
从"取单槽"改成"取队首"。显式的「打断并立即发送」仍旧走今天的 `interruptAndFollowUp`——
它已经是那条路的完整实现，不需要改写，只需要**不再是默认**。

### 3.3 审批锚点用相关性重建，不新增外键

原位渲染靠 `ar-${ev.seq}`；窗口外的审批没有锚点，**必须有兜底位置**
（回落到现在这个 trailing 位置）。`TaskDetailPage.tsx:132,449-471` 的 `focusIdx`
按数组下标排，**必须同时改成按 seq**——否则键盘跳的位置和眼睛看到的不是一个。

### 3.4 打断仍然存在，但要显式且改名

Composer 今天在运行中把第二个按钮写成 `composer.sendGuide` =
"Insert guidance & interrupt"（`Composer.tsx:576-590`），文案本身就是那个破坏性
契约的说明书。队列落地后：默认「发送」= 排队；「打断并立即发送」保留为显式动作。

API 形状：`FollowUpRequest`（`internal/task/engine.go:94-99`：`prompt` / `agent` /
`model` / `permission_mode`）加一个字段表示"这一条是打断"，**不是**加一个端点——
两者是同一件事的两个模式，分流点已经在 `FollowUp` 那个 switch 里了。
默认语义**直接翻转**成排队：本仓不同时维护两版语义，不做兼容垫片
（旧客户端拿到的新行为就是排队的语义，这是有意的）。

### 3.5 宽度不是一条轴，是四条；先分家族，再定名

P1 留给 P2 的活，原话是「五个没名字的宽度在 11 个文件里还是字面量」。
**清点之后这个数字要改**——`src/` 里有 **28 个文件**含任意值宽度工具类，
而它们不是一条轴（`grep -rnoE "(max-w|min-w|w|basis)-\[[^]]*px\]" src`）：

| 家族 | 值 | 是什么 | 现状 |
|---|---|---|---|
| **页面栏宽** | 640 / 920 / 1100 | 一页的居中内容栏 | 各 1 处（`ApprovalsPage:117`、`SettingsPrimitives:80`、`AgentsPage:413`） |
| **会话栏宽** | 720 | 聊天列 | **已有名字**：`max-w-conversation`，13 个调用点 |
| **表格/面板** | 980（`min-w`）、300（`TaskDetailPage:1139`） | 表格最小宽、右栏 | 各 1 处 |
| **浮层宽** | 220×3 / 240×4 / 260 / 280 / 320 / 340 | 菜单与弹出层 | 全是字面量 |
| **控件宽** | 44×9（`min-w`）、22 / 26 / 28 / 18 / 34 / 68 / 13 / 7 / 2 | 图标框、按钮最小宽、分隔线 | 全是字面量，且**属于 P1 的控制件阶梯**，不是栏宽 |

所以 S7 的形状是：**先按家族定名**（页面栏 / 浮层 / 控件三档；会话栏已有名字），
再换掉 28 个文件的字面量，最后才把宽度轴写进 lint——
`ui/eslint-rules/index.js:49-55` 的 `OFF_LADDER` **故意不含宽度轴**，
这正是 P1 留的条件：**先有阶梯，再有守卫**。

两个必须先决定、不能顺手改的：

- `AppState`（`ui/src/store/appStore.ts:63-79`）今天没有布局字段，两个语言表里
  也没有宽度相关的键——「居中栏」是个**状态**（用户能不能调宽度档位），
  不是一个 class 改名。
- 控件宽（44px 那 9 处是按钮最小宽）**不要**并进栏宽阶梯：它和 P1 已经落地的
  控制件高度是同一套刻度，混进来会让两条轴互相污染。

### 3.6 subagent 可见性：两块面料，两个事实来源（S1b 决定）

**结论：引擎不用改。** 数据面今天就是对的，缺的是把「哪块面料归谁」写下来，加两条守卫。

**一、`visibility.user` 的语义是「属于 host 的聊天栏」，不是「给用户看」。**

- worker 的一切（叙述 + 工具）保持 `{user:false, task:true}`。
  **把 worker 工具翻成 `user:true` 是最诱人的错误改法**：`isUserFacingEvent`
  （`transcriptProjection.ts:979-992`）只看这一位，翻了之后聊天栏里就会显示
  host「跑」了它根本没跑的命令——子代理的动作记在主代理头上，比不显示更糟。
- 用户能看到的子代理活动走**活动面**：`isTaskOnlyMeta`
  （`eventMeta.ts:175-181`，显式 `visibility.user` 优先，`task:true` 即入活动面）。
  worker 叙述今天就已经落在活动/进度卡里；worker 工具**也已经在流上**
  （`name`/`tool_name`/`input`/`output`/`summary`/`status`/`ok`，外加
  `execution_id`/`execution_step`/`execution_agent`/`execution_model`），
  控制台只是在**聊天投影**里丢掉它（`:463,492`）。
- 不进面板的：partial / reasoning 增量、`usage`、`raw_output`。

**二、订阅方式：不新增订阅。** 两个事实源，各管一半：

| 事实 | 从哪来 | 为什么不是另一个 |
|---|---|---|
| 某个 worker **正在干什么**（工具调用与结果） | 现有 SSE `GET /api/events`：worker 事件本来就在这条流上，本来就在客户端按 seq 合并、有断档补齐（`?since_seq=`），服务端**不过滤** visibility（`handleListEvents` → `Engine.Events` 原样返回） | `worker-steps` 表里**没有**工具细节 |
| 每个 worker 被**要求**做什么（`role`/`depends_on`/`access`/`step_index`/`attempt`/`result_summary`） | `GET /api/tasks/{id}/worker-steps`（250ms 轮询保留，但它只服务这张表） | 事件流里**没有** `depends_on`/`access` |

**连接键**：事件 `execution_id` + `execution_step` ↔ 行 `execution_id` + `step_index`
（`applyExecutionMeta`，`orchestrate.go:1110`；表的 PK `(task_id, execution_id, step_index)`，
`migrate.go:1928-1946`）。两边都已经打上，**不用新增字段**；`eventMeta.ts:161-171`
那个没人用的 `readExecution` 正好是 UI 侧的解码入口。

**三、所以 S6 是纯渲染**：面板读它**已经拿到**的事件，按 `execution_step` 归到计划行上。
S1b 欠的是两条守卫（已落地，见 §8），保证这个决定不会被后来的改动悄悄推翻：

- worker 事件不得进入 host 聊天栏（今天只有一条 message 形状的断言，工具形状没钉住）。
- worker 叙述不得进入 host 的 handoff 上下文：`summarizeEvent`
  （`approvals.go:1607+`）只处理 `message`/`error`/`result`/`raw_output`，对非
  orchestrator 来源且 `visibility.user=false` 的 message 返回空，所以 `handoffContext`
  看不到 worker 的原话——host 只读 orchestrator 的 summary。这条让「面板可以展示
  worker 叙述」和「host 不会因此多读东西」解耦：把 worker 叙述翻成 `user:true`
  会**改变 orchestrator 在上下文重建时看到的东西**，那是行为变更，不是 UI 变更。

### 3.7 代码高亮不引 Monaco

先例是 `MermaidBlock.tsx:3-17` 的懒加载单例。Monaco 已经 3.3MB 且工作区专用，
**不要**把它拉进聊天（`Markdown.tsx:26-38` 的围栏今天是纯文本）。
选一个轻量高亮器，**体积要量出来**并写进证据。

### 3.8 S4：思考与叙述的区分来自来源，不来自猜文本

`ProgressCard` 已在、默认收起，缺的是**区分**（§2.3）：每种 note 都用
`chat.progress.note` 当标签，`speaker`/`model` 投影一直留着却从不画。

判据是**别去猜文本**（"这段读起来像思考"），而是带**来源**——投影在造 note 的那一刻
就知道它从哪来：消息的 `role`（`reasoning` vs `assistant`）与 canonical `phase`
（`plan`/`progress`/`summary`，见 `eventMeta.ts`）。把来源写进 `NoteStep.source`，行标签照它选：

| `source` | 标签 | 依据 |
|---|---|---|
| `reasoning` | `chat.progress.thinking`（新增） | 适配器把模型的私有思考发成 `role:"reasoning"`，投影已按 `isProgressMessageMeta` 把它关进过程卡（测试「keeps the agent's reasoning out of the answer」） |
| `plan` | `chat.progress.plan`（新增，与现有 `planCleared` 同族） | `PLAN_NOTE_PREFIX` 那条线，一轮一行 |
| `summary` | 复用现有 `summary*` 组 | orchestrator 的总结 |
| 其余 | `chat.progress.note`（今天的默认） | 叙述 |

`speaker`/`model` **只在它与卡片的 speaker 不同时**才画：被委派的 worker 的 note 需要说明
"这不是 host 说的"，而每行都挂模型名在手机上只是噪音。

三个悬空 key 一起结清：`chat.progress.collapsed` 用作收起态的摘要行（`{count}` 已在）、
`chat.progress.step` 用作行号的可访问名、`task.roundBusy` 若 S4 用不上就**删**（§2.3 的清单）。

**落地时的两处订正**：

- 表里的 `summary` 那一档**不成立**。`phase: "summary"` 的消息不是 note：它是 process run
  的定稿消息、`mergeProcessRun` 找的那个锚点（`transcriptProjection.ts:847`），
  所以没有任何 note 会带 `source: "summary"`。来源因此只有三档：`reasoning` / `plan` / `note`，
  行标签也只对应三个 key（`thinking` / `plan` / `note`）。
- 归属**不能只比字符串**。夹具第一版就把 host 自己的 note 画成了「Kin · claude-sonnet-5-5」：
  卡片（`ProgressItem`）的 speaker 是 `hostSpeaker`（`claude-code`），而 legacy 行的 note speaker
  是 `kin`——同一列的两个名字。规则落成 `isHostVoice(speaker, hostSpeaker)`
  （`kin` / `hostSpeaker` / `orchestrator`），它本来在两处内联（`isUserFacingEvent`、
  `legacyVisibilityFor`），现在三处共用一份。**这条只有截图能发现**：两条测试都绿着，
  因为投影那一半（source）是对的，错的是「谁需要署名」。

## 4. 切片

每片一个可独立验证的提交，照 P1 的做法：**量出来的证据 + 守卫（若有可守卫的形状）**，
提交后写进 §8。

### S1 — 数据面（无 UI，每项都有 Go 侧测试）

- **S1a 队列**：有序列 + 持久化 + 排队不碰那三步（不 cancel、不拒审批、不代答）。
  先量清楚今天的内存槽语义，再改。
- **S1b subagent 可见性**：定策略（哪些 subagent 事件给用户看）+ 定订阅方式
  （继续轮询还是走流）。
- **S1c 逐轮 diff 从哪来**：产出是一张表 + 结论。**结论已经能给了**：便宜的那条路
  成立。`ui/src/lib/changedFiles.ts:117` 的 `extractChangedFiles(events)` 与
  `:527` 的 `extractFileDiff(events, filePath)` 都是**对事件流的纯函数**，
  所以"这一轮改了什么" = 用**这一轮的 seq 区间**去切事件流、再调这两个函数。
  缺的只是**轮边界**：`groupIntoTurns`（`transcriptProjection.ts:792-824`）
  不吐 seq 区间，而 `ToolStep`/`NoteStep`/`ProgressItem` 里没有 `seq`
  （`:7-37`）——这两处就是 S1c 的全部改动面，**不需要** turn-diff store。

  必须写明的边界：这两个函数只认**文件类工具**（`EDIT_TOOLS` 那个集合，
  `changedFiles.ts:100-108`），走 shell 改的文件（`sed -i`、`git apply`）
  看不见。所以证据卡是"这一轮**通过文件工具**改了什么"，**不是**工作区的
  权威 diff——权威视图仍是工作区/PR 面板。这条要写在卡片的措辞里，
  别让用户以为它是全量。

### S2 — 消息队列（手机第一优先）

接 S1a。改 `Composer` 的运行中文案与语义（§3.4）。
守卫：投递顺序（多条按序逐轮投递）、重启不丢、打断仍可用、
以及**排队中不得拒审批**——最后这条是回归守卫的重点。

### S3 — 审批顶替输入框

接 S1c 的锚点决定（§3.3）。原位渲染 + 窗口外兜底 + `focusIdx` 改按 seq。
今天审批卡是追加在滚动区末尾的 trailing（`TaskDetailPage.tsx:984-1035`），
输入框照旧可用（`:1041-1060` 只传了 `disabled`）。

### S4 — 活动分组（思考 ≠ 叙述）

模型和卡片都在（`ProgressCard`，默认收起），缺的是**区分**（§2.3）。

### S5 — 逐轮 diff 证据卡（已落地，见 §8）

接 S1c。**已落地**（`31b52a0` `aa40a38` `636d01a`）：卡片画在一轮结束的那个
turn 下面，列出这一轮**通过文件工具**改的文件、行数增量，以及逐个文件的改动预览。

可复用的三样，两样用了、一样**有意不用**：

- `extractChangedFiles` / `extractFileDiff` → `roundEvidence.ts` 按区间读一轮的切片；
- `ApprovalCard` 那个从没人用过的 `previewLines` 槽 → 抽成 `PreviewLines.tsx`，
  审批卡与证据卡共用（顺带接上：审批一个写/改文件时直接画它会做什么，而不是画 JSON）；
- Monaco `DiffEditor` → **不用**。它是给整块面板的懒加载块，而 `extractFileDiff`
  是**尽力还原**（`write` 不知道它覆盖了什么）：把还原结果放进一个看起来可编辑的
  并排编辑器里，正是卡片底部那句「权威差异在工作区」要防的错觉。工作区的
  `DiffEditor` 一行没动。

### S6 — subagent 面板

接 S1b。`WorkerTimeline`（`TaskDetailPage.tsx:970`，`max-w-[760px]`）今天和聊天栏
**不在同一把尺子上**，S7 的宽度阶梯要先落地。

### S7 — 居中栏与宽度档位

按 §3.5。**这一片比名字看起来大**：28 个文件里有任意值宽度，分四个家族。
顺序是 定名（每家族一档）→ 换字面量 → 把宽度轴写进 lint 硬规则。
若换字面量那步超过一次能复核的量，就按家族再切两刀（页面栏/浮层一刀，
控件宽一刀），**不要**做成一个跨 28 文件的大提交。

### S8 — 聊天内代码高亮

按 §3.7。

### 顺手结清（S4/S5 已全部结清）

- 删 `ui/src/components/Transcript.tsx`（§2.3）→ `31b52a0`。
- `ApprovalCard.previewLines` → **接上**（`636d01a`：审批一个写/改文件时画改动）。
- `chat.progress.collapsed` / `chat.progress.step` → **接上**（S4，`7b4fcc9`）。
- `task.roundBusy` → **删**（S4）。

## 5. 守卫

可守卫的形状（无浏览器、照 P1 的先例把规则抽出来测）：

- **排队不拒审批**：Go 侧直接测——排队路上审批仍在 pending。
- **顺序与重启不丢**：Go 侧测有序列的读写。
- **宽度轴**：定名后进 `eslint-rules`（现在故意不含它）。
- **审批锚点**：`focusIdx` 按 seq 之后，「键盘位置 == 可见位置」是可测的纯函数。
- 删掉的死面加一条**反向守卫**：`Transcript.tsx` 不再存在、三个 i18n key 不再悬空。

## 6. 验证方法

- **假数据与截图**：P1 的方法照搬——**色差探针**（把每个元素沿祖先链合成背景，
  再算相邻面的 L\* 分离）、**边线审计**（DOM 里"两个层级之间画了一条线"）、
  以及 44 张截图的路线 / 宽度 / 主题矩阵（fixture 是本地两个假 daemon）。
  这些探针和 fixture 都是**临时脚本，不进仓**——可复用的是方法，不是脚本，
  所以这里写的是方法。P2 的新形态（排队中的消息、顶替输入框的审批、折叠的思考）
  **默认矩阵不覆盖**：要像 P1 的 S5 那样**补定点截图**，别指望那 44 张。
- **测试策略（S1 里定）**：`ui` 今天**没有 DOM 测试环境**——没有
  `@testing-library/*`、没有 `jsdom`/`happy-dom`、`vite.config.ts` 里没有 `test` 块。
  现有组件测试要么是抽出来的纯函数（`DispatchSelector.test.ts`），要么是 `?raw`
  源码正则。P1 的先例是「把规则抽出来，测规则」（`tokens.test.ts` /
  `tailwind.test.ts` / `eslint-rules/index.test.ts`）：成本低且一直有效。
  **S1 里定**：继续抽纯函数，还是为 P2 引入 DOM 环境。若引入，理由要写成
  「哪些断言抽不出来」，不要把 DOM 环境当成默认答案。

### 6.1 决定（S1a 完成时）：不引入 DOM 环境，继续抽纯函数

理由是**逐条数过 P2 要断言的东西，没有一条需要渲染**：

| P2 要断言的 | 抽成什么 |
|---|---|
| 排队不碰审批/提问/在跑的轮（S1a，已落地） | **Go 侧**已覆盖（`internal/task/queued_prompts_test.go`），UI 不承担这条 |
| 哪条消息还「排队中」（S2） | 纯函数：`(pending: {user_seq}[], seq) -> boolean`。API 已经把这份数据给出去了，UI 只是查表 |
| 投递顺序与「不打断」的可观测面（S2） | 同上：投影层是纯函数，`transcriptProjection` 本来就是可单测的纯变换 |
| 审批锚点与键盘位置一致（S3） | 纯函数：`focusIdx` 从「数组下标」改成「按 seq」，可断言 |
| 思考与叙述分组（S4） | 纯函数：投影已有的分组逻辑 |
| 宽度家族（S7） | 已经是 lint 规则 + `?raw` 正则 |

真正抽不出来的只有「这个像素看起来对不对」，而那一类 P1 已经用**截图矩阵 + 定点截图**
解决，并且写进了本文件 §6 的第一条。所以为 P2 引入 `jsdom` + `@testing-library/*`
是**为了不在渲染上做断言而引一套渲染栈**，不划算。

若 S3/S4 落地时出现一条「必须在真实 DOM 上才成立」的断言（例如焦点真的要落在某个节点上），
那时再引入，并把那条断言写成本决定的反例——不要因为「反正迟早要」而先装。

### 6.2 S1c 的表：按区间切流能拼到什么

结论是**够用，不补 turn-diff store**。下表每一行都由一条测试钉住（`transcriptProjection.test.ts`
的 `turn seq ranges` 那组），不是推理：

| 输入 | `extractChangedFiles` 按区间切流后 | 依据 |
|---|---|---|
| 文件类工具（`EDIT_TOOLS`：`edit`/`write`/`str_replace`…） | ✅ 路径 + 动作 + 行数增量 | 「slices the stream into exactly the turn's own file changes」 |
| **subagent/worker 的文件工具**（`visibility.user=false`，聊天栏里根本看不到） | ✅ 事件在流上，抽取器不看 visibility；这一条正是**区间**（而不是可见 item）才是正确边界的证明 | 「reaches work the chat column never showed」 |
| shell 改的文件（`sed -i`、`git apply`） | ❌ 只认文件类工具，`Bash` 的 `command` 不是路径 | 「cannot see a file a shell command wrote, which is why the card says so」 |
| 一轮里没有任何带 seq 的 item（纯 partial 流） | ❌ 没有区间可用，卡片应当**不出现**而不是瞎猜 | 「leaves a turn with no range…」 |
| 最新一轮的**尾事件** | ⚠️ 没有下一轮来闭合，止于自己最新的事件；路径在**调用**事件上，所以仍看得到 | 区间测试里的 `["agent", 10, 10]` |

消费单位是**一轮 = user turn + 紧随其后的 agent turn**，两段的区间并起来才是「这一轮改了什么」：
被过滤掉的事件（worker 工具、`raw_output`）不产生 item，落在两轮之间的空隙里，
只读可见 item 的区间会把「这一轮 host 全程在派活」读成「什么都没改」。

**区间是切片，不是划分**（S1c 复审的修正：原文写的「每个事件恰好属于一轮」是错的）。
两条实测形状都不满足它：

- 一条被 adapter 回显的 `role:"user"` 消息（`stampSpeaker` 把它标成 task-only）会再产生一个
  user turn，于是**两次提问夹着**中间那段工作：那一段只属于**先开着的**那一轮，
  后一个 user turn 的 `fromSeq` 已经在它之后了。
- 流式 message 在 `partial` 时**不带 seq**（`flushStream` 有意省略），所以它可能一个区间都没有。

所以「一轮」在代码里是一条**规则**（`roundsOf(turns)`，`transcriptProjection.ts`），不是一句散文：
在 user turn 上开一轮，已经在开着的一轮**并进去**（两个 user turn 同属一轮），
在**第一个已定稿的 agent 消息**上关闭，或者在这一轮的**工作以错误收场**时关闭
（这一轮的最后一个 turn 停在 error 上，且下一次提问之前没有别的 agent 列把它接回去——
重试失败后又答上的那种形状是一轮，不是两轮）；`fromSeq`/`toSeq` 取成员轮区间的 min/max。
8 条测试钉住它（两个 user turn 归一次提问、夹在中间的工作算这一轮、
提问早于回答仍同轮、回答处闭合所以下一次提问另开一轮、第一问之前的 turn 不进任何轮、
失败收场自成一问、失败后又被接回去仍是一轮、错误夹在列中间不算收场）。

所以卡片的措辞只能是「这一轮**通过文件工具**改了什么」，权威视图仍是工作区/PR 面板。

**S5 落地后补**（`636d01a`）：这条措辞不是口头约定，而是卡片底部一行常驻小字
（`chat.evidence.scope`，两个语言都在），并且**不在折叠里**——把它收起来等于让
「这一轮什么都没改」和「shell 改的我看不见」长得一样。三处规则各有测试：

- 卡片位置 = `roundEvidenceByTurn`（`transcriptProjection.ts`）：挂在**一轮结束的那个
  turn** 下面。因此「第一问从没被回答、第二问并进来」这种轮（上面的合并规则）只有**一张**
  卡，报的是两问合起来改的东西——这是规则的结果不是 bug，由
  「draws a round's card under the turn that answered it」钉住。
- 卡片不出现的两种情形（一轮没有 `seq` 区间、一轮里没有文件工具改动）在 `roundEvidence`
  里是**同一个返回值**（`null`），两条测试各钉一个；把「没有区间」改成「读全流」两处一起变红。
- 预览读的是**这一轮自己的切片**（`RoundEvidence.events`），所以下一轮改同一个文件
  不会漏进这一轮的卡里。

## 7. 风险与未决

| 风险 | 处置 |
|---|---|
| 逐轮 diff 的上游是有损的（8000 字节 / 64KB / 结构化 diff 被拍平） | S1c 先算「用现有数据能拼到什么程度」：结论是够用，表见 §6.2，不补 store |
| 流式 note 与「折叠进 note 的 message」这两条路的 `seq` **没有测试钉住** | 它们只会让区间**更早/更准**，不会让区间变错：真正决定卡片内容的是文件工具事件的 `seq`，而文件类 `tool_use` 一律产生 step（有 `seq`），所以漏的只可能是「本轮更早的一段文本事件」。不编脆弱的 fixture 去盖它，记在这里 |
| 队列落成**独立小表**，没动 `tasks` | 判据（§3.1）是「要不要按序查询」，队列是尾插头取，所以是表不是列。`schemaVersion` 38 → 39；新表在 `migration001` 的拼装串里（空库）与 039 块（满库）各出现一次，两条路同形，各有测试。**「v39 但没有这张表」的库不存在**，所以 `ensurePendingPromptSchema` 在表缺失时直接返回是对的：`git log -S "schemaVersion = 39" -- internal/store/migrate.go` 只有 `d590e87` 一条，它在同一次提交里既升版本又建了表 |
| **投递是「先出队、后应用」，中间崩溃会丢一条已可见的消息** | 未闭合的窗口，代价写在这里：丢的是**投递**不是消息——那条话仍在聊天里、用户能看见也能重发，且与「重启后由 `Recover` 补齐」的窗口相比小得多（毫秒级，同库两次写之间）。不上 `task_limit_waits` 那套租约状态，收益不抵复杂度 |
| 排队中的消息可能等不到轮末（agent 卡在审批/提问上） | 有意的：审批卡与问题就在聊天里可答，答完这一轮就会结束并投递；逃生口是显式打断（`interrupt: true`）与 `Cancel`（清队并报告丢了几条，不静默）。**报告与清队同事务，所以只有两种结果**：清掉了并说清几条，或者一条都没清、队列原样留着（报告写不下去的那次 `cancelTask` 只跳过 publish——取消是安全动作，不该被一次簿记写挡住，而这一挡的代价是「什么都没丢」，不是「丢了不说」）。两种都由 `TestAFailedDiscardReportLeavesTheQueueAlone` 与 `TestAFailedRetryDiscardReportTakesTheRetryBack` 钉住 |
| 宽度阶梯会碰 28 个文件（清点后从 11 修正） | 独立成片（S7），按家族再切，不和功能片混 |
| 手机上「排队中」的状态不明显 | chip 已落地（S2b，`abebb7a`）。**尚未在手机或窄屏上看过**：本机只有浏览器工具，真机验收仍卡在 NAS Hub 部署。残留风险记在这里，不用推理代替截图 |
| ~~**S2b/S3 的新形态还没有定点截图**~~ | **已拍**（`0a1be50`）：390×844 与 1440×900 四个定点（排队 chip、原位审批卡 + 输入框上方 bar），夹具见下条。**它抓到了真 bug**：原位审批卡在它唯一该出现的形状里是**不画的**（见 §8「S3 补丁」）。剩下 S4–S7 的新形态还没拍，用同一套夹具续拍 |
| 夹具（本地假 daemon，不进仓）比看上去更容易搭错 | 两处必须实现，否则截图自带噪音或根本拍不到东西：① 事件通道是 **SSE**（`client.ts:2219` 读 `res.body`，空行分帧），不是 WebSocket——第一版把 `/api/events` 答成 JSON，于是「正在重连…」横幅进了每一张图；② `/api/sessions/cursor` 与 `/api/sessions` 是「连上了」的判据（`sessionSync.ts:137-145` 拿到 cursor 才 `setStatus("connected")`），缺了会退避重试并在图上留同一条横幅。夹具不是被测对象，但它的缺口会伪装成产品缺陷 |
| 「谁需要署名」这条规则**没有单测能替截图作证的部分** | `noteNeedsAttribution` 有 1 条测试钉住四个名字（自己的名字、`kin`、`orchestrator`、别的 agent），但「这张卡上画了什么」仍然只有截图。第一版就是测试全绿而画错的——记在这里，别把它当成已覆盖 |
| 原位审批卡在窄屏比「兜底位置」窄 38px（320 vs 358） | 有意的：卡片留在 agent 那一列里（拆轮会多画一个头像），实测卡本身不溢出（320=320，按钮 70–358），只有 JSON 预览横向滚动（586>286）。两处宽度不同、两处都只画一次 |
| 一轮**从没被回答**时（第一问只落了过程记录），第二问并进同一轮，证据卡于是画在第二问下面、报的是两问的合集 | 有意的（§6.2 的合并规则 + 其末的 S5 补记）：这是投影认定的「同一件工作」，拆成两张卡才是无中生有的边界。由「draws a round's card under the turn that answered it」钉住，并在夹具上定点截图确认过读起来不歧义 |
| 文件动作的**归类**（写/改/删）此前没有测试，于是 `Edit` 一直被当成 `write` | **已修**（`aa40a38`）：`WRITE_TOOLS` 一个集合装着两个家族又被先判，`edit` 分支对集合里的每个名字都不可达——工作区列表、改动条、审查卡因此把每一次编辑都标成「写」（连颜色和排序权重一起错）。改成先判编辑家族，并补上分类表测试（把旧顺序放回去，全仓只有这一条测试变红）。**教训**：这是上一行那类缺口在纯函数层的版本——标签错了，而没有任何测试在问标签 |
| 「提问事件落在哪一栏」这条渲染连线**没有测试** | 按 §6.1 没有 DOM 环境，抽不出纯函数（投影那一半有测试：锚点、seq、只画一次）。守卫就是 §6 的定点截图——这条 bug 正是它抓到的，所以不假装用单测盖住。**S5 同理**：证据卡的**位置规则**（`roundEvidenceByTurn`）现在有测试，但「卡片真的画出来了、画成了什么样」仍然只有截图 |
| `TestRetiredRunCannotOverwriteRunningRetry` 偶发红（merge base 上 40 次红 3 次） | **已修**（`7bbc7d7`）：`persistRunEvent` 让事件写持着引擎锁，于是 `Cancel` 排在它后面；而假 run 的终局事件原本紧跟在被放行的写之后，run 自己的完成若先拿到锁，任务就已 `succeeded`，cancel 随即报「already terminal」。改成假 run 把终局事件**握在测试手里**，cancel 先落地成为构造性事实，终局事件改在 retry 已经在跑之后才到——这才是这个测试名字所指的危险。100 次全绿 |
| `internal/adapter/droid` 的 `TestAdapterCancelAndProcessExit` 与 `internal/github` 的 `TestRunDoesNotWaitForAProcessThatOutlivesGH` 在全量跑时偶发红（单跑必绿） | **先于本片存在**，且都在 P2 从未碰过的包里（P2 的 diff 不含这两个包）：两条都是进程生命周期测试，对机器负载敏感（当时同时在跑别的构建）。记为**负载敏感的既有 flake**，不在本片修，也不当作本片的红 |
| 引入 DOM 测试环境的诱惑 | 见 §6：先论证哪些断言抽不出来 |
| `Cancel` 与「轮末投递」之间那个窄窗（复审 nit 6） | **只关了一半**（P2 复审 N4 订正）：`runLoop` 的投递条件补上的 `!wasCanceled` 读的是 **pop 之前**的那个标志，所以它治的是「turn 退出时取消已经记下」那一半——turn 已经决定不投了。**「cancel 落在 pop 与 apply 之间」仍然开着**：投递的 `UpdateTask(status=queued)` 只有 `WHERE id = ?`（没有状态谓词，`FinishTask` 才有），会盖掉刚提交的 `FinishTask(canceled)`。代价是**状态陈旧 + 一条消息没被答**，不是跑飞的 agent：下一次 run 起跑时的 cancel 检查立刻把它收掉，而那条消息仍在聊天里可见可重发。**没写测试**：靠 sleep 去撞只会得到一条会飘的测试；记在这里而不是假装盖住了 |
| `Cancel` 清队失败时错误被忽略（同一处） | 有意留着：清队失败只影响「丢了几条」的报数，不影响状态机；这条路径上的任何 `return err` 都会让「取消」这个动作本身失败，比少报一个数更糟 |
| A2A 对端没有任何打断手段（复审 nit 8 的另一半） | MCP 那一半已补（`send_task_message` 声明 `interrupt` 并把「忙任务会排队」写进描述）。A2A 走 `Engine.FollowUp`（无 interrupt），**没改**：那是对外协议面，改它要另开一片并定语义。今天 A2A 对端发消息=排队等轮末 |
| 重启后 `waiting_input` 任务上的提问已经「过期」 | **先于本片存在**：进程死了，等的那个 waiter 也没了，答上去也到不了模型（`AnswerUserQuestion` 只把状态推回 running，不重启 run）。本片只保证队列有投递者（消息会被回答）；「重启后提问怎么续」是 P3「审批/提问顶替输入框」那片的范围 |

## 8. 进展

| 片 | 提交 | 内容 | 证据 |
|---|---|---|---|
| S1a 存储 | `d590e87` | `task_pending_prompts` 有序列（表，不是任务行上的列）：尾插头取、`ON DELETE CASCADE`、`model`/`permission_mode` 可空（「没说」≠「说清空」）、`user_seq` 指向那条可见消息。**没有写者**，引擎那一半在下一提交 | 10 条 store 测试（顺序、逐条出队、空队非错误、重启还在、按任务隔离、删任务带走队列、清队报数、空消息不收、未知任务不收）。两条定点 red：列改 `NOT NULL`（「没说」与「清空」塌成一种 → 插入即报错）、`ORDER BY id ASC` 改 `DESC`（先出队变成后出队）。空库/满库两条迁移路各一条测试 |
| S1a 引擎 | `317d18a` | 非终态 ⇒ 入队 + **立刻**写 user-guide 事件（否则手机上发完什么都不显示）；轮末投递，adapter 路径与 orchestrated 路径各一处，取队首、`interrupted=false`（保留会话续跑，不谎报「上一轮被打断」）；`Recover` 投递重启时孤儿任务留下的队列；`Cancel` 清队并报告条数；打断变成显式 `interrupt: true` | 4 条新测试：排队**不碰**那三步（审批仍 pending、提问仍未答、任务状态不变）、多条按序逐轮投递、重启不丢、取消即清且有报错事件。四条都按「删掉机制看它变红」验过——red 1 的报错正是 `pending approvals = []`，也就是今天这条路上待批审批被拒光的实证。5 条旧测试改成显式打断（它们本来就是打断路径的测试） |
| S1a API | `0236670` | `interrupt` 进 `FollowUpRequest`（含 openapi 说明）；新增 `GET /api/tasks/{id}/prompts` 回答「哪些看得见的消息还没被回答」。**additive**：任务读、任务列表、prompt 响应形状都没变 | 3 条 API 测试：等待中的消息可见且有序（含 `user_seq`）、404/401、`interrupt` 在**线上**的行为差异（不带 = 任务仍 running，带 = 重新排队）。red：json tag 改成 `interrupts` 后第三条报错。`scripts/check-openapi.sh` 通过，生成的 TS 类型随同一提交更新 |
| S1b | `07a06a2` | **决定片，引擎零改动**：结论与依据见 §3.6。`visibility.user` = 「属于 host 聊天栏」；worker 事件保持 `{user:false, task:true}`；面板的活动来自已在流上的 worker 工具事件，计划结构来自 `worker-steps`，连接键 `execution_id`+`execution_step` | 两条守卫（都是补今天缺的那半）：① worker 的 message/tool_use/tool_result/raw_output **四种形状**都不得 `user:true`——Go 侧 1 条（4 个子用例）钉住盖章，console 侧 1 条钉住投影（`isUserFacingEvent` 被改成恒真即红）。② worker 叙述不得进入 host handoff，同时 orchestrator 的总结**必须**进得去（`summarizeEvent` 只认 message/error/result/raw_output，且跳过非 orchestrator 的 `visibility.user=false`）——Go 1 条，两条断言写在同一个测试里，好让「干脆全静音」这种修法也红。两条守卫都按删机制验红、按 sha256 逐字节还原 |
| S1c | `0e9a09a` | 决定片 + 一条投影改动（**不渲染**）：`ToolStep`/`NoteStep` 带 `seq`，且锚在**打开它的那个事件**上（不是最后合并进来的那个——结果可能在打断之后、在另一轮里到达）；`groupIntoTurns` 吐 `fromSeq`/`toSeq`，**闭合在下一轮开始前一个事件**。消费单位是**一轮 = user turn + 紧随的 agent turn** | 表见 §6.2（结论：够用，不补 turn-diff store）。**6 条新测试** + **3 个机制删掉验红**（闭合那趟、步的 seq、不许结果挪步），全部按 sha256 逐字节还原。`npm run build` 后 `web/dist/index.html` 随源码同一提交。**两处订正**（复审时改）：① 原文「所以每个事件恰好属于一轮」**是错的**，`fromSeq`/`toSeq` 是切片不是划分，两条实测形状都不满足（adapter 回显产生第二个 user turn、partial message 不带 seq），真正的消费规则已落成 `roundsOf`，见 §6.2；② 新测试是 6 条不是 5 条 |
| S1a 复审 | `4c21404` `d906ef3` | `@claude` 对抗复审（blocker/major/nit 分级）提了 5 major + 4 nit + 5 处测试缺口，逐条核过后**全部成立**，已修（`4c21404` 是其中的 schema 自愈）；另修了复审没提但被测试当场抓到的一处：把三个 reconcile 收进 `ensureCurrentSchema` 后才发现「已是最新版本」那条早退路径**根本没跑**任何 reconcile——也就是说 d590e87 写下的 v39 库永远不会被修 | 6 条新测试（读不了队列≠空队列、workspace 失败要报告且消息保留、retry 带走被删消息的队列、投递只答一次且锚在自己的消息上、打断锚在自己的消息上、waiting_input 的队列要活过重启）+ 2 条 store（队列表缺锚列自愈、`TasksWithPendingPrompts`）+ 2 条 API（空队答 `[]`、`user_seq` 恒在）。**8 个机制逐个删掉验红，全部按 sha256 逐字节还原**。`scripts/check-openapi.sh` 通过（`user_seq` 去掉 omitempty 不改 schema 的 required） |
| S2a 控制台 | `dc9fee4` | `Composer` 运行中的语义翻转成**默认排队**：蓝键 = 发送（占位文案「本轮结束后回答」），旁边多一个橙键 = 打断并立即发送；`followUpPrompt` 只有显式意图才带 `interrupt: true`。toast 按实际发生的事说话（排队 / 打断），不再一律宣称「已打断」 | 3 条新测试钉住请求体：不带意图时**没有** `interrupt` 字段、带意图时才有、原有 model/permission 字段没被顺手改掉。red 两处（默认改成带 `interrupt`、意图分支失效），sha256 逐字节还原。这条同时修掉一个**比旧行为更糟的谎**：引擎默认翻成排队后，控制台从不发 `interrupt`，却仍在 toast 里说「已打断本轮」——用户以为停住的轮次其实还在跑 |
| S2b 排队中 | `abebb7a` | 消息在入队时就写进 transcript（引擎那一半），所以队列是**唯一变化的东西**：哪些 seq 还在等。`GET /api/tasks/{id}/prompts` 报它们，页面在事件落地时重读 + 3s 慢轮询（只有「某条被答了」变化时也追得上），等待中的 user 气泡标签行长出一枚 chip。`QueuedPrompt.user_seq` 升为契约 required——分不清「没锚」与「字段缺失」的客户端无法决定标什么 | 3 条纯函数测试（收集、`user_seq=0` 不标、空队/无 seq 不标）+ 2 处删机制验红、sha256 还原。`npx tsc --noEmit` 0、`vitest run` 57 文件 572 用例全绿、`npm run build` 后 `web/dist/index.html` 随源码同一提交。定点截图见 §7（S2b 的 chip 与 S3 的卡都已逐张看过） |
| S3 控制台 | `9a845e7` | 审批卡不再一律贴在底部：`approval_requested`/`user_question_requested` 带上被问者的 id，投影把卡挂在**提问事件**上，流就画在那里；只有提问事件滚出已加载窗口时才回落到流尾，且两处**只有一处**会画（一个决定不会长出两套按钮）。`j`/`k` 按提问的 seq 走、无锚的排最后（光标落在看不见的地方比没有光标更糟）。输入框上方一条 bar 说明在等什么并能跳过去——这才是「不该靠打字才发现有待批」 | 4 条投影测试 + 5 条顺序测试（`needsYou.test.ts`）+ 既有测试保持绿。**行内卡片第一次拍就发现主路径不画**——补丁见上一行。定点截图见 §7（S2b 的 chip 与 S3 的卡都已逐张看过） |
| S3 补丁 | `0a1be50` | 定点截图抓到 S3 在**主路径上是死的**：`groupIntoTurns` 把带 `pending` 的 meta 项折进它打断的那一轮（对的），但只有 `standalone` 轮拿得到 `pendingSlots`，于是「agent 先说一句、然后停下来问」这个最常见的形状里卡片被丢掉，屏幕上只剩「需要你的审批 ↓」这行字。修在渲染处（`AgentTurn` 也认这张卡），不改投影：拆轮会为一段连续回答多画一个头像。审批与提问两种都一样 | 390×844 / 1440×900 各两个定点（审批卡在原位、排队 chip 在第二条 user 气泡上）**逐张看过**，并实测卡片几何：卡 320px 不溢出、按钮 70–358、JSON 预览 `scrollWidth 586 > 286` 属设计内滚动。`vitest run` 58 文件 586 用例全绿、`tsc --noEmit` 0、`npm run build` 后 `web/dist/index.html` 随源码同一提交（入口 `index-D4qUdRy8.js`）。**这片的教训**：投影有测试而渲染连线没有（§6.1 无 DOM），所以「锚点算对了」与「卡片画出来了」是两件事，只有截图能证明后者 |
| S4 活动分组 | `7b4fcc9` | 每个 note 带上**来源**（`NoteSource`：`reasoning`/`plan`/`note`），造 note 的那一刻从 `role` 与 canonical `phase` 读出——不猜文本；行标签按来源选（`chat.progress.thinking` / `chat.progress.plan` / 今天的 `chat.progress.note`）。`speaker`/`model` 只在**不是 host 自己的声音**时才画（`noteNeedsAttribution` → `isHostVoice`：`kin`/host/`orchestrator` 是同一列的三个名字）。三个悬空 key 结清 | 6 条新测试（来源表、标签映射 + 两个语言都能解析、流式与定稿同一来源、工具调用结束流式后来源还在、plan 事件与 plan 消息同档、worker 的话算叙述但保留 speaker）+ 归属规则 1 条。**4 处删机制验红**、全部 sha256 逐字节还原。定点截图 390×844 / 1440×900 四张（收起态「已收起 5 步」、展开态五行：计划 / 思考 / Read / 过程 / 过程+`Codex · gpt-5`）**逐张看过**——第一版就是靠它发现 host 自己的 note 被署了名 |
| S1a/S1c 复审修复 | `b4e4faa` `2d8cadf` `0e52508` `7bbc7d7` `3729d41` | 复审的 4 个 major + nits 逐条落地：① 打断的 user-guide 事件在「发布 pendingFollowUp 项」**之前**写下并带锚（原来中间那一瞬别人读到的是 0＝「还没人写」，投递于是把用户的话写了第二遍）；② **丢弃报告与丢弃同事务**（retry 的 rewind 与 cancel 各一处：`DiscardEvent` / `DiscardPendingPrompts`），调用方只 publish——进程死在中间也不能「消息没了而记录里什么都不说」；③ worker 可见性守卫改成驱动 `forwardWorkerEvents`（原来只钉住 `stampWorker`，转发器改坏了守卫照样绿）；④ 「一轮」的契约落成可执行的 `roundsOf`，见 §6.2；nit：投递失败要**点名**那条消息（引号、单行、48 字截断）、`deliverQueuedAfterRestart` 的措辞、`wasCanceled` 的注释收窄 | **11 个机制逐个删掉验红**（全部 sha256 逐字节还原）：retry 报告改到提交之后写、cancel 报告改到提交之后写、重放路径不报告、投递错误不带名字、`userSeq` 归零（当场报 `user copies = 2, want 1`）、守卫只驱动 stamper、把一轮当划分… 新增 5 条 Go + 5 条 UI 测试。**订正（P2 复审 N1）**：这两条「报告改到提交之后写」当时**没有复现**——测试钉的是「有报告」，不是「报告与删除同事务」，所以那一格当时是读 diff 得出的结论而不是验过的红；现在由 `TestAFailedDiscardReportLeavesTheQueueAlone` 与 `TestAFailedRetryDiscardReportTakesTheRetryBack` 钉住（`18618e0`）。**这一片没有 `web/dist` 提交是对的**：`roundsOf` 目前还没有消费者（S5 才用），被 tree-shake 掉了，`npm run build` 产物与已提交的 `index.html` 逐字节相同（入口仍是 `index-B59owEAr.js`）。另修掉一条**先于本片存在**的 flake（见 §7） |
| P2 复审 nit 批 | `67bd94f` `028e3ea` `95d532a` `18618e0` | 第二轮 `@claude`（同档）复审 S1c/S4 区间：**0 blocker / 0 major / 7 nit**，逐条处置——**N5**（这一轮的工作以错误收场时那一轮不闭合，下一次提问于是并进来）正好落在 S5 要用的 `roundsOf` 上，改掉 + 3 条测试，§6.2 的规则描述与条数同步；**N6** 投递失败的前缀说了两遍（`err` 自己已经点名了那条消息）；**N3/N4** 两条注释引了代码里不存在的检查（`cancelTask` 是先解锁再调 store；`UpdateTask` 的谓词只有 id），换成真的那个理由；**N1** 两条「报告改到提交之后写」当时**没复现**，补两条失败注入测试把同事务钉住；**N2** §7 那行改成「只有两种结果」；**N7** 是已披露的「渲染连线没有测试」，无需动作（§7 有行） | **3 个新 UI 测试各自被一处不同的变异弄红**（删掉规则 / 不做前瞻 / 用「含 error」代替「停在 error 上」），逐字节还原；**2 个新 store 测试**用触发器中止 `error` 事件写，把删除提前提交即变红，逐字节还原；`go test ./internal/store/... ./internal/task/...` 全绿、`tsc --noEmit` 0、`vitest run` 58 文件 596 用例全绿；`npm run build` 后 `web/dist/index.html` **未变**（`roundsOf` 仍被 tree-shake，入口还是 `index-C7chGWCf.js`），所以这一批没有 `web/dist` 提交 |
| S5 逐轮 diff 证据卡 | `31b52a0` `aa40a38` `636d01a` | 一轮干了什么，现在在聊天里就能看到：卡片画在**这一轮结束的那个 turn** 下面，列出本轮**通过文件工具**改的文件、+/− 行数，点开某个文件看改动本身（有界、超出报数），并能跳到工作区。两条纯库担全部规则——`diffPreview`（裁掉两端未变的行、两侧共有的行留作上下文、整块有上限）与 `roundEvidence`（按区间读一轮的切片；没有区间或没有文件工具改动 ⇒ `null` ⇒ 不画）。卡片底部**常驻**一行小字说明它只是文件工具的账、权威差异在工作区/PR；**有意不嵌 Monaco**（尽力还原 + 并排编辑器 = 看起来和真 diff 一样权威，正是那行小字要防的）。顺手结清：`ApprovalCard.previewLines` 这个从没人用过的槽**接上**（审批写/改文件时直接画改动，而不是画 JSON），`Transcript.tsx` 删除，工作区两份 `DeltaInline`/动作标签合成 `changedFileFace` | `vitest run` **60 文件 617 用例**全绿、`tsc --noEmit` 0、prettier 逐文件过；**6 处删机制验红**（卡片挂到提问而不是回答上；缺区间时读全流；把编辑判成写；不裁两端未变的行；预览不设上限；文件列表不设上限），全部 sha256 逐字节还原（三条被改的库各自 `shasum -c` 通过）。定点截图 430×932 与 1280×900 **逐张看过**（含展开的逐文件 diff、审批卡的改动预览）。**顺带抓到一个先于本片存在的真 bug**：`Edit` 一直被标成「写」（见 §7 与 `aa40a38`）。`web/dist/index.html` 随源码同一提交——`roundsOf` 终于有了消费者，入口 chunk 从 `index-C7chGWCf.js` 变成 `index-BlRFnNu6.js` |
