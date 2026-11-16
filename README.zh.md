# OpenKin

[English](./README.md)

> **OpenKin** — 自托管的多 Agent 控制台。  
> 命令行：`kin`（别名：`ok`）

```text
一个控制台，管理你所有的 coding agent。Self-hosted，任意设备。
Your agents. Your machines. Any device.
```

在手机或任何设备上派发、监控、批准 agent 任务——Claude Code、Codex、任意 CLI。可以在单机上独立运行，也可以在自己的服务器上跑一个 **Hub**，随处登录：同一批会话，没有厂商中继，不需要 OpenKin 账户。

**命名约定**

| 层级 | 名称 | 说明 |
|------|------|------|
| 项目 / 品牌 | **OpenKin** | 对外可检索的开源名 |
| 产品主体 | **Kin** | 你拥有的本地 Agent |
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
- **跟着你走** —— 在自己的服务器上跑 Hub，换设备登录即见同一批会话
- **费用透明** —— 按任务、按 Provider 的 token 与花费
- **用户拥有** —— 自托管；无需 OpenKin 账户；可导出、可离开
- **产物（Artifacts）** —— 会话学习资料 / 长文入库与阅读器；见 [docs/TODO.md](./docs/TODO.md)
- **小而美** —— 如无必要勿增实体；痛感驱动长大（见 [PRINCIPLE §5.11](./PRINCIPLE.zh.md)）

## 运行 Hub

Hub 是常驻的 daemon，会话存在它这里，所以每台设备登录后看到的是同一个工作区。

```bash
scripts/install-hub.sh --domain kin.example.com --email you@example.com
```

脚本会检查 Docker、写入 `.env`（不会覆盖已有文件）、启动整套服务（沿用当前运行中的
同一组 Compose 文件，因此 OAuth 覆盖文件不会在修复时被丢掉），最后只在 stdout
打印一条一次性登录链接。打开就登录，不需要从终端抄密码再输入。
链接 30 分钟内有效；重新运行脚本会生成新链接，并让上一条失效。

它要求 Docker + Compose v2、域名解析到这台机器、80 / 443 端口可达。首次运行会构建或
拉取镜像，需要几分钟。agent 可以用 `scripts/install-hub.sh --help` 读到完整约定。

手动部署仍然支持：

```bash
cp .env.example .env          # 把 KIN_DOMAIN 设成解析到本机的域名
docker compose up -d --build  # 80 / 443 端口要能到达这台机器
docker exec openkin-hub kin hub init --domain kin.example.com --email you@example.com
```

不带 `--email` 时，`kin hub init` 为还没有所有者的 Hub 打印认领链接；带上它就创建
所有者并打印登录链接。两种链接都把密钥放在 URL fragment 里，服务端日志看不到；
都只能使用一次：登录链接 30 分钟、认领链接 24 小时。未使用前请当作密码对待。
用这种方式创建的 owner 有一个没人知道的随机密码；打开链接即可登录，之后也可以用
`reset-password` 设置一个自己知道的密码（重置同时会让未使用的登录链接失效）。

默认用邮箱 + 密码登录。要加 GitHub / Google，先按 `.env.example` 里的说明创建两个
OAuth 应用，再叠加 OAuth 覆盖文件：

```bash
docker compose -f docker-compose.yml -f docker-compose.oauth.yml up -d
```

已经认领过的 Hub，先用密码登录一次，在**设置 → 账号**里绑定第三方账号；之后两种方式都能登录。

恢复命令也在容器里执行，不依赖 compose 文件名，也不依赖当前目录：

```bash
docker exec openkin-hub kin hub accounts
docker exec openkin-hub kin hub login-link --email you@example.com --domain kin.example.com
docker exec openkin-hub kin hub reset-password --email you@example.com
```

`login-link` 打印一次性登录链接，不改密码；`reset-password` 打印新密码，并让所有
已登录会话失效。

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

Apache-2.0 —— 见 [LICENSE](./LICENSE)。
