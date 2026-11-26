# KIN-CONTINUE-003 · 四个区域，一套可以预期的工作台

状态：covered
签字：2026-11-17 CEO 代签（用户授权见 rsi/DECISIONS.md 2026-11-15「KIN-CONTINUE-003 treated as approved」）。设计页与 20 张帧已读；登记的可执行测试见 registry。
优先级：P0
旅程：J1、J2、J3、J4、J5、J6、J7
归属面：`IA.md` 的四区导航与共享外壳
面：Mac、手机

## 谁、什么时候、为什么

当我在手机和 Mac 之间继续处理对话、项目、例行任务和环境设置时，我想在两端找到相同的内容结构、稳定的入口和连续的页面状态，以便把注意力放在正在做的事，而不是重新学习每个页面。

## 现在

手机底部是「对话 / 例行任务 / Agent 运维 / 设置」，归档已收进对话范围，但对话仍是唯一导航根；其余目的地从列表推出，区域之间不能同层切换。Mac 保留固定对话侧栏，与手机不是同一套结构。页面各自决定标题、按钮、面板和状态样式，缺少统一区域的导航与转场规则。

旧合同 `KIN-CONTINUE-002` 与 `NAVIGATION.md` 的「目的地从列表推出」模型已被用户于 2026-11-14 明确替换：`KIN-CONTINUE-003` 定义**对话 / 项目 / 例行任务 / 设置**四个真正同级区域；归档仍是对话范围；Agent 运维是设置分区。

## 范围

- 做：四区及其页面树；Mac 侧栏双栏，手机四 Tab + 各自栈；稳定导航、页面返回和深链；克制的转场；区域筛选/选中/滚动保留；共享页头、浮层、表单和四态规则；所有现有控制台功能继续可达。
- 做：项目区含有项目集合及封面；机器是跨区域的上下文或范围，不是第五区；Agent 运维包括其现有目录、机器、用量、导入能力，归入设置。
- 不做：新功能、通知触发变化、agent 执行/权限/调度语义、Go API/数据库/协议变化、品牌视觉重做。
- 不做：用整条 Tab 横滑切换、把手机控件原样搬到 Mac、把 Astryx 的导航模型作为产品 IA。
- 具体保留边界：对话归 CONTINUE / START / MANAGE / RESULT；项目归 PROJECT；例程归 ROUTINE；环境归 SETTINGS / AGENTS；通知归 NOTIFY；桌面升级仍在 SETTINGS-002。

## 每一步的预期

### 1. 在一级区域之间移动

| 项 | 预期 |
|---|---|
| 起点 | 对话、项目、例行任务、设置任一区的根页面，Mac 或手机 |
| 动作 | 点当前端的四个入口之一（Mac 四个区域，手机 D8 四个入口） |
| 立刻看到 | 导航选中态与内容一致；原外壳保持稳定，目标区短暂淡入轻移；定位从本区根或上次停留的位置开始，不弹三层页面 |
| 慢 / 空 / 失败 / 断线 | 导航和已有内容保留；目标区先显示局部加载或已有缓存；失败给就地重试；断线横幅不定义页面结构、不抢走焦点 |
| 键盘与焦点 | 导航可按 Tab / Enter 操作，选中不只靠颜色；手机读屏知道自己位于第几个 Tab；Mac 内容焦点与侧栏焦点有序连接 |
| 离开再回来 | 每区保留自己的搜索、筛选、选中项、滚动与未提交编辑；无横滑冲突；reduced-motion 只做即时切换或极淡透明度过渡 |

### 2. 从四区进入各自详情并返回

| 项 | 预期 |
|---|---|
| 起点 | 任一区的集合、封面或设置分区，含手机通过通知/命令面板进入的详情 |
| 动作 | 打开项目、对话、远程运行或设置分区，再通过页头返回、系统返回或手机左缘右滑回去 |
| 立刻看到 | 手机在当前区推进详情，Mac 更新对应内容/详情区；返回回到该区域原来的上下文，而不是全局对话列表 |
| 慢 / 空 / 失败 / 断线 | 局部内容可失败/重试，导航与返回保留；没有网络的返回不依赖请求；未保存编辑先经过现有 leave guard |
| 键盘与焦点 | 打开时焦点进入新面的主要内容；返回时回到原触发项；系统返回、按钮、边缘手势同一结果；浮层先关浮层 |
| 离开再回来 | 子页面栈与详情滚动按区域保存；冷启动合成有明确区域归属的父亲；不制造历史环，父级完整规则见下表 |

