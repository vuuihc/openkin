# 导航契约：三个区域，两端一套

状态：**按已批准执行（KIN-CONTINUE-003，2026-11-15 `rsi/DECISIONS.md`；KIN-CONTRACT-001，2026-11-22 退役项目区；故事文件在 `registry.json` 里仍是 draft）。**
2026-11-17 由 G2 按已交付的 S1 / S1b / S2 / S2b / S3 重写；2026-11-22 KIN-CONTRACT-001 把项目区并回对话列表。本文件**取代** 2026-11-12 的手机 B 形态（手机只留一个导航面、目的地都从列表推出）与 2026-11-10 草案的手机 D1（留抽屉）。
配套：[`IA.md`](IA.md)（谁拥有哪个概念，D8）、[`TASTE.md`](TASTE.md)（视觉规则，第 20 条是动效）、[`stories/ux-unification-story-map.md`](stories/ux-unification-story-map.md)（签字的路由与栈合同）、[`stories/KIN-CONTINUE-003.md`](stories/KIN-CONTINUE-003.md)。

## 0. 一句话

控制台有**三个区域**：对话、例行任务、设置。项目不是区域：它的层级由对话列表的设备 → 项目 → 对话画出，`/projects` 只是重定向到列表（KIN-CONTRACT-001）。区域只在一张表里定义（`ui/src/lib/areas.ts`），每个导航面都读这张表；Mac 是左缘一条区域栏，手机是四个入口压在各自区域的根上、同区的深一层是推入；返回只有一条路：推入的详情一步回到对话列表（带它上次的搜索 / 状态 / 归档范围）。

## 1. 区域表

| 区域 id | 根 URL | 图标 / 文案 | 拥有什么 | Mac 入口 | 手机入口 |
|---|---|---|---|---|---|
| `conversations` | `/sessions` | `sessions` / `nav.sessions` | 对话集合（设备 → 项目 → 对话）、按项目收窄（`?project=`）、搜索 / 状态 / 归档范围、对话详情、新建、导入会话详情 | 区域栏「对话」⌘1；回到 `lastListUrl()`（带搜索 / 状态 / 范围） | 底部「对话列表」 |
| `routines` | `/routines` | `routines` / `nav.routines` | 机器选择、例行任务、最近运行（运行详情是共享的 `/tasks/:id?device=`） | 区域栏「例行任务」⌘2，带未读结果角标 | 底部「例行任务」 |
| `settings` | `/settings` | `settings` / `nav.settings` | 通用、本地 Agent 与角色、模型提供方、额度与路由、高级、Agent 运维 | 区域栏「设置」⌘3 | 底部「设置」和「Agent 运维」（Agent Ops，`?tab=operations`） |

- 每个区域有且只有一个根 URL 和一个 `nav.*` 文案键；角标：待批准挂在对话上，未读例程结果挂在例行任务上。
- Mac 的区域栏是 208px 带文字的列；右侧面板打开或窗口窄于 1280 时收成 64px 图标栏（`railCompact`）。⌘1–⌘3 直接切区域。
- 手机底部是四个**入口**，不是三个区域 id：`PHONE_TAB_IDS` = `sessions` / `routines` / `agents` / `settings`（`ui/src/lib/phoneNavigation.ts`）。`agents` 不是第四个区域——它是设置区的 **Agent 运维**分区；`projects` 既不是区域也没有底部入口（见 §5）。

## 2. 路由表

`App.tsx` 的 `<Routes>` 是实际路由；本表只记录它们归哪个区域、手机返回落到哪、哪些参数必须留下。

