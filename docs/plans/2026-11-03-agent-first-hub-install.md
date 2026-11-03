# Agent 时代的 Hub 安装与登录

触发点：Hub 的安装与恢复仍然要求人执行 `docker exec`、从日志里抄认领码、把打印的
密码手输到手机。这是把「运维」当成了用户。agent 已经能读仓库、跑命令、检查健康状态，
它应该一次完成安装，最后只交给用户一条链接。

本文记录这一版的实现边界与验收。OAuth、Dex 与密码重置的背景见
`2026-10-31-hub-oauth-and-recovery.md`；本文不重复。

## 1. 原则

- **人是浏览器的用户，agent 是主机面的用户。** 人不应该看到 shell 命令；agent 不应
  该要求人复述一次性代码。Web UI 只保留「让 agent 给你一条链接」的说明。
- **一条链接完成一件事。** 认领、首次登录、找回登录都产出同一种短时、一次性 URL。
  打开即得到会话，不经过「打印密码 → 手输」。
- **秘密不进入日志与访问记录。** 登录令牌放在 URL fragment（`#login=…`），浏览器
  不会把它发给服务器；聊天工具的链接预览、代理访问日志、`Referer` 都看不到它。
  服务端只存 SHA-256，令牌本身只在打印它的那一瞬间存在。
- **生成新链接 = 旧链接失效。** 链接会留在聊天记录和终端回滚里；「再给我一条」必须
  意味着上一条已经不能用了。失效按账号隔离，不影响其他人的链接。
- **安装脚本是幂等的。** 重复运行启动同一个 Hub，并换一条新链接；不覆盖已有 `.env`，
  不改变已配置的域名，不碰 OAuth 凭据。

## 2. 协议与数据

### 2.1 `login_tokens`

```sql
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
```

与 `auth_sessions` 分开，而不是给会话加一个「一次性」标志：会话是浏览器长期持有的
凭据，登录链接是交给聊天/终端、只花一次的凭据；合成一张表会让其中一种语义被另一种
污染。与 `bootstrap_tokens` 分开的理由同 `invite_tokens`：bootstrap 表回答「这个
Hub 还需要被认领吗」，登录链接不参与那个判断。

写入时在同一个事务里先 `UPDATE … SET used_at = now WHERE user_id = ? AND used_at IS NULL`，
再插入新行。消费时先读 `expires_at/used_at`，再用条件 `UPDATE … WHERE used_at IS NULL`
确保并发下只有一个调用者成功；两种检查同时保留，理由与 `ConsumeInviteToken` 相同。

### 2.2 生命周期

- 默认 TTL 30 分钟（`DefaultLoginLinkTTL`）。比邀请码短得多：链接走的是聊天窗口和
  终端回滚，不是等人的邮箱。
- `ConsumeLoginLink` 先把令牌小写化再哈希——它是十六进制，聊天客户端或人手重输改变
  大小写是唯一合理的格式噪声。
- 未知、过期、已使用、账号被禁用统一返回 `ErrLoginLinkUnavailable`，HTTP 侧统一
  `login_link_invalid`。未认证接口不能用来探测账号状态。

### 2.3 HTTP

`POST /api/auth/login-link`，body `{"token":"…"}`。与密码登录共用尝试限流器；成功
时设置与密码登录完全相同的 HttpOnly 会话 cookie。令牌不放在 query 上，避免进入
服务端访问日志。

## 3. 命令面

```
kin hub init [--email EMAIL] [--domain HOST] [--name NAME] [--print-url]
kin hub login-link --email EMAIL [--domain HOST] [--print-url]
kin hub claim-code [--domain HOST] [--print-url]
```

`init` 是 agent 唯一需要知道的命令，它按 Hub 状态回答：

| 状态 | 参数 | 结果 |
|---|---|---|
| 未认领 | 无 `--email` | 打印认领链接 `https://HOST/#claim=CODE` |
| 未认领 | 有 `--email` | 创建 owner（随机密码，不打印），打印登录链接 |
| 已认领 | 有 `--email` | 解析该地址的账号，打印登录链接 |
| 已认领 | 无 `--email` | 打印 `https://HOST/`，提示需要 `--email` 才能发链接 |

`--print-url` 只输出一行 URL，供脚本捕获；人类模式输出同样的链接加一段说明。
`--domain` 缺省时读 `KIN_DOMAIN`（容器环境里已经由 compose 注入）。

地址解析优先查 `password` 身份（它的 subject 就是规范化邮箱），找不到再按
`users.email` 找一次，这是让只绑定了 GitHub / Google 的账号也能拿到链接的关键。
`users.email` 不唯一，命中多个时拒绝而不是猜——猜错就是把一个人登进另一个人的账号。

## 4. 安装脚本

