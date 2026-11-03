# KIN-NOTIFY-001 · 离开时被叫回来

状态：approved
优先级：P0
旅程：J7
归属面：`IA.md`「设置 → 通知」
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
  - 两端：同一份事件、同一套文案、同一个落点；点通知落到收件箱的那一条或那段对话。
  - 节点：`push_devices` 登记表（按安装 id 去重）、APNs provider、失效 token 清理、每个通道的结果。
  - 设置 → 通知：第一块是这台设备的状态、启用/关闭、发送测试、被系统阻止时的去处；不再有浏览器推送 / Bark / ntfy 区块。
  - 删除 Bark / ntfy / Web Push 的通道、设置、配置和扇出；通知只走 macOS 通知中心和 APNs，不保留兼容开关。
  - 节点具备 APNs 凭据时才能发 iPhone；没有时设置页说清楚缺什么，不假装已开启。
- 不做：
  - iOS 锁屏上的一键批准/拒绝 → `KIN-NOTIFY-002`。
  - 按事件类型的开关、免打扰、静音时段 → `KIN-SETTINGS-001`（或后续故事）。
  - Android 原生推送（没有 Android 壳）。
  - 保留 Bark / ntfy / Web Push、兼容开关或回退通道。
  - 重排 UI base URL、额度阈值等非通道设置；它们保持原位，这一条只删旧通道、加这台设备。
  - 改通知的触发条件、文案语义、收件箱路由；这些沿用今天的行为。
  - 给 Mac 接 APNs（桌面壳未签名；macOS 通知中心才是它的原生通道）。

## 每一步的预期

### 1. 准备：让这台设备可以叫我

| 项 | 预期 |
|---|---|
| 起点 | 设置 → 通知；Mac 桌面壳或 iPhone 原生壳 |
| 动作 | 点"在这台设备上启用"（iPhone 会弹系统权限；Mac 第一次发测试时由 macOS 弹） |
| 立刻看到 | 按钮进入"正在登记…"；状态从"未开启"变成"已开启"，并写明这台设备会收到哪几类事件 |
| 慢 / 空 / 失败 / 断线 | 登记慢：保留"正在登记…"并可离开；权限被拒绝：状态"被系统阻止"，给"打开系统设置"；节点没有 APNs 凭据：说"这个节点还不能发到 iPhone"，并指出由节点管理员配置；离线：说"连不上节点"，给重试 |
| 键盘与焦点 | Tab 到按钮并触发；系统权限框返回后焦点回到状态行；VoiceOver 读出状态和下一步 |
| 离开再回来 | 状态持久；再次打开设置不重复弹权限；已开启时不显示"启用" |

### 2. 定位 / 确认：通知叫的是哪一件事

| 项 | 预期 |
|---|---|
| 起点 | 应用在后台、锁屏或菜单栏；节点产生一个事件 |
| 动作 | 不做任何事 |
| 立刻看到 | 系统原生横幅/通知中心：标题是对话标题，正文说清是批准、提问、跑完、失败、额度还是例行报告；iPhone 上同一个对话的通知归一组，两端同一目标的新事件替换旧的那条 |
| 慢 / 空 / 失败 / 断线 | 设备离线：APNs 尽力而为，不承诺必达；节点没有凭据或发送失败：设置页显示最后一次失败原因，不静默；同一件事重复上报：只留一条，不叠加 |
| 键盘与焦点 | Mac 的批准/拒绝按钮可聚焦；iPhone 只有点按打开；VoiceOver 读标题和正文 |
| 离开再回来 | 通知留在通知中心，直到点开或手动清除；同一目标的新事件替换旧的那条，不同目标并存 |

### 3. 执行：点一下就到那一条

| 项 | 预期 |
|---|---|
| 起点 | 通知中心里的一条通知 |
| 动作 | 点通知（Mac 上点横幅） |
| 立刻看到 | Mac：窗口来到前台并打开那一条；iPhone：应用启动或回到前台，落到收件箱里被点名的那张批准/提问卡片，或那段对话的末尾 |
| 慢 / 空 / 失败 / 断线 | 冷启动：先显示控制台自己的连接/加载状态，加载完再落到那一条，不丢目标；那条已经被处理：收件箱说"这一条已经不在了"，并显示它周围的列表；节点不可达：连接页可重试，目标保留到连接成功；通知里的地址不认识：落到收件箱，不打开任意 URL |
| 键盘与焦点 | Mac：窗口获得焦点，批准卡片的主按钮先接焦点；iPhone：VoiceOver 焦点落到被点名的卡片；返回/Esc 回到收件箱或列表 |
| 离开再回来 | 同一条通知再点一次不重复跳转；目标只消费一次；返回后不再次自动跳转 |

### 4. 监控：没叫到、叫错了