| URL | 区域 | 面 | 手机父级 | Back 与参数保留 |
|---|---|---|---|---|
| `/` | 对话 | 启动路由 | 无（改写成区域根） | Mac 回到上次的对话，没有则 `/new`；手机 `replace` 到 `/sessions` |
| `/sessions` | 对话 | 集合（手机上就是列表；Mac 主区显示新建页，列表在左栏） | 根 | `?search=`、`?status=`、`?scope=` 全部保留；`scope=archived` 是同一份列表的范围，不是入口 |
| `/inbox` | 对话 | 旧通知落点 | 根（重定向） | `replace` 到 `/sessions`；点按携带的 `?focus=<item>` 由 `NotificationTaps` 原样导航到 `/inbox?focus=<item>`，重定向丢掉它，不会挂到错误 task（旧的 focus 助手已随死代码删除；通知点按现在走 `/tasks/:id?focus=`，KIN-CONTINUE-003） |
| `/approvals` | 对话 | 旧通知落点 | 根（重定向） | `replace` 到 `/sessions`，理由同上 |
| `/tasks/:id` | 对话 | 一段对话（`TaskSessionHost` 渲染，在 `<Routes>` 外） | `/sessions` | task id、`?focus=` 保留；列表的搜索 / 状态 / 范围跟着列表父级回来 |
| `/new` | 对话 | 新建对话 | `/sessions` | `?cwd=` 和草稿保留；关闭回列表 |
| `/agent-sessions/:id` | 对话 | 旧导入会话 URL（重定向） | `/sessions` | `replace` 到 `/sessions?agent=<id>`（R-agent-retire 5a）；列表不动，sheet 开在该列表上方，关闭去掉参数回到同一份列表；继续后手机替换成对应的 `/tasks/:id` |
| `/projects` | 对话 | 旧项目区根（重定向） | 根（重定向） | `replace` 到 `/sessions`（KIN-CONTRACT-001）；项目层级由列表画出，书签 / 通知落在这里也落到列表 |
| `/projects/:id` | 对话 | 旧项目封面（重定向） | 根（重定向） | `replace` 到 `/sessions?project=<id>`（KIN-CONTRACT-001）；项目 id 保留为收窄条件，摘要 / 工作说明 / 目录在这份列表的项目行里编辑 |
| `/routines` | 例行任务 | 机器内的例程列表 | 根 | 显式 `?device=` 优先于记忆值，缺失机器按既有 fallback 修正 |
| `/tasks/:id?device=<device>` | 对话（同一份任务详情） | 远程运行详情（只读）：任务行与 transcript 向 `?device=` 指定的机器要 | `/sessions` | task id 与 `?device=` 保留；旧的 `/machines/:device/tasks/:id` 以 `replace` 到这里（原 query 保留）；批准、回复、停跑仍在机器自己的 console |
| `/agents` | 设置 | Agent 运维（旧 URL） | 根（`agents` 是手机入口 id，无合成父级） | `replace` 到 `/settings?tab=operations`（#141 `71402048`）；不再有独立的 `AgentsPage` |
| `/usage` | 设置 | 用量（旧 URL） | 根（重定向；不是入口，手机冷启动先合成 `/sessions`） | `replace` 到 `/settings?tab=operations`（#141 `71402048`） |
| `/settings` | 设置 | 设置根（= `?tab=general`） | 根 | 分区 ID 见下；手机是设置根里的分区切换（原地），Mac 是左内栏 |
| `/settings?tab=<id>` | 设置 | 指定分区 | 根（原地改内容，不叠层） | `SETTINGS_TAB_IDS` = `general` / `agents` / `providers` / `routing` / `advanced` / `operations`；`?tab=agents` 永远是**本地 Agent 与角色**，`operations` 才是 Agent 运维；已删除的 `remote`、`notifications` 折回 `general` |
| `*` | 对话 | 未知路径 | 根 | `replace` 到 `/new`；鉴权通过后才落到安全根，不在登录门前解析任意 URL |

手机上的推入有一条统一规则（`lib/phoneNavigation.ts` 的 `phonePush`）：从任何非列表面打开对话、新建或详情，先把当前条目替换成列表的上次 URL，再把目标压在上面。所以手机上**每一段推入的详情，Back 一步回对话列表**；表里的「手机父级」也是冷启动时由 `phoneDeepLinkParent` 合成的条目。手机入口之间是同级：`/routines`、`/settings`、`/sessions` 互相切换用 `replace`；`agents` 入口落到 `/settings?tab=operations`，旧的 `/agents` URL 也 `replace` 到那里，不靠 Back 穿梭。

「每一页拥有什么」以本表为准；同一个概念在别处再出现就是重复。手机上只有三个区域根显示底部入口；推入的详情提供返回，不再显示入口。

## 3. 规则

| # | 规则 | 反例 |
|---|---|---|
| R1 | **只有一份对话列表**：Mac 在左栏，手机在 `/sessions`；两处共用 `SessionList`，搜索、过滤、排序、行操作一致 | 列表页之外再出现一份带搜索的列表；Mac 主区再画一遍列表 |
| R2 | **每个面只有一个父级**；页头返回、系统 / 浏览器返回、左缘右滑三者同一行为：弹出一个面 | 页头返回和手势各走各的；从设置返回落到 Agent 运维 |
| R3 | **左缘右滑永远是返回**，永远不开任何抽屉或菜单 | 在对话里侧滑弹出导航面板 |
| R4 | **三个区域来自一张表**（`ui/src/lib/areas.ts`）；路由、区域栏、⌘K、通知落点都读它，不各自维护目的地清单 | 某个页面自己发明第四个区域或第二条导航根 |
| R5 | **手机入口是目的地，不是 tab**：每个入口记住并回到自己区域上次的 URL（列表的搜索 / 状态 / 范围、`?device=`、`?tab=`），记不住或不再属于该区域时回自己的根；跨区切换不靠 Back 穿梭 | 从设置返回落到 Agent 运维；切回对话丢掉搜索词 |
| R6 | **浮层先退，面再退**：Back 先关浮层（`backStack`），再弹页面 | 浮层开着时返回把整页弹走 |
| R7 | **深链冷启动合成对话列表父级**：直接打开 `/tasks/:id`、`/projects/:id`、`/agent-sessions/:id` 或远程运行，返回必须落到列表，而不是无路可走或退出应用 | 冷启动进对话后 Back 直接退出 Kin |
| R8 | **新增导航面必须改 §2 的表**；表里没有的行，不许上线 | 新页面自己发明一个返回规则 |

