# 竞品 / 灵感雷达 — 2026-07-31

**范围：** 只收集与 Kin 相关的 3 个点子  
**主题过滤：** local-first agent console · memory · multi-agent UX  
**处置：** 进 inbox，不进主线代码  
**来源：** GitHub Search / 高星相关仓 + HN Show HN；Product Hunt 首页被 CF 拦截，未拿到当日榜单

## 扫描摘要（背景，非点子）

| 信号 | 代表 | 与 Kin 的关系 |
|------|------|----------------|
| 个人超级智能 harness | [OpenHuman](https://github.com/tinyhumansai/openhuman) ~35.7k ★ — Memory Trees + Obsidian wiki、agent 编排、Privacy Mode、上过 PH | 全量是「个人 OS」，违反小而美；切片可借鉴记忆落盘形态 |
| local-first 编码工作台 | [cc-haha](https://github.com/NanmiCoder/cc-haha) ~13.8k ★ — worktree / 逐文件 diff / 五档权限 / SubAgent 活动面板 | 控制台手感强，但绑 Claude Code 生态，非跨厂商宿主 |
| 可移植记忆层 | [EverOS](https://github.com/EverMind-AI/EverOS) ~11.7k ★ — Markdown-native、跨 app 的 portable memory | 与 Kin Memory 原则同向；全量 server+球体 demo 偏重 |
| 并行 agent 舰队 ADE | [Orca](https://github.com/stablyai/orca) ~33.7k ★ — 一 prompt 扇出多 worktree、终端分屏、Design Mode | multi-agent UX 的「舰队」叙事；产品形态是 ADE，不是个人确认控制台 |
| 邮件即 agent 收件箱 | [Kikubot](https://github.com/mxaiorg/kikubot) — Show HN: Each AI agent is an inbox | multi-agent 用「邮箱」隐喻协调，轻量有趣 |
| 开放 agent 桌面 harness | [BossConsole](https://github.com/risa-labs-inc/BossConsole) — 100+ `mcp__boss__*`，agent 可操作宿主本身 | 「控制台可被 agent 感知」方向；JVM 全家桶过重 |

---

## 点子 1 — Local-first agent console：权限与 diff 同屏的「极短决策面」

**灵感来源：** cc-haha（五档权限 + 本轮逐文件 diff + Session activity）；BossConsole（宿主自身暴露为 MCP，agent 有情境感知）  
**一句话：** 确认收件箱不只列「要不要跑」，而是**工具调用意图 + 影响面预览（diff / 路径 / 副作用）+ 一键分级放行**落在同一决策卡上；agent 可读「当前控制台状态」（活动任务、待确认数），但不写回任意 UI 控件。

| 维度 | 标注 |
|------|------|
| 贴合原则 | 控制台优先；权限可感知（§ 信任与审计）；Act 前确认；时间线可读 |
| 是否违反「小而美」 | **cc-haha / BOSS 全量会违反**（Computer Use、桌宠、IM 全家桶、100+ 自省工具、插件热重载是独立产品面） |
| Kin 安全切片 | MVP：确认卡 = 意图摘要 + 文件/命令影响列表 + 允许/拒绝/始终允许此类；**不做**桌面操控、宠物、把整个 Kin UI 工具化给 agent |
| 建议姿态 | 加深现有确认收件箱手感，不新开「权限中心」大模块 |

**可借鉴手感：** 「本轮改了什么」与「批不批」同一视线；避免 BOSS 式「agent 操作宿主」无限面。

---

## 点子 2 — Memory：Markdown 记忆树 + 来源链接，代理可插拔后端

**灵感来源：** OpenHuman Memory Trees → Karpathy 式 Obsidian wiki（本地压缩、可打开编辑）；EverOS（portable、Markdown-native、user-owned，跨 agent 一层记忆）；OpenHuman 可选 `agentmemory` backend  
**一句话：** Kin Memory 的默认落盘是**人可打开的 Markdown 树**（带来源 URI / 时间 / 置信），检索只是索引；身份与记忆不绑单一模型厂商，并可选用外部 memory 后端而不改交互契约。

| 维度 | 标注 |
|------|------|
| 贴合原则 | 模型与身份解耦（§3.1）；记忆可治理（查/改/删/导出）；local-first；Artifacts 先于完整 Wiki 的纪律仍成立 |
| 是否违反「小而美」 | **OpenHuman / EverOS 全量会违反**（全账户 auto-fetch 20min 环、meeting agents、跨 app 经济、潜意识常驻） |
| Kin 安全切片 | 仅：会话/用户明确批准后的笔记式记忆 + 来源；**不做**全量 OAuth 抓取、自动生命日志、跨 agent 市场 |
| 与上次雷达关系 | 07-25 强调「打开就能编辑」；本次补上**可插拔 backend 契约**与「压缩树而非无限 transcript」 |

**可借鉴手感：** 记忆是文件，不是黑盒向量；压缩进树，而不是堆原始聊天。

---

## 点子 3 — Multi-agent UX：任务扇出对比 +「每个 agent 一个收件箱」隐喻

**灵感来源：** Orca Parallel Worktrees（一 prompt → 多隔离 agent → 对比合并）；Kikubot（Each AI agent is an inbox；协调者用邮件协议派工）；AgentsMesh / 既有舰队看板  
**一句话：** 多 agent 的默认交互不是画布编排，而是**（a）同一任务扇出到 N 个适配器/worktree，结果并排 diff 选赢家**，以及 **（b）每个 agent 像一个收件箱——人类只处理需要自己出面的信**；协调协议对用户不可见。

| 维度 | 标注 |
|------|------|
| 贴合原则 | 控制台派发/监控/批准；跨 agent；§5.11 默认做小；人始终在确认环上 |
| 是否违反「小而美」 | **Orca ADE 全量 / Kikubot 组织级邮件网会违反**（设计模式浏览器、Ghostty 级终端 IDE、跨机邮件组织树是另一条产品线） |
| Kin 安全切片 | MVP：同一 prompt 派 2–3 个已配置 agent，结果卡并排 + 采纳/丢弃；每 agent 待办进统一确认收件箱；**不做**可视化 BPM、邮件基础设施、百 agent 编制 |
| 差异化提醒 | 竞品卖「舰队 ADE / 劳动力平台」；Kin 楔子仍是**个人、跨厂商、确认可审计** |

**可借鉴手感：** Orca 的「扇出再选优」；Kikubot 的「agent = inbox」心智（映射到 Kin 确认收件箱，而非真邮箱）。

---

## 刻意不收进主线的噪音

- **OpenHuman meeting agents / 17 渠道 / agent economy** — 个人超级 OS 叙事，阶段错误。
- **cc-haha Computer Use、桌宠、H5 远程全家桶** — 宿主能力膨胀，偏离确认控制台。
- **BossConsole 100+ mcp__boss__*** — agent 全面操作 UI，权限面失控。
- **EverOS 全量 sphere server demo** — 教育向 TUI 可玩，不作为 Kin 交互目标。
- **Orca Design Mode / 移动 companion 全量** — ADE 产品，不是 Kin Core。

---

## 下一步（仍限 inbox）

1. 确认收件箱若做交互评审：对照点子 1，决策卡是否缺「影响面」。  
2. Memory / Artifacts ADR：点子 2 作「必须可打开的 Markdown + 禁止自动全量抓取」检查表。  
3. 多任务文案：可用「扇出对比 / 收件箱」，禁用「workforce / 编排器 / 舰队平台」。

*本文件仅为雷达例行产出，不授权改 cmd/ / internal/ / UI 主线。*
