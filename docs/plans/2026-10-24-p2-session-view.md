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
  （`internal/task/orchestrate.go:1016,1072` → 两处调用在 `:1024`/`:1075` →
  `internal/task/event_meta.go:43-45`），
  控制台再按 `visibility.user` 丢掉（`ui/src/components/chat/transcriptProjection.ts:461-465,491-493`）。
  属性字段 `execution` 已经解出来没人用（`ui/src/components/chat/eventMeta.ts:161-171`）。
  今天订阅方式是 250ms REST 轮询 `GET /api/tasks/{id}/workers`：只有终态、没有工具细节。

  **S1b 核过之后这条要改口**：数据不是没有，是没人说清哪块面料归谁。见 §3.6。
  这一行的**路径**一开始写对了（`/workers`），中途被「订正」成 `worker-steps` 是错的：
  路由就是 `GET /api/tasks/{id}/workers`（`internal/api/api.go:360`，handler 叫
  `handleListWorkerSteps`，在 `internal/api/worker_steps.go`）——`worker-steps` 是 handler
  与表的名字，不是 URL。而且它只服务**计划表**，不是活动。
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

### 3.5 宽度不是一条轴；先分家族，再定名（S7 订正了家族数）

P1 留给 P2 的活，原话是「容器宽度另有 5 个值（`600`/`640`/`760`/`920`/`1100`）没有名字，
是 P2 的活」（`docs/plans/2026-10-24-p1-design-system.md:403`）。
**清点之后这个数字要改**——`src/` 里有 **28 个文件**含任意值宽度工具类（56 处），
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

**S7 落地后的订正**（上表保留原样，它是当时的清点）：

- 家族不是四条，是**两条轴上的五类**：① 页面栏 640/920/1100 ② 会话栏 720（已有名字）
  ③ 面板：右栏 300、命令面板 600 ④ 浮层：菜单 240、弹出层 340、分发层 320
  ⑤ **下限**（`min-w`）：表格 980、正文里的表 240、单元格 160、浮层的 240/168。
  上表把 ⑤ 混进 ③④，又把 220/260/280 这类**文本截断上限**当成浮层宽——它们不是浮层：
  一个对着字号调出来的数字不是一栏，正如下面那条说控件宽的道理一样。
- 界线因此是 **容器 vs 内容**，写在 `tailwind.config.ts` 的 `width` 上：进阶梯的是容器
  （页面栏 / 面板 / 浮层 / 下限），留在字面量里的是**截断上限**（220 的 chip、260 的
  下拉、`max-w-[45%]` 的气泡）与控件尺寸（44px 触控下限、22/26/28px 图标框，
  属 P1 的控制件刻度）。**一个例外，而它正是这条规则的证明**：路径在两处被截断
  （cwd 弹出层、项目根目录）且两处必须一致，所以它有名字（`max-w-path` 280，
  项目根目录那处从 240 上移）。
- **「居中栏」不是状态**：`AppState` 不加布局字段、两个语言表不加键、P2 不做用户可调的
  宽度档位。理由：栏宽由内容定（审批列表短、agents 表宽、会话栏固定 720），
  手机上也没有放这个控件的地方；一个宽度偏好换来的是第四个要持久化、要同步、要翻译的
  东西，而 §1 第 5 项的验收句（窄屏不溢出、宽屏不是一条拉到头的行）由容器定名 + 下限
  就已经达成。
- 守卫**按步**而非按轴，这条轴上不能写「不许有任意宽度」——多数数字本来就该是字面量。
  两条：值被某一步命名即拒（`eslint-rules/index.js` 的 `widthLiterals`，阶梯由
  `eslint.config.js` 从 config 读入，与调色板同一条路），名字必须在阶梯上
  （`tokens.test.ts` 的 `min-w` 轴是 S7 新加的，`w`/`max-w` 本来就有）。

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
| 每个 worker 被**要求**做什么（`role`/`depends_on`/`access`/`step_index`/`attempt`/`result_summary`） | `GET /api/tasks/{id}/workers`（250ms 轮询保留，但它只服务这张表） | 事件流里**没有** `depends_on`/`access` |

**连接键**：事件 `execution_id` + `execution_step` ↔ 行 `execution_id` + `step_index`
（`applyExecutionMeta`，`orchestrate.go:1110`；表的 PK `(task_id, execution_id, step_index)`，
`migrate.go:1928-1946`）。两边都已经打上，**不用新增字段**；`eventMeta.ts` 那个没人用的
`readExecution` 正好是 UI 侧的解码入口（S6 已导出）。

**订正（S6 落地时发现）：这两个字段不是同一个数。** 原文把它写成等值连接，实际是
**差 1**：`execution_step` 是 `si + 1`（`orchestrate.go:261`，给人看的步号），
`step_index` 是 `si`（`orchestrate.go:542`，`plan.Steps` 的下标）。等值连接会让
**每一条 worker 事件都落不到任何一行上**——面板不报错，只是空的。所以连接写成
`step_index === execution_step - 1`，那个 1 是具名常量（`WORKER_STEP_OFFSET`）而不是
裸的 `- 1`。

同一个字段还兼着**第二个守卫**：**没有 `execution_step` 的事件不进面板**。host 自己的
run 也有 `execution_id`（`engine.go:2279` 给 host 的 `ExecutionRef` 只有 `Agent`/`Model`/`ID`，
**没有 `Step`**），所以「必须有步号」正是把 host 的工具调用挡在面板外面的那条规则——
只按 `execution_id` 连接会把 host 跑过的命令记到某个 worker 头上。

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

**落地（S8，`2c6af75`）。** 选的是 **highlight.js**：core 加 23 个手挑语法，藏在
**一个**动态 import 后面（`CodeBlock.tsx` 的单例，与 Mermaid 同形）。量出来的数：

| | 原始 | gzip |
|---|---|---|
| `codeHighlight-*.js`（core + 23 个语法，懒加载） | 107.33 kB | **35.17 kB** |
| 入口 chunk 的增量（`CodeBlock` 的接线） | +0.41 kB | +0.13 kB |
| 对照：Monaco 的 `CodeViewer-*.js`（工作区编辑器） | 3,359.22 kB | 865.01 kB |

也就是**比它替代掉的那个编辑器 chunk 小 24.6 倍**，且只在第一次出现「带语言的围栏」
时才取一次；护栏是 §3.7 原文那条——Monaco 那个 chunk 的字节数一动不动。

三条是**决定**而不是推导出来的，各自的失败面写在代码里：

- **语言表是手挑的，不是全量。** 自动识别（`highlightAuto`）要把 386 个语法全装上
  （磁盘上 2.7MB 的大部分），而且它的答案是**猜的**——被错的规则上色比不上色更难读。
  不在表里的语言渲染成纯文本，和这片之前一模一样。按角色分三组（命令与差异 /
  机器打印的形状 / 一门语言写的东西），每组为什么在表里都写在 `GRAMMARS` 上。
- **不认识的标签是 `null`，不是异常。** highlight.js 对未注册的名字**抛错**，
  所以调用方必须先问——`highlight` 是唯一入口，四种失败（没标签 / 没语法 /
  语法在输入上抛错 / 输出形状不对）都回答 `null`，围栏于是退回旧画法。
- **chunk 对任何带标签的围栏都加载**，包括我们不认识的标签。替代方案是在**入口**
  chunk 里再放一张语言名表来提前判断「值不值得加载」，而那张表是各语法自己已经声明的
  `aliases` 的副本——就是「颜色词表从 config 读」要避免的那种重复。名字表会漂移，
  35.17 kB（gzip）只取一次不会。

**颜色表在 `design/syntax.css`，而其中一条是量出来的、看起来更「对」的那个赋值是错的。**
围栏不是画在表面上，是画在 `--kin-fill` 上：深色 scheme 下 6% 白盖过 `--kin-elevated`
得到 `57 57 59`，而 `--kin-muted` 在那个合成底色上只有 **4.01:1**（在裸表面上 4.9:1，
所以它到处都合规、在这里不合规）。所以**注释用 `--kin-secondary` + 斜体**，
靠倾斜而不是靠更浅的灰退到后面。`tokens.test.ts` 新增一条按这条合成底色测
`syntax.css` 里**每一个**颜色的用例（两个 scheme × 六个表面），颜色改坏了会红。

四个色相、两个中性色，就是全部调色板：语法（关键字/字面量）走蓝、**名字与数字**
走橙、**"文本本身"与 diff 的新增行**走绿、**diff 的删除行**走红（红色在这里只此一处，
它是这个控制台里「出错了」的状态色，语法不许借去当装饰）、要找的那个调用名走满墨。
表里没有的 scope 继承块自己的 `text-kin-secondary`，所以新加一个语法而它的 scope 是新的，
会读起来「没上色」——一个看得见的失败，而不是一个沉默的。

**转义是 highlight.js 的，但边界自己钉。** 输入是 agent 自己的输出，所以注入前把输出
限成一种形状（`SPAN_ONLY`：文本与 span，别的一律不算），并在 DOM 里验过而不是嘴上说：
一个装着 `<a href onclick>`、`<script>`、`<img onerror>` 的 html 围栏在页面上产生
**0 个 a、0 个 img**，标签以文字形态留在那里。

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
  的定稿消息、`mergeProcessRun` 找的那个锚点（`transcriptProjection.ts:918`，形状查找在
  `:924-926`），
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

  必须写明的边界：这两个函数只认**文件类工具**（判据是 `actionForTool`，
  `changedFiles.ts:171-199`：按名字家族先判删除、再判编辑家族、再判写家族；
  `EDIT_TOOLS` 那个集合在 `aa40a38` 已经不存在，只剩 `READ_TOOLS` `:93`），
  走 shell 改的文件（`sed -i`、`git apply`）
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