**手机底栏只在各入口根出现：** 四个同级 Tab 是对话列表 `/sessions`、例行任务 `/routines`、Agent 运维 `/agents`（即 `/settings?tab=operations`）与设置 `/settings` / `?tab=general`；对话详情、导入会话、项目集合与项目封面、远程运行皆隐藏 Tab、保留本区返回；设置按 `?tab=` 分区，任一分区都保留 Tab；新建则是有关闭的专注任务。项目没有独立的手机入口，`/projects/:id` 由对话列表里的项目标题推入。页面栈仍留在原所属区，离开后回该 Tab 恢复它的根/现场。不是全局常驻底栏，也不是用 Back 在各 Tab 之间穿行。

**父级按进入时的证据，从项目打开不丢弃项目。** 原入口的 URL、区域、位置和触发器身份记入该 history entry；从项目封面进对话、导入会话或 `/new` 会回该封面；从列表进则回列表；从通知冷启动则用 [路由映射](ux-unification-story-map.md) 的区域父级。冷启动的父亲只补区域结构，不撒谎恢复没有发生过的滚动/焦点。无 Kin 父级时替换当前面，不盲目 `navigate(-1)` 离开；清除已不复存在的 child，避免历史环。Mac 保持正常浏览器历史与固定侧栏。

| 项目 | 入口 → 冷启动默认父级 |
|---|---|
| `/tasks/:id` / `/agent-sessions/:id` | 实际列表/项目入口；无证据时对话根，原项目入口仍回封面 |
| `/new?cwd=…` | 实际对话根/项目封面；从项目进入时沿用 cwd，多 root 仍显示项目选择器，关闭回封面 |
| `/projects` / `/projects/:id` | 项目根；封面保留摘要、最近一条活动、项目模式、刷新和明确的新建入口 |
| `/machines/:device/tasks/:id` | 实际项目/例程入口；冷启动为 `/routines?device=<原 device>`；原 URL/device 不变 |
| `/agents` / `/usage` | `replace` 到 `/settings?tab=operations`，是设置 → Agent 运维，不改本地 `?tab=agents` |
| `/settings?tab=:id` | general 是带 Tab 的设置根；任一分区都保留 Tab，返回设置根；旧 general/agents/providers/routing/advanced 精确保留 |
| `/inbox?focus=:item` | 保留原 item id，以现有 pending 列表将其解析到真正的 task，再定位匹配审批/问题卡；未匹配不选第一张卡；旧 `/routines?device=:device` 继续选择那一台机器；交付生命周期按本条通知规则执行 |

**通知的处理完成不等于 URL 变了。** 安全归一化后的**原 target（尤其原 `item`/`device` 参数）**独立保存在交付状态中，不能拿已消费并清掉 `?focus=` 的当前 URL 当通知身份。当前或在途的完全相同 target 去重；同一 task 的另一个 item 必须重新送达；离开后同一 target 又是新的点按。旧 `/inbox` 异步解析时保留原值直到鉴权成功、pending 找到对应卡或明确「item 已不存在」、且 leave guard 同意离开；原生 read-and-clear 的链接另有内存中的重试副本，导航真正接受后才确认原生副本。用户拒绝丢弃草稿时停在原页并给不自动导航的重试；新点按取代旧排队目标，完全相同的重复仍抑制。可见 URL 的 focus 清理规则不改，也不借用其他卡顶替。

### 3. 找对话、归档并继续工作