R2 的实现：路由已经进 history；页头返回、对话页自己的返回和左缘右滑都调用 `lib/phoneBack.ts` 的 `goBackToList()`，系统返回的冷启动由 `lib/phoneDeepLinkParent.ts` 在路由挂载前把 `[X]` 改写成 `[/sessions, X]`。Mac 不用手机栈：区域栏始终可见，主区保留普通浏览器历史（story map 规则 6）。

## 4. 动作说明方向

一次导航是一种**到达**，由 `ui/src/lib/areaTransition.ts` 判定，`AreaRoute` 把结果写进 `.kin-route` 的 `data-motion`：

| 到达 | 什么时候 | 动效 |
|---|---|---|
| `area` | 跨区域（对话 → 例行任务） | 160ms，淡入 + 竖直 4px |
| `push` | 同区进入更深一层（列表 → 对话 / 项目封面 / 远程运行） | 180ms，淡入 + 水平 8px |
| `pop` | 同区回到更浅一层 | 160ms，淡入 + 反向 8px |
| `swap` | 同深度的详情 → 详情（对话 → 导入会话） | 不动 |
| `none` | 原地改内容（`?tab=`、`?search=`、`?focus=`、重定向）或未知路由 | 不动 |

- 深度是表（`ROUTE_DEPTH`），不是从 URL 段数猜的：`/tasks/:id`（含 `?device=` 的远程运行）、`/agent-sessions/:id`、`/projects/:id` 是 1，其余是 0；旧 `/machines/:device/tasks/:id` 在它 `replace` 出去之前仍按 1 计。
- 每次到达都保留 140ms 的透明度淡入；`area` / `push` / `pop` 在这之上加几像素位移。
- **减少动态只保留淡入**：`prefers-reduced-motion: reduce` 时所有位移去掉，只剩 140ms 透明度淡入；`swap` 和原地改动对任何人都不动（TASTE 20）。
- 只有 `.kin-route` 的包裹层可以动。`.kin-main`、keep-alive 宿主和任何被 portal 的浮层的祖先都不许有 `transform`——它会让 `position: fixed` 改以页面为包含块。

## 5. 现在与合同的距离

这些是**已知差距**，不是允许随手补的洞：

1. **项目不是区域。** 项目层级由对话列表的设备 → 项目 → 对话画出；`/projects` 和旧封面 `/projects/:id` 都重定向到 `/sessions`；项目标题把列表收窄到该项目（`?project=`），不新增返回层（KIN-CONTRACT-001）。加一个「项目」区域或入口需要一条自己的签字故事，不能在实现里顺手加。
2. **入口 id 不是区域 id。** `sessions` / `agents` 是手机入口和历史模块的名字；区域叫 `conversations` / `settings`。不许把 `PHONE_TAB_IDS` 当成区域表，也不许为了「对齐」改用户的四个入口。
3. **按区域的冷启动父级还没接线。** `ui/src/lib/areaNavigation.ts` 的 `coldStartPhoneParent` 已写出签字地图的按区父级（旧项目封面 → `/sessions`、设置分区 → `/settings`、远程运行 → `/routines?device=`），也有测试；但实际安装的 `phoneDeepLinkParent` 仍只合成 `/sessions`。旧封面与它一致；设置分区与远程运行在接入前，手机冷启动的 Back 仍落到对话列表。
4. **「原入口返回」在手机上还没实现。** 从 Agent 运维打开的对话，Back 回对话列表，不回运维页：`phonePush` 的既有规则是「列表是对话的唯一父级」。签字地图的入口证据返回目前只在 Mac 的普通历史上成立。接这条线要改 `phonePush` 和它的合同测试，不能在某个页面里单独写一份。

## 6. 怎么防止再腐烂

- 本文件里可机检的部分由 `ui/src/lib/navigationContract.test.ts` 守住：每个区域、根、手机入口、`App` 拥有的每条路由、动效种类与「减少动态只淡入」、以及 IA 里 D8 的四个入口。词句可以改，契约字面不能丢。
- 行为由现有测试守住：`AreaNavigation.dom.test.tsx`、`areaNavigation.test.ts`、`areas.test.ts`、`areaTransition.test.ts`、`AreaRoute.dom.test.tsx`、`PhoneNavigation.dom.test.tsx`、`PhonePushContract.dom.test.tsx`、`phoneBack.test.ts`、`phoneDeepLinkParent.test.ts`。
- 新增页面或导航控件：在同一个 commit 里先改 §2 的表，再写代码；表里没有的行就是没定义。
