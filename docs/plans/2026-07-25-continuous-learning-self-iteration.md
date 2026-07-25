# 持续学习 / 自迭代闭环设计（脑暴收敛 + A/B 实现方案）

**Status:** Draft（脑暴收敛稿，供评审）
**Date:** 2026-07-25
**Related:** ADR 0011 (Routines·定时触发) · ADR 0012 (Continuous-Learning Eval·尺子) · ADR 0013 (Prompt Recipes·单一执行入口) · ADR 0005 (Isolated Task Workspaces) · ADR 0006 (Usage Ledger) · ADR 0008 (Project / One-Pager) · PRINCIPLE §"越用越好用" / §5.11 "small by default" / §"Stable entrances"

> 缘起：梁文锋讲"通往 AGI 路上要解决的大问题之一是**持续学习**，agent 是其重要形态"。本文把"让 kin 在**人参与尽量少**的前提下自己迭代自己"这个命题，收敛成 kin 现有原语上可落地的闭环，并给两条沉淀机制 A/B 做取舍。

---

## 1. 一句话结论

**持续学习不是新造一个引擎，而是把已有的四个原语接成一个带闸门的环：**
`Routine（触发）→ Task（做，隔离工作区+checkpoint）→ Eval台（判它变好还是变笨）→ 沉淀（Episode / 规则提案）→ 人审采纳 → 回灌下一轮的上下文`。

其中**唯一需要新增**的是"沉淀"这一步的最小数据结构（Episode 卡），以及一条把沉淀变成规则的**提案→采纳闸门**。其余全部复用。这与 ADR 0012 "先造尺子再谈进化"、ADR 0013 "应用层用配方不用专用 API" 同一重力方向。

---

## 2. 为什么"自己迭代自己"必须先接上尺子

脑暴里最诱人的形态是：**定时触发 → 挑一个缺口 → 自己写代码 → 自己打包自己 → computer-use 体验新特性 → 验证通过就采纳**。这是对的方向，但直接做会踩两个经典坑：

1. **没有尺子的自迭代是自嗨。** 它改完自己后无法回答"这版比上一版更好还是更笨"。ADR 0012 已经把这把尺子定义清楚：单元是**轨迹**不是 task，指标是 **Δ / 斜率**不是单点分。所以自迭代环的"验证"节点**必须**落到 eval run 上——computer-use dogfooding 是 eval 的一种判分器（尤其对 GUI 特性），而不是独立的一套验证逻辑。
2. **没有闸门的自采纳会中毒。** ADR 0012 的反命题（护栏）正是这里：自己归纳的规则若无人审就写回 AGENTS.md / skill，会引入陈旧、矛盾、跨项目串味。所以"采纳"必须是一个**显式闸门**，默认人审；只有当 eval Δ>0 且显著、且护栏题不回归时才允许自动采纳（P2 才谈自动）。

> 因此本设计的自迭代环 = **ADR 0012 的尺子** + **一个触发器（ADR 0011）** + **一个沉淀单元（本文新增）** + **一个采纳闸门（本文新增）**。四者缺一，环就退化成刷 token。

---

## 3. 闭环总览

```
         ┌──────────────────────────────────────────────────────────────┐
         │                     自迭代闭环（一圈 = 一个 Episode）              │
         └──────────────────────────────────────────────────────────────┘

  ① 触发            ② 选缺口           ③ 做                ④ 判             ⑤ 沉淀          ⑥ 采纳
 Routine ticker → 从积压里挑一题 → Task(隔离工作区   → Eval run:      → Episode 卡  → 提案 diff
 (ADR 0011)      (Episode/Issue    +git checkpoint)   cold vs warm     (A)            → 人审 → 写回
  定时/事件        积压 backlog)     ADR 0005          Δ + 护栏          规则候选(B)     AGENTS/skill
      │                                                   │                              │
      │                                                   └── computer-use dogfood ──┐   │
      │                                                       (GUI 特性的判分器)       │   │
      └───────────────────────── 回灌：新规则/新 Episode 进入下一轮上下文 ◄───────────┴───┘
```

**每一圈就是一批打了 tag 的普通 Task**（与 ADR 0012 "一次 eval run 就是一批 tagged Task"、ADR 0011 "routine run 就是一个 tagged Task" 完全同构）。GUI 里点进去即有完整 transcript / checkpoint / 成本账，零新增消费面。

