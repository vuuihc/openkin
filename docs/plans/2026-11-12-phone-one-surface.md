# 手机只留一个导航面 · 2026-11-12

状态：**已交付**：复审、提交、快进合入、桌面重建与 Hub 部署均完成。故事 `KIN-CONTINUE-002`（B 形态）已签字，本文件是这一轮的进度表。

## 现在的位置

| 项 | 状态 | 证据 |
|---|---|---|
| 代码与测试 | ✅ 完成 | 47 改 + 11 个新代码文件 + 5 删；`npx tsc --noEmit` 干净；全套 208 文件 / 2089 例通过 |
| 仓库门禁 | ✅ 绿 | `./scripts/check.sh` 14 项全绿（含 `stories`） |
| 红验证 | ✅ 30/30 红 | `/tmp/kin-mutants-phone.json`：第五个入口、归档丢范围、入口不记返回、冷深链回退、边缘滑不提交、取消仍提交、侧栏回到手机、关闭草稿走回退、项目页丢自己的返回、失败态丢重试、列表丢滚动位置、面板叠目的地、手机冷启动回对话、深链无父级、详情页自写回退、滚动不记录、外壳/面板绕过页面守卫、缺 matchMedia、丢 hash、未安装父级合成、滚动信号数标题、面板离开再次追问（两处）、外壳重复追问、加载行期间仍重试、侧栏把点击事件当参数 |
| 高模型复审 | ✅ 无 blocker / major | 首轮 2 blocker / 6 major / 9 nit；二轮 1 blocker（守卫被绕过）+ 1 major（滚动只读不写）；三轮 2 major（面板「新建」行先跳后问、滚动重试观察错节点）；四轮确认面板已闭，指出滚动恢复的信号仍是标题数；五轮 delta 复审确认该 major 关闭、只问一次的链路正确，另指出三处 nit（加载行会吞掉恢复重试、侧栏点击参数无人钉住、计数过期），均已修复或加固 |
| 提交 / 合入 | ✅ 完成 | `3d546705 feat(mobile): make the chat list the phone's only navigation surface`，正文带 `KIN-CONTINUE-002`；`main` 已快进到同一提交 |
| 桌面与 Hub | ✅ 完成 | 桌面包已重建，`:7777` 与 `web/dist/index.html` 同为 `index-GDgZ9gjn.js`；Hub 镜像已部署，公网入口 chunk 同值，容器 healthy，回滚镜像 `openkin:dogfood-prev` 保留 |

## 这一轮做了什么

签字内容（2026-11-12）：B 形态，D1 改为「归档保留在列表页，导入放到 Agent 运维」，D2–D4 同意。

- 手机只留一个导航面：`/sessions` 是唯一根，顶部标题 + 一个搜索，中间共享列表，底部恰四个入口（归档、例行任务、Agent 运维、设置），右下新建。
- 删掉抽屉与 dock：`MobileDock.tsx`、`useDrawerSwipe.ts`、`useCloseOnWideScreen.ts` 及测试；`Sidebar.tsx` 收敛为桌面专用（不再有 `mobileOpen` / 抽屉）。
- 归档是同页范围 `?scope=archived`，切换时保留已有 `search` / `status`；导入只在 Agent 运维页，列表页没有导入入口。
- 目的地（例行任务、Agent 运维、设置）整页推出，返回一步回列表；焦点经 `placeReturn`（sessionStorage）回到入口。
- 对话、草稿、冷深链都以列表为父：`goBackToList` 有历史时 `-1`，无历史时 `replace` 到 `/sessions`；关闭草稿一律 `replace` 到列表，不留下第二层。
- 左缘右滑返回：`useEdgeSwipeBack`，20px 内起手、64px 或快速甩动提交；列表页本身没有这个手势。

## 测量

- 变更：已跟踪 diff 52 个文件 +1086 / −1390（含文档）；另有 11 个新代码文件（`PhoneFooter.tsx`、`PhoneNavigation.dom.test.tsx`、`useEdgeSwipeBack.ts` + 测试、`phoneBack.ts` + 测试、`placeReturn.ts`、`phoneDeepLinkParent.ts` + 测试、`leaveGuard.ts`、`useLeaveGuard.ts`）与 1 份本计划；删除 5 个（dock、抽屉、宽屏关抽屉及其测试）。
- 测试：`PhoneNavigation.dom.test.tsx` 17 例（新）、`useEdgeSwipeBack.test.tsx` 7 例（新）、`phoneDeepLinkParent.test.ts` 7 例（新）、`phoneBack.test.ts` 3 例（新）、`SessionsPage.dom.test.tsx` 15 例（重写）、`CommandPalette.dom.test.tsx` 新增 5 例、`Sidebar.dom.test.tsx` 新增 2 例；全套 208 文件 / 2089 例。
- 红验证：30 个 mutant，30/30 红，恢复逐字节一致。

## 复审修复（首轮 → 第二轮）

- **Blocker 1 读失败无重试**：失败态加「重试」按钮，刷新当前作用域的列表；`SessionsPage.dom.test.tsx` 钉住点击确实重取。
- **Blocker 2 项目页绕过未保存确认**：`/projects/:id` 归入详情路由，外壳不再画第二条返回；项目页自己的返回保留 `canLeave` 确认。
- **Major 3 系统返回**：冷深链在路由挂载前由 `lib/phoneDeepLinkParent.ts` 把 `[X]` 改写为 `[/sessions, X]`，浏览器 Back 落到列表；jsdom 里真的 `history.back()` 验证。
- **Major 4 面板跳转叠层**：手机从非列表的面跳转改为 replace，历史始终「列表 → 当前面」。
- **Major 5 冷启动冲突**：手机 `/` 落列表（`StartRoute`），Mac 仍回上次对话；`KIN-CONTINUE-001` step 1 的手机半边在变更记录里写明被本条取代。
- **Major 6 pointercancel**：取消视为放弃，不再提交返回；补取消与鼠标测试。
- **Major 7 返回实现分叉**：对话页、项目页、外部会话页统一调用 `goBackToList`；源码守卫钉住。
- **Major 8 列表滚动位置**：`MobileScreen` 的 `scrollKey` 记住滚动位置，回到列表恢复；内容未长出来时不覆盖旧值。
- **Nits**：`placeReturn` 只接受已知 id、草稿转对话时清除；删掉 dock/drawer 的 CSS、未用的 `clamp` 与过期注释；zen 隐藏底部入口与 FAB；FAB 排到 footer 之后；列表底部留出 FAB 的空间；NAVIGATION 的规则与 `/new` 父级、D4 措辞同步。

