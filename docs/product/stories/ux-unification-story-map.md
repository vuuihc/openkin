# 四区重构与现有功能合同的映射

状态：草案，与 `KIN-CONTINUE-003` 一并审阅；不替代已有功能合同。

## 交付状态（2026-11-17，G2）

- **已交付**：N1/N2 区域表与路由（#68 `8137ba28`、#76 `3206755c`）；S1 Mac 区域栏（#128 `0c2ec124`）；S1b 面板打开时列表让位（#144 `5576e938`）；S2 手机底部入口（#118 `0a6c7a17`）；S2b 列表头新建与返回（#136 `fe4b18a5`）；S3 到达动效（#146 `47ddcbde`）；E4a 旧链接重定向（#141 `71402048`）。
- **已托管**：Agent 运维本体已由 N4 托管在 `/settings?tab=operations`。
- **未交付**：C*（余下的共享外壳与 primitives 切片）、G1（禁用旧 primitives 的 lint 门）、G3（J1–J7 冒烟走查）、G4（bundle / inventory 验收）。

| 新面 | 主合同 | 变化 | 必须保留的测试 / 面 |
|---|---|---|---|
| 对话根、集合、归档范围 | KIN-CONTINUE-003 + CONTINUE-001 | CONTINUE-002 的列表唯一导航根作废 | PhoneNavigation、Sidebar、SessionsPage、sessionSearch、archive/deletion/pin、原有完整 status 筛选 |
| 对话详情 / 新建 / diff / 审批 | CONTINUE-001、START-001、RESULT-001、NOTIFY-001 | 外壳所属区变化，功能不变 | TaskDetailPage、Composer、RunConfigSheet、NotificationTaps |
| 导入会话详情 | CONTINUE-001 + AGENTS-001 | 归入对话区；列表/项目入口保留历史与继续，运维入口可回 Agent 运维 | AgentSessionDetailPage、agentSessionHistory、projectChats |
| 项目集合与封面 | KIN-CONTINUE-003 + PROJECT-001 | 转为区域根 → 封面的页面栈 | ProjectDetailPage、projectChats、projectScroll、onePager、项目新建与四种项目模式 |
| 例行任务与远程运行 | ROUTINE-001 | 一级导航；机器仍属于数据源，改成区域里的上下文 | RoutinesPage.machineHistory、routineDevice、routineEdit、routineConversation |
| 设置根 / 本地 Agent / Agent 运维 | SETTINGS-001、AGENTS-001、CONTINUE-003 | 运维归入设置，但 `?tab=agents` 的本地 Agent/角色/按 Agent 导入仍独立保留 | SettingsPage.leaveGuard、settingsTabsWiring、AgentsPage.*、agentSessionImport |
| 桌面壳更新托盘 | SETTINGS-002 | 不进入控制台导航 | updater / tray wiring |
| 原生通知 | NOTIFY-001 | 新外壳复用同一安全的具体落点，不丢 focus/device | notificationRoute、NotificationTaps、原生端、TaskDetailPage 卡片 focus |
| 参数校验 / 鉴权门 / 托盘 | 现有 App、桌面壳合同 | 保持独立特殊面，不伪装成第五区 | AuthGate、TrayPage、SessionSync；指定为鉴权门，不使用含糊的「锁定」状态 |
| 共享 primitives 与视觉规则 | TASTE、components/docs、design/agentic-states | Astryx 成为实现底座，不替代 Kin IA / token | tokens、overlayOwnsKeyboard、IME、44px、UI inventory |

## 界面与路由逐项保留

下表是导航归属、冷启动默认父级及旧链接保留规则的同一份合同。「实际入口父亲的证据」优先于此处的冷启动默认；它让从项目封面进入某段对话的人可以回到封面，而不是无条件回对话根。`*id` / `*device` 表示原 URL 的已有受控 ID，不在设计材料中使用真实设备或路径。

