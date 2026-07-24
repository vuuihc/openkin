# ADR 0012: Continuous-Learning Eval (先造尺子，再谈进化)

**Status:** Proposed
**Date:** 2026-07-24
**Related:** ADR 0011 (Routines) · ADR 0006 (Request-level Usage Ledger) · ADR 0005 (Isolated Task Workspaces) · ADR 0007 (Pluggable Agent Runtime) · ADR 0008 (Project / One-Pager) · PRINCIPLE §"越用越好用"

## Context

路线图接下来是 **memory → continuous learning**，目标是让 kin **"越用越好用"**。但没有评测就无从进化——你无法回答"这版记忆让 kin 变好了还是变笨了"。本 ADR 先建**评测台**，不实现记忆本身。

**核心认知：这不是一个能用静态 benchmark 测的东西。** SWE-bench、终态 pass@1 都是**单点快照**，测"kin 现在多强"；而"越用越好用"要测的是**"kin 会不会变强"**。因此：

> 评测的基本单元**不是一个 task，而是一条 task 轨迹（trajectory / curriculum）**；核心指标**不是一个分数，而是分数随使用量变化的 Δ / 斜率**。把 memory 当成受控实验里的**自变量**：同一套题在"有记忆 vs 无记忆"下各跑一遍，两者之差才是学习信号。

要同时证两件相反的事，缺一不可：
- **正命题**：开记忆后，面对相似任务 kin 更快 / 更准 / 更省（transfer 有效）。
- **反命题（护栏）**：记忆没让它**变笨**——无陈旧记忆导致的回归、无成本爆炸、无跨项目串味。第二条恰是多数 continuous-learning 翻车处，也最能体现 harness 成熟度。

**现状盘点（评测能挂靠的现成信号）：** 每个 task 已有**终态成功/失败**（`Status` + `result.is_error`，`task/engine.go`）、**逐轮 token/成本账本**（`usage_records`，ADR 0006）、**可回放的事件流**（`events` 表）、**git checkpoint 快照**（`task_checkpoints`，ADR 0005）。**尚无任何 memory 表，也无任何 eval/benchmark 框架**——干净的地。

## Decision

建一个坐在 `task.Engine` 之上的评测台，**融合进 kin，但接缝按"可抽取"设计**（见 §"融合 vs 独立"）。它把 memory 当自变量，在 cold / warm 条件下跑同一套 held-out 题，产出 Δ 报告与学习曲线。

> **Eval case** = `{prompt, seed 仓, 判分器}`，一个目录一道题。
> **Eval run** = 在某个记忆条件下、对某 suite 跑 N 次的一次完整记录。
> **Δ 报告** = 两个 run（通常 cold vs warm）的指标对照 + 学习曲线。
> 没有通用 agent 驱动层，没有跨 agent 排行榜（v1 只有 kin 一个选手）。

### Product rules（非商量项）

1. **单元是轨迹，指标是 Δ。** 任何只报单点绝对分的做法都跑偏。报告的一等公民是 cold↔warm 的差和随序列位置的曲线。
2. **训练集与评测集严格不相交。** warm 记忆只能由**训练轨迹**喂出；held-out 题绝不进训练。否则测的是背题不是学习。
3. **先测噪声底，再谈 Δ。** LLM 有抖动。每题跑 N 次（默认 5）报分布不报单点；**先量无记忆时同题的方差**，确认 Δ 大于噪声底才算数。
4. **效率类指标优先。** "对但省"（同样对、更少轮数/更少 token）比"从错到对"更早、更灵敏地暴露学习。别只盯 pass 率。
5. **判分能程序化就不用 LLM。** 用 `task_checkpoints` 的 git tree diff + `expect.yaml` 断言；LLM-judge 只兜底不可程序化的题，且必须 cold/warm **成对盲评**消偏。
6. **护栏与正命题同等重要。** 陈旧/中毒/串味测试是一等测试，不是附赠。
7. **小而精起步。** MVP 一个 suite、10–20 题；先把尺子造准，别追覆盖。

### 融合 vs 独立（本 ADR 的关键取舍）

v1 的自变量是 **"kin 有记忆 vs kin 无记忆"——这是 kin 内部的消融，不是多选手赛**。据此：