### S6 — subagent 面板（已落地，见 §8）

接 S1b。`WorkerTimeline`（`TaskDetailPage.tsx:970`，`max-w-[760px]`）今天和聊天栏
**不在同一把尺子上**，S7 的宽度阶梯要先落地。

**落地时把这个次序解开了，且没有先做 S7。** 面板住在聊天栏**自己的滚动区里**，
所以它不需要「一条自己的宽度」，它需要的是**已经有过名字的那一条**：
`max-w-[760px]` → `max-w-conversation`（720）+ 聊天栏自己的 `px-4 sm:px-7`。
760 本来也不在 §3.5 的四家族里——这是一处漏网的孤值。于是 S6 是**少一个字面量**
而不是多一个家族，S7 也就不必当前置。

### S7 — 居中栏与宽度档位（已落地，见 §8）

按 §3.5，落成两个提交：**容器定名 + 换字面量 + 测试守卫**，然后**把宽度轴写进 lint**。
原计划「按家族再切两刀」没有用到：清点后真正要换的是 **13 个文件 21 个类**
（不是 28 个文件——那 28 个里大半是控件宽与截断上限，按 §3.5 的订正留在原地），
两次提交各自独立可复核。

### S8 — 聊天内代码高亮（已落地，见 §8）

按 §3.7，落成一个提交（`2c6af75`）。落地时订正了两处措辞级的预期：
**「选一个轻量高亮器」并不等于「装上就有全部语言」**——语言表是手挑的 24 个，
自动识别被明确拒掉（要全量语法，且答案是猜的）；以及**颜色不能直接沿用调色板里
那个「给注释用的」token**——`--kin-muted` 在围栏自绘的合成底色上只有 4.01:1，
换成 `--kin-secondary` + 斜体，并把这条测进守卫。详见 §3.7 的落地块。

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
  **没落地**（P2 复审 N7 复核）：`Transcript.tsx` 确实已删、三个 key 确实没有引用者，
  但那是**一次核对**，没有任何测试或脚本在断言它；`locales.test.ts` 只查两份语言文件的
  键集一致与空白，不查「某个 key 还有没有人用」。真正的守卫是 P3 计划里的源码级检查
  （`docs/plans/2026-10-25-p3-shell.md` §4；那份计划开在 `feat/p3-shell` 分支上，
  还没并进 `main`），届时一并覆盖。

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
| 文件类工具（`actionForTool` 认出的写/改/删家族：`edit`/`write`/`str_replace`…） | ✅ 路径 + 动作 + 行数增量 | 「slices the stream into exactly the turn's own file changes」 |
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
| ~~宽度阶梯会碰 28 个文件（清点后从 11 修正）~~ | **已落地**（S7，`47db3b1` `1d919cc`）：真正要换的是 13 个文件 21 处（`git show 47db3b1` 数掉的任意宽度字面量就是 21）；另外 28 个文件里的控件宽与截断上限按 §3.5 的订正**有意留在原地**，由 lint 按「值被某一步命名」而不是按尺寸拦 |
| 语言表是手挑的，围栏写了表外的语言就只有纯文本 | 有意的（§3.7 落地块）：自动识别要装全部 386 个语法且答案是猜的。代价是**看得见**的——那一段没颜色，不是画错。加一门语言是一行 import 加一行表项，加完 `codeHighlight.test.ts` 的「它自称认识的每一门都真的注册了」自动盖住。**未验证**：真机上会不会经常遇到表外的语言（dogfood 时看，遇到就补） |
| 分享/导出的那份文档**不**画围栏，因此没有高亮 | 有意的，也不是本片的缺口：`design/exportDocument.ts` 一直是 `white-space: pre-wrap` 的纯文本（没有 markdown，也没有围栏），S8 没碰它。所以导出件与聊天栏**看起来不一样**是设计内的差异，不是漏了一条路。真要让导出也有颜色，那是给那份「自己的文档、没有 token」的样式表再做一个亮色语法表，另开一片 |
| 生成器下拉（`WorkspaceGenerationPicker`，下限 200→168）**在夹具里没拍到** | `WorkspacePanel` 在这个夹具的数据里不画任何东西（任务页右栏 0 个子节点），所以那一处只有代码与构建产物作证，没有截图。风险有限且有理由：改的是 **`min-w` 下限**（不是宽度上限），只抬地板不夹内容，内容比它宽就照样撑开；同一个名字（168）在侧栏排序菜单上实测正好 168 并逐张看过，另两个菜单（终端 profile、Open in）本来就是 168。**真机 dogfood 时顺手看一眼** |
| 手机上「排队中」的状态不明显 | chip 已落地（S2b，`abebb7a`）。**尚未在手机或窄屏上看过**：本机只有浏览器工具，真机验收仍卡在 NAS Hub 部署。残留风险记在这里，不用推理代替截图 |
| ~~**S2b/S3 的新形态还没有定点截图**~~ | **已拍**（`0a1be50`）：390×844 与 1440×900 四个定点（排队 chip、原位审批卡 + 输入框上方 bar），夹具见下条。**它抓到了真 bug**：原位审批卡在它唯一该出现的形状里是**不画的**（见 §8「S3 补丁」）。剩下 S4–S7 的新形态还没拍，用同一套夹具续拍 |
| 夹具（本地假 daemon，不进仓）比看上去更容易搭错 | 两处必须实现，否则截图自带噪音或根本拍不到东西：① 事件通道是 **SSE**（`client.ts:2219` 读 `res.body`，空行分帧），不是 WebSocket——第一版把 `/api/events` 答成 JSON，于是「正在重连…」横幅进了每一张图；② `/api/sessions/cursor` 与 `/api/sessions` 是「连上了」的判据（`sessionSync.ts:137-145` 拿到 cursor 才 `setStatus("connected")`），缺了会退避重试并在图上留同一条横幅。夹具不是被测对象，但它的缺口会伪装成产品缺陷 |
| 「谁需要署名」这条规则**没有单测能替截图作证的部分** | `noteNeedsAttribution` 有 1 条测试钉住四个名字（自己的名字、`kin`、`orchestrator`、别的 agent），但「这张卡上画了什么」仍然只有截图。第一版就是测试全绿而画错的——记在这里，别把它当成已覆盖 |
| 原位审批卡在窄屏比「兜底位置」窄 38px（320 vs 358） | 有意的：卡片留在 agent 那一列里（拆轮会多画一个头像），实测卡本身不溢出（320=320，按钮 70–358），只有 JSON 预览横向滚动（586>286）。两处宽度不同、两处都只画一次 |
| 一轮**从没被回答**时（第一问只落了过程记录），第二问并进同一轮，证据卡于是画在第二问下面、报的是两问的合集 | 有意的（§6.2 的合并规则 + 其末的 S5 补记）：这是投影认定的「同一件工作」，拆成两张卡才是无中生有的边界。由「draws a round's card under the turn that answered it」钉住，并在夹具上定点截图确认过读起来不歧义 |
| 文件动作的**归类**（写/改/删）此前没有测试，于是 `Edit` 一直被当成 `write` | **已修**（`aa40a38`）：原来有一个 `WRITE_TOOLS` 集合装着「写」和「改」两个家族又被先判，于是 `edit` 分支对集合里的每个名字都不可达——工作区列表、改动条、审查卡因此把每一次编辑都标成「写」（连颜色和排序权重一起错）。改成先判编辑家族，**那个集合随之删除**（今天只剩 `changedFiles.ts:93` 的 `READ_TOOLS`，写/改/删三家的判断都在 `actionForTool` 里按名字逐个问，没有集合了），并补上分类表测试（把旧顺序放回去，全仓只有这一条测试变红）。**教训**：这是上一行那类缺口在纯函数层的版本——标签错了，而没有任何测试在问标签 |
| 面板**长出了实时内容，位置却还在一段会自己滚到底的滚动区顶端** | S6 让面板开始显示「正在干什么」，而它和聊天共用一个 `overflow-y-auto` 容器，容器在有新事件时 `scrollToBottom`——于是任务跑起来的那一刻，最该看的那块正好在屏幕上方外面。**没有在本片顺手挪位置**：位置是 P1/P2 定下的（计划在读之前、在它所解释的消息之前），挪它要重新想「一轮的产出属于谁」，不该夹在 S6 里做。手机 dogfood 正是回答这个的地方，记在这里 |
| 「提问事件落在哪一栏」这条渲染连线**没有测试** | 按 §6.1 没有 DOM 环境，抽不出纯函数（投影那一半有测试：锚点、seq、只画一次）。守卫就是 §6 的定点截图——这条 bug 正是它抓到的，所以不假装用单测盖住。**S5 同理**：证据卡的**位置规则**（`roundEvidenceByTurn`）现在有测试，但「卡片真的画出来了、画成了什么样」仍然只有截图 |
| S8 的**接线**（chunk 到了之后真的换成了上色那一支、不认识的标签真的退回纯文本那一支）没有单测 | 按 §6.1 没有 DOM 环境，而这片能抽的全抽了：标签解析、转义、tokenize 三条纯函数各有测试。剩下的是**条件渲染**，守卫仍与 S3/S5 同一条——定点截图，只是这次多用了 `$B js` 量计算色与**逐块数 span**，因为「上色了没有」是一个能数出来的事实，比看图更硬。**教训沿用 S3 的**：纯函数全绿不等于那一支会被走到 |
| S8 的高亮在**流式**时按事件重算（长围栏会放大这个成本） | **量过，决定这一片不设长度上限**：`highlight()` 的吞吐约 **0.12 µs/字符**（go：35 kB 3.8 ms、348 kB 42 ms、3.4 MB 460 ms），最慢的语法是 **json**（160 kB 98 ms，约 0.61 µs/字符，比 go 慢 5 倍/字符）。上限看着像便宜的保险，但这里不成立：重算只发生在**这段围栏正在长**的时候，而同一帧里它也在被 markdown 重新解析、整条 transcript 也在重画——高亮是这条**既有**成本上的一个常数因子，不是新的量级；`MermaidBlock`（比它贵约两个数量级，每次 `code` 变化就整张重排）同样没有上限，只在这里加一条会是不一致的门槛。真要治，治的是「整条流每个事件重算」本身（流式期间先不上色，或给围栏设上限），那是另一片，不是 S8 的收尾。**dogfood 时手机上若感到卡，这里是第一嫌疑**，不是待验证的猜测而是待触发的已知项 |
| `TestRetiredRunCannotOverwriteRunningRetry` 偶发红（merge base 上 40 次红 3 次） | **已修**（`7bbc7d7`）：`persistRunEvent` 让事件写持着引擎锁，于是 `Cancel` 排在它后面；而假 run 的终局事件原本紧跟在被放行的写之后，run 自己的完成若先拿到锁，任务就已 `succeeded`，cancel 随即报「already terminal」。改成假 run 把终局事件**握在测试手里**，cancel 先落地成为构造性事实，终局事件改在 retry 已经在跑之后才到——这才是这个测试名字所指的危险。100 次全绿 |
| `internal/adapter/droid` 的 `TestAdapterCancelAndProcessExit` 与 `internal/github` 的 `TestRunDoesNotWaitForAProcessThatOutlivesGH` 在全量跑时偶发红（单跑必绿） | **先于本片存在**，且都在 P2 从未碰过的包里（P2 的 diff 不含这两个包）：两条都是进程生命周期测试，对机器负载敏感（当时同时在跑别的构建）。记为**负载敏感的既有 flake**，不在本片修，也不当作本片的红 |
| 引入 DOM 测试环境的诱惑 | 见 §6：先论证哪些断言抽不出来 |
| `Cancel` 与「轮末投递」之间那个窄窗（复审 nit 6，P2 复审的 blocker 正是它） | **两半都关上了**（P2 复审 N4 说只关了一半；前一版本 `281cd6e` 关的是第一半，剩下那半由第三轮复审的 `cec96dc` 关掉）。① 第一半：`runLoop` 的投递条件加 `!wasCanceled`，治「turn 退出时取消已经记下」。② 第二半（`cec96dc`，第三轮复审的 blocker）——**「cancel 落在读标志之后、写之前」**：写这一侧全部改成**谓词在语句里**的 `UpdateTaskUnlessCanceled`（`internal/store/store.go:921`），投递（`deliverQueuedPrompt` → `applyFollowUpPrepared`，`approvals.go:600`）、重启补投（`:627`）、被打断那一轮的延迟投递（`:788`，这条原先传的是 `reviveCanceled`，也就是**故意**允许把取消翻回来——复审的 blocker）、惰性提升（`engine.go:2710`）四处都是。**读一次标志再写**关不掉这个窗（取消不持有本 goroutine 会拿的那把锁），所以修法是谓词而不是第二次检查。③ 被拒的那条消息**要在聊天里说出来**：`reportUndelivered` 直写 store 而不是走 `emitError`，因为取消已经清掉 `activeRuns` 那一格，run 作用域的写会返回冲突——也就是说唯一一句「这条消息没被答」本来会被自己丢掉。**残余**：拒绝这件事由 `TestACancelRefusesTheInterruptsDeferredFollowUp`（拒绝 + 报错里点名那条消息 + 状态保持 canceled + 队列空）与 `TestARefusedDeliveryIsReportedAfterTheCancelClearedTheRun`（先证明 gated 写此刻确实返回冲突，再要求报告落地）各钉一半，但 `engine.go:2664`/`:2710` **那两行本身没有被测试驱动**，它们的正确性是靠「谓词在语句里」这个论证，不是靠一次红；惰性提升那一格连报告都没有（提升被拒就落到下面的状态重读，按取消收尾）。**第四轮复审又找到两个同类窗（都是 major），已关（本轮）**：④ **打断自己的两处直投**（`approvals.go` 的 :700 与 :757，一个是「任务只在起跑队列里」、一个是「读到时已经没有句柄」）当时传的是 `reviveCanceled`，而且是**先自己把行写成 canceled 再复活**——自己制造的取消让真正的那次取消无法分辨，于是取消照样被翻回来。两处改成：**不再自取消**（本来就没有在飞的 run 要腾位置），直接用带谓词的写；被拒就把那条消息点名报出来（`reportUndelivered`）并把错误交回调用方。`applyPendingFollowUp` 的那段注释（「cancelTask 删掉挂起项正是为了让取消能拦住它」）现在对所有投递路径都成立。⑤ 更彻底的一层：**让默认就是安全的**——`deliverQueuedPrompt(ctx, id)`／`applyFollowUpPrepared(...)` 现在只写带谓词的那条，唯一的复活入口是名字里写明来意的 `deliverQueuedPromptReviving`（只有「用户自己此刻发的消息」这一个调用者；曾与它并列的 `applyFollowUpReviving` 一个调用者都没有，第五轮复审点名后已删——一个叫「复活」却谁都不用的包装，会让下一个找入口的人以为找对了地方）。这个类已经出现两次（blocker 一次、major 一次），靠「每个新调用点都记得多传一个常数」是它反复出现的原因；改成「要复活必须挑一个名字」之后，漏掉的那个方向不再可写。⑥ 顺带补上另一半：**取消删掉挂起项时也要说**（`engine.go:1823`）——那条消息在打断时就已经进了聊天记录，删挂起项正是它失去投递者的时刻，而在此之前没有人报过它。**测试**：`TestAnInterruptCannotReviveATaskTheUserCanceled`（走真分支：取消先落地，任务既不在起跑队列也没有句柄）、`TestAnInterruptOfAWaitingTaskCannotReviveACanceledRow`（另一个分支：行被写 canceled 而它还在起跑队列里）、`TestACancelSaysWhatItDidToTheInterruptItDropped`（用 `Cancel()` 不生效的适配器让那一轮活过打断，挂起项才真的在手）。三条都按「删机制验红」验过（把默认写改回复活 → 前两条红；把取消那侧的报告删掉 → 第三条红，`sha256` 逐字节还原）。**仍存的残余**：`engine.go:2664`/`:2710` 两行仍不是被测试直接驱动的（它们现在与其余投递共用同一个入口，所以「写的是哪条语句」由入口决定，但入口本身没有被一行测试指着）；两处直投分支的**时序**（解锁到写之间）无法用现有假适配器构造，测试钉的是这两处**选用的写**，不是它们跑在哪个时刻——`approvals.go` 里那句注释说了为什么这个区别在代码上是可读的：那里已经没有第二个意图可选了 |
| `Cancel` 清队失败时错误被忽略（同一处） | 有意留着：清队失败只影响「丢了几条」的报数，不影响状态机；这条路径上的任何 `return err` 都会让「取消」这个动作本身失败，比少报一个数更糟 |
| A2A 对端没有任何打断手段（复审 nit 8 的另一半） | **已补**（`1758995`，第三轮复审升为 major）：`followUpRequest` 加 `interrupt`（`internal/a2a/server.go:95`，`omitempty`），路由把 `task.FollowUpRequest{Prompt, Interrupt}` 交给引擎。**additive**：不带这个字段的对端拿到的还是排队，也就是它今天的行为；语义与 MCP 的 `send_task_message` 同一开关（字段注释里写明打断会拒掉待批审批并代答待回问题，因为那个进程要被杀）。`TestA2AFollowUpInterruptIsOptIn` 同时钉住两半：不带 = 任务仍跑着原来的 prompt，带 = 新消息成为那一轮（断言是**包含**不是相等——打断会给消息套一层交接前言，那是引擎的事）。**订正（第四轮复审 major）**：**前半条原先钉不住**——打断是「先停后存」，不带字段的那次发送如果被误当成打断，读任务 prompt 这一刻看到的仍然是旧的，只有等那一轮真的收尾才变；也就是说旧断言在**没被识破时是绿的**，识破与否取决于时序（把路由改成恒打断后它确实红了，但那是运气：假适配器一 Cancel 就结束那一轮）。现在前半条读**队列行**（`st.ListPendingPrompts`，恰好一条、就是那条消息）——排队从 POST 返回那一刻就有持久行，打断只有内存里的一次挂起，两者不可能混；后半条同理再断言队列里**只剩**先前那条（打断不会把自己的消息也塞进队列） |
| 重启后 `waiting_input` 任务上的提问已经「过期」 | **先于本片存在**：进程死了，等的那个 waiter 也没了，答上去也到不了模型（`AnswerUserQuestion` 只把状态推回 running，不重启 run）。本片只保证队列有投递者（消息会被回答）；「重启后提问怎么续」是 P3「审批/提问顶替输入框」那片的范围 |
| 无 body 的删除原本报 **±0**，与另外两张脸说的「大小未知」互相矛盾 | **已修**（`1c1498e`）：`delete_file` 只带 `path` 时 `lineDeltaFromTool` 返回 `null`——`changedFiles.ts` 的契约是「payload 重建不出来的数**缺席**，不是 0」。**行为变化要写在这里**：以前拿到 `{additions:0,deletions:0}` 的消费方现在拿到 `null`。新测试「a delete with no recorded body is unknown, not zero」同时钉两侧（无 body → `null`；带 body → `{0, 2}` 仍然照算）。**订正（第四轮复审）**：这一格原先接着写「工作区条对同一个文件本来就写『大小未知』」——**改完之后这句是假的**。真相是：工作区条的**聚合行**以前显示「大小未知」纯属巧合（`hasStats` 为真、和为零），改成 `null` 之后它**什么都不显示**，而每行的文件条目本来就不显示（`f.additions != null \|\| …` 时才画）。也就是说这一提交把话说反了：真正一直说「大小未知」的只有聊天卡（`RoundEvidenceCard` 的逐行）。**修法**（本轮，见 §8 第四轮）：把「一份改动的大小，或者没人知道它的大小」抽成 `FileSize`（`changedFileFace.tsx`，与 `DeltaInline` 同一处，因为那个模块的存在理由就是三张脸对同一个文件说同一句话），工作区条的聚合行与逐行、聊天卡的逐行都改用它；聚合行现在 `hasStats ? ±x : 大小未知`，`±0` 由 `DeltaInline` 照旧负责。**订正（第六轮复审）**：`FileSize` 自己留了个 `±0` 的洞——它把缺席的那一侧换成 0 再交给 `DeltaInline`，于是 `{additions: null, deletions: 0}`（一侧缺、另一侧是实打实的 0）会印出 `±0`，也就是**替一个根本没送来的数断言「这处改动没动任何行」**。`±0` 正好是「替代值就是整个答案」的那一种形状，所以现在只有**两侧都真的到了**才印 `±0`；一侧缺席而另一侧是 0 时改说「大小未知」。同族但**有意不改**：一侧缺、另一侧非零仍只印到了的那一个（`{null, 5}` → `−5`），因为它说的是真的、只是不全，而且它一直这么画。`changedFileFace.test.tsx` 六条钉住四种形状（两个都缺、缺一但另一侧是 0、缺一但另一侧非零、两个都在） |
| 打断键的意图**可能在一次被拒的发送上被留到下一次** | **已修**（`ccb50c5`）：`Composer` 原先在几个早退分支之后才读 `submitIntent.current`，于是一次上传失败/空输入之后，那枚 `interrupt` 还挂着，而下一次通常是普通回车——它会把这**一轮**剪短，顺带替用户拒掉这一轮正在等的审批、代答它正在等的问题。改成进函数就先读并立刻复位成 `"queue"`。同一批：打断键在 `busy/stopping/uploading` 期间 `disabled`（原先只有发送键灰着，打断键可点但点了没意义）。**订正（第四轮复审 nit）**：同一排的**排队发送键**当时漏了 `uploading`（三个键里只有它还灰不住），已补——理由与另两个一样，写在按钮上方那行注释里 |
| 三处**只有渲染连线**的修（没有 DOM 测试可给） | 三处都是「值对了但画错了」，都属于 §6.1 那类抽不出纯函数的：① 改动卡与审批卡的截断提示把 `hidden`（被切掉的行数）当成总行数印出来（`RoundEvidenceCard` / `ApprovalCard`，改成 `preview.lines.length`，`67dbd45`）；② 面板里的工具调用窗口少算了自己的起点，6 次调用画 4 行时编号是 1-4（`WorkerTimeline` 改成 `hidden + idx + 1`，`def22e4`）；③ `Composer` 的意图复位（`ccb50c5`，见上一行）。守卫仍是 §6 的定点截图，不假装单测盖住 |
| `internal/task` 有三个测试文件在 HEAD 上就是 **gofmt 不干净**的 | 先于本片存在（`kin_resume_test.go`、`orchestrate_summary_test.go`、`user_questions_test.go`，都是多余空行）。仓里没有 CI 在跑 `gofmt -l`，本批不去顺手重排别人的文件（AGENTS.md：不做 drive-by cleanup），记在这里以便哪天开 `gofmt -l` 门禁时知道会有 3 个既有命中 |
| 投递的**间隙**（行写成功之后、入队与标签之前）里的取消 | **已修**（第六轮，`8d2ca4b`）：在入队那个临界区里**把行读回来**，已取消就拒收（`ErrTaskCanceled` ⇒ 调用方那句「the queued message … could not be delivered」），于是句子的写者唯一、已取消的任务进不了起跑队列、也不会留下一枚日后被同任务另一次取消当成「第二条丢失」引出来的标签。成立的理由是那把锁：取消扫队列用的是同一个 `e.mu`，所以先拿到锁的一方决定结果、另一方一定看得见；只有 `canceled` 拒收（同一条行被 retry 或另一次投递重新置成 queued 是重复，不是丢失）。**测试**：注入一个扣住投递自己那次 user-guide 写的 event writer，把这个几微秒的窗口从外面撑开；三个变异各红在不同断言（守卫关掉 / 挪到入队之后 / 标签改装在行写旁）。**残余**：同类竞态只能借 event-writer 这条缝构造——`Engine.store` 与 `Engine.bus` 都是具体类型，没法在投递中间暂停；若这类窗口再多一个，值得加一个可注入的 store 缝（本轮没加，它比修法本身大） |
| `applyLimitPolicy` 的惰性提升改成带取消谓词的写（`9539a3a`）之后，**拒收这条路没有测试驱动** | 记在这里：构造它要让一次取消正好落在 `applyLimitPolicy` 的「读行」与「写 `failed`」之间，而那段代码没有缝（它不走 event writer，也不经过投递）。行为上它是单向的——最坏也只是「一个已被取消的任务还会被起一轮交接」这件事不再是必然；哪天引擎有了可注入的 store，这条要补 |

