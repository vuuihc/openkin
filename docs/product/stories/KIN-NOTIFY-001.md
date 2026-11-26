# KIN-NOTIFY-001 · 离开时被叫回来

状态：approved
优先级：P0
旅程：J7
归属面：`IA.md`「通知（KIN-NOTIFY-001）」（`docs/product/IA.md:62`；控制台没有通知设置面，R0b-3 2026-11-11）
面：Mac、手机

## 谁、什么时候、为什么

当我合上 Mac、只带着 iPhone，或者把 Kin 收进菜单栏去开别的会时，我想在批准、提问、跑完、额度变化的那一刻被手上这台设备叫住，点一下就落到那一条，以便不用每隔几分钟回来找一遍，也不让一个等我批准的 agent 空等。

"被叫回来"就是：离开控制台以后，**原生通知把我带回那一条**。不是发一条叫"继续"的消息，也不是打开收件箱让我自己找。

## 现在

Mac：桌面壳自己听 WebSocket，只对批准和任务终态弹 macOS 通知；提问、额度、例行报告、worker 离线没有原生通知。设置页的"通知"只有 Bark / ntfy、UI base URL、额度阈值和"浏览器推送"；在桌面壳里 `pushSupported()` 为假，所以那一块显示"这个浏览器不能接收推送"。

iPhone：`mobile/` 是 Capacitor 壳，加载 Hub 自己的控制台；没有推送 entitlement，没有 APNs 注册。Web Push 只在把控制台"加到主屏幕"的 PWA 里成立，壳里的 `PushManager` 不存在；所以壳内设置页同样显示"这个浏览器不能接收推送"。后台提醒只能靠 Bark / ntfy 这类第三方 app。

节点：只有一套 Bark / ntfy / Web Push 扇出；没有原生的设备登记表，没有 APNs，没有"这台设备能不能收到"的状态；payload 只有 title / body / url，通知里没有可用来定位的结构化 id。

证据：`77f0ea51`（Web Push 送达关闭的浏览器标签）、`5157346d`（Mac 只播报没在看的任务）、`6d2d1416`（Capacitor 壳）；`docs/plans/2026-10-28-lody-common-features-program.md` 里"Capacitor shell 需要 APNs"那一行。

## 范围

- 做：
  - iPhone：Capacitor 壳接入 APNs（权限、注册、token 更新、注销），成为壳内唯一的通知通道。
  - Mac：桌面壳的通知改由节点统一的事件扇出驱动，覆盖批准、提问、任务终态、额度、例行报告、worker 离线；保留现有批准/拒绝按钮和"正在看的那条不弹"的规则。
  - 两端：同一份事件、同一套文案、同一个落点；批准/提问通知落到那段对话并让被点名的卡片获得焦点（`/tasks/<id>?focus=<item>`，`docs/product/IA.md:76`）。
  - 节点：`push_devices` 登记表（按安装 id 去重）、APNs provider、失效 token 清理、每个通道的结果。
  - 设置 → 通用：iPhone 未授权时一行「开启通知」；已授权后每次启动自动重登记。控制台不提供设备列表、测试推送或按事件开关（R0b-3，`docs/product/IA.md:75`）。
  - 删除 Bark / ntfy / Web Push 的通道、设置、配置和扇出；通知只走 macOS 通知中心和 APNs，不保留兼容开关。
  - 节点具备 APNs 凭据时才能发 iPhone；没有时控制台不假装已开启，凭据状态只在节点的非敏感 API 里报告（`internal/api/push_devices_test.go` 的 `TestPushDeviceListOmitsTokenAndReportsCredentials`）。
- 不做：
  - iOS 锁屏上的一键批准/拒绝 → `KIN-NOTIFY-002`。
  - 按事件类型的开关、免打扰、静音时段 → `KIN-SETTINGS-001`（或后续故事）。
  - Android 原生推送（没有 Android 壳）。
  - 保留 Bark / ntfy / Web Push、兼容开关或回退通道。
  - 重排 UI base URL、额度阈值等非通道设置；它们保持原位，这一条只删旧通道、加这台设备。
  - 不改通知的触发条件与文案语义；落点沿用 R0b-2 的对话 + `?focus=`（`docs/product/IA.md:76`）。
  - 给 Mac 接 APNs（桌面壳未签名；macOS 通知中心才是它的原生通道）。

## 每一步的预期

