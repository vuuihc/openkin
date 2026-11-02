# Hub 登录体验：GitHub / Google OAuth 与密码恢复

基线：分支从 `main` 的 `03248d64` 起步，落地前 rebase 到当时的 `main`。本文记录
两件用户直接提出的问题：

1. `docker compose exec kin "kin hub reset-password --email …"` 在 NAS 上报
   `no configuration file provided: not found`；
2. 要在 NAS 上的 Hub 上提供 GitHub / Google 登录。

## 1. 实测到的根因

### 1.1 恢复命令：文件名不是 Compose 的默认名

NAS 上 `<hub-dir>` 实际运行的编排文件是
`docker-compose.dogfood.yml`（`name: openkin`、服务 `kin`、镜像
`openkin:dogfood`、`192.168.1.42:7777`）。Docker Compose 只自动发现
`compose.yaml` / `compose.yml` / `docker-compose.yaml` / `docker-compose.yml`，
所以：

- 不在该目录时，`docker compose exec` 直接报 `no configuration file provided`；
- 即使在该目录，plain `docker compose` 也不会选中 dogfood 文件（旧 checkout 里
  确实还留着一份 `docker-compose.yml`，但它描述的是另一套部署）。

另外，`docker compose exec kin "kin hub reset-password --email …"` 把整条命令
当成一个可执行文件名，即使 compose 文件找对了也只会得到
`executable file not found`。登录页上一版提示是「给命令加
`docker compose exec kin` 前缀」，仍然把正确性绑在 cwd 和文件名上。

**修法**：给容器一个固定名字 `openkin-hub`，恢复命令改成与 cwd、compose 文件
无关的形式：

```
docker exec openkin-hub kin hub reset-password --email you@example.com
```

登录页同时展示主机原生形式与容器形式，不再让运维自己拼前缀。

### 1.2 OAuth：Dex 的反向通道是 HTTPS 的，Dex 却是 HTTP 的

仓库里的 `docker-compose.github.yml` 设计是对的（Kin 只实现一种联邦协议
OIDC，GitHub 由 Dex 转接），但它从未在 NAS 上跑起来过：`docker ps` 里没有
dex 容器，NAS 的 `.env` 也只有 `KIN_DOMAIN` / `ACME_EMAIL`。

读代码还发现一处会立刻失败的地方。`internal/auth/oidc.go` 的
`backchannelClient` 只改 **dial 地址**，请求 URL 仍是
`https://<KIN_DOMAIN>/dex/...`：它会向 `dex:5556` 发 TLS 握手，而 Dex 的
`web.http` 在该端口上说的是明文 HTTP。结果是 discovery 与 token exchange
都失败。`TestBackchannelClientRedirectsOnlyTheIssuerHost` 用的是
`http://` issuer + HTTP 测试服务器，所以这条路径一直没被覆盖。

**修法**：反查通道在命中 issuer host 时同时改写 scheme 与 Host（`http` +
`dex:5556`，`Host` 保留公网域名，Dex 才能生成公网 URL）。测试改成
**HTTPS issuer → 明文 HTTP 后端**，旧代码会在 TLS 握手处红。

### 1.2a Dex 自己也要出网，而 NAS 上的容器不继承 Docker 代理

实测（本机 `dexidp/dex:v2.46.1-alpine` + 同一份配置）：

- `/dex/.well-known/openid-configuration` 返回 200，issuer 是公网
  `https://<KIN_DOMAIN>/dex`，授权页同时列出 GitHub 与 Google —— 路径前缀与
  多 connector 都成立。
- **Google connector 在 Dex 启动时就会做 discovery**；`accounts.google.com`
  不可达时 Dex 直接退出，整个 overlay 起不来。GitHub connector 不做启动期
  请求，但换 code 时仍要访问 `github.com`。
