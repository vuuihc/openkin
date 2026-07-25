# OpenKin

[English](./README.md)

> **OpenKin** — 本地优先的多 Agent 控制台与个人教练。  
> 命令行：`kin`（别名：`ok`）

```text
一个控制台，管理你所有的 coding agent。Self-hosted，任意设备。
Your agent. Your memory. Any model.
```

在手机或任何设备上派发、监控、批准 agent 任务——Claude Code、Codex、任意 CLI——流量只走你自己的网络。没有厂商中继，不需要 OpenKin 账户。并将生长为记忆归你所有的 local-first 个人 Agent（**Kin**）。

**命名约定**

| 层级 | 名称 | 说明 |
|------|------|------|
| 项目 / 品牌 | **OpenKin** | 对外可检索的开源名 |
| 产品主体 | **Kin** | 你拥有的、连续存在的本地 Agent |
| CLI | `kin` | 可选别名：`ok` |
| 数据目录（现状） | `~/.kin` | 兼容暂不改动 |

> **不是** [Kin / mykin.ai](https://mykin.ai)（面向 iOS/Android 的商业 Personal AI 陪伴应用）。OpenKin 是独立的开源项目。

## 文档

| 文档 | 内容 |
|------|------|
| [PRINCIPLE.zh.md](./PRINCIPLE.zh.md) · [English](./PRINCIPLE.md) | 产品纲领与不可妥协原则 |
| [SYSTEM_DESIGN.zh.md](./SYSTEM_DESIGN.zh.md) · [English](./SYSTEM_DESIGN.md) | 对外架构快照（Draft，不是 API 合同） |
| [OPEN_DEVELOPMENT.md](./docs/OPEN_DEVELOPMENT.md) | 公开边界与节奏（英文主文档） |

## 状态

MVP agent 控制台（daemon + web UI）已实现。macOS 菜单栏 **桌面壳** 在 `desktop/`（Electron）。公开文档描述**方向**；实现细节见 [docs/IMPL_NOTES.md](./docs/IMPL_NOTES.md)。

## 一句话特性

- **跨 agent 控制台** —— 一处派发 / 监控 / 批准 Claude Code、Codex 或任意 CLI agent
- **Self-hosted 远程** —— 局域网 → tailnet / Funnel 梯子；流量不经过任何 agent 厂商的云
- **费用透明** —— 按任务、按 Provider 的 token 与花费
- **用户拥有** —— 本地优先；无需 OpenKin 账户；可导出、可离开
- **产物随后（Artifacts）** —— 会话学习资料 / 长文入库与阅读器；见 [docs/TODO.md](./docs/TODO.md)
- **记忆更后（v2）** —— 跨 agent、跨模型延续的可治理记忆
- **小而美** —— 如无必要勿增实体；痛感驱动长大（见 [PRINCIPLE §5.11](./PRINCIPLE.zh.md)）

## 桌面应用

macOS 菜单栏壳（darwin-arm64）。以 sidecar 方式托管本地 `kin` daemon，在 BrowserWindow 中嵌入 web 控制台，并用系统通知呈现确认请求。

```bash
# 开发：构建 ./kin，启动 Electron（使用仓库根目录二进制）
make desktop-dev

# 打包未签名 .dmg 到 desktop/dist-electron/
make desktop-dist
```

**未签名构建：** 安装 `.dmg` 后，macOS Gatekeeper 可能拦截。请首次右键 App → **打开**（或移除隔离：`xattr -cr /Applications/Kin.app`）。代码签名尚未配置。

架构与决策见 [docs/IMPL_NOTES.md](./docs/IMPL_NOTES.md) § Desktop shell。

## 许可证

计划采用宽松开源许可（如 Apache-2.0）；正式代码落地时一并确认。