### 1. 准备：让这台设备可以叫我

| 项 | 预期 |
|---|---|
| 起点 | iPhone 壳里的 设置 → 通用：未授权时有一行「开启通知」；Mac 桌面壳没有这一行（`PushPermissionRow.dom.test.tsx:50`） |
| 动作 | iPhone 壳里点「开启通知」并允许系统权限；Mac 没有这一步，通知由桌面壳自己的 macOS 权限管（`PushPermissionRow.dom.test.tsx:85`） |
| 立刻看到 | 按钮进入「正在登记…」；授权成功后这一行消失，这台手机已登记给节点（`PushPermissionRow.dom.test.tsx:85,138`） |
| 慢 / 空 / 失败 / 断线 | 授权成功但节点调用失败：保留这一行并显示可重试的失败，回到前台时自动补登记（`PushPermissionRow.dom.test.tsx:72,113`）；权限被系统阻止：不弹权限框，给「打开系统设置」（`:102`） |
| 键盘与焦点 | 这一行是语义按钮（`getByRole("button")`），可 Tab 到并触发；失败提示是 `role="alert"`，读屏会播报（`PushPermissionRow.dom.test.tsx:72,85`） |
| 离开再回来 | 已授权的手机每次启动自动重登记，不再弹权限；未授权的手机下次打开这一行仍在（`PushPermissionRow.dom.test.tsx:55,62`、`NotificationTaps.dom.test.tsx:144`） |

### 2. 定位 / 确认：通知叫的是哪一件事

| 项 | 预期 |
|---|---|
| 起点 | 应用在后台、锁屏或菜单栏；节点产生一个事件 |
| 动作 | 不做任何事 |
| 立刻看到 | 系统原生横幅/通知中心：标题是对话标题，正文说清是批准、提问、跑完、失败、额度还是例行报告；iPhone 上同一个对话的通知归一组，两端同一目标的新事件替换旧的那条 |
| 慢 / 空 / 失败 / 断线 | 设备离线：APNs 尽力而为，不承诺必达；节点没有凭据或发送失败：节点记录最后一次失败原因，控制台不展示（`internal/api/push_devices_test.go` 的 `TestPushDeviceTestRecordsFailure`）；同一件事重复上报：只留一条，不叠加 |
| 键盘与焦点 | Mac 的批准/拒绝按钮可聚焦；iPhone 只有点按打开；VoiceOver 读标题和正文 |
| 离开再回来 | 通知留在通知中心，直到点开或手动清除；同一目标的新事件替换旧的那条，不同目标并存 |

### 3. 执行：点一下就到那一条

| 项 | 预期 |
|---|---|
| 起点 | 通知中心里的一条通知 |
| 动作 | 点通知（Mac 上点横幅） |
| 立刻看到 | Mac：窗口来到前台并打开那一条；iPhone：应用启动或回到前台，落到那段对话并让被点名的批准/提问卡片获得焦点（`/tasks/<id>?focus=<item>`） |
| 慢 / 空 / 失败 / 断线 | 冷启动：先显示控制台自己的连接/加载状态，加载完再落到那一条，不丢目标；节点不可达：连接页可重试，目标保留到连接成功；通知里的地址不在已知路由里：落到收件箱，不打开任意 URL（`notificationRoute.ts:34,62-67`） |
| 键盘与焦点 | Mac：窗口获得焦点，批准卡片的主按钮先接焦点；iPhone：VoiceOver 焦点落到被点名的卡片（`TaskDetailPage.tsx:1340-1410` 的 `?focus=` 揭示） |
| 离开再回来 | 同一条通知再点一次不重复跳转；目标只消费一次；返回后不再次自动跳转 |

### 4. 监控：没叫到、叫错了

| 项 | 预期 |
|---|---|
| 起点 | iPhone 壳里的 设置 → 通用，这一行还在：未授权、被系统阻止，或授权后登记失败（`PushPermissionRow.dom.test.tsx:72,102,169`） |
| 动作 | 点「开启通知」重试；被系统阻止时点「打开系统设置」（`PushPermissionRow.dom.test.tsx:85,102`） |
| 立刻看到 | 成功：这一行消失；失败：这一行保留并显示失败提示（`PushPermissionRow.dom.test.tsx:72`） |
| 慢 / 空 / 失败 / 断线 | 登记还在进行：显示「正在登记…」，这一行不移除（`PushPermissionRow.dom.test.tsx:138`）；授权成功但节点调用失败：回到前台时自动补登记，失败则继续保留这一行（`:113`） |
| 键盘与焦点 | 失败提示是 `role="alert"`，按钮是语义按钮；都可用键盘与读屏到达（`PushPermissionRow.dom.test.tsx:72,85`） |
| 离开再回来 | 从系统设置返回时重读权限：拿到授权就补登记并让这一行消失，没有授权则这一行仍在（`PushPermissionRow.dom.test.tsx:169`） |