## 8. 进展

| 片 | 提交 | 内容 | 证据 |
|---|---|---|---|
| S1a 存储 | `d590e87` | `task_pending_prompts` 有序列（表，不是任务行上的列）：尾插头取、`ON DELETE CASCADE`、`model`/`permission_mode` 可空（「没说」≠「说清空」）、`user_seq` 指向那条可见消息。**没有写者**，引擎那一半在下一提交 | **11 条 store 测试**（顺序、逐条出队后队空、可空设置「没说」≠「清空」、重启还在、按任务隔离、删任务带走队列、清队报数、空消息不收、未知任务不收这 9 条行为测试，加空库/满库两条迁移路各一条；`git show d590e87:internal/store/pending_prompts_test.go \| grep -c '^func Test'` = 11）。两句定点 red：列改 `NOT NULL`（「没说」与「清空」塌成一种 → 插入即报错）、`ORDER BY id ASC` 改 `DESC`（先出队变成后出队） |
| S1a 引擎 | `317d18a` | 非终态 ⇒ 入队 + **立刻**写 user-guide 事件（否则手机上发完什么都不显示）；轮末投递，adapter 路径与 orchestrated 路径各一处，取队首、`interrupted=false`（保留会话续跑，不谎报「上一轮被打断」）；`Recover` 投递重启时孤儿任务留下的队列；`Cancel` 清队并报告条数；打断变成显式 `interrupt: true` | 4 条新测试：排队**不碰**那三步（审批仍 pending、提问仍未答、任务状态不变）、多条按序逐轮投递、重启不丢、取消即清且有报错事件。四条都按「删掉机制看它变红」验过——red 1 的报错正是 `pending approvals = []`，也就是今天这条路上待批审批被拒光的实证。5 条旧测试改成显式打断（它们本来就是打断路径的测试） |
| S1a API | `0236670` | `interrupt` 进 `FollowUpRequest`（含 openapi 说明）；新增 `GET /api/tasks/{id}/prompts` 回答「哪些看得见的消息还没被回答」。**additive**：任务读、任务列表、prompt 响应形状都没变 | 3 条 API 测试：等待中的消息可见且有序（含 `user_seq`）、404/401、`interrupt` 在**线上**的行为差异（不带 = 任务仍 running，带 = 重新排队）。red：json tag 改成 `interrupts` 后第三条报错。`scripts/check-openapi.sh` 通过，生成的 TS 类型随同一提交更新 |
| S1b | `07a06a2` | **决定片，引擎零改动**：结论与依据见 §3.6。`visibility.user` = 「属于 host 聊天栏」；worker 事件保持 `{user:false, task:true}`；面板的活动来自已在流上的 worker 工具事件，计划结构来自 `worker-steps`，连接键 `execution_id`+`execution_step`（**订正见 §3.6**：和 `step_index` 差 1，不是等值） | 两条守卫（都是补今天缺的那半）：① worker 的 message/tool_use/tool_result/raw_output **四种形状**都不得 `user:true`——Go 侧 1 条（4 个子用例）钉住盖章，console 侧 1 条钉住投影（`isUserFacingEvent` 被改成恒真即红）。② worker 叙述不得进入 host handoff，同时 orchestrator 的总结**必须**进得去（`summarizeEvent` 只认 message/error/result/raw_output，且跳过非 orchestrator 的 `visibility.user=false`）——Go 1 条，两条断言写在同一个测试里，好让「干脆全静音」这种修法也红。两条守卫都按删机制验红、按 sha256 逐字节还原 |
| S1c | `0e9a09a` | 决定片 + 一条投影改动（**不渲染**）：`ToolStep`/`NoteStep` 带 `seq`，且锚在**打开它的那个事件**上（不是最后合并进来的那个——结果可能在打断之后、在另一轮里到达）；`groupIntoTurns` 吐 `fromSeq`/`toSeq`，**闭合在下一轮开始前一个事件**。消费单位是**一轮 = user turn + 紧随的 agent turn** | 表见 §6.2（结论：够用，不补 turn-diff store）。**6 条新测试** + **3 个机制删掉验红**（闭合那趟、步的 seq、不许结果挪步），全部按 sha256 逐字节还原。`npm run build` 后 `web/dist/index.html` 随源码同一提交。**两处订正**（复审时改）：① 原文「所以每个事件恰好属于一轮」**是错的**，`fromSeq`/`toSeq` 是切片不是划分，两条实测形状都不满足（adapter 回显产生第二个 user turn、partial message 不带 seq），真正的消费规则已落成 `roundsOf`，见 §6.2；② 新测试是 6 条不是 5 条 |
| S1a 复审 | `4c21404` `d906ef3` | `@claude` 对抗复审（blocker/major/nit 分级）提了 5 major + 4 nit + 5 处测试缺口，逐条核过后**全部成立**，已修（`4c21404` 是其中的 schema 自愈）；另修了复审没提但被测试当场抓到的一处：把三个 reconcile 收进 `ensureCurrentSchema` 后才发现「已是最新版本」那条早退路径**根本没跑**任何 reconcile——也就是说 d590e87 写下的 v39 库永远不会被修 | 6 条新测试（读不了队列≠空队列、workspace 失败要报告且消息保留、retry 带走被删消息的队列、投递只答一次且锚在自己的消息上、打断锚在自己的消息上、waiting_input 的队列要活过重启）+ 2 条 store（队列表缺锚列自愈、`TasksWithPendingPrompts`）+ 2 条 API（空队答 `[]`、`user_seq` 恒在）。**8 个机制逐个删掉验红，全部按 sha256 逐字节还原**。`scripts/check-openapi.sh` 通过（`user_seq` 去掉 omitempty 不改 schema 的 required） |
| S2a 控制台 | `dc9fee4` | `Composer` 运行中的语义翻转成**默认排队**：蓝键 = 发送（占位文案「本轮结束后回答」），旁边多一个橙键 = 打断并立即发送；`followUpPrompt` 只有显式意图才带 `interrupt: true`。toast 按实际发生的事说话（排队 / 打断），不再一律宣称「已打断」 | 3 条新测试钉住请求体：不带意图时**没有** `interrupt` 字段、带意图时才有、原有 model/permission 字段没被顺手改掉。red 两处（默认改成带 `interrupt`、意图分支失效），sha256 逐字节还原。这条同时修掉一个**比旧行为更糟的谎**：引擎默认翻成排队后，控制台从不发 `interrupt`，却仍在 toast 里说「已打断本轮」——用户以为停住的轮次其实还在跑 |
| S2b 排队中 | `abebb7a` | 消息在入队时就写进 transcript（引擎那一半），所以队列是**唯一变化的东西**：哪些 seq 还在等。`GET /api/tasks/{id}/prompts` 报它们，页面在事件落地时重读 + 3s 慢轮询（只有「某条被答了」变化时也追得上），等待中的 user 气泡标签行长出一枚 chip。`QueuedPrompt.user_seq` 升为契约 required——分不清「没锚」与「字段缺失」的客户端无法决定标什么 | 3 条纯函数测试（收集、`user_seq=0` 不标、空队/无 seq 不标）+ 2 处删机制验红、sha256 还原。`npx tsc --noEmit` 0、`vitest run` 57 文件 572 用例全绿、`npm run build` 后 `web/dist/index.html` 随源码同一提交。定点截图见 §7（S2b 的 chip 与 S3 的卡都已逐张看过） |
| S3 控制台 | `9a845e7` | 审批卡不再一律贴在底部：`approval_requested`/`user_question_requested` 带上被问者的 id，投影把卡挂在**提问事件**上，流就画在那里；只有提问事件滚出已加载窗口时才回落到流尾，且两处**只有一处**会画（一个决定不会长出两套按钮）。`j`/`k` 按提问的 seq 走、无锚的排最后（光标落在看不见的地方比没有光标更糟）。输入框上方一条 bar 说明在等什么并能跳过去——这才是「不该靠打字才发现有待批」 | 4 条投影测试 + 5 条顺序测试（`needsYou.test.ts`）+ 既有测试保持绿。**行内卡片第一次拍就发现主路径不画**——补丁见上一行。定点截图见 §7（S2b 的 chip 与 S3 的卡都已逐张看过） |
| S3 补丁 | `0a1be50` | 定点截图抓到 S3 在**主路径上是死的**：`groupIntoTurns` 把带 `pending` 的 meta 项折进它打断的那一轮（对的），但只有 `standalone` 轮拿得到 `pendingSlots`，于是「agent 先说一句、然后停下来问」这个最常见的形状里卡片被丢掉，屏幕上只剩「需要你的审批 ↓」这行字。修在渲染处（`AgentTurn` 也认这张卡），不改投影：拆轮会为一段连续回答多画一个头像。审批与提问两种都一样 | 390×844 / 1440×900 各两个定点（审批卡在原位、排队 chip 在第二条 user 气泡上）**逐张看过**，并实测卡片几何：卡 320px 不溢出、按钮 70–358、JSON 预览 `scrollWidth 586 > 286` 属设计内滚动。`vitest run` 58 文件 586 用例全绿、`tsc --noEmit` 0、`npm run build` 后 `web/dist/index.html` 随源码同一提交（入口 `index-D4qUdRy8.js`）。**这片的教训**：投影有测试而渲染连线没有（§6.1 无 DOM），所以「锚点算对了」与「卡片画出来了」是两件事，只有截图能证明后者 |
| S4 活动分组 | `7b4fcc9` | 每个 note 带上**来源**（`NoteSource`：`reasoning`/`plan`/`note`），造 note 的那一刻从 `role` 与 canonical `phase` 读出——不猜文本；行标签按来源选（`chat.progress.thinking` / `chat.progress.plan` / 今天的 `chat.progress.note`）。`speaker`/`model` 只在**不是 host 自己的声音**时才画（`noteNeedsAttribution` → `isHostVoice`：`kin`/host/`orchestrator` 是同一列的三个名字）。三个悬空 key 结清 | 6 条新测试（来源表、标签映射 + 两个语言都能解析、流式与定稿同一来源、工具调用结束流式后来源还在、plan 事件与 plan 消息同档、worker 的话算叙述但保留 speaker）+ 归属规则 1 条。**4 处删机制验红**、全部 sha256 逐字节还原。定点截图 390×844 / 1440×900 四张（收起态「已收起 5 步」、展开态五行：计划 / 思考 / Read / 过程 / 过程+`Codex · gpt-5`）**逐张看过**——第一版就是靠它发现 host 自己的 note 被署了名 |
| S1a/S1c 复审修复 | `b4e4faa` `2d8cadf` `0e52508` `7bbc7d7` `3729d41` | 复审的 4 个 major + nits 逐条落地：① 打断的 user-guide 事件在「发布 pendingFollowUp 项」**之前**写下并带锚（原来中间那一瞬别人读到的是 0＝「还没人写」，投递于是把用户的话写了第二遍）；② **丢弃报告与丢弃同事务**（retry 的 rewind 与 cancel 各一处：`DiscardEvent` / `DiscardPendingPrompts`），调用方只 publish——进程死在中间也不能「消息没了而记录里什么都不说」；③ worker 可见性守卫改成驱动 `forwardWorkerEvents`（原来只钉住 `stampWorker`，转发器改坏了守卫照样绿）；④ 「一轮」的契约落成可执行的 `roundsOf`，见 §6.2；nit：投递失败要**点名**那条消息（引号、单行、48 字截断）、`deliverQueuedAfterRestart` 的措辞、`wasCanceled` 的注释收窄 | **11 个机制逐个删掉验红**（全部 sha256 逐字节还原）：retry 报告改到提交之后写、cancel 报告改到提交之后写、重放路径不报告、投递错误不带名字、`userSeq` 归零（当场报 `user copies = 2, want 1`）、守卫只驱动 stamper、把一轮当划分… 新增 4 条 Go + 5 条 UI 测试（`git diff b4e4faa^..3729d41 -- '*.go' \| grep -c '^+func Test'` = 4，UI 侧 `it(` 5 条），另改写 2 条既有 Go 测试：③ 那条守卫从钉 `stampWorker` 改成驱动 `forwardWorkerEvents`，`TestRetiredRunCannotOverwriteRunningRetry` 改成把终局事件握在手里（两者都不新增函数，所以按 `func Test` 数不出来）。**订正（P2 复审 N1）**：这两条「报告改到提交之后写」当时**没有复现**——测试钉的是「有报告」，不是「报告与删除同事务」，所以那一格当时是读 diff 得出的结论而不是验过的红；现在由 `TestAFailedDiscardReportLeavesTheQueueAlone` 与 `TestAFailedRetryDiscardReportTakesTheRetryBack` 钉住（`18618e0`）。**这一片没有 `web/dist` 提交是对的**：`roundsOf` 目前还没有消费者（S5 才用），被 tree-shake 掉了，`npm run build` 产物与已提交的 `index.html` 逐字节相同（入口仍是 `index-B59owEAr.js`）。另修掉一条**先于本片存在**的 flake（见 §7） |
| P2 复审 nit 批 | `67bd94f` `028e3ea` `95d532a` `18618e0` | 第二轮 `@claude`（同档）复审 S1c/S4 区间：**0 blocker / 0 major / 7 nit**，逐条处置——**N5**（这一轮的工作以错误收场时那一轮不闭合，下一次提问于是并进来）正好落在 S5 要用的 `roundsOf` 上，改掉 + 3 条测试，§6.2 的规则描述与条数同步；**N6** 投递失败的前缀说了两遍（`err` 自己已经点名了那条消息）；**N3/N4** 两条注释引了代码里不存在的检查（`cancelTask` 是先解锁再调 store；`UpdateTask` 的谓词只有 id），换成真的那个理由；**N1** 两条「报告改到提交之后写」当时**没复现**，补两条失败注入测试把同事务钉住；**N2** §7 那行改成「只有两种结果」；**N7** 是已披露的「渲染连线没有测试」，无需动作（§7 有行） | **3 个新 UI 测试各自被一处不同的变异弄红**（删掉规则 / 不做前瞻 / 用「含 error」代替「停在 error 上」），逐字节还原；**2 个新 store 测试**用触发器中止 `error` 事件写，把删除提前提交即变红，逐字节还原；`go test ./internal/store/... ./internal/task/...` 全绿、`tsc --noEmit` 0、`vitest run` 58 文件 596 用例全绿；`npm run build` 后 `web/dist/index.html` **未变**（`roundsOf` 仍被 tree-shake，入口还是 `index-C7chGWCf.js`），所以这一批没有 `web/dist` 提交 |
| S5 逐轮 diff 证据卡 | `31b52a0` `aa40a38` `636d01a` | 一轮干了什么，现在在聊天里就能看到：卡片画在**这一轮结束的那个 turn** 下面，列出本轮**通过文件工具**改的文件、+/− 行数，点开某个文件看改动本身（有界、超出报数），并能跳到工作区。两条纯库担全部规则——`diffPreview`（裁掉两端未变的行、两侧共有的行留作上下文、整块有上限）与 `roundEvidence`（按区间读一轮的切片；没有区间或没有文件工具改动 ⇒ `null` ⇒ 不画）。卡片底部**常驻**一行小字说明它只是文件工具的账、权威差异在工作区/PR；**有意不嵌 Monaco**（尽力还原 + 并排编辑器 = 看起来和真 diff 一样权威，正是那行小字要防的）。顺手结清：`ApprovalCard.previewLines` 这个从没人用过的槽**接上**（审批写/改文件时直接画改动，而不是画 JSON），`Transcript.tsx` 删除，工作区两份 `DeltaInline`/动作标签合成 `changedFileFace` | `vitest run` **60 文件 617 用例**全绿、`tsc --noEmit` 0、prettier 逐文件过；**6 处删机制验红**（卡片挂到提问而不是回答上；缺区间时读全流；把编辑判成写；不裁两端未变的行；预览不设上限；文件列表不设上限），全部 sha256 逐字节还原（三条被改的库各自 `shasum -c` 通过）。定点截图 430×932 与 1280×900 **逐张看过**（含展开的逐文件 diff、审批卡的改动预览）。**顺带抓到一个先于本片存在的真 bug**：`Edit` 一直被标成「写」（见 §7 与 `aa40a38`）。`web/dist/index.html` 随源码同一提交——`roundsOf` 终于有了消费者，入口 chunk 从 `index-C7chGWCf.js` 变成 `index-BlRFnNu6.js` |
| S7 容器宽度阶梯 | `47db3b1` `1d919cc` | 树里 56 个任意宽度工具类分布在 28 个文件（口径见 §3.5 那条 `grep -rnoE "(max-w\|min-w\|w\|basis)-\[[^]]*px\]" src`，在 `47db3b1^` 上数是 56 处 / 28 文件），但能归到**容器**的只有 21 个（13 个文件）；其余是截断上限与控制件尺寸，按决定留在字面量里。这一片只给**容器**定名：页面栏（640/920/1100）、面板（右栏 300、命令面板 600）、浮层（菜单 240、弹出层 340、分发层 320）与**下限**（表格 980、正文里的表 240、单元格 160、浮层的 240/168）；截断上限（220/260/280、百分比、rem 值）与控制件尺寸（44/22/26/28px）**按决定留在字面量里**，界线写在 `tailwind.config.ts` 的 `width` 上。唯一进阶梯的文本上限是**路径**，因为它在两处被截断且两处必须一致（240→280）。五个值真的移动了，全是地板或天花板而不是度量：两个菜单的下限共用一个 168（148 与 200），AgentsPage 同列的两个单元格从 140/160 统一到 160，分发层桌面端上限 320 并入弹出层的 340。守卫**按步**：`eslint-rules` 拒「值已被某一步命名」的字面量（阶梯由 config 读入，与调色板同路，两种单位都认），`tokens.test.ts` 多一条 `min-w` 名字轴并让「不许写出已有名字的值」这条守卫**从 config 派生**而不是手列。**「居中栏」不是状态**：不动 `AppState`、不加语言键、不做用户可调宽度档位（理由见 §3.5） | `vitest run` **61 文件 637 用例**全绿、`tsc --noEmit` 0、`eslint .` 0 error（16 条既有 warning）、prettier 干净；**4 处删机制验红**（把 `max-w-page` 写回 `max-w-[920px]` → lint 与守卫同时红；同一宽度写成 `max-w-[57.5rem]` → 两条都红（单位换算这条路是真的）；`min-w-tabl` 拼错 → 名字轴红；把阶梯读成空 → lint **抛错**而不是放行），全部 sha256 逐字节还原。构建产物里 **14 个名字各自 emit 一次 CSS**（`min-w-popover` 只在 `sm:` 下，而这是它唯一的用法），这一步同时证明没有一步是白写的。浏览器实测（夹具，430×932 与 1280×900/1680×1000）：三个页面栏实测 640/920/1100 且居中（x=444 / 304 / 248）、表格 980 落在 `overflow-x-auto` 里、单元格 160、右栏（≥1600px）300、路径上限 280、侧栏排序菜单正好 168（截图看过）、分发层实测 240（内容撑到下限，天花板 340 根本没碰到）；**430px 下 8 条路由的 `documentElement.scrollWidth` 都等于 430**——窄屏不溢出这条验收句是量出来的，不是看出来的 |
| S6 subagent 面板 | `4e324c1` `56d4ad6` | 每个 worker **正在干什么**，现在长在「它被要求做什么」下面：面板读它已经拿到的两份事实（计划表来自 `/workers` 轮询，工具调用来自同一条 SSE），按 `step_index === execution_step - 1` 归到行上；行的活动直接复用 host 进度框那张脸（`ToolStepRow` 从 `ChatStream` 原样抽出，两边同一个组件，展开就是输入/输出）。**只有还在跑的那一行默认展开**——面板的全部意义是回答「现在怎么了」，这件事不能藏在一次点击后面；已结束的行折成一行，所以跑完的计划还是原来那么高。**计划表里没有这一步时也画**（`unplanned`）：事件先到而轮询后到（首次轮询在 250ms 后），轮询失败则整轮都是空列表——这时候把有活动的步骤丢掉，等于在读者最需要它的时候把面板清空。顺手：`eventMeta.readExecution` 这个唯一解码入口导出 | `vitest run` **61 文件 630 用例**全绿、`tsc --noEmit` 0、`eslint .` 0 error、prettier 逐文件过；**5 处删机制验红**（步号偏移改成 0；不要求步号——host 事件于是并进来；丢掉无行的步骤；结果覆盖调用自己的 summary；上限改成留头部），全部 sha256 逐字节还原。定点截图 430×932 与 1280×900 **逐张看过**：live 行自动展开 + 「还有 1 次更早的调用未显示」、孤立步骤画成失败行、展开一次调用的输入/输出、host 进度框在抽取后仍正常（`HOSTONLYTOOL` 只出现在聊天栏、worker 的 7 次调用一次都没进去）。夹具（不进仓）加了第三个任务与 `/workers` |
| S8 聊天内代码高亮 | `2c6af75` | 围栏不再是一块纯文本：`CodeBlock` 把 `pre>code` 原样搬出来（三态同一份 markup，所以 chunk 到达的那一帧不重排），颜色表在 `design/syntax.css`，语法与 core 藏在一个动态 import 后面（`codeHighlight.ts` 的单例，与 Mermaid 同形）。**量出来的数**：`codeHighlight-*.js` 107.33 kB / **gzip 35.17 kB**（23 个手挑语法），入口只涨 **0.41 kB 原始**（vite 报 1,129.25→1,129.66 kB）／**+0.13 kB gzip**（vite 报 314.38→314.51 kB）——这一格原先把两个数并成「入口只涨 0.41 kB（314.38→314.51 gzip）」，把原始那一档挂到了 gzip 上；两对数本身没错（都是 vite 自己报的，见构建日志），错的是哪个数属于哪条流，**订正（P2 复审 N8）**，Monaco 那个 3,359.22 kB 的 chunk 一动不动——比它替代掉的编辑器小 24.6 倍。三个决定：语言表**手挑**（自动识别要全量语法且答案是猜的）、**不认识的标签是 `null` 不是异常**（highlight.js 对未注册名字抛错，所以先问再调）、**chunk 对任何带标签的围栏都加载**（否则要在入口放一张各语法 `aliases` 的副本，正是从 config 读色表要避免的重复）。颜色是 **4 个色相 + 2 个中性色**：关键字走蓝、名字与数字走橙、字符串与 diff 新增行走绿、diff 删除行走红（红色只此一处）、要找的调用名走满墨；注释是 `--kin-secondary` + 斜体，**因为 `--kin-muted` 在围栏自绘的合成底色上只有 4.01:1**（裸表面 4.9:1，所以它到处合规、在这里不合规——这条是量出来的，不是挑出来的） | `vitest run` **62 文件 645 用例**全绿、`tsc --noEmit` 0、`eslint .` 0 error（16 条既有 warning）、prettier 干净；**4 处删机制验红**（注释改回 `--kin-muted` → 新守卫红且报出是哪个 ink 哪个表面；从 `GRAMMARS` 拿掉 `go` → 3 条红；`SPAN_ONLY` 收成 `/^[^<]*$/` → 4 条红，证明这道形状检查真的在拦真实输出；标签切分只按空白 → 标签那条红），全部 `cmp` 逐字节还原。构建产物里 `index-*.css` 含 **45 条 `.kin-code .hljs-*` 规则**（含 `color:var(--kin-secondary);font-style:italic`），`index.html` 指向新入口 `index-6oVOdiSG.js`。浏览器实测（夹具，1440×900 与 430×932）：7 个围栏逐个点数 span——go 26 / diff 5 / json 19 / bash 1 / **无标签 0** / **`brainfuck` 0** / html 8（退化是看得见的），计算色 `func`→`rgb(108,178,255)`、注释→`rgb(199,199,204)` + italic、字符串→`rgb(141,228,160)`、数字→`rgb(255,179,64)`、新增→绿、删除→`rgb(255,138,128)`、调用名→`rgb(245,245,247)`，底色实测 `rgba(255,255,255,0.06)`（正是守卫建模的那个合成），**装有 `<a onclick>`/`<script>`/`<img onerror>` 的 html 围栏产生 0 个 a、0 个 img**；430px 下 `scrollWidth == innerWidth == 430` 而 7 个代码块各自在 `overflow` 里滚 |
| P2 第三轮复审（blocker 批） | `cec96dc` `1758995` `ccb50c5` `67dbd45` `def22e4` `1c1498e` `e86cd53` | 第三轮 `@claude`（同档）对 S8 之后的全量 diff 复审，提了 **1 blocker + 4 major + 若干 nit**，逐条核过后**全部成立**，全部落地。**blocker**：`Cancel` 落在「被打断那一轮收尾」的窗口里会被那次延迟投递翻回来（`applyPendingFollowUp` 传的是 `reviveCanceled`，也就是**故意**允许取消被撤销）——两半现在都关上了，机制与残余写在 §7 那一行。**major** ①取消拒掉的那条消息**在聊天里不说**（run 作用域的写会被已清掉的 `activeRuns` 挡下，所以「这条没被答」这句唯一的交代本来会被自己丢掉 → `reportUndelivered` 直写 store）；②A2A 对端没有任何打断手段（REST 的 S1a API 与 MCP 的 `send_task_message` 都有 `interrupt`，只有 A2A 走的是不带它的 `Engine.FollowUp` → 补上，additive）；③三处 UI 把值画错了（截断提示印 `hidden` 而不是屏上的行数、工具窗口编号从 1 数而不是从窗口起点数、`Composer` 的打断意图可能在一次被拒的发送上留到下一次）。**顺手同族的两处**（复审没点名，改 blocker 时看到的）：被拒的 run 用 `endStatusForDelivery` 收尾而不是一律 `failed`，惰性提升那处写也换成带取消谓词的 `UpdateTaskUnlessCanceled` | **证据**：`go test ./internal/task/ ./internal/store/ ./internal/a2a/ ./internal/api/` 全绿（12.8s / 3.6s / 1.2s / 42.4s）、`go vet` 干净、改动过的 6 个 `.go` 文件 `gofmt -l` 空、`tsc --noEmit` 0、`vitest run` **62 文件 646 用例**全绿（原 645）、`eslint .` 0 error（16 条既有 warning）、prettier 干净、`npm run build` 复现同一入口 `index-WIi88Hsl.js`（1,129.65 kB / gzip 314.51 kB，与提交的 `index.html` 一致，`web/dist/assets/` 未提交）。**两处 Go 修按删机制验红**（`respectCancel` 改回 `reviveCanceled` → 新测试红且报出是哪个任务；把 store-direct 的报告换回 run 作用域的 `emitError` → 报告那条红，且**第一次变异是空转**：用空 execution id 时 `activeRuns[taskID]` 也是空，`"" != ""` 为假于是守卫放行——换成非空 id 才红，这条记下来因为它正是「测试可能为错的原因变绿」的样本），全部 `sha256` 逐字节还原。**复审留下的残余**见 §7 末几行（`engine.go:2664`/`:2710` 两行没被测试驱动、跨进程丢一条投递、两处负载敏感的既有 flake、3 个既有 gofmt 脏文件） |
| P2 第四轮复审（3 major + 4 nit） | `1e9780d` `b9b13bb` `77c62da` `efe3944` `d48ba8a` | 同一档 `@claude` 对**第三轮修复之后**的全量 diff 复审，提了 3 major + 4 nit，逐条核过后**全部成立**，全部落地。**major** ①`internal/task/orchestrate.go:755`：**编排路径**轮末投递被拒时还在用 `emitError`（run 作用域），而它的孪生兄弟 `engine.go:2673` 已经换成 `reportUndelivered`——那条路径上「这条消息没被答」同样会被自己丢掉（同一类里的漏网，就是「修了一个调用点、没修另一个」）。②`approvals.go` 的两处打断直投仍是 `reviveCanceled` + 自取消，取消照样能被翻回来（机制、修法与为什么改成「默认安全」写在 §7 那一行）。③`ChangedFilesBar.tsx` 的「大小未知」聚合行被我上一提交**反向**改坏了（§7 那一行有订正）：它此前显示得对纯属巧合，改完之后一行字都不显示。**nit** ④`TestA2AFollowUpInterruptIsOptIn` 前半条钉不住（订正见 §7 那一行）；⑤`endStatusForDelivery` 的「按取消收尾」当时被记成**构造上不可达**（每个写 canceled 的地方都在同一个 `e.mu` 临界区里清掉 `activeRuns`，于是 `finishRun` 只会返回冲突、不会写）——**这句话是错的，第五轮复审把它证伪了**（见下一行）：它只对「已经有句柄」那条分支成立，两条「还没交给适配器」的分支是**先写状态、再清格**，中间那一瞬投递照样能过闸。本轮不动代码，把「已被证伪」记在这里，免得它继续读起来像一条被验证过的行为；⑥`engine.go` 里 `workspaceErr != nil` 时 `interrupt` 消息被静默丢弃（先于本片存在，未修，记在 §7）——**订正（第五轮复审）**：这一格两处都不对。§7 里没有这一行（当时确实漏记了），而它已经在第五轮修掉了——丢掉时把那句话点名出来，与其余每一处拒绝一致（见下一行 nit ⑤）。剩下「N 条排队消息只报个数不点名」那一半是有意保留的；⑦`Composer` 的排队发送键漏了 `uploading`（订正见 §7 那一行）。| **证据**：`go test ./internal/task/ ./internal/store/ ./internal/a2a/ ./internal/api/` 全绿（12.6s / 3.5s / 1.2s / 41.8s）、`go vet` 干净、`gofmt -l` 只列出那 3 个既有的（见上）、`tsc --noEmit` 0、`vitest run` **62 文件 646 用例**全绿、`eslint .` 0 error（16 条既有 warning）、`npm run build` 复现同一入口（两次构建同为 `index-DoMeI8Zy.js`，1,129.72 kB / gzip 314.52 kB，相对上一版入口 **+0.06 kB / +0.01 kB gzip**）。**三条新测试逐个删机制验红**（默认写改回复活 → 两条红；取消那侧的报告改成空转 → 第三条红），全部按 `sha256` 逐字节还原（`approvals.go` 582d53a1…、`engine.go` 5397f105…）。**全量 `go test ./...` 里三个红**：`internal/adapter/droid`、`internal/github` 两个既有的负载敏感 flake（各自单跑 2 次全绿，见 §7 那一行），加 `internal/remote` 的 `TestHubChallengeServerRoutesACMEWithoutRedirecting`（`bind: address already in use`，端口撞车，单跑 2 次全绿）——三个都不在本次改动的包里。**残余**：§7 那一行末段列了这轮之后仍然存在的（两行没被测试直接驱动、两处分支的时序无法构造、跨进程丢一条投递、`workspaceErr` 静默丢弃） |
| P2 第五轮复审（1 major + 6 nit） | `d1c63d7` `302f1f3` `1c7847b` `a472f09` `7194243` | 同一档 `@claude` 对第四轮修复之后的全量 diff 复审：**1 major + 6 nit**，逐条核过后全部成立。**major（M1）**：`cancelTask` 的两条「还没交给适配器」分支（起跑队列里、以及已认领但句柄还没注册）是**先写 canceled、再清 `activeRuns`**，中间那一瞬一个已经在路上的投递能过 `finishRun` 的闸，于是**同一个任务被宣告结束两次**（重复 `PublishTask` + 第二条终止推送，`finished_at` 被重写；终态仍是 canceled，所以不是状态损坏，是「一条命两条讣告」）。复审用 overlay 探针复现，并指出它**只在 `h != nil` 那条分支上不成立**——也就是上一行 ⑤ 记的那句话是错的。**修法**：两条分支合并进 `Engine.cancelUnstarted`，写状态与清 `activeRuns` 在**同一个 `e.mu` 临界区**里，之后再 publish（`publishFinishedTask` 一直在锁外，因为它会向订阅者扇出）。**store 层试过、退回**：把 `FinishTask` 的允许集合里的终态去掉（想让 store 当「只结束一次」的闸）会让三条 reconcile 测试红——崩溃恢复本来就要把 `failed` 改写成 `succeeded`，终态到终态是**承重**的，所以闸只能在引擎的 active-run 那一格；`FinishTask` 的注释已把这个结论和它的理由写下来。**测试**：新增 `TestACancelAndTheRunItRefusedCannotBothEndTheTask`，两个子用例各走一条分支（真分支：用 gate 卡住 `Adapter.Start` 造出「已认领、无句柄」；另一条：直接把行插成 `queued` 并把 id 放进起跑队列，因为今天没有路径能产出「在队列里且还有活跃 run」这个组合）。窗口只有「store 提交」到「一次 delete」之间的几微秒，所以测试**从外部把它撑开**：注入一个在第 N 次终止推送时停住的 notifier（引擎在写之后、锁之外调它），探针在那个停顿时调 `finishRun`。**删机制验红**：把 `cancelUnstarted` 换回「先写后清」两半，**两个子用例都红**且红在 `finishRun` 返回 `nil`（`engine.go` 按 `sha256` 逐字节还原：988dc8ac…）。**nit**：①`applyFollowUpReviving` 零调用者（已删，见 §7 那一行的订正）；②`efe3944` 的提交信息把排队发送键的漏 `uploading` 说成「会在上传中点出去一条提示词」——**不成立**，`submit()` 本来就在 `uploading` 时早退（`Composer.tsx:212`），真正被修的是「点了没反应但把意图留到下一次」，提交信息不改（它已在评审的 SHA 里），订正记在这里；③`TestAnInterruptOfAWaitingTaskCannotReviveACanceledRow` 只钉了「有报告」，没钉「那条消息本身在聊天里」——补 `userEventsNaming` 断言（删掉预写用户事件验红）；④`reportUndelivered` 自己写失败时静默——改走新的 `noteDroppedEvent`（记进 persist-gap 台账），**不**走 `criticalPersistFail`：那个标志由「下一个收尾的 run」读取，而这两处调用都发生在没有 run 可评分的时刻（取消已经结束或即将结束这个任务，finalizer 的 canceled 分支在读取它之前就 return 了），把标志留在那里会让同一任务**以后某一轮无关的成功**被判成失败；⑤`workspaceErr != nil` 丢掉挂起 follow-up 时不说清是哪条消息——现在点名（`messageLabel`），与其余每一处拒绝一致；另一半「N 条排队消息只报个数」**有意保留**（N 条标签会让错误串无界，而这几条气泡就在聊天记录里紧挨着）；⑥`RoundEvidenceCard` 的卡头在一轮没有行数时**什么都不显示**，而它自己下面的每行都写着「大小未知」——卡头改成与行同一个组件（`FileSize` + 同一个 i18n key），于是四个面（工作区列表、聚合条两处、卡片头与行）走同一条未知分支。**订正（第六轮复审）**：这一格的「四个面」、以及 `7194243` 提交信息里那句「the workspace list, the changed-files bar, and the per-file rows all say it」，都是**错的**。这一提交只动了**卡片头**：工作区列表压根没走 `FileSize`，它在两个计数都缺席时**一行都不画**（第六轮才换成 `FileSize`，见 §8 第六轮）；改动条的四行里只有**逐行文件**走 `FileSize`，**两条聚合行**（`ChangedFilesBar.tsx:190` / `:278`）仍是自己的 `stats.hasStats` 三元式——同一句文案、两条代码路径。第六轮之后真正同一条分支的是四个**逐行**面：工作区列表逐行、改动条逐行、卡片头、卡片逐行。聚合行**有意**留在自己的分支上（它判的是一个聚合标志「这一轮有没有统计」，排版也不同），不是漏掉的第五个面。| **证据**：`go test ./...`（唯一红是既有的负载敏感 flake `internal/adapter/droid TestAdapterCancelAndProcessExit`，单跑绿）、`go test -race ./internal/task/... ./internal/store/...` 全绿（46.9s / 71.4s）、`go vet ./internal/task/` 干净、改动过的 `.go` 文件 `gofmt -l` 空（仓库里那 3 个既有脏文件未动）、`tsc --noEmit` 0、`vitest run` **62 文件 646 用例**全绿、`eslint src` 0 error（16 条既有 warning）、prettier 干净、`npm run build` 已重建并提交 `web/dist/index.html`（入口 `index-CjTQk5MO.js`，`web/dist/assets/` 未提交）。**仍存残余**：两处「N 条排队消息」报告只报数不点名（上面 ⑤ 的理由）；`applyFollowUp` 状态写成功之后若 `DetachTaskAgentSessions`/`GetTask` 失败，会留下一行 `queued` 而它不在起跑队列里（先于本片存在，要重启的 `FailOrphaned` 或下一次入队才恢复）；两处直投分支的**时序**仍无法用现有假适配器构造 |
| P2 第六轮复审（**被限流截断**）+ 它留下的那个窗口 | `ebd859a` `9539a3a` `8d2ca4b` `4f32fe2` | **这一轮的复审没有跑完**：复审 agent 与它扇出的每一个子 agent 都被网关挡在限额外面（`429 · Codex: The usage limit has been reached`，`codex/gpt-6.1-sol`），所以第六轮**没有一份完整的复审报告**，「最后一遍复审无 blocker/major」这句话本轮**无从说起**。按 AGENTS.md 的退路，这一格给的是自查 + 明确列出的残余（本行末段与 §7），而不是一句绿灯。它临死前交出的条目和留下的那条线索都处理了。**本轮的真身（`8d2ca4b`）**：一条被投递、又在起跑前被取消的 follow-up，现在在聊天里说得清是哪条消息没被答。`Engine.queuedMessage` 从投递装上队列项那一刻起记住那行标签，`cancelUnstarted` 在写 canceled 的**同一个临界区**里报告它；标签不能改从任务行读——那是 run prompt，交接 / `@` / 被打断的一轮里可能是一整包上下文。清掉它的四个地方就是「这条消息不再欠着」的四个地方（交给适配器、起跑失败、取消杀掉的是活 run、任务被删）。`FinishTask` 的注释同时订正：它原先说「每个写终态的写者都在同一临界区里退掉 active-run 格」——属于那套协议的只有四个（`finishRun`/`finishQueuedRun`/`cancelTask`/`cancelUnstarted`），重启 reconcile、`failStart` 的无执行分支、以及把行**移出**终态的复活改写都不是，各自只在它所在的位置安全。**复审留下的线索 → 已修（`8d2ca4b`）**：投递的**间隙**——`applyFollowUp` 先写行（那是让任务可跑的写），再在另一个临界区里装队列项与标签；落在中间的取消两样都看不到，于是**必然沉默**，而在那一瞬它确实还不该说话（还没有任何一方说过这条消息会被回答）。剩下的那一半是投递自己的：它会把一个已取消的任务塞进起跑队列、顺手留下一枚标签，然后**返回成功**——那枚标签日后会被同任务的另一次取消当成「第二条丢失」引出来。修法是同一个临界区里**把行读回来**，已取消就拒收（`ErrTaskCanceled`，每个调用方本来就会把它变成「the queued message … could not be delivered」那句话），于是句子的写者唯一、已取消的任务进不了起跑队列、标签也不会留下；只有 `canceled` 会拒收（同一条行被 retry 或另一次投递重新置成 queued 是重复，不是丢失）。**复审的其余条目**：major ① `registerWorkerHandles` 从不清标签——编排轮把 prompt 交给 worker 的地方不是 `startOne`，于是一次更晚的取消会引用一条**已经被回答**的消息当成没答（`ebd859a`）；major ② `applyLimitPolicy` 的惰性提升用裸 `UpdateTask` 写 `failed`，读与写之间的取消会被覆盖、随后还给一个已取消的任务起一轮交接（改成带谓词的写 + 拒了就返回，`9539a3a`；**这条没有测试驱动**，理由见 §7）；major ③ 工作区文件列表在两个计数都缺席时**什么都不画**，而它上面的改动条说着「大小未知」（`4f32fe2`，并把 `FileSize` 自己的 `±0` 洞一起关掉——一侧缺席、另一侧是实打实的 0 时不再替没送来的那个数断言「没动任何行」）；nits：三处注释说了比代码更多的话（`FinishTask`、`cancelUnstarted` 的两个调用方、`reportUndelivered` 的「比保证更弱」）、`engine.go` 的标签注释把写者写成 `applyFollowUpPrepared`（真正写的是它转调的 `applyFollowUp`，而队列那条路根本不经过那个 wrapper）、测试里的 `close(notifier.release)` 换成幂等的 `releaseAll()` + `t.Cleanup`（失败早退不再能把取消 goroutine 停住）。| **证据**：`go test ./internal/task/ ./internal/store/` 全绿（12.6s / 3.8s）、同两个包的 `-race` 全绿（48.5s / 71.4s）、`go build ./...` 与 `go vet ./internal/task/ ./internal/store/` 干净、改动的 `.go` 文件 `gofmt -l` 空（仓库那 3 个既有脏文件未动）、`tsc --noEmit` 0、`vitest run` **63 文件 652 用例**全绿（原 62/646；多出来的是新的 `changedFileFace.test.tsx` 6 条）、`eslint src` 0 error（16 条既有 warning）、prettier 干净、`npm run build` 复现同一入口 `index-Vjah9cqG.js`（1,129.89 kB / gzip 314.50 kB）并随源码同一提交 `web/dist/index.html`（`web/dist/assets/` 未提交）。**间隙那条测试是确定性的**（不是碰运气）：注入一个扣住投递自己那次 user-guide 写的 event writer——正好是行写与临界区之间的那一句——把几微秒的窗口从外面撑开，再在那一刻取消。**三个变异各红在不同的断言上**：守卫关掉 → 「投递在取消拿走任务后仍报成功」；守卫挪到入队之后 → 「已取消的任务被留在起跑队列里」；标签改装在行写旁边（被否决的那个设计）→ 「同一条丢失写了两句话」（报告数 2，也就是取消引用了标签、投递又报了一次）；`approvals.go` 每次按 `sha256` 逐字节还原（bb12b6f6…）。**过程中踩到一次空转变异**：变异脚本自己把刚插入的那行又删掉了（`str.replace` 命中的是刚插进去的那一处），于是「变异后仍绿」什么也证明不了——记在这里，因为它正是「变异测试也可能测错东西」的样本，与第三轮那次空转同族。**残余**：见 §7 新增的两行（`applyLimitPolicy` 的拒收无测试驱动；同类间隙只能借 event-writer 这条缝构造，因为 `Engine.store` 与 `Engine.bus` 都是具体类型） |