- NAS 宿主机没有直连 GitHub / Google（`curl` 5–10 秒超时）；Docker daemon 配了
  HTTP 代理（见 `.env` 里的 `KIN_OAUTH_PROXY`）但**只用于拉镜像**，容器运行时
  拿不到。该代理本身对 `github.com`、`accounts.google.com` 是通的（宿主机与
  容器内分别实测 200），所以给 `dex` 服务加 `HTTPS_PROXY` / `HTTP_PROXY` 透传
  即可。

**修法**：overlay 给 `dex` 读 `KIN_OAUTH_PROXY` / `KIN_OAUTH_NO_PROXY`，默认空
（直连）。真实代理地址只写进 NAS 的 `.env`（已 gitignore），仓库里只放
`192.168.1.10:7890` 这类占位符。

### 1.3 已认领的 Hub：OAuth 必须先「绑定」

`LoginIdentity` 对未知身份返回 `ErrRegistrationClosed`，`ClaimWithIdentity`
在非测试代码里没有调用者。因此 OAuth 只适用于：

1. 用密码认领 Hub；
2. 在「设置 → 账号」里绑定 GitHub / Google；
3. 以后直接用该身份登录。

但 `AccountSection` 既没有展示已绑定方式，也没有绑定按钮；`startOIDC` 只在
登录页被调用。也就是说，即使 Dex 配好了，用户也没有入口把身份绑上去。

**修法**：状态接口已经返回 `user.identities`，把它接进 store / 设置页，并为
已配置的 OIDC provider 提供绑定按钮（`startOIDC(provider, "/settings")`，
`handleOIDCStart` 在已有会话时本来就走绑定分支）。

评审时又发现两个连带问题：

- **Dex 的 `sub` 是按 connector 生成的**：GitHub 和 Google 即使同一个人，也会
  得到两个不同的 subject。绑定 GitHub 后如果隐藏绑定按钮，Google 就永远绑不上。
  因此按钮在已有身份后仍然保留，改成「再绑定一种登录方式」；状态接口对同一
  provider 的多个身份去重，避免重复 chip 和重复 React key。
- **未知身份用错了错误**：`LoginIdentity` 原来返回 `ErrRegistrationClosed`，
  登录页于是说「这台 Hub 已有所有者」。对「第三方登录还没绑定」的人来说，正确
  的下一步是先用密码登录再绑定，所以新增 `ErrIdentityNotLinked` 及
  `identity_not_linked` 文案。

同时把登录页的 OIDC 按钮限制为 **只在登录模式**出现：认领/加入流程里没有
claim code 参与 OIDC，点了只会得到假错误。

**绑定结果原先是静默的**：OIDC 回调把 `auth_notice=linked` /
`auth_error=…` 放在 URL 上，只有登录页读它；绑定回到 `/settings` 时没人消费，
失败和成功看起来一样。现在 `AccountSection` 读取并清理这些参数，用全局 toast
显示结果。

### 1.4 密码命令对 OIDC-only 账号说错话

`ResetPassword` 只查 `password` 身份，查不到就答
`no password account with that email`，并把账号列表打出来。对存在但没有密码
的账号，这句话既误导又让人以为打错了地址。

**修法**：查不到密码身份时，用邮箱在 `ListUsers` 里找一次；找到了就列出它的
登录方式并明确说「没有密码可重置」。`kin hub accounts` 也顺带列出每个账号的
登录方式（`sign-in: password, GitHub`）。

## 2. 改动清单