设备级接口只存在于 daemon：`POST /api/push/devices` 与 `POST /api/push/devices/test` 由 `internal/api/push_devices_test.go` 钉住；控制台不暴露设备列表、测试推送或按设备关闭（`docs/product/IA.md:75`）。

### 5. 修改：关掉、换设备、解除配对

| 项 | 预期 |
|---|---|
| 起点 | 一台已授权并登记过的手机 |
| 动作 | 在手机上退出登录；或在节点上解除与这台手机的配对 |
| 立刻看到 | 退出登录时这台手机的登记一并删除，换账号登录不会收到上一个账号的工作（`internal/api/push_devices_test.go` 的 `TestSignOutDeletesThePhonesRegistration`、`ui/src/lib/nativePush.test.ts`、`ui/src/api/account.test.ts`）；解除配对时登记随设备凭据在同一事务里删除（`internal/api/devices_test.go` 的 `TestDevicePairingScopesAndRevocation`） |
| 慢 / 空 / 失败 / 断线 | 删除失败：退出登录不被阻塞，删除留待下次重试，404/401/403 视为终态不再重试（`ui/src/lib/nativePush.test.ts`）；离线：本地先清掉 token，节点侧的登出仍会删除登记（`ui/src/api/account.test.ts`） |
| 键盘与焦点 | 不适用：控制台没有可操作的控件；开关在系统设置里（`docs/product/IA.md:69`） |
| 离开再回来 | 控制台没有「关闭」开关；要停止接收，退出登录（删除登记）或在系统设置里关掉通知；已授权的手机下次启动会静默重登记（`PushPermissionRow.dom.test.tsx:62`、`docs/product/IA.md:75`） |

### 6. 收尾：处理完就安静

| 项 | 预期 |
|---|---|
| 起点 | 用户在应用里批准/回答了那一项，或它超时/被取消 |
| 动作 | 不做任何事 |
| 立刻看到 | 对应的已送达通知从通知中心移除（iPhone）；Mac 上不再出现同一件事的新横幅；同一目标的后续事件替换而不是叠加 |
| 慢 / 空 / 失败 / 断线 | 移除失败不报错；事件重复到达时按 kind + id 去重；已经处理的事再触发一次也不会弹 |
| 键盘与焦点 | 不适用 |
| 离开再回来 | 通知中心里没有已经处理完的事；对话仍是唯一真相，通知丢了，对话行上的计数还在（`docs/product/IA.md:75`） |

## 各面差异

| 面 | 这一面怎么呈现 | 为什么不同 |
|---|---|---|
| Mac | 控制台没有通知设置面；macOS 通知中心是唯一通道，权限与开关归系统设置；批准/拒绝按钮保留；当前正在看的对话的终态不弹；Mac 本身不是 APNs 目标（`docs/product/IA.md:69,75`、`desktop/src/notifications.test.ts`） | Electron 的 Notification 走的就是 macOS 通知中心，不是网页通知；桌面壳未签名，不能接 APNs；这一条补齐触发范围和状态，不另写 Swift 壳 |
| 手机 | 设置 → 通用里只有未授权时的一行「开启通知」；授权后每次启动自动重登记，这一行消失；通知由 APNs 送到 Capacitor 壳；点开落到那段对话并让被点名的卡片获得焦点；前台时用应用内横幅，不重复弹系统通知；被系统阻止时这一行给「打开系统设置」（`PushPermissionRow.dom.test.tsx:102,169`、`notificationRoute.ts:75-84`） | iOS 的后台送达只有 APNs；WKWebView 里没有 Web Push；控制台不提供设备列表、测试推送或按设备关闭（`docs/product/IA.md:75`） |
| 两面 | 同一份事件、同一套标题/正文、同一个落点；对话是真相；发送成功不等于看到；通知丢了，东西还在对话里（`docs/product/IA.md:75-76`） | 两端平台能力不同，但用户要完成的动作相同 |

