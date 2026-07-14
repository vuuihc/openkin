# Kin 系统设计

[English](./SYSTEM_DESIGN.md)

**状态：** Draft v0.2 — 方向说明，不是 API 合同  
**依据：** [PRINCIPLE.zh.md](./PRINCIPLE.zh.md) · [English](./PRINCIPLE.md) — 对 §12 优先级做了一次刻意重排（见 §2）  
**主张：** Your agent. Your memory. Any model.

探索性草稿与实现日记不放在本仓库。本文是**对外**架构快照：帮助判断 Kin 是否适合你，而不是内部工作备忘录。

---

## 1. 总览

```text
用户拥有的 Kin Core（local-first daemon）
  ├── Agent 适配层               ← 驱动外部 coding agent（Claude Code、Codex、任意 CLI）
  ├── 任务引擎 + 确认            ← 派发、监控、批准、审计
  ├── Provider / 费用层          ← 按任务、按模型的用量与花费
  ├── 远程访问（梯子）           ← 局域网 → tailnet / Funnel；绝不做 Kin 云
  ├── Identity + Memory（v2）    ← 连续主体、可治理记忆
  └── Client Shells              ← 桌面 App + 任意设备的 Web 控制台
```

**硬约束**（来自原则）：

| 约束 | 含义 |
|------|------|
| 用户拥有 | 不需要 Kin 账户；可导出 / 删除 / 自托管 |
| Local-first | 设备是主本；云仅在明确启用时出现 |
| 模型无关 | Provider 特性不拥有身份与记忆 |
| 权限渐进 | 外部影响需可授权、可审计 |
| 默认做小 | 可选层是以后的事，不是 v1 实体（[§5.11](./PRINCIPLE.zh.md)） |

**定位。** 两家厂商都已提供远程控制：Claude Code 的 Remote Control 把每条消息经由 Anthropic 云中继；Codex 的设备控制通过 OpenAI 账号同步状态，且宿主机必须运行其桌面 App。结构上都是单厂商、厂商云居中。Kin 是跨 agent、self-hosted 的另一条路：**在你自己的网络上，用一个控制台管理你所有的 agent。**

---

## 2. 先交付什么（MVP = agent 控制台）

切入点：**在任何设备上派发、监控、批准 agent 任务** —— self-hosted、跨 agent、流量不经过任何 agent 厂商。

**MVP 范围内**

- Kin daemon 通过**适配器**包住外部 coding agent：Claude Code 与 Codex 为一等公民，通用 PTY 兜底任意 CLI
- 任务生命周期：派发 / 流式进度 / 取消 / 历史
- **确认收件箱**：agent 的权限请求推送到桌面与手机，每次决定都有审计记录
- 费用透明：按任务、按 Provider 的 token 与花费
- 远程访问梯子（§5）：局域网扫码 → 内嵌 tailnet + Funnel → 完整 tailnet
- 导出；核心使用不需要任何 Kin 账户

**明确后置——或永不做**

- 可治理记忆 + 身份 —— v2 故事（「Kin 跨 agent 越用越懂你」）；§3 中语义不变
- Kin 自研 code agent —— **永不**；适配器负责监督，不做重新实现
- 原生移动 App —— 基于同一 API 的快速跟进；先 Web 控制台（App Store 审核周期不能卡住 MVP 迭代）
- Kin 托管中继 —— 只有 traction 需要时才考虑；且必须可选、端到端加密
- 完整同步产品、多用户、长期 Routine、自动模型路由

**关于 PRINCIPLE §12 的说明。** 本版重排了 MVP：控制台先于对话/记忆（§12 P1）交付。理由：对话已经发生在 Kin 所监督的 agent 内部；未被满足的需求——两家厂商先后推出远程控制即是验证——是「没有厂商居中的跨 agent 监督」。PRINCIPLE §12/§13 已同步更新（2026-07）。

---

## 3. 核心概念（逻辑模型）

存储实现可变；**语义**应尽量稳定。

| 概念 | 作用 |
|------|------|
| **Task / Run** | 一次派发的 agent 工作单元：目标、agent、状态、transcript、费用 |
| **Agent 适配器** | Kin 驱动外部 agent 的方式：有结构化事件用结构化（Claude Code stream-json、Codex exec），否则 PTY |
| **确认请求** | agent 提出的权限问题，路由到用户所在的设备；一次 / 会话 / 有时限授权 |
| **审计事件** | 做了什么、在何种授权下、必要时脱敏 I/O |
| **费用记录** | 挂在任务与 Provider 上的 token 与花费；本地价格表 |
| **Provider 配置** | 端点与能力；密钥在系统密钥体系，不进日志 |
| **Export bundle** | 可版本化的带走包（**不含**密钥） |
| **Identity / Profile**（v2） | 结构化的「Kin 是谁、如何行事」 |
| **Memory**（v2） | 带类型、来源、置信度、确认态的可治理条目；推断 ≠ 用户事实 |