### 三个内环（同心圈，按人参与度递减）

| 圈 | 人的角色 | 触发 | 沉淀去向 | 采纳闸门 | 阶段 |
|---|---|---|---|---|---|
| **内环：经验沉淀** | 看板 review | 每个 task 完成即触发 | Episode 卡（可召回） | 无（只是记忆，不改行为规则） | P0 |
| **中环：规则提案** | 审 diff（PR 式） | 攒够 N 张同类 Episode | 规则候选 → AGENTS/skill 的 diff | **人审**（默认） | P1 |
| **外环：自开发自验证** | 定策略 + 兜底否决 | Routine 定时 / eval 回归掉点 | 代码 PR + eval Δ 报告 | eval Δ>0 且护栏不回归 → 人 merge | P2 |

**人参与随圈层向外递减，但从不归零**：内环人只看，中环人审 diff，外环人定"允许它动哪些文件/什么条件下自动 merge"。这既是安全边界（ADR 0013 §4.1 permission）也是叙事上的诚实——"最小人参与"不是"零人参与"。

---

## 4. 缺口从哪来（②选缺口的输入）

自迭代要有"题"可做。缺口的来源全部已存在或近在手边，不需要新采集管道：

1. **Eval 回归掉点**（最硬的信号）：ADR 0012 的回归看板是一条 Routine，某 suite 的 Δ 掉了 → 直接生成一个"修复缺口"缺口。
2. **失败轨迹**：`tasks.Status=failed` / `result.is_error` 的 task，尤其是需人工纠正（follow-up 里人推翻了 agent）的，是最富学习信号的缺口。
3. **重复求助**：同一 Episode 结构反复出现（见 §5 Episode 的 recall key），说明缺一条规则或一个 skill。
4. **人显式投喂**：`docs/inbox/` 里的条目（如 competitor-radar）本就是"值得跟进"的收件箱，可作为外环 backlog 的人工入口。

> **选题策略先笨后聪明**：MVP 只处理来源 1（eval 掉点）——它信号最硬、判分最程序化、最不容易跑偏。来源 2/3 是 P1，来源 4（自主挑 feature 做）是 P2 外环。

---

## 5. 方案 A — Episode Card（内环沉淀的最小单元）

### 5.1 是什么

**Episode = 一条 task 轨迹压缩成的一张"经验卡"**，是记忆的最小可召回单元。它不是完整 transcript（那太大且已在 events 里），而是"这次遇到什么、怎么解的、代价多少、可复用的判断是什么"的结构化摘要。

```
Episode
  id
  task_id            FK tasks（源轨迹，可回放）
  project_id         归属（跨项目召回要用它做隔离/加权）
  trigger            what kind of task（bugfix / feature / repo-convention / …）
  situation          触发情境（1-3 句：遇到了什么）
  resolution         解法要点（做了什么关键动作）
  signal_json        效率/结果指标快照：turns / tokens / cost / passed
                     （直接引 ADR 0006 usage + task_checkpoints，不重算）
  recall_key         归一化的可匹配键（用于"相似任务"检索与去重）
  outcome            success | corrected_by_human | failed
  created_at
```

### 5.2 怎么产生（沉淀这一步本身也是一条 recipe，不是新 API）

按 ADR 0013：沉淀 = "让 kin 想一件事" = **一条 Prompt Recipe（`episode.distill`）+ 一次 Task/Follow-up**，不是服务端 JSON 合并引擎。任一 task 收尾时（或由内环 Routine 批量补齐）跑该 recipe：读自己的 transcript + checkpoint diff + usage → 产出上面的结构化卡 → 写入 `episodes` 表。

> **为什么 Episode 值得一张表（而不是又一个文件）？** 对照 ADR 0013 §4 的四条"允许硬编码"标准：Episode 命中 **②durable source of truth**（要跨会话存活、可被检索器无 LLM 地按 recall_key 查询）+ **④deterministic metrics**（signal_json 是账本快照，模型不能瞎编）。所以它是数据，不是配方——但**生产它**仍走配方。分工与 ADR 0012 "写题在文件、跑题在 GUI" 同理。

### 5.3 召回与应用（记忆闭环的另一半，P1）