浏览器控制台不是通知面：控制台不显示任何推送区块，也没有浏览器推送 / Bark / ntfy；原生通知只在 Mac / iPhone 应用里（`docs/product/IA.md:75`）。

## 设计

草图：`KIN-NOTIFY-001.review.html`（`figma-flow-v1`；Figma 帧为主体，每个界面跟一段用户流程；手机可读，390px 不横滚）。Figma 设计源：`KIN-NOTIFY-001.figma/`（SVG 源帧，审批页直接引用；设计以此为准）。状态改成 `approved` 前两样都必须有。

必须画到的状态：未授权（一行「开启通知」）、登记中、被系统阻止（「打开系统设置」）、登记失败 / 重试、已授权（这一行不再显示）。2026-11-02 画廊里的已开启 / 已关闭 / 测试失败属于已被 R0b-3 删除的通知设置面板（`docs/product/IA.md:69`）。

实现边界（审批用，不是界面）：

- iOS 构建需要 Push Notifications capability 和 `aps-environment`；Debug 走 sandbox，Release 走 production；真机做端到端，模拟器只验界面和状态。
- 登记和发送必须在同一个 daemon：谁运行任务引擎、发通知，APNs 凭据和 `push_devices` 就登记在谁那里；Hub 只把控制台请求转过去，不能让 token 只留在另一台机器上。例行任务的手机通知是唯一的例外：Node 只通过已鉴权控制通道上报报告内容，Hub 用自己登记的凭据扇出 APNs（见 ADR 0030）；APNs token/私钥仍不离开 Hub。
- 登记归属于建立它的凭据：浏览器登录（含手机上的 Hub 会话）建立的登记绑到那条登录，登出或被撤销时在同一事务里一并删除；会话过期后扇出会拒绝它，测试推送会把过期行删掉（当前没有定时清理，登出/重置/撤销之外的过期行会留在列表里直到有人测试或重新登记）；手机退出登录前先注销自己记住的那一行。测试通知是唯一的全节点广播。
- APNs 私钥由节点管理员配置；控制台不显示凭据状态或最后一次错误，节点只在非敏感 API 状态里报告已配置/未配置，回传的永远不是私钥（`internal/api/push_devices_test.go` 的 `TestPushDeviceListOmitsTokenAndReportsCredentials`）。

## Do not

- 不保留 Bark / ntfy / Web Push、兼容开关或回退通道；它们在这一条删除，旧配置一并清理。
- 不给 Mac 接 APNs；不把桌面壳改成需要 Apple 签名的推送。
- 不在这一条里做 iOS 锁屏一键批准/拒绝；Mac 现有的批准/拒绝按钮保持可用（iOS 的归 `KIN-NOTIFY-002`）。
- 不做按事件类型开关、免打扰、静音时段（归 `KIN-SETTINGS-001` 或后续故事）。
- 不做 Android。
- 不改通知的触发条件、文案语义和收件箱路由。
- 不在设置页显示、回传或导出 APNs 私钥；私钥不进日志、URL、导出文件。
- 不打开通知里的任意 URL；只接受同源路径和已知路由。
- 应用在前台且正在看那一条时，不再弹一条系统横幅。
- 不把 APNs 的 200 当成"用户看到了"；不把通知当成唯一真相。
- 不在原生壳里显示"这个浏览器不能接收推送"；检测到原生壳就显示原生那一块。

## 验收

