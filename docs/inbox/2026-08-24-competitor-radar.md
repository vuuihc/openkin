# 竞品 / 灵感雷达 — 2026-08-24

**范围：** 只收集与 Kin 相关的 3 个点子  
**主题过滤：** local-first agent console · memory · multi-agent UX  
**处置：** 进 inbox，不进主线代码  
**来源：** GitHub Trending（daily / weekly）+ 高星相关仓 + Product Hunt Atom feed（首页被 CF 拦 403，未拿到当日榜单 UI）+ HN Algolia 作交叉验证

## 扫描摘要（背景，非点子）

| 信号 | 代表 | 与 Kin 的关系 |
|------|------|----------------|
| local-first agent 工作区把「权限决定」写成日志 | [apache/maka](https://github.com/apache/maka) ~2.5k ★，日榜+周榜 — 模型消息 / 工具调用 / 工具结果 / **permission decisions** / 终止事件进 **append-only log**；上下文缩短 ≠ 删除历史；Desktop / TUI / eval 共用 Runtime Host | 直接贴合控制台「时间线可读 + Act 前确认」；全量是 agent workspace/runtime，不是宿主控制台 |
| 记忆+RAG+Skills 合成「上下文数据库」 | [volcengine/OpenViking](https://github.com/volcengine/OpenViking) ~32.7k ★，周榜 — Self-evolving Context Database，Unify Agent Memory / Knowledge RAG / Skills | 记忆层市场热；全量是 infra 平台，违反小而美 |
| git-native / 可自退役的跨 agent 记忆 | [grpcer/ownmem](https://github.com/grpcer/ownmem) ~109 ★ — 一套 Markdown 同时服务 Claude Code / Codex / Gemini CLI / Cursor / Grok CLI；[hsusul/lore](https://github.com/hsusul/lore) ~141 ★ — 本机会话档案，v0 无账号/遥测/云/LLM；[dat999zx/knowl](https://github.com/dat999zx/knowl) — Show HN：CLAUDE.md 涨到 1000 行后做 **supersession**（旧事实退役） | 与 Kin Memory「可打开、可治理、模型无关」同向；切片可借，产品本体不做 |
| 人与 agent 同房间、同审计 | [block/buzz](https://github.com/block/buzz) ~30.3k ★，日榜 — 自托管 workspace；agent 是 **member 不是 bot**，自有 keypair 与审计；workflow approval gates 在接线 | multi-agent UX 的「同一房间」隐喻；全量是 Slack-for-agents，过重 |
| 本机权限沙箱 / 合盖续跑 | PH · **Plow Latch**（Run AI agents on your Mac with scoped access）；PH · **Agents Never Sleep**（Agents keep running with the lid closed） | 确认控制台的两端：作用域放行、daemon 不因合盖停；不是新 runtime |
| 个人超级智能 / 元 harness 仍在榜 | [tinyhumansai/openhuman](https://github.com/tinyhumansai/openhuman) 仍日榜；[ruvnet/ruflo](https://github.com/ruvnet/ruflo) ~69k ★ swarm meta-harness | 与 07-25 / 07-31 同噪声，不升级为点子 |

与上次（07-31）的增量：确认卡从「影响面预览」推进到 **权限决定本身是日志事件**；记忆从「Markdown 树 + 可插拔 backend」推进到 **事实会退役（supersede）+ 一套文件喂多个适配器**；多 agent 从「扇出对比 / 收件箱」推进到 **agent 作为有身份的成员出现在同一��间线**。

---

## 点子 1 — Local-first agent console：权限决定是日志，不是弹窗副作用

**灵感来源：** Apache Maka（append-only：messages / tool calls / results / **permission decisions** / termination；缩短下一轮上下文不等于丢掉记录）；PH · Plow Latch（本机 agent 必须 scoped access）  
**一句话：** Kin 控制台的真源应是**同一条可导出的事件日志**——工具意图、影响面、人的允许/拒绝/始终允许、任务如何结束，都是一等事件；UI 只是这条日志的阅读器。合盖后续跑可以，越权作用域不行。

| 维度 | 标注 |
|------|------|
| 贴合原则 | 控制台优先（派发 / 监控 / 批准）；权限可感知（Act 前确认 + 可读时间线）；用户拥有 / 可审计；local-first；§5.11「少一个用户必须理解的概念」——确认收件箱 = 日志，不另起权限中心 |
| 是否违反「小而美」 | **Maka 全量会违反**（自研 Runtime Host、Graph/worktree 编排、Desktop+TUI+Eval 三端 agent 工作区 = 第二套 Kin/Runtime）。Plow Latch 做成独立「OS 沙箱产品」也会膨胀 |
| Kin 安全切片 | 加深现有确认收件箱与任务时间线：每条确认写入与 agent 事件同一条 append-only 记录；导出/审计能回答「谁在何时批了什么」。**不做**自研 coding runtime、Graph 模式、HID/OS 级沙箱框架 |
| 建议姿态 | inbox 观察；对照现有确认流是否「批完就散」——若批准只活在 UI 状态里，就是本点子要补的缺口 |

**可借鉴手感：** Maka 的「The record is kept」；Plow Latch 的「先划作用域再跑」。避免把 Kin 做成又一个 agent IDE。

---

## 点子 2 — Memory：一套可打开的 Markdown，旧事实会退役

**灵感来源：** ownmem（git-native、deterministic，**一份 Markdown 喂多个 coding agent**）；Knowl（CLAUDE.md 膨胀的反模式 → **supersession**：新事实退役旧事实，旧条仍可在 timeline 查到）；Lore（本机 git 档案，v0 无云、无 LLM 调用，明确「是 archive 不是 runtime」）  
**一句话：** Kin Memory 默认是**人可打开、git 可 diff 的文件**；跨 Claude Code / Codex / 通用 CLI 共用同一份，而不是每适配器一份 CLAUDE.md；写入是提议→确认，**同主题新事实默认取代旧事实**（可查历史，不在检索里打架）。

| 维度 | 标注 |
|------|------|
| 贴合原则 | Your memory；模型与身份解耦（§3.1）；记忆可治理（§5.6 查/改/删/来源，宁可少记）；Artifacts 先于完整 Wiki 的纪律仍成立；跨 agent 延续 |
| 是否违反「小而美」 | **OpenViking 全量会违反**（Memory ∪ RAG ∪ Skills 的自进化上下文数据库是独立 infra）。Knowl 的 27 个 MCP 工具、Lore 做成第二套桌面档案 App，也会增实体 |
| Kin 安全切片 | 仅：会话/用户批准后的笔记式记忆 + 来源 + **同主题覆盖/退役**；一份目录被多个适配器只读注入。**不做**自进化向量 OS、全量 OAuth 抓取、把会话 transcript 当记忆 |
| 与上次雷达关系 | 07-25 / 07-31 已钉「打开就能编辑、禁止自动全量抓取」；本次补上 **supersede（防 CLAUDE.md 无限胀）」** 与 **一份记忆、多个 adapter**，对应「换模型不丢 Kin」 |

**可借鉴手感：** 记忆是会退休的事实，不是越积越吵的 prompt 附录。Lore 的范围声明可当反例清单：archive ≠ IDE ≠ cloud memory service。

---

## 点子 3 — Multi-agent UX：agent 是有身份的成员，不是画布上的节点

**灵感来源：** Buzz（agent = member，自有 key / 频道成员资格 / 审计；人与 agent 同一房间；approval gates）；Maka Graph（隔离 worktree 上的分片，但那是 runtime 内编排）；PH · Agents Never Sleep（合盖仍跑）+ HN · Zuse（一个协调者盯多个 worktree issue）  
**一句话：** 多 agent 的默认画面不是 DAG 也不是「舰队」，而是**同一条任务时间线上站着几个有名字的成员**——各自事件、各自花费、各自待确认；人只在成员请求越权时出面。合盖不断线是 daemon 的本分，不是「无人值守自治」。

| 维度 | 标注 |
|------|------|
| 贴合原则 | 控制台派发/监控/批准；跨 agent、self-hosted、不经厂商中继；人始终在确认环上；§5.11 默认做小、外部执行器是 Tool 不是第二套 Kin |
| 是否违反「小而美」 | **Buzz 全量会违反**（Nostr relay、频道/画布/huddle/git hosting、agent 操作整个 workspace）。ruflo swarm / OpenHuman fleet / 「workforce」叙事同样过线 |
| Kin 安全切片 | MVP：并行任务列表里每个适配器像一个成员（名字、状态、待确认数、花费）；合盖后 daemon 继续、确认仍进收件箱。**不做**聊天室产品、agent-to-agent 经济、百 agent 编制、可视化 BPM |
| 差异化提醒 | 竞品卖「人机同房间的团队 OS」或「合盖自治」；Kin 楔子仍是**个人、跨厂商、确认可审计**。合盖续跑若绕过确认，就违背 Act 前确认 |

**可借鉴手感：** Buzz 的「agent 有自己的身份和收据」；拒绝其「让 agent 跑整个 workspace」。Agents Never Sleep 只借「lid closed ≠ process killed」。

---

## 刻意不收进主线的噪音

- **OpenViking 统一 Memory/RAG/Skills** — 上下文数据库平台，阶段错误。
- **ruflo / OpenHuman fleet / agent economy** — 元 harness 与个人超级 OS，重复上次排除。
- **Buzz 全量社区/relay/huddle** — 协作套件，不是个人确认控制台。
- **Maka Graph / 自研 Runtime Host** — Kin 调用外部执行器，不重做 coding agent。
- **free-claude-code「海量免费 token」** — 增长黑客，与费用透明、用户拥有无关。
- **ShogunAI / AutoClaw 个人 AGI / 全桌面 agent** — 叙事过大。
- **Knowl 27 MCP tools** — 记忆引擎工具面膨胀；只借 supersession。

---

## 下一步（仍限 inbox）

1. 确认收件箱评审：对照点子 1，批准是否写入与工具事件同一条可导出日志。  
2. Memory / Artifacts ADR：点子 2 作检查表——一份 Markdown、禁止 CLAUDE.md 只增不退役、禁止 Memory∪RAG∪Skills 大一统。  
3. 多任务文案：可用「成员 / 时间线 / 收件箱」，继续禁用「workforce / 编排器 / 舰队平台 / 人机同房间 OS」。

*本文件仅为雷达例行产出，不授权改 cmd/ / internal/ / UI 主线。*