- **召回**：新 task 起手时，按 recall_key 检索 top-k 相似 Episode，注入上下文（复用 `maybeInjectProjectContext` 的注入位，跨项目召回默认关、按需开——对上 ADR 0012 护栏 C "A 项目经验在 B 项目该不该召回，测 retrieval precision 不只 recall"）。
- **应用率**：ADR 0012 已定义"记忆专属指标"——检索到 Episode 后是否**真的改变了行为**（靠回放 events 判定），而非只看召回命中。Episode 表让这个指标可算。

### 5.4 A 的边界（non-goal）

- 不做向量库 / 语义检索基建（v1 recall_key 用规则化字符串匹配即可，够 10–20 题的 MVP 用）。
- 不做自动遗忘/衰减策略（P2 护栏话题）。
- Episode **不直接改任何行为规则**——它只是"记住了"，把"改行为"的权力留给方案 B 的闸门。这条分界是护栏的核心。

---

## 6. 方案 B — 规则提案 / 采纳（中·外环的行为改变闸门）

### 6.1 是什么

当同类 Episode 攒够（或 eval 反复在同一处掉点），agent 从**多张 Episode 归纳**出一条候选规则，写成对 `AGENTS.md` / 某个 skill / 项目 playbook 的**diff 提案**，走 **提案 → 人审（PR 式）→ 采纳** 的闸门。

```
RuleProposal
  id
  source_episode_ids  归纳依据（可追溯到具体轨迹）
  target              AGENTS.md | skills/<name> | project playbook
  diff                拟写入的改动（unified diff，人可读可审）
  rationale           为什么（引用 Episode 的复现频次 + eval 信号）
  eval_ref            可选：支撑该规则的 eval run（证明 warm>cold）
  status              proposed | accepted | rejected | superseded
  reviewed_by         人（P2 才允许 = system + 满足自动闸门条件）
```

### 6.2 采纳闸门（本设计的安全核心）

| 环 | 允许谁采纳 | 硬条件 |
|---|---|---|
| 中环 P1 | **人** | 人看 diff + rationale，一键 accept（写回文件，走正常 git） |
| 外环 P2 | system（自动） | ①eval Δ>0 且 > 噪声底（ADR 0012 规则3）②护栏题全绿（无回归/中毒/串味）③改动落在**白名单路径**内 ④成本不爆。任一不满足 → 降级为"人审提案"。 |

> **为什么提案值得机器 + 表，而封面更新（ADR 0013）却被判为"不该有专用 API"？** 关键差异在 ADR 0013 §4：规则采纳命中 **①permission/safety boundary**（它改的是所有后续 task 的行为，是权限边界）+ **②durable source of truth**（AGENTS.md/skill 是长期真源）。封面更新只是"选词→模型改→人确认"，故是配方；规则采纳是"改全局行为的闸门"，故允许机器。**这正是两个 ADR 判据的一次真实应用，不是例外。**

### 6.3 与 computer-use / "自己打包自己" 的接法（外环 P2）

脑暴里的"自己打包自己 → 体验新特性 → computer-use 验证"，在本框架里**不是一条独立管道，而是外环 RuleProposal（此时 target 是代码而非文档）的 eval_ref 判分器**：

1. 缺口来自 eval 掉点或 backlog feature。
2. agent 在**隔离工作区**（ADR 0005）改代码 → 自己 build 出一个候选构建。
3. **判分 = 一次 eval run**：对 GUI 特性，判分器就是 **computer-use / browse skill** 走一遍用户流，断言新特性可用（对齐 ADR 0012 "落地形态 GUI 原生"、`/browse` `/qa` skill 已存在）；对逻辑特性用程序化 `expect.yaml` / `check.sh`。
4. 只有 eval Δ>0 且护栏全绿，才把这个"代码 RuleProposal"升级为一个可 merge 的 PR，人做最后 merge（P2 允许在白名单内自动 merge）。

> 这样"自迭代自验证"就复用了同一把尺子和同一个闸门，而不是另起炉灶——computer-use 只是众多判分器里的一个，专治 GUI。

---

## 7. A vs B —— 不是二选一，是先后与分工