| 层级 | 位置 | Given / When / Then |
|---|---|---|
| 单元 | `internal/apns/apns_test.go`（新建） | Given 设备 token 和 topic When 发一条批准 Then 请求带 `apns-topic`、`apns-push-type=alert`、`apns-priority=10` 和 ES256 provider token；When APNs 返回 410 Then 删除该 token 并报告失效 |
| 单元 | `internal/notify/native_test.go`（新建） | Given 一个批准事件 When 扇出 Then APNs 和桌面通道都拿到 kind、id、url；Given 没有配置 APNs Then 该通道不出现，不算失败；Given 旧 Bark / ntfy / Web Push 配置 When 启动 Then 不加载、不发送、不报错；Given 登记绑定的登录已结束 When 扇出 Then 跳过那一行；Given 没有会话检查器 Then 同样跳过绑定的行；Given routine / eval / CLI 事件没有 task owner Then 送到 operator 账号的登记和无主行，不到成员手机；没有 operator 账号时只到无主行 |
| 存储 | `internal/store/push_devices_test.go`（新建） | Given 同一安装换了一个 token When 再登记 Then 只留一行；Given 空库和已有数据的库 When 迁移 Then 都能读写；Given 旧库里有 Bark / ntfy / Web Push 配置 When 迁移 Then 旧配置被清理且启动不报错；Given 一个登录建立的登记 When 该登录登出、过期、被撤销或被密码重置 Then 只删那条登录的登记，operator 行与配对设备行不动；Given 一个 v46 文件没有登记表或丢了会话列 When 打开 Then 补表/补列成功，旧版本留下的无会话成员行被删 |
| 接口 | `internal/api/push_devices_test.go`（新建） | Given 已配对的设备 When `POST /api/push/devices` Then 201 并只登记自己；Given 一个不属于这台机器的 principal When `DELETE` 登记 Then 403 且那一行还在；Given 同一安装重复登记 Then 仍然一行；Given 手机用会话 cookie 登记 When 登出 Then 那台手机的行被删除；Given 一个成员 principal 没有会话 id When 登记 Then 拒绝且不写行；Given 登记绑定的会话已结束 When 测试推送 Then 410、那一行被删且没有发给 Apple；Given 旧的 Bark / ntfy / Web Push 设置端点 When 调用 Then 404 |
| 单元 | `ui/src/lib/nativePush.test.ts`（新建） | Given Capacitor iOS When 读状态 Then 是 native 而不是 browser；Given 权限 denied Then blocked；Given registration 事件 Then POST 带安装 id 和环境；Given 普通浏览器 Then 原生不可用，也不出现浏览器推送入口；Given 退出登录 When 注销 Then 删除这台设备记住的行、停止原生壳接收，删除失败留给下次重试（404/401/403 视为终态，不再重试） |
| 单元 | `ui/src/api/account.test.ts`（扩充） | Given 这台手机已登记推送 When 退出登录 Then 先注销这台设备的行、再结束会话；会话结束后它不再被扇出选中；Given 网络永不返回 Then 本地 token 已先清掉，两个请求仍带捕获的 token；Given 手机清理失败 Then 仍然结束会话 |
| 组件 | `ui/src/components/settings/PushPermissionRow.dom.test.tsx`（修改） | Given 非 iPhone 壳 When 渲染 Then 什么都不画；Given 已授权 When 渲染 Then 不画这一行并静默重登记；Given 点「开启通知」 When 授权成功 Then 登记这台手机并让出位置；Given 被系统阻止 Then 不弹框并给「打开系统设置」；Given 启动重登记失败 Then 保留这一行并可重试；Given 从系统设置返回 Then 重读权限；中英两份文案都在 |
| 单元 | `ui/src/lib/notificationRoute.test.ts`（新建） | Given `/inbox?focus=a1` Then 落到收件箱并点名叫 a1；Given 同源绝对 URL Then 取路径；Given 外站或 `javascript:` Then 落到收件箱；Given 冷启动待处理 Then 只消费一次 |
| 组件 | `ui/src/components/NotificationTaps.dom.test.tsx`（新建） | Given 冷启动链接和同一次点按的事件同时到达 When 路由 Then 只导航一次；Given 已在该条目 When 再点同一条 Then 不跳；Given 离开该条目后 When 再点同一条 Then 重新落回；Given 条目在另一台设备被处理 When 它从 pending 消失 Then 移除已送达横幅；Given 回到前台 When 可见 Then 刷新一次 pending |
| 单元 | `internal/node/routinenotify_test.go`（新建） | Given 首次 handshake 前的能力未知 When 上报报告 Then 有界排队，不对旧 Hub 发送未知帧；Given Hub 断开时写阻塞 When 入队 / SetSender / ACK Then 都不被网络写卡住；Given 超长多字节标题正文 Then 按 UTF-8 边界截到 wire 上限后才进帧 |
| 单元 | `internal/apns/apns_test.go`（扩充） | Given 转义密集和多字节的标题正文 When 序列化 Then 实际 HTTP body ≤ 4096 字节且 kind/id/url/thread-id 保留；Given 只有元数据就超过 4 KiB When 发送 Then 在请求前拒绝并记原因 |
| 单元 | `internal/api/routine_notify_test.go`（新建/扩充） | Given 一个被更新的连接 When 上报 Then 拒绝且不 ACK、不扇出；Given 凭据已撤销 Then 不 ACK、不扇出；Given 扇出槽耗尽 When 上报 Then 失败关闭、不 ACK，重放仍算新事件 |
| 单元 | `internal/api/routine_notify_test.go`（集成） | Given 一个真实例行任务终态（noteworthy / 静默 / 熔断禁用） When 走 Engine→NotifyRoutine→RoutineForward→Node→鉴权 Hub→APNs mock Then noteworthy 和熔断各扇出一次且落点正确，静默不扇出；不向真实 Apple 发送 |
| 组件 | `ui/src/pages/RoutinesPage.dom.test.tsx`（新建） | Given 冷/热点按、手动切换、同一条再次点按、前进后退、离线/缺失机器 When 改 `?device=` 或选机器 Then 页面机器与 URL 一致，缺失机器落到现存机器并修正 URL |
| 组件 | `desktop/src/notifications.test.ts`（扩充） | Given 正在看的对话终态 When 收到通知 Then 不弹；Given 批准/提问 When 收到 Then 弹；Given 重复事件 Then 只弹一次；Given 点击 Then 打开那一条；Given 旧 Bark / ntfy 配置 When 启动 Then 不再读取 |
| 接线 | `desktop/src/native-notifications.wiring.test.ts`（新建） | Given 节点推来 `notify` 消息 When 桌面壳收到 Then Notifier 拿到 kind/id/url；Given APNs 不可用 Then 桌面通道仍然工作 |
| iOS | 模拟器/真机，`mobile/scripts/build-ios.sh device` | Given 允许通知并登记 When 把应用切到后台 Then 在 Mac 上触发批准能看到横幅；点开落到那张卡片；杀进程冷启动也能落到那一条；拒绝权限时设置页给系统设置入口；关闭后不再收到；没有 Bark / ntfy / Web Push 回退 |
| 真浏览器 | 1100 / 390，`/browse` | Given 浏览器控制台 When 打开设置 → 通用 Then 不出现原生设备块，也不出现浏览器推送 / Bark / ntfy；Given 未授权的 iPhone 壳 When 打开同一页 Then 只有一行「开启通知」；Given 已授权 Then 这一行不出现 |
| 视觉 | 390 / 1100 截图 | 看两端的"这台设备"块、状态、测试结果和失败原因；对照 `KIN-NOTIFY-001.review.html` 里的 Figma 帧 |