| 已有或新增 URL | 新区 / 主内容 | 手机的冷启动父级 | 返回与参数的保留 |
|---|---|---|---|
| `/`、`/sessions?search=&status=&scope=` | 对话 / 集合 | 对话根 | 默认进入对话区；沿用唯一 SessionList、搜索、status 与 scope；「待处理」是已有 status 筛选的组合快捷入口，不删精确状态筛选 |
| `/inbox?focus=<item>` | 对话 / 通知指名的卡片 | 对话根 | 保留 `focus`；先经 `usePendingResources` 将审批/问题 ID 解析至其 task，再落到 `/tasks/<id>?focus=<原值>` 并定位那张卡。已处理的卡消失时不选其他卡；任务可见、pending 尚慢时保持该任务的加载再定位。重试与确认执行下条完整交付生命周期 |
| `/tasks/<id>?focus=<item>` | 对话 / 原生对话 | 原入口或对话根 | task ID、focus、列表筛选和行焦点均保留；项目入口回到该项目封面，通知入口回对话根；只滚到并标出匹配 ID，不把彩色浮层当聚焦语义 |
| `/new?cwd=<root>` | 发起新建的那一区 | 原入口；无入口时为对话根 | URL 的 cwd、机器/项目、模型/权限和草稿沿用 START；多 root 仍由已有项目选择器选，不猜第一个 root |
| `/agent-sessions/<id>` | 对话 / 导入会话历史与继续 | 原入口；未知时对话根 | 从列表或项目回原来源；从 Agent 运维入口回运维分区。继续后为手机替换为对应 `/tasks/<id>`、仍回同一原始来源；Mac 保留正常历史以回导入历史 |
| `/projects`、`/projects/<id>` | 项目 / 集合或封面 | 项目根 | 集合的设备/搜索/选中/滚动保留；封面继续拥有摘要编辑、ship/learn/explore/maintain、刷新、最近活动、只读例程入口及「新建对话」；旧 `?tab=` 保持清除，不复活对话子列表 |
| `/routines?device=<device>` | 例行任务 / 机器内列表 | 例行任务根 | 显式 device 优先于记忆值，缺失机器仍按现有 fallback 修正；通知、项目入口和运行的返回保留机器；不把机器 id 当可打开的外部 URL |
| `/machines/<device>/tasks/<id>` | 例行任务 / 所属机器的远程运行 | `/routines?device=<原 device>` | 原 URL 与设备段不变；项目直接跳到某远程运行时，原入口存证后可回封面；冷启动回有该设备的例程列表 |
| `/agents`、`/usage` | 设置 / Agent 运维 | 设置根 → Agent 运维 | `replace` 到 `/settings?tab=operations`；一段本地 agent/机器/用量的现有能力均保留，不建设第二份运维面板 |
| `/settings?tab=<id>` | 设置 / 指定分区 | 设置根 | 见下方的固定 ID 表；手机设置分区是该区栈的一级推进页，Mac 是左内栏；现有分区 URL 保持可恢复 |
| 未知路径 / 无效通知 URL | 鉴权门后安全的对话根 | 对话根 | 不把指名的 `focus` 挂到错误 task；保留 `notificationRoute` 对已知路径/协议的白名单，不将主机或 `javascript:` 当可导航内容 |

## 通知：原 target 独立留到导航真正接受