| | A：Episode Card | B：规则提案/采纳 |
|---|---|---|
| 解决的问题 | "记住发生过什么" | "把经验变成会改行为的规则" |
| 是否改 kin 行为 | **否**（只沉淀，安全） | **是**（过闸门才改） |
| 依赖 | 无（P0 即可，不依赖 memory 上线） | 依赖 A（要从 Episode 归纳）+ Eval台（要 Δ 背书） |
| 风险 | 低（存错顶多没用） | 高（中毒/串味/回归——正是 ADR 0012 护栏靶心） |
| 阶段 | **P0/P1** | **P1（人审）/ P2（自动闸门）** |

**结论：A 先行、B 后至、闸门渐开。** A 是地基（无 Episode 就无从归纳），B 是价值兑现但必须被 eval 尺子和人审闸门夹住。**先造尺子（0012）→ 再攒 Episode（A）→ 再谈规则提案（B）→ 最后才谈自动采纳（外环 P2）**。任何跳过尺子直接做 B 自动采纳的路线，都是本设计明确拒绝的。

---

## 8. 分期落地

- **P0（不依赖 memory / 不改任何行为）**：
  - `episodes` 表 + `episode.distill` recipe（沉淀）。
  - 内环 Routine：每个/每批 task 完成后补齐 Episode。
  - GUI 复用现有 task 面消费；Episode 列表可作为一张 artifact 或复用 Routines inbox。
  - 与 ADR 0012 P0 并行：eval台先把噪声底/基线量出来。
- **P1（记忆闭环 + 人审规则）**：
  - Episode 召回注入（recall_key 匹配）+ ADR 0012 "应用率"指标。
  - `rule_proposals` 表 + `rule.propose` recipe；人审 diff → accept 写回文件（走 git）。
  - 缺口来源扩到失败轨迹 / 重复求助。
- **P2（外环自开发自验证 + 受控自动采纳）**：
  - 代码类 RuleProposal + computer-use/browse 判分器 + 白名单路径。
  - 自动采纳闸门（Δ>0 且显著 + 护栏全绿 + 白名单 + 成本约束），否则降级人审。
  - 护栏题（陈旧/中毒/串味）成为自动采纳的强制前置。

---

## 9. Non-goals（明确不做）

- 不做通用 workflow / DAG 引擎（ADR 0011/0013 一致立场）。
- P0/P1 不做无人审的自动采纳——采纳闸门默认人在环。
- 不做向量数据库 / 大规模语义记忆基建（MVP 规则化匹配）。
- 不做在线生产 A/B（ADR 0012 已拒绝：不可复现）；自迭代验证一律走离线可复现 eval。
- 不追题库/规则覆盖率；小而精先证方法学。

---

## 10. 对 agent-infra 岗的叙事价值

这套设计的卖点不是"我做了个会自己进化的 agent"（人人都在吹这个、且大多没有尺子），而是：

> **"我先造了评测尺子（0012），再把持续学习拆成'沉淀（记忆）→提案（归纳）→采纳（受控 gate）'三段，每段的闸门条件都由可复现的 Δ + 护栏背书，且人参与随可信度递减而递减、但从不归零。"**

这展示的是**工程判断力与安全边界意识**——正是 harness/agent-infra 岗最稀缺的信号，比"端到端全自动 demo"更能体现成熟度。参见 ADR 0012 §Consequences 同款论证。

---

## 附：与现有原语的复用清单（一个都没白造）

| 需求 | 复用 | 出处 |
|---|---|---|
| 定时/事件触发 | Routine ticker（catch-up，非 cron） | ADR 0011 |
| 做题的隔离环境 + 可回滚快照 | Isolated workspace + task_checkpoints | ADR 0005 |
| 效率指标（turns/token/cost） | usage_records | ADR 0006 |
| "变好还是变笨"的判定 | Eval run（cold/warm Δ + 护栏） | ADR 0012 |
| GUI 特性的自动验证 | computer-use / `/browse` `/qa` skill | ADR 0012 落地形态 + 现有 skill |
| 沉淀/提案的执行入口 | Prompt Recipe + Task，不新造 API | ADR 0013 |
| 消费/审阅面 | 现有 task transcript + artifact + routines inbox | ADR 0011/0012 |
| 归属与跨项目隔离 | projects / one-pager | ADR 0008 |

**唯二新增**：`episodes` 表（durable+metrics，判据 0013 §4）、`rule_proposals` 表 + 采纳闸门（permission+durable，判据 0013 §4）。其余全是接线。
