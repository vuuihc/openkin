# Kin

[English](./README.md)

> 一个控制台，管理你所有的 coding agent。Self-hosted，任意设备。

在手机或任何设备上派发、监控、批准 agent 任务——Claude Code、Codex、任意 CLI——流量只走你自己的网络。没有厂商中继，不需要 Kin 账户。并将生长为记忆归你所有的 local-first 个人 Agent。

```text
Your agent. Your memory. Any model.
```

## 文档

| 文档 | 内容 |
|------|------|
| [PRINCIPLE.zh.md](./PRINCIPLE.zh.md) · [English](./PRINCIPLE.md) | 产品纲领与不可妥协原则 |
| [SYSTEM_DESIGN.zh.md](./SYSTEM_DESIGN.zh.md) · [English](./SYSTEM_DESIGN.md) | 对外架构快照（Draft，不是 API 合同） |
| [OPEN_DEVELOPMENT.md](./docs/OPEN_DEVELOPMENT.md) | 公开边界与节奏（英文主文档） |

## 状态

设计阶段；下一步是构建 MVP（agent 控制台）。公开文档描述**方向**；实现细节随代码落地。

## 一句话特性

- **跨 agent 控制台** —— 一处派发 / 监控 / 批准 Claude Code、Codex 或任意 CLI agent
- **Self-hosted 远程** —— 局域网 → tailnet / Funnel 梯子；流量不经过任何 agent 厂商的云
- **费用透明** —— 按任务、按 Provider 的 token 与花费
- **用户拥有** —— 本地优先；无需 Kin 账户；可导出、可离开
- **记忆随后（v2）** —— 跨 agent、跨模型延续的可治理记忆
- **小而美** —— 如无必要勿增实体；痛感驱动长大（见 [PRINCIPLE §5.11](./PRINCIPLE.zh.md)）

## 许可证

计划采用宽松开源许可（如 Apache-2.0）；正式代码落地时一并确认。
