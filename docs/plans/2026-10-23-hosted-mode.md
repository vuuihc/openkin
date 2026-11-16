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

### 3. 任务按账户隔离（`289a089`）

原来 `/api/tasks`、`/api/tasks/{id}/events`、`/api/sessions`、`/api/approvals`、`/api/artifacts`、
`/api/routines` **对任何已登录调用者返回全部内容**，`tasks.owner_user_id` 存在但从未写入。

规则只有一份：`store.ScopeForPrincipal`。放两个包各写一遍，就是两条会漂移的规则，
而这里漂移的代价是读到别人的任务。`TaskScope` **fail-closed**——零值谁都不匹配，
忘了设 scope 的 handler 返回空列表（有人会报 bug），而不是全部任务（没人会注意到）。

**谁算"持有这台机器"**：master token、claim 了 Hub 的账户、以及配对设备。设备之所以
unscoped，是因为配对本身是 operatorOnly——凭据由持有人签发，代表持有人行事。
（等成员能自己配对，这条要改，见下面第 5 条。）

| 层 | 改动 |
|---|---|
| store | `owner_user_id` 写入并读出；`ListTasks` / `ListApprovals` / `ListUserQuestions` 收 scope；删除前先读 owner 写进 tombstone |
| REST | `/api/tasks/{id}` 整棵子树受 `taskInScope` 保护，**404 而不是 403**——任务是否存在本身就是不该泄露的信息 |
| MCP | `toolReaches` 一张表声明每个工具够得着什么，在 `executeTool` 里统一执行；不是逐个 handler 判断 |
| 实时流 | WebSocket / SSE / `sessions/wait` 都按 scope 订阅；不隔离的话每条流都是列不出但推得动的通道 |
| 变更流 | 游标是"**我看得见的**最后一个变更"；因为 owner 写入后不再修改，这个条件稳定，所以游标不会漏 |
| 机器自身记录 | projects / routines / artifacts / agent-sessions / recent-cwds / uploads / usage / connectors / workers / agent-providers / agents-management / routing 全部归持有人：member 拒绝，**配对设备放行**（用 `operatorOnly` 会顺手打断远控） |
| 人闸 | 审批/回答改成"看行背后的任务归谁"，不再是角色判断，于是 member 能批自己的任务 |

老库在 open 时补齐：`ensureTaskScopeSchema` 加列和 `(owner, cursor)` 索引，
幂等且增量。**故意不写成编号迁移**——编号迁移只跑一次，会让以后每个测试 fixture
为了正确性重放整条链。三条出库路径（已是最新版 / 升级 / 全新安装）都会走一遍断言。

### 3a. 第一轮 review 后的修正

第二双眼睛找出四个真问题，都在同一次提交里修掉：

| 问题 | 症状 | 修法 |
|---|---|---|
| MCP 只有 `list_tasks` 带 scope | 另外 14 个按 id 取任务的工具照常通行——HTTP 面堵住、工具面绕过去 | `toolReaches` 表 + 一条测试：任何宣告的工具没登记就 fail |
| 删除把自己编号到游标下方 | 删掉"最新改动的那个任务"时，tombstone 落在该任务自己的序号上；**已经同步到那个号的客户端永远收不到删除** | `nextHubSeq` 移到 `DELETE` 之前——被删的行还在 MAX 里，tombstone 必然严格更大 |
| `PublishTaskDeleted` 查不到 owner | 行已经没了，resolver 返回空，于是"任务归谁"里唯一收不到删除通知的正是那个账号 | owner 从 `engine.Delete` 手里已有的行传进去，不查库 |
| 一台机器的描述性 GET 对 member 全开 | routing / connectors / workers / agent-providers / agents-management 谁都读得到 | 同一把 `holderOnly` 尺子 |

另外：A2A 建任务时补上 `owner_user_id`（否则它建的任务在 `/api/tasks` 里对
同一个账号不可见，两套答案打架）；`maybeInjectProjectContext` 改成**没有 principal
也拒绝**（原先是"有 principal 才检查"，漏判方向是别人的项目文档进你的 prompt）。

