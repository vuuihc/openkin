# 用 Kin 冲击 Agent Infra / Agent Harness 岗位：差距分析、补强清单、简历写法

> 目的：把 kin 从「一个能跑的产品」变成「面试官一看就想深挖、深挖之后还能守得住」的作品。
> 结论先行：**你已经有 70% 的料，缺的不是功能，是「可量化的工程信号」和「一份能讲的技术故事」。**

---

## 0. 先认清你在卖什么

Agent 相关岗位大致分两类，招聘信号不一样，kin 对两类的匹配度也不同：

| 岗位类型 | 团队关心什么 | kin 现状匹配度 |
|---|---|---|
| **Agent Harness / Runtime**（agent 执行环境、工具循环、多 agent 编排、CLI/IDE agent 集成） | 工具调用循环、上下文管理、流式、打断/steering、审批与沙箱、异构 agent 统一抽象 | **强（85%）**—这是 kin 的主场 |
| **Agent Infra / Platform**（把 agent 跑成平台，多租户、调度、可观测、规模化） | 调度/并发、可观测/tracing、多 provider 路由、容错、吞吐/延迟、eval | **中（55%）**—单机 local-first 是天然短板 |

**策略建议：**
- **主打 Harness**，用 kin 的 adapter 抽象 + 多 agent 编排 + 审批/隔离作为核心叙事。这块你代码里是真货，面试守得住。
- **补强 Infra 信号**（下面的补强清单），把「单机玩具」的印象抹掉，让 Infra 岗也愿意约你。
- 简历里同一个项目，**针对不同 JD 换 3~4 条 bullet 的排序和措辞**（后面给模板）。

---

## 1. kin 现在真正的「硬通货」（面试能守住的点）

这些不是 README 吹的，是我读了代码确认的、面试官深挑也塌不了的东西：

1. **异构 agent 的统一 adapter 抽象**
   - `internal/adapter/`：Claude Code（解析 `stream-json`）、Codex（解析 JSONL）、内置 kinagent（自研 provider 循环）、rawpty（任意 CLI 兜底），统一到一个 `Start(ctx, spec) → RunHandle{Events(), Cancel()}` 接口。
   - `internal/agent/registry.go`：插件式注册表（ADR 0007）。
   - **这是 harness 岗最值钱的信号**：你证明了能把「行为各异的第三方 agent」收敛成一个可编排、可观测、可取消的运行时契约。

2. **多 agent 编排 + 波次并行**（`internal/task/orchestrate.go`，我逐行读过）
   - `@worker` 触发委派 → `PlanWaves` 依赖分波 → 每波内用 goroutine + WaitGroup **并行**跑 worker → 结果汇聚 → host 控制面做 plan refine / synthesis。
   - **可靠性细节是加分项**：`isWorkerMetaOutput` 检测 worker「答非所问/复读系统提示」→ 用更紧的 brief **自动重试一次** → 仍失败则 fail-closed，不把垃圾塞进主对话。这种「对模型不确定性做工程兜底」正是 harness 面试想听的。
   - worker brief 的构造（assignment 前置、context/prior 有容量上限截断）体现了上下文预算意识。

3. **持久化优先的事件日志 + 审计**（`appendEventLocked`：先落库再广播）
   - critical vs disposable 事件区分：关键事件落库失败会让 task fail，不允许「成功但审计缺口」。
   - 每个 event 带 `execution_id/step/agent/model` 归因、`visibility`（user-facing vs task-only）。
   - **这是可观测性/可回放的地基**，Infra 岗会喜欢。

4. **执行隔离（无容器）**（ADR 0005，`internal/workspace/`）
   - 干净 git repo → 自动 worktree + `kin/task/<id>` 分支；每轮前对 tree 做 checkpoint 快照（私有 object dir，不污染历史）；支持 restore/discard。
   - 面试点：**不用 Docker 也能做到 per-task 隔离 + 回滚**，是很聪明的取舍。

5. **审批/权限模型 + MCP 桥**（`internal/task/approvals.go`、claudecode adapter 的 `--permission-prompt-tool mcp__kin__approve`）
   - `default / accept_edits / yolo` 三档；通过临时 MCP server 把 Claude Code 的权限请求拉回 kin 审批。
   - 安全边界：内部路由（MCP、PTY）即使 LAN 绑定也只 loopback。