| 层 | 文件 | 改动 |
|---|---|---|
| 认证 | `internal/auth/oidc.go` | 反查通道改写 scheme + Host；校验 `BackchannelAddr` 形状；删除失效的 `hostOf`；更新 `BackchannelAddr` 说明 |
| 认证 | `internal/auth/service.go` | 未绑定身份改用 `ErrIdentityNotLinked`，与「Hub 已有所有者」分开 |
| 认证测试 | `internal/auth/oidc_test.go`、`service_test.go` | HTTPS issuer → HTTP 后端；断言路径与 Host；反查地址校验 |
| API | `internal/api/auth.go` | 新错误码 `identity_not_linked`；身份列表按 provider 去重 |
| CLI | `internal/server/hub.go` | `accounts` 列登录方式；reset 对 OIDC-only 账号给出可行动的说明 |
| CLI 测试 | `internal/server/hub_reset_test.go` | 两条新测试（见 §4） |
| 部署 | `docker-compose.oauth.yml`（由 `docker-compose.github.yml` 改名） | Dex + GitHub + Google 两个 connector；健康检查；代理透传；回滚说明 |
| 部署 | `docker-compose.yml` | `container_name: openkin-hub`；注释同步 |
| 部署 | `.env.example` | GitHub / Google OAuth App 的创建步骤与变量 |
| 控制台 | `ui/src/components/settings/AccountSection.tsx` | 展示登录方式；始终可再绑定；消费绑定结果（toast） |
| 控制台 | `ui/src/components/AccountScreen.tsx` | OIDC 只在登录模式出现；恢复/认领命令加容器形式 |
| 控制台 | `ui/src/components/settings/AccountSection.test.tsx` | 绑定、再绑定、成功/失败回调三条路径 |
| 控制台 | `ui/src/store/appStore.ts`、`ui/src/api/account.ts`、`ui/src/lib/accountGate.ts` | `identities` 贯通；新错误码 |
| 文案 | `ui/src/i18n/locales/{en,zh}.ts` | 新增键，双语同步 |
| 文档 | `README.md`、`README.zh.md` | Hub 部署与恢复命令、OAuth 开启方式 |

## 3. 部署形态

NAS 侧最终形态（占位符）：

```yaml
# <hub-dir>/.env
KIN_DOMAIN=kin.example.com
COMPOSE_FILE=docker-compose.dogfood.yml:docker-compose.oauth.yml
GITHUB_CLIENT_ID=…
GITHUB_CLIENT_SECRET=…
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
DEX_CLIENT_SECRET=…
KIN_OAUTH_PROXY=http://192.168.1.10:7890
```

`COMPOSE_FILE` 让该目录里的 plain `docker compose` 也选中正确的文件。**仓库里的
`container_name` 只覆盖仓库自带的 `docker-compose.yml`；NAS 用的是自己那份
`docker-compose.dogfood.yml`，必须同样加上 `container_name: openkin-hub`**，否则
恢复命令仍会找不到容器。Cloudflare Tunnel 仍然只指向 `:7777`；Dex 不单独发布，
`https://<KIN_DOMAIN>/dex` 由 Hub 自己的 federation proxy 转发到 `dex:5556`。

**凭据不在仓库里。** GitHub OAuth App 与 Google OAuth Client 必须在用户自己的
控制台创建，回调地址都是 `https://<KIN_DOMAIN>/dex/callback`。

`COMPOSE_FILE` 只在四个 client 值都填好后才能加：overlay 用 `:?` 强制要求它们，
缺值时整个 `docker compose up` 会失败，连密码登录一起停掉。没有凭据时 Hub 保持
密码登录，两者互不影响。

Dex 在启动时会对 Google 做 discovery。若 NAS 不能出网，Dex 退出，Kin 的 OIDC
discovery 也随之失败，Hub 整体不服务。回滚是不带 overlay 启动同一份 base 文件：

```bash
docker compose -f docker-compose.dogfood.yml up -d
```

NAS 侧已经实测：宿主机和容器内通过 `KIN_OAUTH_PROXY` 访问 `github.com` 与
`accounts.google.com` 都返回 200。

## 4. 验收

- `go test ./internal/auth ./internal/server ./internal/api`
- `cd ui && npm run build && npm test`
- 红验证：把 `backchannelTransport` 的 scheme 改写删掉，新测试必须红在 TLS 握手；
  把绑定按钮删掉，DOM 测试必须红；把 `AccountSection` 的 toast 消费删掉，成功/
  失败两条回调测试必须红；把 `LoginIdentity` 改回 `ErrRegistrationClosed`，
  `identity_not_linked` 的 Go 测试必须红。