- **现在融合**：eval 直接读 kin 内部信号。理由：能最早探测学习的信号（到解轮数、自我纠错、记忆应用率）**全靠回放 `events` + `task_checkpoints`**；过早中立化会把这些信号挡在通用接口外——**过早中立 = 主动损失测量精度**。且确定性/回放地基是 kin 特有的。
- **但接缝画对，留好抽取退路**：定义窄接口 `AgentUnderTest`（case → 可判分轨迹），kin 只是第一个实现；判分器/报告保持中立（不 import kin 内部类型）；依赖严格单向 `eval → kin`。
- **抽成独立 arena 的触发条件（满足任一再拆）**：(a) 真出现第二个要认真比的选手且需对外可复现排行榜；(b) 目标从"指导 kin 进化"变为"发布通用 benchmark"；(c) kin 内部 churn 需隔离 eval。在此之前独立只会拖慢唯一需要的实验。

### 实验设计（三层，从简到繁）

- **A — 配对冷/暖（MVP）**：cold（空记忆）得基线；warm（喂过训练轨迹）跑**同一套 held-out 题**；`Δ = warm − cold`。
- **B — 学习曲线**：一条 N 步长序列，后题结构上受益于前题；指标对序列位置画曲线，**斜率 > 0 且显著 = 真在学**。这是"越用越好用"那张图。
- **C — 护栏（消融 / 陈旧 / 串味）**：清空或污染记忆看指标塌多少（贡献度）；先教"用 npm"中途改环境为"pnpm"，看它盲从旧记忆还是被现场证据纠偏；A 项目经验在 B 项目该不该召回（测 retrieval precision，不只 recall）。

### 指标体系（三族）

| 族 | 指标 | 数据来源 |
|---|---|---|
| **结果质量** | pass 率、终态正确性、需人工纠正次数 | `task_checkpoints` git diff + `expect.yaml` / `check.sh` |
| **效率** | 到解轮数、tool 调用数、tokens、cost、wall-clock | `usage_records`（ADR 0006）+ `events` 回放 |
| **记忆专属** | 召回命中率、**应用率**（检索到后是否真改变了行为，靠回放 `events`）、记忆精度（存下的记忆里有用的占比） | `events` + 未来 memory 表 |

### 落地形态（怎么用）—— GUI 原生，CLI 可选

kin 是 **GUI-first** 产品，故评测的**运行与消费全部复用现有 GUI 面**。分层：**真正的原语是 `internal/eval` 服务 + API，GUI 是主客户端；CLI 仅作 headless/CI 的可选入口，不是主面。**

**关键认知：一次 eval run 就是一批打了 tag 的普通 Task。** 每个 `case × rep × condition` 都是一个 Task——它在 GUI 里**已经**有完整的 transcript 回放、checkpoint、成本账（复用 `transcriptProjection`）。所以"看某道题 kin 怎么跑的"零新增开发，点进去即是。

**运行与消费（GUI）：**
- **触发**：一个"发起 suite"按钮/页面（类似 Routine 的 run-now），后台 fan-out 成一批 Task。
- **单题**：点进任一 Task 看 transcript（复用现有投影）。
- **Δ 报告 = 一个 Artifact**：cold/warm 对照表 + 学习曲线，用 kin 现有 artifact 渲染在 GUI（复用 HTML export）。
- **回归看板 = 一条 Routine（ADR 0011）**：定时重跑，`noteworthy` 信号回退即 push；本就是 GUI 原生。

**写题（留在 repo，这是对的分工）：** case 是 fixture/测试，像单元测试一样**随代码版本化写在仓里**，不进 GUI——你不会在 GUI 里手搓测试夹具：
```
eval/suites/<suite>/<case>/
  prompt.md        # 给 kin 的任务
  seed/            # 初始 cwd，一个已 git init 的 fixture 仓
  expect.yaml      # 声明式断言（该存在的文件/内容/git diff）
  check.sh         # 可选，程序化兜底（退出码）
```
判分器直接 diff `task_checkpoints` tree OID 与 seed 的差。**目标是"复制目录改 prompt 即新题"**——写题不痛，题库才长得起来。**写题在文件、跑题/看结果在 GUI。**

**记忆快照/恢复原语**（cold/warm 的命门，须与 memory 功能同期设计）：`cold` = 空记忆跑题；`warm` = 先把训练轨迹回放进一份**独立记忆命名空间/独立 sqlite** 快照，恢复后跑 held-out 题。每个 eval_run 一份快照，跑完可弃、可复现、互不污染。快照的建立/切换由后端在 fan-out 前完成，GUI 无感。

