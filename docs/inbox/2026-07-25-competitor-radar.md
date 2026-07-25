# 竞品 / 灵感雷达 — 2026-07-25

**范围：** 只收集与 Kin 相关的 3 个点子  
**主题过滤：** local-first agent console · memory · multi-agent UX  
**处置：** 进 inbox，不进主线代码  
**来源：** GitHub Trending（daily/weekly）+ 高星相关仓 + Product Hunt feed

---

## 扫描摘要（背景，非点子）

| 信号 | 代表 | 与 Kin 的关系 |
|------|------|----------------|
| 多机 agent 劳动力控制台 | [AgentsMesh](https://github.com/AgentsMesh/AgentsMesh) ~2.3k ★ — 自托管、跨 Claude Code / Codex / Gemini CLI，一控制台调度百级 agent | 直接对标「控制台优先」定位 |
| 单厂商控制台潮 | codex-console ~2.2k ★；nullhub ~1.6k ★；pi-web ~2.7k ★（pi 生态 Web UI） | 市场在验证「agent 需要控制台」，多数仍单 runtime |
| 个人记忆 OS | [EverOS](https://github.com/EverMind-AI/EverOS) ~11.5k ★ — local-first、Markdown-native 可移植记忆层；[openhuman](https://github.com/tinyhumansai/openhuman) ~35k ★ — Memory Tree + Obsidian Wiki + agent fleet | 贴合 v2 Memory，但体量大、易膨胀 |
| 权限 / 确认 UX | PH: **Pushary** — 锁屏批准 AI 请求；**ADE** — 多 coding agent 跨端同步 | 与确认收件箱、跨设备监督同痛点 |
| 多 agent 循环 | PH: **AgentLoop** — Codex worker + critic 周期；**Vizhi** — 实体键盘 mission control | multi-agent UX 的极端形态（循环 / 硬件） |

---

## 点子 1 — 确认收件箱做成「锁屏级」决策面

**灵感来源：** Product Hunt · Pushary（Approve AI requests from your lock screen）；Kin 已有「确认收件箱」MVP 描述  
**一句话：** 把权限请求 / 澄清问题从「控制台里的列表」升成**跨设备、可一键决策**的轻量面——锁屏通知、手表/手机快捷回复、桌面 banner，每次决定仍落审计。

| 维度 | 标注 |
|------|------|
| 贴合原则 | §12 控制台优先；权限可感知（外部动作前确认 + 可读时间线）；用户拥有 / 审计；跨设备 embodiment |
| 是否违反「小而美」 | **不违反**，若只加深已有确认收件箱的触达与反馈，不新增 agent runtime 或云中继 |
| 风险 | 做成独立「推送产品」或依赖厂商推送云 → 膨胀且可能违背 local-first |
| 建议姿态 | inbox 观察；MVP 内优先「手机 Web 控制台可批准」已够；锁屏级是触达增强，非新子系统 |

**可借鉴手感：** 决策 UI 极短（批准 / 拒绝 / 一句话回答），不把完整会话拽到手机。

---

## 点子 2 — 记忆用「Markdown 真源 + 提议写入」，不做向量黑盒 OS

**灵感来源：** EverOS（portable memory layer, Markdown-native, user-owned）；openhuman Memory Tree / Obsidian Wiki；PH · Second Brain for Mac and Windows  
**一句话：** Kin Memory（v2）坚持**用户可读的 Markdown / 文件真源**，高影响写入走提议→确认；Artifacts 已是近端切片，记忆层从产物提炼，而不是另起一套 RAG 平台。

| 维度 | 标注 |
|------|------|
| 贴合原则 | 「Your memory」；记忆可治理（确认、查看、删除、来源；宁可少记）；模型无关（记忆不绑 provider）；Artifacts → Memory 提炼路径（SYSTEM_DESIGN） |
| 是否违反「小而美」 | **openhuman / EverOS 全量会违反**（100+ OAuth、subconscious 常驻、agent economy、自动每 20 分钟抓取）——那是「个人超级智能 OS」 |
| Kin 安全切片 | 仅：本地 Markdown 索引 + 来源链接 + 提议入库；**不做**全网集成、潜意识循环、跨 agent 经济 |
| 建议姿态 | 继续 Artifacts P0 先行；本点子作 v2 记忆形态的竞品锚点，防止以后滑向「AnythingLLM 式大而全」 |

**可借鉴手感：** 「打开就能编辑的记忆」，而不是只在 embedding 里可搜。

---

## 点子 3 — Multi-agent UX：一张���舰队看板」，而不是图编排平台

**灵感来源：** AgentsMesh（schedule / isolate / steer from one console）；openhuman workflows canvas；PH · AgentLoop（worker + critic）；ADE（all coding agents synced）  
**一句话：** 多 agent 的默认 UX 是**任务级看板 + 单任务时间线 + 人工 steer**（暂停 / 改派 / 回答提问），跨 Claude Code / Codex / 通用 CLI；不把 Kin 做成 DAG 工作流编辑器或「百 agent 劳动力平台」。

| 维度 | 标注 |
|------|------|
| 贴合原则 | 控制台优先（派发、监控、批准）；跨 agent、self-hosted、不经厂商中继；权限渐进；§5.11 默认做小 |
| 是否违反「小而美」 | **AgentsMesh / openhuman fleet 全量会违反**（百级并行、图编排、agent-to-agent 经济、多机隔离编排是独立产品） |
| Kin 安全切片 | MVP：多任务并行列表 + 每任务适配器事件流 + 确认收件箱；steer = 取消 / 追问 / 换 agent 重派，而非可视化 BPM |
| 差异化提醒 | 竞品多「单 runtime 控制台」或「劳动力平台」；Kin 的楔子仍是**个人、跨厂商、确认可审计**，不是企业 agent 农场 |

**可借鉴手感：** AgentsMesh 的「一个地方看所有 agent」；避免其「workforce platform」叙事吞掉个人控制台。

---

## 刻意不收进主线的噪音

- **pi / jcode / nanobot 等 agent harness 本体** — Kin 是宿主控制台，不重做 coding agent。
- **code-review-graph 等代码智能图** — 属 agent 侧 context 工具，非 Kin Core。
- **screenpipe 全量屏幕录制** — 记忆输入源可远期考虑，v1 过重且隐私面大。
- **OpenHuman 式 agent economy / tiny.place** — 明显违背小而美与当前阶段。

---

## 下一步（仍限 inbox）

1. 若确认收件箱交互评审，对照点子 1 的「极短决策面」。  
2. Artifacts → Memory 形态 ADR 时，用点子 2 作反例清单（禁止项）。  
3. 多任务 UI 文案避免「workforce / 编排器」，坚持「控制台 / 收件箱」。

*本文件仅为雷达例行产出，不授权改 cmd/ / internal/ / UI 主线。*