## 第二轮复审修复

- **Blocker：守卫被绕过**。新增 `lib/leaveGuard.ts` 与 `useLeaveGuard`；页头返回、左缘手势与命令面板跳转离开前都先问当前页。项目页注册 `canLeave`（未保存摘要确认），例行任务页注册 `closeForm`（表单脏时确认）。
- **Major：滚动只读不写**。`MobileScreen` 的保存监听改为无条件安装：没有存档时从第一帧就能记录；恢复被内容高度卡住时不覆盖旧值，触摸但没滚动也不写入；写入按 300ms 节流，卸载时补一次。
- **Nits**：缺 `matchMedia` 时回退宽屏而不是抛错；重推的深链保留 hash；`main.tsx` 的调用有源码守卫；归档范围的重试有断言；查看位置改为 effect 里读取（StrictMode 下不吃掉标记）；三处过期注释与测试名修正。

## 第三轮复审修复

- **Major：面板「新建」行先跳后问**。`openNewChat` 自己先问守卫（覆盖 ⌘N），面板行在任何动作前再问一次并在「新建」后直接返回，不再走第二次跳转。
- **Major：滚动重试观察错节点**。不再观察滚动容器自身的盒子（它随行数变化也不变），改由列表传入行数 `scrollWhen`；恢复只在存档位置真正可达时才算完成，数据到达后按行数变化重试。

## 第四轮复审修复

- **Major：滚动恢复的信号数的是标题，不是行**。归档范围在任务到达前就为每个归档项目种下标题，标题数在首帧已经定稿，恢复永远等不到下一次重试。`scrollWhen` 改为行数（`listed.reduce((n, b) => n + b.rows.length, 0)`），并补归档范围的恢复测试：先种标题、首帧被截断，行到达后必须回到存档位置。
- **Nits**：面板行离开只问一次——行内问过页面后，答案随调用传给 `onNewChat(true)` / `go(path, true)`，页面不会再弹第二次确认；侧栏的「新建」按钮改为 `() => onNewChat()`，避免把点击事件当成「已问过」的参数。故事与计划补齐延期说明。

## 第五轮（delta）复审修复

- **Nit：加载行会吞掉恢复重试**。机器列表或归档列表尚未就绪时，正文还不是行，行数却可能已经定稿；机器列表随后结束加载并不会改变行数。`scrollWhen` 在 `loading` 期间固定为 `-1`，内容真正绘制时再移动；补冷重载测试（行已知、机器列表后到）。
- **Nit：侧栏点击参数无人钉住**。`Sidebar` 的 `onClick` 改为 `() => onNewChat()`，并加测试断言回调收到零参数；`openNewChat` / `go` 只把字面 `true` 当作「已问过」，即使事件对象误入该槽位也会照常问守卫。
- **Nit：计数过期**。计划里的 mutant 数与测试数已按实测更新。

## 已知限制

- 手机底部没有例行任务未读角标（本轮范围外）。
- Mac 左栏保留自己的导入菜单；只有手机列表页不再有导入入口。
- 帧里的三处细节未按图实现，按可用性保留现状：加载态是文字行而非骨架行、空态只有指路文案没有第二个「新建」按钮、归档范围在折叠的筛选面板里而不是常驻范围条。
- 浏览器 / 系统的返回键不经过 `leaveGuard`：页内返回、左缘手势、面板跳转与 ⌘N 会先问页面，但脏表单时按系统返回仍会直接离开（浏览器不提供拦截返回键的入口）。
- 导入会话（Agent sessions）读取失败只有提示条，没有重试：重试按钮重取的是 live / archived 任务列表，不重取导入会话。
- 键盘滚动（PageDown / 空格）不被当作「读者自己接管」：待恢复的位置在后续内容变化时仍可能把读者拉回存档点；触摸与滚轮会正确让位。
- 恢复是否「落定」在 jsdom 里不可观察：测试只能断言 `scrollTop` 被再次写入，真实浏览器里以可达高度为准的 settle 分支没有自动化覆盖。

## 落地

- 提交 `3d546705`，`main` 快进到同一提交；工作树干净。
- 桌面重建后 `:7777` 入口 chunk `index-GDgZ9gjn.js`，与 `web/dist/index.html` 一致。
- 真浏览器（390 / 1100，本地留存 `kin-phone-390.png`、`kin-phone-390-archived.png`、`kin-mac-1100.png`）：390 一页列表、一个搜索、四个底部入口、无抽屉无 dock，行 → `/tasks/…` → 页内返回落列表，归档是同页 `?scope=archived` 且搜索仍在，冷开 `/settings` 后系统返回落 `/sessions`；1100 左栏与对话面不变；无页面错误。
- Hub 镜像 `f8ec820e`（回滚 `edff1afa`）部署到 NAS，容器 healthy，公网 `/` 的入口 chunk 与本地一致。

## 下一步

无。剩余待办只有「已知限制」里列出的范围外事项。