- NAS：容器 healthy；`https://<KIN_DOMAIN>/` 返回新资产哈希；
  `docker exec openkin-hub kin hub accounts` 列出登录方式；
  `docker exec openkin-hub kin hub reset-password --email <地址>` 能打印新密码。
- 有凭据后：`/dex/.well-known/openid-configuration` 返回 issuer
  `https://<KIN_DOMAIN>/dex`；登录页出现「Continue with GitHub / Google」；
  设置页可绑定；退出后能用该 provider 登录；未绑定的 provider 登录时得到
  「这个登录方式还没有绑定」而不是「Hub 已有所有者」。

## 5. 落地记录

### 5.1 提交

从 `03248d64` 起步，rebase 到 `c8b9f424`（172 个提交，无冲突），最终 6 个提交：

| 提交 | 内容 |
|---|---|
| `112c04cd` fix(auth) | 反查通道同时改写 scheme 与 Host；`BackchannelAddr` 形状校验 |
| `c3f5bf5c` feat(auth) | `ErrIdentityNotLinked` 与 `identity_not_linked` |
| `dc9fb9ea` feat(hub) | `kin hub accounts` 列登录方式；reset 解释无密码账号 |
| `8b7edbe1` feat(ui) | 设置页登录方式与绑定；回调结果 toast；登录页 OIDC 仅登录模式 |
| `58a9ed20` feat(deploy) | Dex overlay 改名并加 Google；`container_name`；代理透传；回滚说明 |
| `3b206c1d` build(web) | 重建内嵌控制台（`index-DBjMpQMQ.js`） |

rebase 后 `main` 的 `ui/package-lock.json` 有变化，重新 `npm ci` 后再构建与测试。

### 5.2 评审

同一 Opus 评审代理，三轮，审查全量 diff 与调用点：

- 第一轮：无 blocker；5 条 major——绑定结果静默、绑定一个 connector 后另一个
  无法绑、未绑定身份报错文案错、Dex 起不来会拖垮整个 Hub、NAS 的 compose 没有
  `container_name`。
- 修复后第二轮：无 blocker；唯一新 major 是 `web/dist` 仍是旧构建，源码修复未进
  产物。
- 重建后第三轮：确认产物 `index-DBjMpQMQ.js` 含新文案、`web/dist/assets` 未入库、
  分支无阻塞项。

未采纳（附理由）：解绑入口（后端没有解绑接口，本次不扩 API）；重复绑定同一
connector 仍提示「已绑定」（幂等，提示略乐观）；connector 级标签（Dex 只暴露一个
provider，「GitHub / Google」是准确的名字）。

### 5.3 检查

- `go test ./... -count=1`（rebase 后）：除两个**本分支未触碰**的包的计时 flake 外
  全绿——`internal/adapter/droid`（事件等待超时）与 `internal/github`（2 秒宽限
  实际 5.7 秒）；两包单独重跑均通过，rebase 前也出现过，属既有负载敏感测试。
- `go test ./internal/auth ./internal/api ./internal/server ./internal/hub -count=1`：
  全绿。
- `go vet ./...`：干净。
- `npx tsc --noEmit`：干净；`npx vitest run`：173 个文件 / 1709 条用例全绿。
- `npm run build`：入口 `assets/index-DBjMpQMQ.js`；bundle 已确认含
  `Link another sign-in`、`Sign-in method linked.`、`identity_not_linked`。
- `docker compose -f docker-compose.yml -f docker-compose.oauth.yml config`：解析
  通过。
- 红验证：反查通道 scheme 改写、`ErrIdentityNotLinked`、绑定结果 toast、始终可再
  绑定、登录模式门控、形状校验（空 host / 非数字端口）逐项改坏后对应用例失败，
  恢复后通过。

### 5.4 部署

- 镜像在本机用 `docker buildx build --platform linux/amd64 --load` 构建，
  `openkin:dogfood` = `39be99f837ab`（66.7 MB）；NAS 上原运行镜像保留为
  `openkin:dogfood-prev`（`105e88ae8594`）作回滚。`docker save | ssh docker load`
  传输。