| 项 | 预期 |
|---|---|
| 起点 | 设置 → 通知，这台设备显示未开启、被阻止或登记失败 |
| 动作 | 看原因；点"打开系统设置"；点"重试"；点"发送测试" |
| 立刻看到 | 这一台设备一行：平台、名字、状态、最后一次成功/失败时间；测试结果按这台设备列出，不只给一个总的"成功" |
| 慢 / 空 / 失败 / 断线 | 测试超时：说"没有在 10 秒内收到回执"，并保留原因；APNs 说 token 失效：删掉这一行并说"这台 iPhone 需要重新开启"；这台设备还没有登记：说"还没有设备"，给启用入口；离线：状态标"未知"，不把上次的"已开启"当现在 |
| 键盘与焦点 | 每个按钮可 Tab；操作后焦点留在原处；错误文本可被读屏读到 |
| 离开再回来 | 从系统设置返回时重新读权限；不缓存过期的"已开启" |

### 5. 修改：关掉、换设备、解除配对

| 项 | 预期 |
|---|---|
| 起点 | 一台已开启的设备 |
| 动作 | 点"在这台设备上关闭"；在手机上解除与节点的配对；退出登录 |
| 立刻看到 | 这一行变成"已关闭"并从节点删除；不再收到新通知；重新开启可以恢复；退出登录时这台手机的登记一并删除，换账号登录不会收到上一个账号的工作 |
| 慢 / 空 / 失败 / 断线 | 删除失败：保留"已关闭"但标明"节点上的登记还没删掉"，给重试；离线：说明关闭只在本机生效，节点恢复后重试；解除配对时登记一并删除 |
| 键盘与焦点 | 按钮可 Tab；没有二次确认（可逆）；成功后焦点留在状态行 |
| 离开再回来 | 关闭状态跨启动保留；重新打开应用不会偷偷重新登记，除非用户点启用 |

### 6. 收尾：处理完就安静

| 项 | 预期 |
|---|---|
| 起点 | 用户在应用里批准/回答了那一项，或它超时/被取消 |
| 动作 | 不做任何事 |
| 立刻看到 | 对应的已送达通知从通知中心移除（iPhone）；Mac 上不再出现同一件事的新横幅；同一目标的后续事件替换而不是叠加 |
| 慢 / 空 / 失败 / 断线 | 移除失败不报错；事件重复到达时按 kind + id 去重；已经处理的事再触发一次也不会弹 |
| 键盘与焦点 | 不适用 |
| 离开再回来 | 通知中心里没有已经处理完的事；收件箱仍是唯一真相 |

## 各面差异

| 面 | 这一面怎么呈现 | 为什么不同 |
|---|---|---|
| Mac | 设置 → 通知 顶部是"这台 Mac"：macOS 权限状态、发送测试、打开系统设置；通知由桌面壳的 macOS 通知中心显示；批准/拒绝按钮保留；当前正在看的对话的终态不弹；Mac 本身不是 APNs 目标 | Electron 的 Notification 走的就是 macOS 通知中心，不是网页通知；桌面壳未签名，不能接 APNs；这一条补齐触发范围和状态，不另写 Swift 壳 |
| 手机 | 设置 → 通知 顶部是"这台 iPhone"：系统权限、启用/关闭、发送测试、打开 iOS 设置；通知由 APNs 送到 Capacitor 壳；点开落到那一条；前台时用应用内横幅，不重复弹系统通知；这一条不做锁屏按钮 | iOS 的后台送达只有 APNs；WKWebView 里没有 Web Push；原生壳带推送 entitlement，PWA 的 Web Push 随之删除 |
| 两面 | 同一份事件、同一套标题/正文、同一个落点；收件箱是真相；发送成功不等于看到；通知丢了，东西还在收件箱 | 两端平台能力不同，但用户要完成的动作相同 |

浏览器控制台不是通知面：删除 Web Push 后，设置 → 通知只说明"通知在 Mac / iPhone 原生应用里"，不显示启用或测试。

## 设计

草图：`KIN-NOTIFY-001.review.html`（`figma-flow-v1`；Figma 帧为主体，每个界面跟一段用户流程；手机可读，390px 不横滚）。Figma 设计源：`KIN-NOTIFY-001.figma/`（SVG 源帧，审批页直接引用；设计以此为准）。状态改成 `approved` 前两样都必须有。

必须画到的状态：未开启、登记中、已开启、被系统阻止、节点缺 APNs 凭据、测试失败、离线、没有设备、已关闭、同一条已处理。

实现边界（审批用，不是界面）：