6. **自研 provider 抽象与流式**（`internal/provider/openai_compat.go`）
   - `Chat(req)` 带 `OnContentDelta` 流式回调、tool_calls 解析、usage（含 cached_tokens）核算、上下文溢出时压缩旧 tool 结果。

7. **成本/用量账本**（ADR 0006）：per-task / per-provider token 与 $ 核算。

> 一句话记住：**adapter 契约 + 波次编排 + 持久事件日志 + 无容器隔离 + 审批桥**，这五个是你的护城河，简历和面试都围绕它们讲。

---

## 2. 差距分析：为什么现在还不够「一眼高级」

| 短板 | 为什么伤 | 哪类岗位在意 |
|---|---|---|
| **没有 eval / benchmark** | Agent 团队信仰 eval。没有量化成功率/延迟/成本对比，你的编排「好不好」全凭嘴说 | 两类都在意，Infra 尤甚 |
| **可观测性停在事件日志** | 有 event log 但没有 trace/span、没有延迟拆解、没有指标导出。「observability」是硬关键词 | Infra |
| **调度是隐式的** | engine 有 `active--` / `pump()` 的队列雏形，但没有显式的有界并发池、公平调度、背压、吞吐基准 | Infra |
| **provider 只有 OpenAI-compat** | 「多模型路由」讲不圆。缺原生 Anthropic / 本地模型 | Infra |
| **容错语义没成体系** | 有 persist-first、meta-retry，但没有统一的超时/退避/熔断、没有从事件日志 replay 恢复 | 两类 |
| **单机 local-first 的规模叙事天花板低** | Infra 岗必问 scale。你需要一个「即便单机，我也把并发/延迟/吞吐量化并优化过」的故事来对冲 | Infra |
| **没有对外的技术writeup** | 面试官/HR 没时间读你 4 万行 Go。缺一篇带图带数字的设计文/benchmark 博客做「门面」 | 两类 |

---

## 3. 补强清单（按 ROI 排序，投入产出比高的在前）

> 原则：**别再堆产品功能**。堆的是「工程信号 + 可量化数字 + 能讲的故事」。做完每一项，我都标了它「解锁的简历句」。

### ★★★ P0：Eval / Benchmark Harness（最高 ROI，必做）
- **做什么**：一个可复现的任务评测器。定义一个任务集（比如 20~50 个编码/问答任务），对每个 (agent × model) 组合跑，采集：成功率、端到端延迟、token、$、重试次数。产出一份 HTML/CSV 报告。
- **为什么高 ROI**：① 你已经有事件日志，采集几乎白送；② 直接给你**简历数字**；③ eval 是 agent 岗最强共同语言；④ 能顺带暴露并证明你 orchestrate 的价值（单 agent vs 多 agent 波次对比）。
- **实现抓手**：复用 `store.events` 里的 usage/result；新增 `cmd/kin eval` 子命令 + `internal/eval/` 跑批 + 汇总。
- **解锁简历句**：「构建 agent 评测框架，覆盖 N 个任务 × M 个 agent/模型，量化成功率/延迟/成本，驱动编排策略从 X 优化到 Y」。

### ★★★ P0：可观测性 / 分布式 Tracing
- **做什么**：给 task 生命周期打 OpenTelemetry span：dispatch → wave → worker → tool_call → provider request，父子关系串起来。导出延迟/token 拆解（哪一步慢、哪一步烧钱）。
- **为什么**：把「event log」升级成「trace」，直接命中 observability 关键词；多 agent 并行的 trace 图在面试里极具说服力。
- **实现抓手**：`appendEventLocked` 已是天然埋点位；`forwardWorkerEvents`、provider `Chat` 各包一层 span。
- **解锁简历句**：「为多 agent 并行执行实现端到端分布式 tracing，定位并消除编排热点，P95 延迟降低 Z%」。