## 未做（review 提出、我判断不该顺手改的）

**1. 控制台看不到 role**（`internal/api/auth.go:34` 的 `authUser` 没有 role 字段），
所以 member 会渲染出 operator 界面然后收一屏 403。第 3 条把 connectors / workers /
routing 也收进持有人之后，**这个缺口比之前更明显**：以前他只是看到不该看的东西，
现在他会看到一屏报错。真要做 member 界面时，任务创建路径需要的
`GET /api/agents`（选 agent）是故意留开的，其余的要么按 member 重做，要么就别渲染。

**2. `User.IsOwner()` 没有生产调用者**，守卫里是内联比较；测试断言它反而给人"helper 和守卫一致"的错觉。

**3. `normalizeRole` 的 trim 分支没有测试覆盖**（现有测试只覆盖空值）。

**4. 没有注册入口。** 第二个账户目前只能通过 OIDC 或直接写库产生——`/api/auth` 只有
bootstrap / login / logout。托管模式的"注册后多端登录"还差这一环。

**5. 成员不能配对自己的设备。** 于是设备凭据只可能由 owner 签发，隔离里把
`PrincipalDevice` 当作 holder（unscoped）是成立的；等成员能自己配对时，
这条必须改成读登记账户的角色，`devices.owner_user_id` 已经准备好承载它。

**6. MCP scope 是自己声明的**（`X-Kin-MCP-Scopes: admin` 就拿到 admin）。
**没有改**，因为它现在买不到东西：admin 只解锁三个工具，`approve_task_action` /
`answer_task_question` 背后是"审批归哪个任务"，`resolve_idempotency` 只在自己
principal + client 的 key 空间里操作。真正的控制是 reach 检查，不是 scope 声明。
要让 scope 也变成硬边界的话，得按 principal 类型设上限，那时再说。

**7. member 选 `cwd` 就能读到持有人机器上的文件。** `POST /api/tasks` 只覆盖 owner、
不覆盖 `cwd`；随后 `GET /api/tasks/{id}/source/file` 的边界是任务自己的 `cwd`
（`validateScopePath`，`..` 已正确拦住），于是 member 把 `cwd` 指向持有人机器上任意
git 仓库，就能读那个仓库里的文件。**这不是越权漏洞而是威胁模型问题**：member 本来就能
让 agent 以 daemon 用户身份跑命令，读文件严格弱于那个。但它是**唯一一处 member 的触达
范围是"机器级"而不是"任务级"**的地方，托管模式对外开注册之前必须有个说法：
限制可选 `cwd`（白名单 / 只能选已有 project），或者明确接受它。

**8. A2A 的身份键改过（`a2a:<kind>:<Identity()>`），旧行不会自动改键。**
`IsA2ATaskOwner` 只从 `a2a_idempotency` / `a2a_operations` 的 `principal_id` 解析归属，
**不读 `tasks.owner_user_id`**。所以如果这两张表里有升级前写下的 `a2a:user:` 行，
升级后同一账户会收到 403，重试还会再建一个任务。**实测这两张表 0 行**（作者自己的库，
157 个任务、0 个 owner），所以此刻无影响；真出现那行数据时，要么折叠旧键，要么写迁移。

## 下一步

1. **离线写：本地发件箱**（已定）。断网时消息进本地队列、UI 立刻显示；重连按到达顺序发，
   Hub 照常分配 `seq`。会话是追加流不是协作文档，**不需要 CRDT**。
2. **NAS 上线**：`--role hub --domain` + 注册 + 多端登录。
3. **配对降级为高级功能**：主流程是"一个账户登录、自动同步"，配对只用于"给设备有限权限"。

## 已知取舍

`role` 列加在基础 schema 里，**没有迁移步骤**。现存只有一个数据库（作者自己的，
0 个账户 / 157 个任务），且尚未 dogfood，所以旧库是"重建"而不是"升级"。
**这个取舍在出现真实数据时失效**——之后 schema 变更要恢复写迁移。