- NAS 的 `docker-compose.dogfood.yml` 加上 `container_name: openkin-hub`（原文件
  备份为 `.bak`），`docker compose -f docker-compose.dogfood.yml up -d` 重建容器；
  状态 `Up (healthy)`。
- 公网 `https://<KIN_DOMAIN>/` 返回 `assets/index-DBjMpQMQ.js`，与本次提交的
  `web/dist/index.html` 一致。
- `docker exec openkin-hub kin hub accounts` 输出
  `owner  <address>  sign-in: password`；同一形式跑
  `reset-password --email nobody@example.com` 走到「列账号 + 报错」路径，不再依赖
  compose 文件名或 cwd。**没有**对真实账号执行重置——那会改掉现有密码；无密码账号
  的专门提示由单测覆盖。
- 最终版 `docker-compose.oauth.yml` 已同步到 NAS，但当时**没有叠加**：`.env` 里
  仍缺 GitHub / Google 的 client 值。

### 5.4a 凭据与 overlay 落地（2026-11-02）

- GitHub 侧使用一个已有的 GitHub App（占位名 `<github-app>`），回调地址
  `https://<KIN_DOMAIN>/dex/callback`；Account permissions 里
  **Email addresses 设为 Read-only**，因为 Dex 的 GitHub connector 用
  `/user/emails` 取主邮箱，GitHub App 也不接受 `user:email` scope。
  App 的私钥（`.pem`）Dex 不使用——它只用于以 App 身份签发 JWT——必须只留在
  本机，不能提交或外发。
- Google 侧是 Web application 类型的 OAuth Client：JavaScript origin
  `https://<KIN_DOMAIN>`，redirect `https://<KIN_DOMAIN>/dex/callback`。
- 四个 client 值与 `DEX_CLIENT_SECRET` 已写入 NAS 的 `.env`（gitignored，
  `chmod 600`）；仓库与本文只保留占位符。写入前的校验方式：用 GitHub token
  端点提交一个假 code，返回 `bad_verification_code` 说明 client 凭据有效
  （`incorrect_client_credentials` 才是凭据错）。
- `docker compose -f docker-compose.dogfood.yml -f docker-compose.oauth.yml up -d`
  之后 `openkin-dex-1` 与 `openkin-hub` 均 `Up (healthy)`。首次启动时 Kin 的
  discovery 早于 Dex 就绪，Hub 连续重启 5 次后自愈；`restart: unless-stopped`
  承担了这个等待，不需要手工干预。
- 公网验证：`/dex/.well-known/openid-configuration` 的 issuer 是
  `https://<KIN_DOMAIN>/dex`；`/api/auth/status` 的 providers 含
  `GitHub / Google`；登录页出现「使用 GitHub / Google 继续」，Dex 选择页同时
  列出 GitHub 与 Google；GitHub 授权跳转携带正确的
  `redirect_uri=…/dex/callback` 与 `scope=user:email`。
- 控制台行为：GitHub App 与 Google 的 client secret 都只在创建时显示一次，
  之后只能轮换不能查看。轮换顺序是「先生成新的、再删旧的」，因为两家都不允许
  删除最后一个 secret。

### 5.5 遗留风险

- **身份尚未绑定**：Hub 已有 owner，OAuth 只对已绑定身份生效。需要先用密码
  登录，在「设置 → 账号」里绑定 GitHub 与 Google，之后才能用它们登录；未绑定时
  会得到「这个登录方式还没有绑定」。首次真实登录仍需人工各走一遍。
- GitHub App 当 OAuth client 的验证目前只到授权页：完整链路要求
  Email addresses 权限已保存（§5.4a），以及 App 未被用户撤销授权。
- Dex 启动失败会让整个 Hub 不可用（已文档化回滚）。
- 无解绑入口；重复绑定提示偏乐观。
- 全量测试的计时 flake（见 §5.3）。