1. **身份不是清理后的地址。** 点按身份为现有 `notificationRoute` 归一化后的原 target（含原 `focus` 或 `device`）。它和可见 URL、active/queued delivery 分开保存。`TaskDetailPage` 消费 focus 后仍从地址清理 `?focus=`；不得为使去重生效长期保留 focus，也不得用清理后的同 task URL 吞掉另一个 item。
2. **仅在相同目标时去重。** 相同原 target 仍在当前目标交付或 in-flight/queued 时，冷启动事件与 held URL 的重复只交付一次；同 task 的不同 focus 是另一次有效点按。离开该通知目标后，同 target 的点按再次有效。新点按取代旧排队目标，完全相同的重复除外。
3. **read-clear 不等于已交付。** iOS 原生 `takePendingURL` 读除后，立即将此归一化原 target 留在应用会话内存并对该交付持有确认权；只有鉴权通过、旧 inbox 的 pending 找到并定位匹配 item 或明确得出「item 已不存在」、且 `runGuardedNavigation` 返回接受后，才视为完成、清掉这个仍保留副本并确认原生持有层。现有 `KinPushState` 是 read-clear 桥、不是可乘的 ack 接口；因此完成后的再次 `takePendingURL` 是清空已接受的 shell 副本，不是宣称有本设计未新建的协议。真正的持久恢复边界是应用会话内的通知目标；系统通知中心仍是用户下一次主动入口。
4. **拒绝不离开，不清除唯一副本。** 鉴权期间、pending 加载、显式「item 已不存在」处理和 leave guard 询问期间，原 target 均未被消费为当前页面；未匹配给出就地说明，不可选另一张卡。用户拒绝丢弃草稿时停在原页，保留一个明确的「重试打开通知」提醒，不自动导航、不并入任意区域历史；重试沿用完整原 target。pending 读取失败保留重试，不把未知 item 直接抹为不存在；只有 pending 成功加载且不存在，或明确过期/被另一设备解决时才进入「item 已不存在」状态。
5. **通知消息与目标分开恢复。** 设备 id 与原生安全 URL 约束原样保留；导航拒绝后不得把旧 target 绑定到当前区或任意 task。提交时以这条通知交付生命周期和 [NOTIFY-001](KIN-NOTIFY-001.md) 的实际原生边界为准；这里不改 bridge、agent 或推送协议，也不改推送产生或业务审批语义。

1. **Tab 仅入口根显示。** `/sessions`、`/routines`、`/agents`（即 `/settings?tab=operations`）、`/settings` 与 `/settings?tab=general` 是四个手机入口的根，显示完整四 Tab。`/tasks/:id`、`/new`、`/projects`、`/projects/:id`、`/machines/:device/tasks/:id`、`/agent-sessions/:id` 隐藏 Tab，提供原区域栈的返回；新建是关闭，摘要未保存等场景仍先过 leave guard。四个入口始终同级，但从项目进入新建的返回仍是项目封面。
2. **入口证据而非导航目录改写 URL。** 区根到详情 push；跨区显式动作保存来源区、URL、位置和触发器身份，将新详情推进目标区。原入口回栈仍有效；冷启动使用上表默认父级，而非伪造“上次的滚动位置”。
3. **同区栈不是全局一条。** 四区各自保存自己的根、筛选/选中/滚动与未提交编辑；四 Tab 切换不用 Back 互相穿梭。对原入口的回栈证据持久于 history state；tab 本地缓存只补充该应用会话的现场，不能篡改其他区的历史。
4. **根页的父母是退出 Kin。** 在真正的区根或没有 Kin 父级的首次进入，页头/边缘不人为增加回栈；浏览器 Back 仍可正常离开应用。主应用在路由前给冷启动详情合成已知父级，history ledger（历史入口记录）只记录真实 Kin 入口，不伪造“上一页”把退出圆堵住。通知和外部 history 不能导致 `[项目, 对话, 项目, 对话]` 的环。跨区替换旧 child 时，ledger 和 marker 一起绑定入口 URL、region 与 history index；index 只是校验，不是唯一身份。
5. **浮层先退，dirty guard 再问，最后才回栈。** 页头、系统 Back、浏览器 Back、左缘右滑走同一 resolver；鉴权门是特殊面，进入前保留通知落点，通过后只消费一次。
6. **Mac 保留自己的正常历史。** 四区侧栏始终可见，不是假手机栈；覆盖右侧内容时仍恢复触发器/选中项和列表滚动。手机 attach 导入会话的 replace 语义不套用到 Mac。