## 证据

- 之前：无原生推送；iPhone 壳内设置页显示"这个浏览器不能接收推送"（本机截图待补，交付时写入文件名）。
- 旧通道：Bark / ntfy / Web Push 的现有实现、设置和配置在交付时删除，不保留回退。
- 之后（Vite 开发服务器连一台隔离的新节点，`/browse`，2026-11-02）：
  - 1100：设置 → 通知 只有"通知"（UI base URL、额度阈值、保存）和"这台设备上的通知"两块；没有 Bark / ntfy / 浏览器推送；浏览器端明确说通知在 Mac / iPhone 原生应用里，不显示启用或测试。
  - 390：同一页单列、无横滚，两块内容和按钮完整可见。
  - 截图为本地临时文件，未入库。
- 自动化（2026-11-03，合并 `main`、第三轮复查修复后，最终交付状态）：
  - `./scripts/check.sh --all` 14 项全过：gofmt、vet、`go test ./...`、probe、desktop test/tsc、UI test/tsc、`api-contract`（生成的 API 类型与 `api/openapi.yaml` 一致）、`api-coverage`（退役的 Web Push 路径与 schema 已从 spec 删除）、shell 语法与 shell 测试、python 语法、`stories`。
  - `go test -race ./internal/store ./internal/notify ./internal/api ./internal/apns ./internal/auth` 通过。
  - UI：`npx tsc --noEmit` 通过；`vitest run` 178 个文件、1818 个测试通过。
  - 桌面：`node --test "src/**/*.test.ts"` 96 个测试、23 个套件通过。
  - 42 个变异体全部变红，每个都先跑绿基线再变异，还原后逐字节比对；覆盖 APNs 扇出与错误脱敏、会话绑定与登出/撤销/过期/密码重置、迁移 046→047 与缺表缺列及执行顺序、无主事件路由、桌面横幅去重与替换、手机点按与冷启动、设置页 410 与终态删除、退役 API、SPA 回退。
  - 早前一轮 `go test ./...` 曾遇到 `internal/github` 一个 2 秒宽限计时测试在并行负载下超时一次，单独重跑通过；与本次改动无关。