### ★★ P1：显式调度器 + 并发基准
- **做什么**：把隐式队列变成显式的**有界 worker pool + 公平调度 + 背压**，加压测：N 个并发 task 下的吞吐、排队延迟、资源占用曲线。
- **为什么**：这是把「单机玩具」印象翻盘成「我懂调度」的关键一击，专治 Infra 岗的 scale 拷问。
- **实现抓手**：现有 `e.active` / `pump()` / handleGroups 重构成 scheduler 包，参数化并发度，加 `-race` + bench。
- **解锁简历句**：「设计有界并发调度器（背压 + 公平性），单机支撑 K 个并发 agent task，吞吐提升 …」。

### ★★ P1：Provider 抽象加宽 + 一致性测试
- **做什么**：加原生 Anthropic（非 OpenAI-compat）+ 一个本地 provider（Ollama）。抽一套 provider **conformance test**（流式、tool-calling、usage 三件套跨 provider 一致）。
- **为什么**：让「多模型路由/抽象」成立；conformance test 体现平台化思维。
- **解锁简历句**：「设计跨 provider 的统一 Chat/工具调用抽象，含一致性测试套件，新增 provider 接入成本 < 1 天」。

### ★ P2：容错语义成体系
- **做什么**：统一超时/指数退避/熔断（provider 与 adapter 层）；**从事件日志 replay 恢复**一个中断的 task。
- **为什么**：resumability + 容错是 infra 硬信号；你 persist-first 的地基已经铺好了。
- **解锁简历句**：「基于持久事件日志实现 task 可恢复/可重放；provider 层退避+熔断，故障下成功率从 … 提升到 …」。

### ★ P2：一篇技术 writeup / benchmark 博客（不是代码，但杠杆巨大）
- **做什么**：把 §1 的五大护城河 + §3 的 benchmark 数字，写成一篇带架构图、带 trace 截图、带数字的设计文/博客，简历里放链接。
- **为什么**：面试官不会读你的仓库，但会点开一篇好文。这是转化率最高的「门面」。

---

## 4. 该做到什么程度就收手

别陷入「无限补强」。给你一个止损线：

- **最小可交付（拿面试）**：P0 两项（eval + tracing）+ 一篇 writeup。这三样做完，简历立刻不一样，且面试题你都答得出。
- **拿 offer 加成**：再加 P1 一项（调度器 **或** provider 加宽，二选一，别都做）。
- **P2 是「有余力再说」**，或者干脆留作面试时的「我下一步会做 X」来展示 roadmap 思维——**没做完也能变成加分项**。

> 反直觉但重要：**「讲清楚一个没做完的正确方向」有时比「多做一个功能」更能证明你是 infra 的料。** 面试官在找判断力，不是找劳模。

---

## 5. 简历写法（可直接改数字用）

### 5.1 项目标题行
> **Kin — 自托管跨 Agent 编排运行时（Agent Harness）** · Go / React / SQLite · 个人项目，[开源链接]
> 把 Claude Code、Codex 及任意 CL/自研 agent 统一到一个可编排、可观测、可审批的本地优先运行时。

### 5.2 核心 bullet（按信号强度排序，挑 4~5 条，按 JD 调序）

**编排 / Harness 向（主打）：**
- 设计异构 agent 的**统一 adapter 契约**（`Start→RunHandle{Events,Cancel}`）与插件注册表，接入 Claude Code / Codex / 自研 agent / 任意 CLI 四类运行时，新 agent 接入成本 < 1 天。
- 实现**多 agent 波次编排**：按依赖自动分波、波内 goroutine 并行、结果汇聚 + 控制面二次综合；针对模型「答非所问」实现**检测—收紧 brief—自动重试—失败兜底**的可靠性闭环。
- 构建**持久化优先的事件日志**（先落库再广播，区分关键/可丢事件），带执行归因与可见性分级，作为审计、回放与可观测性的统一地基。

**Infra / Platform 向（补强后加）：**
- 构建 **agent 评测框架**：N 任务 × M(agent×模型) 跑批，量化成功率/延迟/成本，驱动编排策略优化，多 agent 相对单 agent 在 [某类任务] 上成功率 +__%。
- 为多 agent 并行执行实现**端到端分布式 tracing**（dispatch→wave→worker→tool→provider），定位编排热点，P95 延迟 −__%。
- 设计**有界并发调度器**（背压 + 公平调度），单机稳定支撑 __ 个并发 agent task，吞吐 +__%。