验收路径：`ui/src/components/layout/AreaNavigation.dom.test.tsx`、`ui/src/lib/areaNavigation.test.ts`、`ui/src/lib/areas.test.ts`、`ui/src/lib/areaTransition.test.ts`、`ui/src/components/layout/AreaRoute.dom.test.tsx`、`ui/src/components/layout/PhoneNavigation.dom.test.tsx`、`ui/src/lib/phoneBack.test.ts`、`phoneDeepLinkParent.test.ts`、`notificationRoute.test.ts`、`NotificationTaps.dom.test.tsx`、`TaskDetailPage.dom.test.tsx`、`ProjectDetailPage.dom.test.tsx`、`RoutinesPage.dom.test.tsx`、`AgentSessionSheet.dom.test.tsx`、设置相关现有测试。`registry.json` 的测试数为 0 只表示它仍在草案阶段，不代表覆盖。

## 设置分区：改位置，不丢字段

保留 `/settings` 与 `tab` 参数；不重命名/重写既有五个 tab 的 URL。`operations` 是新增的真实设置内容分区，owner 为 `AgentsPage.tsx` 迁移出的 Agent 运维主体；**`/settings?tab=agents` 仍是 LocalAgentSettingsSection，不是 Agent 运维。**

| URL / 设置根名字 | owner 与现有字段 | 变化边界 |
|---|---|---|
| `general` / 通用、语言/外观、帐户 | `SettingsPage`、`AccountSection`、`PushPermissionRow`、app 现有语言选择 | 保持外观、帐户/授权状态与 iOS 通知权限入口同一 root 区；不新增密码秘密读取。已删除的 `remote`、`notifications` 仍落到 general，不能悄然重现旧面板 |
| `providers` / 模型提供方与运行默认 | `ProviderSettingsSection` | 保留 provider 名称/base URL/API key/模型/stream、模型列表读取及默认运行模型；Secret 仍只在明确动作时读取。此区不是凭想像创建的「默认 Agent」字段容器 |
| `agents` / 本地 Agent 与角色 | `LocalAgentSettingsSection`、`RolesSection` | 保留检测、明确刷新、按 provider 手动导入、能力及角色编辑；被动查看不自动刷新第三方或导入会话 |
| `operations` / Agent 运维、机器与用量 | 原 `AgentsPage` 的同一领域主体，设置分区宿主 | 并入原目录、连接/检查/默认 Agent、机器状态、额度与用量、发现后明确确认接入和手动导入；所有原操作都有桌面菜单/手机 Sheet 的可达入口 |
| `routing` / 额度与路由 | `RoutingSettings` 与 `SettingsPage` | wait/ask/switch、fallback 原字段继续拥有自身保存/离开保护；不因名字称为「权限/运行默认」而从 UI 消失 |
| `advanced` / 成本表、额度上限与高级项 | `SettingsPage` 原有 advanced panels | 原价格表、agent limits 等整段和精确 URL 保留；设计帧里的短卡片是索引，不是删字段许可 |

## 合同变更边界

1. 本签字方案只替换 `KIN-CONTINUE-002` / `NAVIGATION.md` 的旧列表唯一根和旧「目的地从列表推出」模型，以及旧四入口；不是把架空的「D1–D8 全部功能」从文档里抹掉。
2. `KIN-PROJECT-001` 的功能合同继续成立；其中「项目不是第二个列表」指的是不复制对话列表，不禁止一个拥有项目集合的区域。新增的集合提供封面发现路径，原对话标题继续可达封面。它与原项目合同对返回的冲突以本表的**原入口返回**为准：项目打开的对话仍回项目。
3. 本方案一签字，`IA.md`、`NAVIGATION.md` 与本条一起变更旧决定；其他故事增加本引用并调整真正冲突的父级描述，不重签其中未变的功能流程。
4. 任何新面仍有指定拥有者，不能因「暂时过渡」另建旁路列表。

[总设计合同](KIN-CONTINUE-003.md) · [总计划](../../plans/2026-11-14-ux-unification.md)