- iOS 构建需要 Push Notifications capability 和 `aps-environment`；Debug 走 sandbox，Release 走 production；真机做端到端，模拟器只验界面和状态。
- 登记和发送必须在同一个 daemon：谁运行任务引擎、发通知，APNs 凭据和 `push_devices` 就登记在谁那里；Hub 只把控制台请求转过去，不能让 token 只留在另一台机器上。
- 登记归属于建立它的凭据：浏览器登录（含手机上的 Hub 会话）建立的登记绑到那条登录，登出或被撤销时在同一事务里一并删除；会话过期后扇出会拒绝它，测试推送会把过期行删掉（当前没有定时清理，登出/重置/撤销之外的过期行会留在列表里直到有人测试或重新登记）；手机退出登录前先注销自己记住的那一行。测试通知是唯一的全节点广播。
- APNs 私钥由节点管理员配置；设置页只显示"已配置/未配置"和最后一次错误，不回传私钥。

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
| 组件 | `ui/src/components/settings/NativePushSettings.dom.test.tsx`（新建） | Given 原生 iPhone When 渲染 Then 只有"这台 iPhone"，没有浏览器推送 / Bark / ntfy；Given blocked Then 有"打开系统设置"；Given 测试失败 Then 显示原因；Given 旧配置还在 When 渲染 Then 不显示旧通道；Given 节点登记的 `ios` / `sandbox` / `production` When 渲染 Then 显示译名而不是机器值；Given 测试推送返回 410 Then 忘掉本机登记、刷新列表并显示登录已结束，不显示英文原文；Given 返回 404 Then 同样忘掉登记、刷新列表并显示节点上已没有这台手机的登记；中英两份文案都在 |
| 单元 | `ui/src/lib/notificationRoute.test.ts`（新建） | Given `/inbox?focus=a1` Then 落到收件箱并点名叫 a1；Given 同源绝对 URL Then 取路径；Given 外站或 `javascript:` Then 落到收件箱；Given 冷启动待处理 Then 只消费一次 |
| 组件 | `ui/src/components/NotificationTaps.dom.test.tsx`（新建） | Given 冷启动链接和同一次点按的事件同时到达 When 路由 Then 只导航一次；Given 已在该条目 When 再点同一条 Then 不跳；Given 离开该条目后 When 再点同一条 Then 重新落回；Given 条目在另一台设备被处理 When 它从 pending 消失 Then 移除已送达横幅；Given 回到前台 When 可见 Then 刷新一次 pending |
| 组件 | `desktop/src/notifications.test.ts`（扩充） | Given 正在看的对话终态 When 收到通知 Then 不弹；Given 批准/提问 When 收到 Then 弹；Given 重复事件 Then 只弹一次；Given 点击 Then 打开那一条；Given 旧 Bark / ntfy 配置 When 启动 Then 不再读取 |
| 接线 | `desktop/src/native-notifications.wiring.test.ts`（新建） | Given 节点推来 `notify` 消息 When 桌面壳收到 Then Notifier 拿到 kind/id/url；Given APNs 不可用 Then 桌面通道仍然工作 |
| iOS | 模拟器/真机，`mobile/scripts/build-ios.sh device` | Given 允许通知并登记 When 把应用切到后台 Then 在 Mac 上触发批准能看到横幅；点开落到那张卡片；杀进程冷启动也能落到那一条；拒绝权限时设置页给系统设置入口；关闭后不再收到；没有 Bark / ntfy / Web Push 回退 |
| 真浏览器 | 1100 / 390，`/browse` | Given 浏览器控制台 When 打开设置 → 通知 Then 不出现原生设备块，也不出现浏览器推送 / Bark / ntfy，只说明通知在 Mac / iPhone 原生应用里；Given 原生壳 When 打开同一页 Then 不出现"这个浏览器不能接收推送" |
| 视觉 | 390 / 1100 截图 | 看两端的"这台设备"块、状态、测试结果和失败原因；对照 `KIN-NOTIFY-001.review.html` 里的 Figma 帧 |

## 证据

- 之前：无原生推送；iPhone 壳内设置页显示"这个浏览器不能接收推送"（本机截图待补，交付时写入文件名）。
- 旧通道：Bark / ntfy / Web Push 的现有实现、设置和配置在交付时删除，不保留回退。
- 之后（Vite 开发服务器连一台隔离的新节点，`/browse`，2026-11-02）：
  - 1100：设置 → 通知 只有"通知"（UI base URL、额度阈值、保存）和"这台设备上的通知"两块；没有 Bark / ntfy / 浏览器推送；浏览器端明确说通知在 Mac / iPhone 原生应用里，不显示启用或测试。
  - 390：同一页单列、无横滚，两块内容和按钮完整可见。
  - 截图为本地临时文件，未入库。
- 自动化（2026-11-03，第三轮复查修复后，最终交付状态）：
  - `./scripts/check.sh --all` 11 项全过：gofmt、vet、`go test ./...`、desktop test/tsc、UI test/tsc、`api-contract`（生成的 API 类型与 `api/openapi.yaml` 一致）、shell/python 语法、`stories`。
  - `go test -race ./internal/store ./internal/notify ./internal/api ./internal/apns ./internal/auth` 通过。
  - UI：`npx tsc --noEmit` 通过；`vitest run` 174 个文件、1758 个测试通过。
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