**安全 / 隔离向（点缀）：**
- 无容器实现 **per-task 执行隔离**：自动 git worktree + 每轮 checkpoint 快照 + 一键 restore/discard；三档权限模型 + MCP 审批桥把第三方 agent 的权限请求拉回统一审批。

### 5.3 English 版（核心 3 条，投海外/外企用）
- Designed a **uniform adapter contract** (`Start → RunHandle{Events, Cancel}`) unifying heterogeneous agents (Claude Code, Codex, a self-built agent loop, and arbitrary CLIs) behind one orchestratable, observable runtime; new-agent onboarding < 1 day.
- Built **multi-agent wave orchestration** with dependency-based parallelism (goroutine fan-out per wave) and a reliability loop that detects off-task worker output, retries with a tightened brief, and fails closed instead of polluting the main transcript.
- Implemented a **persist-first event log** (write-before-publish, critical-vs-disposable semantics) with per-execution attribution and visibility tiers, serving as the foundation for audit, replay, and tracing.

### 5.4 数字从哪来（别编，跑出来）
- 成功率 / 延迟 / 成本：来自 P0 的 eval harness 报告。
- P95 延迟、吞吐：来自 P1 调度器的 bench（`go test -bench` / 压测脚本）。
- 「接入 < 1 天」：真实记录你加 Codex/rawpty adapter 花的时间。
- **一条铁律**：简历上每个数字，面试时都要能说清「怎么测的、baseline 是什么」。测不出来的数字宁可不写。

---

## 6. 面试深挖预案（守得住才敢写）

面试官大概率会挑这几处，先想好答案：

1. **「多 agent 并行怎么保证结果不串、日志不乱？」**
   → `forwardWorkerEvents` 用 `eventMu` 串行化落库；event 带 `execution_id/step/agent` 归因 + `visibility` 分级（worker 事件 task-only，不进主对话）。

2. **「模型输出不可靠你怎么兜底？」**
   → `isWorkerMetaOutput` 检测 + 一次收紧重试 + fail-closed。承认这是启发式，说清楚为什么选启发式而非再套一层模型（成本/延迟/可解释性）。

3. **「不用容器怎么隔离？回滚安全吗？」**
   → git worktree + 私有 object dir 的 checkpoint 快照，restore 不产生隐藏 commit；discard 需显式确认。讲清取舍：轻量、可读、但隔离强度弱于容器。

4. **「事件为什么要先落库再广播？」**
   → 避免「UI 看到了但审计缺了」；关键事件落库失败直接让 task fail。这是 correctness-over-availability 的选择。

5. **（Infra 岗）「这套东西怎么上规模 / 多租户？」**
   → 诚实说单机 local-first 是当前定位；然后讲你的调度器/背压设计，以及若要多租户你会怎么改（无状态化 engine、事件日志外置、worktree 池化）。**展示判断力，而非假装已经做了。**

6. **「context 怎么管理不爆？」**
   → provider 层溢出压缩旧 tool 结果；worker brief 对 context/prior 有硬容量截断且 assignment 前置。引用 ADR 0002。

---

## 7. 两周行动清单（如果你只有有限时间）

1. **Day 1-4**：P0 eval harness（`cmd/kin eval` + `internal/eval/`），跑出第一版数字。
2. **Day 5-8**：P0 tracing（OTel span 埋在 `appendEventLocked` / worker / provider），出一张多 agent trace 图。
3. **Day 9-11**：P1 二选一（推荐调度器，因为它直接对冲「单机玩具」印象），出 bench 数字。
4. **Day 12-14**：写 §3-P2 的 technical writeup，把数字、架构图、trace 图放进去；同步把 §5 的简历 bullet 填上真实数字。

做完这四步，你就有：**真数字 + 能讲的故事 + 守得住的深挖**——这正是 agent infra/harness 岗从「约面」到「拿 offer」缺的那一环。

---

*本文基于对 kin 仓库的实际代码走查撰写（`internal/task/orchestrate.go`、`internal/adapter/*`、`internal/provider/*`、`internal/store/*`、ADR 0001/0002/0005/0006/0007）。所有「护城河」条目均有对应实现支撑，可放心写入简历并接受深挖。*