| 项 | 预期 |
|---|---|
| 起点 | 对话区；同一设备 → 项目 → 对话集合中包含活跃、待处理和归档内容 |
| 动作 | 搜索或筛选全部 / 待处理 / 已归档；既有精确的 running/等待/成功/失败/取消筛选仍可达；打开一行继续、新建、改名、置顶、归档、删除 |
| 立刻看到 | 归档只更改对话范围，不高亮另一个导航区；Mac 列表与当前对话并存，手机推进对话；范围、选中与列表滚动连续 |
| 慢 / 空 / 失败 / 断线 | 首载骨架、空态下一步、读失败重试、断线时保留已有数据；运行/审批/导入各行保持原有语义 |
| 键盘与焦点 | 搜索框唯一，⌘F 归属可见区；模型/权限浮层与运行配置按平台换形；所有 IME 键走共享谓词 |
| 离开再回来 | 草稿、流式、审批、diff 与运行设置不因切区卸载；原功能测试继续证明领域行为不变 |

### 4. 从项目或例行任务继续一件事

| 项 | 预期 |
|---|---|
| 起点 | 项目区集合/封面，或例行任务区的机器范围与列表 |
| 动作 | 打开项目封面，编辑摘要、选择 ship/learn/explore/maintain、从原生/导入最近活动继续，或从这里新建；或切机器、编辑/创建/运行例行任务、打开运行详情 |
| 立刻看到 | 项目集合与封面属于同一区的页面栈，不复制第二份对话列表；新建带项目 cwd 且关闭回封面，多种 root 仍交给选择器；例程机器上下文在页内保留，不成为全局导航分叉 |
| 慢 / 空 / 失败 / 断线 | 项目摘要、记录、热力图、活动、例程各自失败、各自保留旧数据；离线机器显式标示，运行读失败可回列表 |
| 键盘与焦点 | 机器选择、编辑、删除与运行有清楚标签和确认；返回原行/封面；Mac 桌面面板与手机 Sheet 各自遵循浮层栈 |
| 离开再回来 | 项目搜索/选中与滚动、例程所选机器和编辑内容保留；项目字段与调度的业务规则不变 |

### 5. 完成设置与 Agent 运维

| 项 | 预期 |
|---|---|
| 起点 | 设置区根，或设置 → Agent 运维分区；包含 Mac 的桌面壳外部托盘 |
| 动作 | 改运行默认值，进入 Agent 分区查看机器/agent/用量、确认接入或手动导入，返回设置和之前的工作区 |
| 立刻看到 | 设置根明确显示分区，Agent 运维不再是全局第五区；选择的设置分区与深链在地址中保留；二级内容不挤住主要表单 |
| 慢 / 空 / 失败 / 断线 | 离线机器与读取失败就地显示；被动查看设置不读秘密或调用第三方；已加载内容不因切区清空 |
| 键盘与焦点 | 表单 label/hint/error 关联、焦点归还、Escape 分层清楚；导入与设置离开保护仍只问一次 |
| 离开再回来 | 表单草稿、分区、机器和滚动保留；旧 `/agents` 和 `/usage` 跳到设置内同一运维功能，通知仍回原对话 |