`scripts/install-hub.sh --domain HOST [--email ADDRESS] [--dir DIR] [--service NAME]`

1. 检查 `docker`、`docker compose`、daemon 可达；
2. 解析域名：`--domain` 优先，其次 shell 里的 `KIN_DOMAIN`，再其次已有 `.env`，
   TTY 下才提示输入。`.env` 的解析交给 `docker compose config --environment`，
   因此行内注释、引号、`${VAR}` 插值、以及「shell 覆盖 .env」这些 Compose 规则
   与真正启动时完全一致；两者指向不同域名时拒绝，而不是替用户改指向；
3. 没有 `.env` 就写一份（`umask 077`），有就只补缺失的键，保留 OAuth 凭据；追加前
   先补末尾换行，避免把新键接到没有结尾换行的最后一行上（会改坏 OAuth secret）；
4. 若当前在跑的 Hub 是由 `-f base -f overlay` 这类显式文件列表启动的，从容器上的
   `com.docker.compose.project.config_files` 标签读回同一组文件再执行 Compose——
   否则 OAuth overlay 会在 `up` 时被丢掉，provider 配置消失、Dex 变成孤儿；
5. 定义 `build:` 的 checkout 走 `up --build`，不先 pull：否则同名的发布镜像会盖住
   用户刚 clone 的源码；只声明 `image:` 的部署才 pull 发布镜像。判断前先把
   `compose config` 的完整输出收进变量再匹配，避免 `grep -q` 提前关管道、`pipefail`
   把大配置误判成「没有 build」；
6. `docker compose up -d`（其自身输出也走 stderr）；
7. 轮询容器健康状态（默认 300 秒）；没有 healthcheck 的手工部署则以
   `compose exec kin kin health`（容器内请求 `/api/health`）成功为准；两种路径在
   发链接前都会再跑一次 `kin health`，容器活着但 daemon 不答时失败并打印最近
   60 行日志；
8. `docker compose exec -T SERVICE kin hub init --domain … [--email …] --print-url`；
9. **stdout 只有那一行 URL**，其余进度全部走 stderr，agent 可直接捕获；登录链接说明
   30 分钟、认领链接说明 24 小时，不再混用。

`COMPOSE_FILE` 写在 `.env` 里的既有部署也能用：预检在没有默认 Compose 文件时接受
`.env` 指定了 `COMPOSE_FILE` 的目录；`compose.yaml` / `compose.yml` /
`docker-compose.yaml` / `docker-compose.yml` 四种默认文件名都接受。

它不做的事：安装 Docker、配置反向代理、创建 GitHub / Google OAuth 应用。这些需要
sudo 或第三方控制台里的决定，应该由人和 agent 明确完成，而不是脚本猜。

## 5. 控制台

- `#claim=CODE`（旧版打印的 `?claim=CODE` 仍接受）预填认领码；认领页在已预填时
  不再显示「去哪里找认领码」，只说明「码已从链接填入」，随后从地址栏清掉 fragment，
  query 形式的旧码同样在读入表单后清掉。认领码是未认领 Hub 的全部所有权证明，和
  登录令牌一样不该进入服务端日志、代理、链接预览或 Referer。
- `#login=TOKEN` 在首次渲染前兑换：清掉 fragment、POST、重新读账号状态，然后直接
  进入已登录界面。失败时把 `auth_error_code` 写回 query，复用登录页已有的错误展示；
  若访客其实已有 device token 或 Hub 会话，账号页不会出现，这组参数随即从地址栏
  移除，避免下次加载时冒出一条陈旧错误。
- 登录页与认领页删除全部 shell 命令块，改为「让安装/管理这个 Hub 的 agent 给你一条
  链接」。CLI 是 agent/运维面，Web 是人的面。
- 已登录访客的地址栏会清掉 `invite`、query 里的 `claim` 与 fragment 里的 `claim`；
  有 device token 的访客不经过账号门，同样会清理。三者都是仍然有效的凭据。

## 6. Agent runbook

安装（在一台有 Docker 的机器上）：

```bash
git clone <repo> openkin && cd openkin
scripts/install-hub.sh --domain kin.example.com --email owner@example.com
```

把 stdout 的那条 URL 原样交给用户：登录链接只能打开一次、30 分钟内有效；认领链接
只能打开一次、24 小时内有效。不要转述域名、不要替用户打开（agent 打开会花掉链接）、
不要把 URL 写进仓库或日志。

恢复登录：

```bash
docker exec openkin-hub kin hub login-link --email owner@example.com --domain kin.example.com --print-url
```

排查顺序：