- 待补：iOS 真机/模拟器（登记、拒绝权限、后台横幅、点开冷启动、关闭后安静）。当前环境没有网络，Xcode 无法解析 Capacitor SwiftPM 依赖，本轮只做了 Swift 语法解析。真实 APNs 送达、Electron 通知外观与 macOS 权限读取同样未在此环境验证。

## 变更记录

- 2026-10-31 创建（原生通知设计）。
- 2026-11-01 审批页曾改为手机优先（`mobile-v1`），供 Lody 手机审阅；行为合同不变。
- 2026-11-01 D1 定为删除 Bark / ntfy / Web Push（原生唯一通道），并清理旧配置；审批页改为 Figma 帧 + 每屏用户流程（`figma-flow-v1`）。
- 2026-11-02 批准 D1–D5（全部同意），按整条故事实现：节点 APNs + `push_devices` + 单一 `notify` 扇出，桌面壳只显示，iPhone 壳注册 APNs 并在点按后落到那一条；Bark / ntfy / Web Push 连同设置与旧配置清理一起删除。自动化验收已跑；真机/模拟器与 390/1100 截图待补，补齐后再改 `covered`。
- 2026-11-02 高级模型审查（2 blocker / 7 major / 5 nit）后修复：APNs 传输错误不再带 device token；空 owner 只匹配 operator 行；登记读取失败返回 500 而非 404；设置页只看非敏感元数据；退役 `/api/*` 返回 JSON 404；桌面同目标横幅先关后开；iPhone 点按按当前路由去重，冷启动不再重复导航；条目在别处被处理后移除已送达横幅，回前台刷新 pending；`*.p8` 加入忽略。保留的 minor/已知项：iOS 前台通知在监听器挂载前仍可能丢一次（N2，需真机验证后再决定是否加缓冲）；设备凭据登记依赖 registry 行来填 owner（N3，既有行为）；`docs/IMPL_NOTES.md` 与 `docs/MVP_TECH_SPEC.md` 的 Bark/ntfy 段落已标注 superseded（N4）。
- 2026-11-03 复查发现的 blocker：登出、会话过期或被撤销后，那台手机仍会收到 APNs。`push_devices` 现在记录建立登记的浏览器会话（schema 47）；登出、撤销其他会话、清理过期会话在各自事务里删除绑定的登记；扇出前用 `AuthSessionLive` 复核会话仍存在、未过期且账号未停用，没有检查器时按失败关闭；手机退出登录先注销自己记住的那一行并停止原生壳，删除失败留待下次重试，清理失败也不阻塞退出。顺带修掉三条 nit：`kin notify apns --status` 只读非敏感元数据，不再解析私钥；设置页设备行的 `ios` / `sandbox` / `production` 走中英文案；桌面横幅被淘汰时先关闭再忘记。保留的 nit（已知、不阻塞）：同一安装 id 的重新登记会接管旧行，未加 409 所有权校验；发送前没有本地 4 KB APNs 载荷预检，超限由 Apple 拒绝并记入最后一次错误；桌面接线测试断言的是发布返回值，不是 IPC 送达。
- 2026-11-03 同日第二轮复查（0 blocker / 3 major / 8 nit）后修复三条 major：密码重置在结束该账号全部登录的同一事务里删除这些登录登记的手机；`POST /api/push/devices/test` 发送前复核会话，已结束则删行并返回 410；手机退出登录先同步清掉本地 token，再用捕获的 token 完成注销与登出，网络永不返回也不会把 token 留在设备上；成员登记缺少会话 id 时拒绝，不写入无法结束的行。顺带修的 nit：迁移 047 对没有 `push_devices` 表的 v46 文件跳过 ALTER，并清理旧版本留下的无会话成员行；每次开库先补列再跑注册表 DDL（否则索引先于列报错）；登出失败返回 500 并记日志；会话过期后没有定时清理，扇出先行拒绝、测试推送删行，这一点写进本故事与 `IMPL_NOTES`。保留的 nit：待删列表只记一个 id（连续两次失败时后一个覆盖前一个，节点端登出删除仍是兜底）；没有一条集成测试直接断言 `SessionLive` 的接线（`notify` 与 `store` 各自有测试）；同一安装 id 重新登记会接管旧行，未加 409；发送前没有 4 KB 载荷预检；桌面接线测试断言发布返回值而非 IPC 送达。
- 2026-11-03 第三轮复查（0 blocker / 1 major / 7 nit）后修复 major：没有 task owner 的 routine / eval / CLI 事件此前只匹配 owner 为空的行，而操作员用自己的登录登记的手机带着账号，结果 routine 报告永远不响；扇出现在先把空 owner 解析成 operator 账号再圈定收件人，standalone 节点（无账号）仍只到无主行。顺带修的 nit：测试推送的 410 在 OpenAPI 与设置页都有交代（设置页忘掉本机登记并刷新，不再显示英文原文）；测试推送的 404 同样忘掉登记并显示"节点上已没有登记"，不再显示 `device not found`；410 文案与 OpenAPI 不再断言删行一定成功；`ownerAccount` 读取失败会记日志，并有测试钉住失败时只到无主行；退出登录时 404/401/403 不再当作可重试，不会每次打开设置都重试一条永远删不掉的行。保留的 nit：被动状态只看元数据，私钥丢失或从导出恢复后会显示已配置而实际发不出去；过期会话行没有定时清理，只会被扇出拒绝或被测试推送删掉；APNs 客户端每条事件重建，provider token 缓存没有跨事件复用；`pushOwner` 吞掉 registry 读取错误（DB 故障时设备登记会退化成无主行）；`RevokeAllDeviceCredentials` 不删绑定登记（当前无生产调用）。
- 2026-11-03 合并 `main`（Hub 一次性登录链接）：登出仍先清本地 token、再注销手机、最后登出；测试改为断言注入的 `apiFetch`，不再依赖全局 `fetch`。OpenAPI 合掉了两处重复的 `/api/notify/test` 与重复 schema，并删除退役的 Web Push 路径与四个旧 schema；`AccountSection` 采用 main 的新布局，但移除重复的 `clearToken()`，因为 `signOut()` 已先捕获并清除 token。
- 2026-11-13 ADR 0030（Node 上例行任务的手机通知）：例行任务仍在 Node 上，Node 通过已鉴权的控制通道把「noteworthy 例行报告 / 电路熔断禁用」告警内容上报 Hub；Hub 用自己登记的设备和 `notify.Sender` 扇出 APNs，绝不复制 APNs token/私钥到 Node。报告落点改为 `/machines/:device/tasks/:id`，禁用告警落到 `/routines?device=<id>`；`hello_ack` 增加可选 `routine_notify` 能力位，旧 Hub 先升、Node 后升。第二轮独立复查后收紧可靠性合同：报告在能力未知时也先有界排队、绝不向旧 Hub 发未知帧；Node 转发改为单一异步发送者，网络写不再占用任务引擎/读循环/心跳；Hub 只接受当前连接的 generation、失败关闭并给 APNs 扇出设并发上限；4 KiB 上限改为按实际序列化 payload 在 APNs 边界截断；`/routines?device=` 的机器选择与 URL 双向同步。本故事原有的"登记与发送在同一 daemon"约束对 Hub 自己的任务仍成立（例行任务的扇出是唯一例外）。
- 2026-11-21 真机验收第一轮（Ethan，iPhone）：点批准/提问通知能打开应用，但落不到那条对话的卡片上。根因：节点写 `/tasks/<id>?focus=<item>`，`parseNotificationRoute` 只对 `/inbox` 保留 `?focus=`，任务对话的 query 被丢掉，`TaskDetailPage.tsx:1286` 的揭示从不触发；`notificationRoute.test.ts` 只断言过不带 focus 的 `/tasks/<id>`。修复 PR #536（`rsi/notify-tap-focus`）；`covered` 仍等装一次含该修复的包，再点一次批准/提问通知确认卡片出现且 VoiceOver 焦点在它上面。
- 2026-11-26 · CEO 代签修订：合同与设计页按已落地的 R0b-2 / R0b-3 改写——控制台没有「设置 → 通知」面（`docs/product/IA.md:69`），唯一控件是 iPhone 未授权时「设置 → 通用」的一行（`:75`），落点是对话 + `?focus=`（`:76`）；验收表里指向已删组件的那一行改用实际存在的 `PushPermissionRow.dom.test.tsx`。「做 / 不做」里的 Go、APNs、桌面行与验收的同名行未动。