**同心圈（复用现有面，非新造三套 UI）：** 内环开发态走 GUI 触发 + Δ artifact；中环回归态是一条 Routine；外环跨 agent 赛场延后，现在只留 `AgentUnderTest` 接口。

### 任务套件设计

每题需同时满足：**可程序化判定**（免 LLM 噪声）、**有重复结构**（记忆才有东西可迁移）、**分档难度**（看曲线哪段起效）、**能成序列**（支撑设计 B）。三类题：(1) 重复型技能——同模板多变体，测 transfer；(2) 项目惯例型——"这 repo 用什么测试框架/命名"，只能靠积累，对上 `projects.one_pager`；(3) 陷阱型——埋陈旧/矛盾信息，正确行为是**不盲从记忆**。

### 数据模型

- **`eval_runs`**：`id, suite, suite_version, condition(cold|warm|poisoned), kin_git_sha, n_reps, started_at, finished_at`。
- **`eval_results`**：`id, run_id, case_id, rep_idx, task_id(FK tasks), pass(bool), turns, tokens_in/out, cost_usd, checker_json`。
- **memory 快照**引用（独立 sqlite 路径 / 命名空间），随 run 记录以便复现。
- Run 里的每一次执行**就是一个普通 Task**（tagged eval），所以成本账本、artifacts、事件回放全部免费复用。

### Non-goals（本 ADR）

- 通用 agent 驱动层 / 跨 agent 排行榜（外环，延后）。
- 记忆机制本身（memory retrieval/store 是后续 ADR）。
- 追覆盖率的大题库；比 SWE-bench 规模。
- 只靠 LLM-judge 的打分；生产环境在线 A/B（本台是离线可复现评测）。
- CI 强制门禁（可选，P2 再议）。

## Consequences

- kin 获得第一个**可复现的持续学习评测台**；memory 上线前就能建基线、量噪声底，为后续 Δ 提供参照系——避免"记忆上线后根本说不清有没有变好"的经典坑。
- 与 ADR 0011 协同：eval 回归看板直接落成一条 Routine，复用其自报信号与 push，零额外 UI。
- Eval run 复用 Task/Artifacts/Usage，故成本、导出、回放全部沿用。
- **叙事价值（对 agent-infra 岗）**："先把评测作为 kin 内部消融工具落地，并按可抽取为通用 arena 的接口设计"——比"造了个只有一个选手的通用评测平台"更能体现工程判断力。
- 风险：题库设计是真功夫，写题若痛则套件长不起来 → 用目录约定把写题成本压到最低。
- 风险：配对 × N 次 × 多档，token 量级大 → MVP 用 10–20 题小套件，先证方法学再扩。
- 风险：LLM 抖动淹没 Δ → 强制"先测方差底"规则，Δ 须显著大于噪声。

## Alternatives considered

1. **独立评测项目，kin+记忆只是一个选手** — 拒绝（v1）：只有一个选手却先造赛场是过早抽象；且通用接口会挡住最丰富的学习信号。改为"融合 + 可抽取接缝"，触发条件满足再拆。见 §融合 vs 独立。
2. **静态 benchmark / 单点 pass@1** — 拒绝：测"多强"不测"会不会变强"，无法回答"越用越好用"。
3. **只用 LLM-judge 打分** — 拒绝：噪声大、不可复现；改为程序化判分为主、judge 成对盲评兜底。
4. **在线生产 A/B** — 拒绝（本台）：不可复现、慢、受流量混杂污染；离线可复现评测是进化的方向盘。
5. **P0 就接 memory 才开测** — 拒绝：P0 无需 memory 即可建基线与噪声底，这一步恰是多数人跳过的关键前置。
6. **CLI-first 落地** — 拒绝：kin 是 GUI-first 产品，评测的运行/消费应复用现有 GUI（runs = tasks、报告 = artifact、看板 = routine），原语是 `internal/eval` 服务 + API；CLI 降级为可选 headless/CI 入口。仅**写题（fixture）**留在 repo，与单元测试同理。

## Phasing

- **P0**：`internal/eval` 服务 + API + GUI 触发按钮（eval run = 一批 tagged Task，Δ 报告落为 artifact） + 10 道可程序化判定题 + cold/warm 配对 + **只看效率类指标 + 先测无记忆方差底**。（不依赖 memory 上线；CLI 入口可选、延后。）
- **P1**：接 memory，补记忆专属指标 + 学习曲线（设计 B）。
- **P2**：护栏（陷阱题 / 消融 / 中毒）+ Routine 化回归看板 +（可选）CI 门禁。