1. `docker compose ps`：容器是否 healthy；
2. `docker compose logs --tail=100 kin`：证书、端口、DNS；
3. `docker exec openkin-hub kin hub accounts`：地址是否存在；
4. 仍然不行：`kin hub reset-password --email …` 生成一个已知密码，作为链接之外的退路。
   reset 会同时结束所有会话并使该账号未使用的登录链接全部失效——重置正是因为怀疑
   凭据泄露才做的，留下一条还能用的链接等于没关后门。

## 7. 验收

- `go test ./internal/auth ./internal/api ./internal/server ./internal/store`
- `cd ui && npx tsc --noEmit && npx vitest run`
- `bash -n scripts/install-hub.sh && ./scripts/install-hub.test.sh`
  （假 docker：首次安装、`.env` 插值/行内注释、OAuth overlay 保留、shell 覆盖拒绝、
  两种链接的 TTL 文案、缺失域名拒绝、stdout 只有一行 URL）
- 红验证：`./scripts/mutants.py docs/plans/2026-11-03-agent-first-hub-install.mutants.json`
  对本计划的 30 个变异逐个变红（链接过期、两个单次使用守卫、旧链接失效、重置使链接
  失效、大小写、fragment 位置、认领 fragment、认领预填、令牌长度、地址栏清理、
  认领帮助文案、旧式 query 认领码清理、死链错误参数清理、已登录访客的门状态复位、
  人类模式前端地址、安装脚本的 `.env` 解析/追加换行/overlay 保留/构建选择（含大
  配置下的管道提前关闭）/无 healthcheck 探测/发链接前的就绪门/空域名拒绝/超时值
  校验、`kin health` 的非 200 判定）。
- 本机真浏览器（Hub 角色 + 临时状态目录）：`hub init --email` 打印的链接打开后落在
  `/new`，fragment 被清空，`/api/auth/status` 为已登录；退出后用同一链接重开，落到
  登录页并显示「这条登录链接无效或已过期」；无 `--email` 的认领链接预填认领码，
  填表提交后直接进入控制台，`#claim=` fragment 在读取后即被清掉。
- 安装脚本：`scripts/install-hub.test.sh` 已入库并由 `scripts/check.sh` 执行，用假
  `docker` 覆盖首次写入 `.env`（600）、重复运行保留 OAuth 键与 overlay、拒绝改域名、
  stdout 只有一行 URL、认领/登录两种提示与各自的 TTL。
- 真机端到端（未做，见 §8）：在 NAS 上跑一次脚本，stdout 得到的链接在浏览器里打开后
  直接进入已登录界面；同一链接第二次打开落到登录页并显示「登录链接无效或已过期」。

## 8. 部署记录（2026-11-03）

- 镜像在本机用 `docker buildx build --platform linux/amd64 --load` 构建；NAS 上原镜像
  保留为 `openkin:dogfood-prev`，`docker save | ssh docker load` 传输后用
  `docker compose -f docker-compose.dogfood.yml -f docker-compose.oauth.yml up -d`
  重建。openkin-hub 与 openkin-dex-1 均为 `Up (healthy)`，容器内 `kin health` 通过。
- 公网首页返回 `assets/index-DXS-1lQZ.js`，与本次提交的 `web/dist/index.html` 一致；
  `POST /api/auth/login-link` 用一个不存在的 64 位十六进制令牌请求返回 401，说明路由
  已上线且没有签发任何真实链接（真实令牌不打印、不外传）。
- 本机 desktop 重建：`scripts/desktop-rebuild.sh` 构建 UI 与 `kin`、刷新
  `~/.kin/node/kin` 并重启本地节点；`:7777` 首页同样返回 `index-DXS-1lQZ.js`，
  Electron 已连上 `ws://127.0.0.1:7777/api/ws`。
- **未做**：没有在 NAS 上端到端跑 `scripts/install-hub.sh`——那会重建现有 Hub，而本轮
  只做镜像替换。脚本行为由假 Docker 契约测试覆盖，真实 Compose 上的首次安装仍应在
  一台干净机器上验证一次。

## 9. 遗留风险

- 链接一经发出就等价于密码；在过期前被转发给第三方，第三方也能登录。TTL 与一次性
  是仅有的约束。
- `kin hub init --email` 创建的 owner 有一个随机密码，没有人知道。这是有意的（链接
  是唯一入口），但用户若想改用密码登录，必须显式跑一次 `reset-password`。
- 安装脚本要求仓库或部署目录已在机器上；它不会自动 clone。agent 可以先 clone。
- 从容器标签读回 Compose 文件列表依赖路径仍然存在；目录被移动时脚本回退到默认
  Compose 解析并打印警告，此时需要人工确认 overlay 是否还在。
- 域名变更仍要人工编辑 `.env`：脚本拒绝改指向，这是保护而不是缺陷。
- 控制台的人类文案假设「有一个 agent」。没有 agent 的纯手工运维仍可用 CLI，但 Web
  不再教他们命令。
