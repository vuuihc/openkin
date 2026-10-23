# 托管模式：进展与下一步

> 目标：**本地优先 + 可选托管执行**。托管侧用自己的 NAS 当服务器、自己的域名做入口，
> 用户注册后多端登录即同步。对标 Codex / lody 的多端体验。
>
> 相关：`2026-10-23-docs-audit.md`（文档取舍）、`docs/adr/0026-operator-authority-role.md`。

## 已完成

### 1. operator 权限从"登录状态"改成"角色"（`0987367`）

`operatorOnly` 原来放行任何已登录账户，正确的**唯一原因**是 Hub 首个 claim 后关闭注册、
世界上只有一个账户。ADR 0023 当初就把这个前提写下来了，也写明了它失效的条件。

现在 `users` 有 `role` 列：claim 写入 `owner`，其余 `member`；无法识别的值**一律降级 member**。

**真正的风险在写路径，不在读路径。** settings 的 GET 对非 master 调用者会清空 token、
掩码 provider key；但 `PUT /api/settings` 接受 `provider.base_url`、`provider.api_key`、
`relay.url`、`notify.bark_url`。一个 member 可以把 provider 指向自己的主机，
之后 daemon 就会把 owner 的 API key 和每一条 prompt 送过去。

> 修正记录：这个改动的第一版 ADR 与 commit message 声称"member 能读到 master token"。
> **那是错的**——token 是故意清空的。code review 抓到后已改正。

### 2. 同一假设还在另外三处（同一次提交修掉）

| 位置 | 问题 | 修法 |
|---|---|---|
| `handleDecision` / `handleAnswerUserQuestion` | **完全不读 principal**，任何登录账户都能批准 owner 任务的待批动作 | 新增 `taskActorOnly`：放行 master / owner / 配对设备，拒绝 member |
| `a2a` 的 `principalID`、MCP 的 auth context | 用 `DeviceID` 做身份，而会话 principal 没有 DeviceID → **所有账户塌成同一个字符串** | 新增 `remote.Principal.Identity()`：优先账户，退回设备 |
| `connectors.go` 调用归属 | 浏览器会话被记成 `"master"` | 会话记为 `user:<id>` |

配对设备**必须**保留审批权——手机上的审批收件箱是产品要求（PRINCIPLE §12 第 4 条），
而且设备凭据是 owner 主动登记的，不是自助注册的。

A2A 身份格式变了，但 `a2a_operations` / `a2a_idempotency` **都是 0 行**，无归属丢失。

## 未做（review 提出、我判断不该顺手改的）

**1. 没有任何东西按账户隔离。** `/api/tasks`、`/api/tasks/{id}/events`、`/api/sessions`、
`/api/agent-sessions*`、`/api/approvals`、`/api/artifacts`、`/api/routines`
**对任何已登录调用者返回全部内容**。schema 里 `tasks.owner_user_id` 和
`devices.owner_user_id` 存在但从未写入。

> **这是开放注册的真正门槛**：一旦第二个用户注册，他会看到第一个用户的全部任务。
> 新测试里那句 `member.get("/api/tasks") == 200` 等于默认承认了"所有账户共用一个任务列表"——
> 这应该是一个**明确的决定**，不是默认值。

**2. 控制台看不到 role**（`internal/api/auth.go:34` 的 `authUser` 没有 role 字段），
所以 member 会渲染出 operator 界面然后收一屏 403。

**3. `User.IsOwner()` 没有生产调用者**，守卫里是内联比较；测试断言它反而给人"helper 和守卫一致"的错觉。

**4. `normalizeRole` 的 trim 分支没有测试覆盖**（现有测试只覆盖空值）。

## 下一步

1. **离线写：本地发件箱**（已定）。断网时消息进本地队列、UI 立刻显示；重连按到达顺序发，
   Hub 照常分配 `seq`。会话是追加流不是协作文档，**不需要 CRDT**。
2. **任务按账户隔离**（上面第 1 条）。开放注册之前必须做。
3. **NAS 上线**：`--role hub --domain` + 注册 + 多端登录。
4. **配对降级为高级功能**：主流程是"一个账户登录、自动同步"，配对只用于"给设备有限权限"。

## 已知取舍

`role` 列加在基础 schema 里，**没有迁移步骤**。现存只有一个数据库（作者自己的，
0 个账户 / 157 个任务），且尚未 dogfood，所以旧库是"重建"而不是"升级"。
**这个取舍在出现真实数据时失效**——之后 schema 变更要恢复写迁移。