用户应感知的记忆路径（v2）：**保存 · 建议 · 确认/拒绝 · 编辑/删除**。

权限阶梯（产品语言）：观察 → 准备 → 确认后执行 → 范围内委托 → 用户定义的例程。

外部 coding agent 是**适配器背后的受管 worker** —— Kin 监督它们，不重新实现它们，它们也不是第二套 Kin 身份。

---

## 4. 组件（稳定命名）

| 组件 | 职责 |
|------|------|
| 适配层 | 驱动外部 agent；归一化事件、确认请求、费用遥测 |
| 任务引擎 | 派发、状态机、暂停/取消、历史 |
| Trust & Audit | 授权、确认、凭据、出站感知 |
| Providers / 费用 | Provider 配置、用量记账、按任务花费 |
| 远程访问 | §5 的梯子；绝不是必需的 Kin 云 |
| 控制台 UI | 桌面壳与任意设备 Web 共用同一套 UI |
| Identity（v2） | 偏好、边界、跨模型/设备一致性 |
| Memory（v2） | 可治理记忆的全生命周期（含冲突与导出） |
| Sync（更晚） | 可选、可替换；核心使用不依赖 |

---

## 5. 远程访问梯子

组网是买来的，不是造的。每一级都可选；地板级零账户即可用。

| 层级 | 用户成本 | 机制 |
|------|----------|------|
| 同一局域网 | 零 | 扫码，手机打开局域网 IP + token |
| 远程・默认 | 一次 Tailscale SSO 点击（无需装 App） | 内嵌 tailnet 节点（tsnet）+ Funnel 公网 HTTPS；TLS 在用户设备上终止，中继只见密文 |
| 远程・隐私最大化 | 手机装 Tailscale App | 纯 tailnet，无公网端点 |
| 自带方案 | 高级用户 | daemon 前面放任意反代 / VPN |

**厂商账户说明：** Funnel 这一级用到可选的 Tailscale 账户——是它家的、不是 Kin 的，仅远程功能需要，且可被上下两级替代。零账户的地板（局域网、自带方案）永远存在。

公网端点从第一天就要求硬鉴权：二维码 URL 内一次性长随机 token、会话 cookie、接口限流。

---

## 6. 实现快照

当前选择；随证据可变。唯一不变量：**UI 只通过 HTTP/WebSocket 与核心通信** —— 跨语言边界绝不做进程内绑定。

| 层 | 选型 |
|----|------|
| Daemon | Go，单静态二进制；纯 Go SQLite（无 CGO）；内嵌 Web 控制台；内建 tsnet |
| 桌面壳 | Electron；daemon 作为受管 sidecar；托盘、原生通知批确认、自动更新 |
| UI | React + Tailwind 一套代码，Electron 窗口与手机 Web 共用 |
| API 契约 | OpenAPI 单一来源；代码生成 Go handler 与 TS 类型 |
| 分发 | 桌面 .dmg / .exe 双击；headless 机器 `curl \| sh` 或 brew |

---

## 7. 对外路线图主题

只谈主题，不排日历。细节会变；价值顺序不应乱。

1. **Watch** — 包住一个 agent，本地控制台看流式进度  
2. **Approve** — 桌面与手机批确认，全程审计  
3. **Reach** — 远程梯子、扫码上手  
4. **Track** — 按任务、按 Provider 的费用  
5. **Remember**（v2） — 跨 agent、跨模型延续的 Profile + 可治理记忆  
6. **Live in it** — 打磨到维护者把每天的 agent 工作都跑在 Kin 里

---

## 8. 开放开发

公开边界与邀请节奏：[docs/OPEN_DEVELOPMENT.md](./docs/OPEN_DEVELOPMENT.md)。

有代码后的开源核心承诺：daemon、适配层、任务引擎、权限与审计、费用记账、控制台 UI、导入导出、本地模式——**不**强迫绑定厂商云。记忆层落地时同样开源：那是最值得被看到的部分。

---

## 9. 摘要

Kin 是 **self-hosted 的 agent 控制台，并将生长为个人 Agent 核心**：在你自己的网络上，一个地方派发、监控、批准跨厂商的 agent 工作；身份与记忆随后跨模型延续。

> Kin should grow with the user, without owning the user.
