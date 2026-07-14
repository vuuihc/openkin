# Kin 系统设计

[English](./SYSTEM_DESIGN.md)

**状态：** Draft v0.1 — 方向说明，不是 API 合同  
**依据：** [PRINCIPLE.zh.md](./PRINCIPLE.zh.md) · [English](./PRINCIPLE.md)  
**主张：** Your agent. Your memory. Any model.

探索性草稿与实现日记不放在本仓库。本文是**对外**架构快照：帮助判断 Kin 是否适合你，而不是内部工作备忘录。

---

## 1. 总览

```text
用户拥有的 Kin Core（local-first）
  ├── Identity + Memory + Policies   ← 连续主体
  ├── Runtime + Tools / Skills       ← 规划与执行
  ├── Provider Layer                 ← 可替换模型
  ├── Sync（可选、可替换）            ← 绝非中心
  └── Client Shells                  ← 桌面优先；其它稍后
```

**硬约束**（来自原则）：

| 约束 | 含义 |
|------|------|
| 用户拥有 | 官方账户非必须；可导出 / 删除 / 自托管 |
| Local-first | 设备是主本；云仅在明确启用时出现 |
| 模型无关 | Provider 特性不拥有身份与记忆 |
| 权限渐进 | 外部影响需可授权、可审计 |
| 默认做小 | 可选层是以后的事，不是 v1 实体（[§5.11](./PRINCIPLE.zh.md)） |

---

## 2. 先交付什么（MVP 主题）

不是完整数字分身——先做一台机器上愿意每天用的个人 Agent。

**早期范围内**

- 共用 **Kin Core** + 稳定**桌面**客户端（CLI 与 Core 共用时再加强）
- 多 Provider 流式对话（常见 API 形态 + 本地路径）
- 可治理记忆：建议 / 确认 / 查看 / 删除——不是静默黑箱
- 带确认的工具调用 + 可读的 **Review** 轨迹
- 开放工具接入（如 MCP 兼容），但不把架构绑死在单一外部协议
- 导入导出；不登录官方账户也能用核心能力

**明确后置**

- 完整多设备同步产品
- 作为完整第二客户端的移动端
- 长期 Routine、自动路由中台、用户侧多 Agent 阵容
- 自研组网 / 远程编排作为产品中心

优先级对齐原则 §12：对话、Provider、记忆、工具、确认、审计 **先于** 跨端叙事。

---

## 3. 核心概念（逻辑模型）

存储实现可变；**语义**应尽量稳定。

| 概念 | 作用 |
|------|------|
| **Identity / Profile** | 结构化的「Kin 是谁、如何行事」——不是巨型不可维护 prompt |
| **Session / Message** | 对话历史；可选模型 / 成本元数据 |
| **Memory** | 带类型、来源、置信度、确认态的可治理条目；推断 ≠ 用户事实 |
| **Task / Step** | 目标、计划、可暂停继续的执行状态 |
| **Tool 调用 + Audit** | 做了什么、在何种授权下、必要时脱敏 I/O |
| **Provider 配置** | 端点与能力；密钥在系统密钥体系，不进日志 |
| **Permission grant** | 一次 / 会话 / 有时限范围——最小权限 |
| **Export bundle** | 可版本化的带走包（**不含**密钥） |

用户应感知的记忆路径：**保存 · 建议 · 确认/拒绝 · 编辑/删除**。

权限阶梯（产品语言）：观察 → 准备 → 确认后执行 → 范围内委托 → 用户定义的例程。

外部 coding CLI / harness 若使用，只作为 **Tool**——不是第二套 Kin 身份或 Runtime。

---

## 4. 组件（稳定命名）

| 组件 | 职责 |
|------|------|
| Identity | 偏好、边界、跨模型/设备一致性 |
| Memory | 可治理记忆的全生命周期（含冲突与导出） |
| Runtime | 上下文、模型循环、工具、确认闸门、轨迹 |
| Providers | 可插拔生成 / 流式 / tool-calling 后端 |
| Tools / Skills | 原子能力与可复用方法；风险与权限元数据 |
| Trust & Audit | 授权、确认、凭据、出站感知 |
| Sync | 可选、可替换；核心使用不依赖 |
| Client shell | 桌面（及其后）：同一个 Kin，保留平台原生能力 |

---

## 5. 对外路线图主题

只谈主题，不排日历。细节会变；价值顺序不应乱。

1. **Talk** — 扎实的本机对话、多 Provider  
2. **Remember** — Profile + 可确认记忆  
3. **Act** — 工具、确认、审计 / Review  
4. **Leave** — 导入导出与清晰的删除说明  
5. **Live in it** — 打磨到维护者自己用它做真事  

跨端阶段保持高层（原则 §13）：桌面/CLI → 伴随客户端 → 单机足够好之后再谈更深的多设备。

---

## 6. 开放开发

公开边界与邀请节奏：[docs/OPEN_DEVELOPMENT.md](./docs/OPEN_DEVELOPMENT.md)。

有代码后的开源核心承诺：Runtime、Provider、本地记忆、权限与审计、Tool SDK、基础客户端、导入导出、本地模式——**不**强迫绑定厂商云。

---

## 7. 摘要

Kin 是 **local-first 的个人 Agent 核心**：身份与记忆跨模型延续；工具仅在可感知的授权下行动；复杂度由真实使用驱动，而非完整性焦虑。

> Kin should grow with the user, without owning the user.