设置不把改名当迁移：`general` 仍拥有外观/帐户和现有通知权限入口；`providers` 保留 provider 与模型字段；`agents` 仍是本地 Agent 检测、明确刷新/按 provider 导入及角色；`routing` 和 `advanced` 保留额度策略、fallback、价格表与 limits 等原内容。`operations` 才是原 AgentsPage 的机器、目录、用量、发现接入与导入。每个 tab 保留同一 URL；已删除的 remote/notifications 继续落到 general。具体 owner 与字段见 [功能映射](ux-unification-story-map.md#设置分区改位置不丢字段)，不是由三张短帧猜测。

### 6. 建立后续界面的公共边界

| 项 | 预期 |
|---|---|
| 起点 | 任一现有页面或后续要新增的界面，可能为空、加载、失败、断线、运行或等待批准 |
| 动作 | 组合按钮、输入、选择器、菜单、对话框、状态与转场，而不是每页重新发明 |
| 立刻看到 | 同一动作有一致的轻重、形状与反馈；移动与桌面是同一模型的不同形态，不是两套视觉语言 |
| 慢 / 空 / 失败 / 断线 | 每个区域真实拥有的状态都有文字和下一步；骨架不覆盖已有内容；状态更新不抢焦点 |
| 键盘与焦点 | 44px 触达、可见焦点、屏幕阅读器语义与 IME 正确；每个浮层一个键盘所有者；Astryx 不降低这些现有底线 |
| 离开再回来 | URL、草稿、缓存与所选上下文一致恢复；新增面先在 IA 与 story 登记，再写代码 |

## 各面差异

| 面 | 这一面怎么呈现 | 为什么不同 |
|---|---|---|
| Mac | 左侧全局四区导航；对话与项目拥有稳定列表/选中与右侧详情；例程/设置主区按内容排列表单与分区；浮层轻量贴触发点 | 大屏应一眼保留上下文，不用手机 Tab 和底部 Sheet |
| 手机 | 四个底部同级 Tab，分别有根页与详情栈；一级切换淡入轻移，详情推进/返回对称；弹层占据移动安全区内的明确层级 | 390px 只能专注一件内容，但必须保留位置和方向感 |
| 两面 | 四区名称、内容归属、操作结果、四态、URI/深链与操作后的状态一致 | 容器自适应，不是功能两套或一份页面硬缩放 |

## 设计

设计稿：`KIN-CONTINUE-003.figma/frames/`（20 张离线 SVG）和 `KIN-CONTINUE-003.review.html`（Figma 帧为主体，每屏六段用户流程）。

总计划：[UX 整体统一](../../plans/2026-11-14-ux-unification.md)。总设计签字只授权 UX/导航/组件重构，不是新功能或后端变更的授权。

必须画到的状态：默认、空、加载、读失败、断线、运行中、等待批准、鉴权门、草稿返回、reduced-motion、深链父级。鉴权门由已有的 AuthGate/凭据会话合同拥有，不是随页面加载引入的另一个 UI 状态。

## Do not

- 不许将归档、设备或 Agent 运维重新变成第五个一级导航。
- 不许手机四个 Tab 之间仍通过返回键互相穿梭；各栈返回落在自己的区域父级。
- 不许用大幅横滑切换 Tab，或在 UI 已滚动/编辑时重置整个页面。
- 不许为统一而把 Mac 变成放大的手机，也不许将手机四区变成桌面三栏。
- 不许复制对话列表到项目封面，或用“找不到项目”隐藏原对话。
- 不许改 agent 协议、通知语义、数据存储或秘密读取时机。
- 不许无动画偏好支持，不许隐藏的面持有快捷键与焦点。
- 旧 `NAVIGATION.md` D8 / `KIN-CONTINUE-002` 的“四目的地从列表推出”不得与本合同并存；它们保留历史记录，但规范引用只能指向本条。

## 验收

| 层级 | 位置 | Given / When / Then |
|---|---|---|
| 导航 | `ui/src/components/layout/AreaNavigation.dom.test.tsx` | Given 四区中任一区 When 点另一区 Then 新入口与对应内容同时选中，壳不刷新，没有额外返回层 |
| 导航 | 同上 | Given 四区各有筛选/滚动 When 来回切换 Then 各自恢复且不与另一区混用 |
| 返回 | `ui/src/components/layout/PhoneNavigation.dom.test.tsx` | Given 手机详情由区根、通知或冷启动打开 When 按钮/系统/边缘返回 Then 回到该区父级且焦点回原项 |
| 对话 | `ui/src/components/layout/PhoneNavigation.dom.test.tsx` | Given 对话区 When 选归档 Then 区域仍为对话且同一列表换范围；归档不再是底部 Tab |
| 路由 | `ui/src/lib/areaNavigation.test.ts` | Given 旧深链或通知 URL When 打开再返回 Then 原内容可达，父级属于正确区域；/agents 与 /usage 到 operations，?tab=agents 仍是本地 Agent；机器任务保留 device |
| 跨区 | `ui/src/lib/areaNavigation.test.ts` and `PhoneNavigation.dom.test.tsx` | Given 从某项目打开原生/导入对话或新建 When 页头/系统/边缘返回 Then 回原封面、滚动与触发器；关闭项目新建回封面；冷启动用该区默认父级且不会盲目退出 Kin 或开始环 |
| 通知 | `ui/src/lib/notificationRoute.test.ts`, `NotificationTaps.dom.test.tsx`, `TaskDetailPage.dom.test.tsx` | Given /inbox?focus=a1、另一任务的 b2、一个慢 pending 列表和已处理的 card When 点通知 Then 保留 ID，以 pending 解析到真正 task 且只标对应卡；未匹配不选同任务第一张卡并说明；同一冷启动 target 重复仍抑制，focus 消费清理后同 task 的 b2 可导航；离开后重进 a1 可再导航，设备例程继续带 device |
| 交付恢复 | `NotificationTaps.dom.test.tsx` + `ui/src/lib/notificationRoute.test.ts` | Given 鉴权前、pending 尚未到、leave guard 拒绝或 item 已消失 When 点原生通知 Then 原 target 保留到鉴权成功、解析得出明确结果且导航被接受；拒绝停留原页可主动重试，新 tap 替代旧排队、精确重复仍去重，原 read-clear 不是唯一副本；接受导航后才确认原生副本 |
| 键盘 | `ui/src/lib/overlayOwnsKeyboard.dom.test.ts` and `ui/src/pages/macKeyboardWiring.test.ts` | Given 多区缓存、Sheet、菜单或对话框 When 快捷键/IME 输入 Then 只有可见当前层响应 |
| 对话 | `ui/src/pages/TaskDetailPage.dom.test.tsx`, existing START/CONTINUE tests | Given 原有流式/队列/审批/配置/草稿 When 外壳与控件更新 Then 行为未变 |
| 项目 | `ui/src/pages/ProjectDetailPage.dom.test.tsx` | Given 项目深链、单/多 root 与编辑摘要 When 新建、选模式、开原生/导入活动、返回与再进入 Then 新建仍带 cwd 或多 root 选择、关闭回封面、四模式保持、封面滚动恢复且没有第二份完整对话列表 |
| 导入 | `ui/src/components/sessions/AgentSessionSheet.dom.test.tsx`, `ui/src/components/layout/PhonePushTargets.dom.test.tsx` | Given 列表、项目或设置运维打开导入历史 When 读早期历史、继续或返回 Then 来源入口正确，所有原能力可达，attach 路由与历史保持原平台语义 |
| 例程 | `ui/src/pages/RoutinesPage.*.test.tsx` | Given 远程机器与旧在途选择 When 切换区域或运行详情 Then 不误切机器、不错误显示 badge、可返回 |
| 设置 | `ui/src/pages/SettingsPage.leaveGuard.dom.test.tsx`, `settingsTabsWiring.test.ts` and Agents tests | Given general/agents/providers/routing/advanced/operations 的各自字段与旧 tab 深链 When 换形、离开/再回来 Then 所有原字段/角色/按 provider 导入均在，operations 与原 agents 不合并，草稿与分区恢复且无被动秘密读取 |
| 无障碍 | `ui/src/components/layout/AreaNavigation.dom.test.tsx` and browser | Given 触屏、外接键盘或 reduced-motion When 导航 Then 44px、可见焦点、读屏 Tab 位置与无位移均成立 |
| 视觉 | 390×844 / 1100×760 / 1280×800 | Given 四个区域及详情 When 执行 J1–J7 Then 四区位置稳定、Mac 双栏与手机栈分别成立、没有意外重排或重复列表 |
| 组件 | `python3 scripts/ui_inventory.py` + UI tests/lint | Given 迁移过的面 Then 裸按钮/手写 menu/dialog/tab 下降，旧写法不能回流；证据回填到总计划 |

已签字，registry 登记了本故事的可执行测试：四区表与路由/父级表、Mac 四区栏、手机四栈、通知目标与交付恢复、浮层键盘、设置离开守卫、项目封面与导入会话详情。登记集里包含真正挡住旧导航的表驱动测试——`areas.test.ts`、`areaNavigation.test.ts`、`AreaNavigation.dom.test.tsx`，以及部分覆盖的 `notificationRoute.test.ts`（/agents、/usage 退回列表，或从四区表删除一个区时变红）；其余登记文件守住各自面的行为，不是只按路径存在。不另造 pendingTests 字段混淆执行真相。

测试文件或测试名必须出现 `KIN-CONTINUE-003`。第 10、13、14 行点名的 `TaskDetailPage.dom.test.tsx`、`RoutinesPage.*.test.tsx` 与 Agents 相关测试暂不带本故事 id：这三个文件由各自的平行故事/批次拥有，这里只登记引用，补 id 随那些批次落地。真实旅程最终统一验收，不在每个内部批次请人确认。
## 证据

- 设计源：`KIN-CONTINUE-003.figma/frames/`（20 张）。2026-11-17 补记：帧 01/04/06/07/08/15/16 早于 IA D8，仍画「对话/项目/例行任务/设置」底栏或让 Agent 运维隐藏 Tab，已作废；现行契约以本故事 §2 为准——四个入口是 对话 / 例行任务 / Agent 运维 / 设置，`/projects/:id` 由项目标题推入，Agent 运维分区保留 Tab。
- 集中审阅：`KIN-CONTINUE-003.review.html`。
- 当前问题：用户 2026-11-14 明确指出导航没有对话入口、归档被错误提升、入口间缺乏统一转场，且 Mac 与手机结构不统一。
- 交付证据（2026-11-19，`rsi/continue-003-final-walk` 树）：`bash rsi/runtime/ux-walk.sh <worktree> <outdir> J1,J2,J3,J4,J5,J6,J7` 退出 0，`walk.json` 为 `hardFail: []`，J1–J7 全部出现，共 156 张截图（每张同名 `.aria.txt` 无障碍快照），存于 `rsi/state/shots/continue-003-final-walk/`。宽度按各旅程声明：J1 仅 phone 390×844；J2 mac 1100×760 与 mac-wide 1280×800；J3 phone 与 mac；J4 phone、mac 与 mac-wide；J5/J6/J7 phone 与 mac。代表截图：`J1-phone-02-search`、`J1-phone-04-approval-card`、`J2-mac-05-workspace-panel`、`J2-mac-wide-10-diff-comment-sent`、`J3-phone-13-midrun-queued`、`J3-mac-16-stopped`、`J4-phone-02-project-cover`、`J4-mac-wide-20-cwd-chosen`、`J5-mac-02-row-actions`、`J6-phone-03-legacy-agents-redirect`、`J7-mac-01-landing-card`。
- 登记的套件在同一棵树全绿（2026-11-24 重跑；`ProjectDetailPage.dom.test.tsx` 已随项目封面退役，故从清单移除，余 11 个文件）：`npx vitest run src/lib/areas.test.ts src/lib/areaNavigation.test.ts src/components/layout/AreaNavigation.dom.test.tsx src/components/layout/PhoneNavigation.dom.test.tsx src/lib/notificationRoute.test.ts src/components/NotificationTaps.dom.test.tsx src/lib/overlayOwnsKeyboard.dom.test.ts src/pages/macKeyboardWiring.test.ts src/pages/SettingsPage.leaveGuard.dom.test.tsx src/pages/settingsTabsWiring.test.ts src/components/sessions/AgentSessionSheet.dom.test.tsx` → 11 files / 143 tests passed。走查前先跑这组基线，绿后才开始走查。
- 走查修正了一处夹具时序、未放宽断言：`scripts/journeys_fake_agent/claude` 的 `[seed] slow` 保持改为覆盖整段回答（含项目指令回显）。此前回显先于 10 秒保持输出，`shouldShowGenericThinking` 会在首段文本落地后收起等待行，J3 的等待行断言因此变成竞态（同一命令修正前连续两次 `hardFail` 各 5 条，修正后为 `[]`）。
- 验收逐行证据（行号按上表顺序）：
  1. 导航/选中态：登记 `AreaNavigation.dom.test.tsx`；J6 `03-legacy-agents-redirect` 与 J4 `01-projects` 在 390/1100/1280 保持同一外壳。
  2. 导航/区域状态：登记 `AreaNavigation.dom.test.tsx`；J2、J3 的 390/1100/1280 截图未见重排或重复列表。
  3. 返回：登记 `PhoneNavigation.dom.test.tsx`；J7 `02-back-list`→`03-back-card` 在 390 与 1100 回到原列表与原卡。
  4. 对话/归档：登记 `PhoneNavigation.dom.test.tsx`；J1 `01-list` 的筛选行仍在对话区内。
  5. 路由：登记 `areaNavigation.test.ts`；J6 `03-legacy-agents-redirect` 现场证明 `/agents` 落到 `?tab=operations`。
  6. 跨区：登记 `areaNavigation.test.ts` + `PhoneNavigation.dom.test.tsx`；J4 `01-projects`→`02-project-cover` 从项目集合进入封面。
  7. 通知：登记 `notificationRoute.test.ts` + `NotificationTaps.dom.test.tsx`；`TaskDetailPage.dom.test.tsx` 由 START/RESULT 故事登记引用。J7 `01-landing-card` 在 390/1100 落在确切卡。
  8. 交付恢复：登记 `NotificationTaps.dom.test.tsx` + `notificationRoute.test.ts`；J7 `03-back-card` 回原卡。
  9. 键盘：登记 `overlayOwnsKeyboard.dom.test.ts` + `macKeyboardWiring.test.ts`；J1 `06-conversation-focus`、J3 `11-run-config-closed-focus` 在 390/1100 显示焦点归还。
  10. 对话/现有行为：`TaskDetailPage.dom.test.tsx` 与 START/CONTINUE 既有测试由各自故事登记引用；J3 在 390/1100 完成发送、排队、回复与停止（`12-sent`、`13-midrun-queued`、`16-stopped`）。
  11. 项目：登记 `ProjectDetailPage.dom.test.tsx`；J4 `02-project-cover` 在三个宽度显示封面与工作方式。
  12. 导入：登记 `AgentSessionSheet.dom.test.tsx`；J6 `02-operations` 保留导入入口。
  13. 例程：`RoutinesPage.*.test.tsx` 由 ROUTINE 故事登记引用；J4 `16-routines`、`17-routine-editor`、`18-cwd-browser-open` 在三个宽度运行。
  14. 设置：登记 `SettingsPage.leaveGuard.dom.test.tsx` + `settingsTabsWiring.test.ts`；Agents 测试由 AGENTS 故事登记引用；J6 `01-settings`、`02-operations`、`04-default-agent-row`、`05-new-chat-host`。
  15. 无障碍：登记 `AreaNavigation.dom.test.tsx` 持有 44px 与 reduced-motion；走查为每张截图留下同名 `.aria.txt`，四区入口以 navigation/链接呈现（如 `J1-phone-01-list.aria.txt`）。
  16. 视觉：本行即本次走查——J1 390；J2 1100+1280；J3/J5/J6/J7 390+1100；J4 390+1100+1280；`hardFail: []`。
  17. 组件：`python3 scripts/check-ui-inventory.py` 未增长；`./scripts/check.sh` 绿（本故事未改 `ui/src`，只改夹具与证据）。

## 变更记录

- 2026-11-14 创建，按用户选择：四区为 对话 / 项目 / 例行任务 / 设置；Mac 同构侧栏双栏；一级克制动效、二级对称转场、区域状态保留；保留 Kin token、采用 Astryx 交互底座。
- 2026-11-14 取代 `KIN-CONTINUE-002` 和 `NAVIGATION.md` 手机目的地模型；将项目提升为一级集合而不是取消项目封面能力。
- 2026-11-17 签字并登记测试（CEO 代签，授权见 rsi/DECISIONS.md）；Astryx 计划 62/62 已合并，四区导航与其测试在 main。
- 2026-11-19 J1–J7 在 390×844 / 1100×760 / 1280×800 走查完成，`hardFail: []`，12 个登记套件全绿；状态改为 covered。同时修正 fake agent 的 `[seed] slow` 保持顺序，使 J3 的等待行窗口确定（断言未放宽）。
- 2026-11-24 退役封面（KIN-CONTRACT-001，PR #665）：`/projects/:id` 删除，导航合同里的项目目的地改为 `/sessions?project=<id>`（`replace`，不新增历史层）；`ProjectDetailPage.dom.test.tsx` 随页面删除，四区导航的其余部分与测试不变。
