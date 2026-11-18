# KIN-RESULT-002 · 读懂文件、预览并返回原对话

状态：covered
优先级：P0
旅程：J4
归属面：`IA.md`「对话详情 → 文件工作区」
面：Mac、手机

## 谁、什么时候、为什么

当我在 Kin 手机上读对话生成的文件、diff 或 HTML 设计稿时，我想打开正确的文件、清楚返回文件列表或原对话，并用链接再次打开，以便不会困在全屏预览，也不必从列表逐层找文件。

## 现在

文件属于某段对话的工作区，没有通用文件管理器；`.html` / `.htm` 只显示代码。手机回列表只有小图标，外层关闭只有 ×；选择没有 URL。已有 task/file 权限、目录、diff 和远程读取继续复用，不恢复 `/artifacts`。

## 范围

- 做：手机文件列表 → 文件 / diff → 列表，及面板 → 对话；返回有文字/图标、至少 44px 触达和焦点恢复，系统返回与边缘手势走同一状态机。
- 做：`/tasks/:id?panel=files&file=<相对路径>` 直达当前 source 文件；无登录时沿用 AuthGate，登录后保留完整同源地址。
- 做：自包含 `.html` / `.htm` 的「预览 / 源码」切换；保留现有文本/图片/表格/下载、机器与 generation 本地行为。
- 不做：通用文件管理器、Artifacts、后端文件协议、工作区脚本、generation/diff 深链、四区导航或 Astryx 底座。

## 每一步的预期

### 1. 定义与定位：一个文件状态机

| 项 | 预期 |
|---|---|
| 起点 | 手机对话、文件列表，或含 task/panel/file 的同源 Kin 链接；Mac 同一对话 |
| 动作 | 从 Files 打开面板；选文件/diff；点「文件」或「对话」，或系统 Back/边缘手势 |
| 立刻看到 | 详情→列表、面板→对话的出口稳定且 ≥44px；Mac 保持列表/详情双栏 |
| 慢 / 空 / 失败 / 断线 | 标题和返回不消失；读取失败在详情内显示原因和**新增的重试按钮**；路径无效/文件消失不空白 |
| 键盘与焦点 | 进入详情聚焦返回；回列表恢复原行/滚动/焦点；关闭回原 Files 触发器，冷启动回页面 Files 按钮，再退到消息流 |
| 离开再回来 | 刷新按 URL 恢复 source 文件；关闭清 file/panel；普通打开 Files 不重放旧文件 |

手机只认这三种面板状态，不能拿现有 `phonePush` 的同路径替换规则代替它：

| 状态 | URL | 历史 / 返回 |
|---|---|---|
| 对话 | `/tasks/:id`，无 panel/file | 沿用现有对话父级与 leaveGuard，不改全局 phonePush |
| 文件列表 | `?panel=files`，无 file | 文件详情 Back 的目标；再退出回同一对话，随后沿用对话父级 |
| source 文件详情 | `?panel=files&file=<相对路径>` | 回显式列表，不直接跳出对话 |

打开面板 push 列表；列表→详情 push 详情；详情内换另一个文件 replace，预览/源码切换只改组件状态、不写历史。关闭面板 pop 到列表下面的对话；若没有本页建立的列表/对话父级，replace 到无 panel/file 的当前对话。冷启动详情用同一 history 队列 replace 当前详情为对话、push 列表、push 详情，完成前禁用重复导航；这样详情 Back 到列表，再退出到对话，而不是用 `navigate(-1)` 猜网站外历史。列表无 file 仍显示列表，不暗开上一条文件。Forward/刷新按 URL 恢复。

这些 URL 变化经现有 `runGuardedNavigation`；panel 内新增的手机返回拦截必须先于 AppShell 的「离开对话」边缘手势，浏览器 Back 由真实 history entry 驱动。只有 active 的 TaskDetailPage 解析/变更自己 task 的 panel/file；TaskSessionHost 隐藏 keep-alive pane 不消费全局参数。focus 等其他参数归原消费者，文件导航不吞掉。

深链只描述 **task id + source + 相对路径**，source 是隐含固定视图、无需额外 generation 参数。`..`、绝对路径、URI 协议、反斜线逃逸和空白被拒绝。普通 generation/diff 行不生成/切换到 source URL：详情选择 push 一条相同 `?panel=files` URL 的 history entry，在 location.state 写 `{ workspacePanel: { view: "generation", generationId, path } }`，Back pop 回列表。它是临时本页状态，刷新只恢复列表，不恢复 generation 详情，不把不可信 state 当深链或跨 task 重放。generation 深链明确延期。取消未完成的读取后再换 generation/workspace，并回其列表；不把旧 source file 套到新 generation。

OIDC 两种入口都把经过同源校验的 `pathname + search + hash` 交给现有 safeReturnTo，而不是只传 pathname。不能带 token，不接受外部 origin。

### 2. 准备与确认：预览自包含 HTML，必要时看源码

| 项 | 预期 |
|---|---|
| 起点 | source 的 `.html` / `.htm`，且现有读取响应 `truncated=false`；本地/远程上限不同，不写死 512 KiB |
| 动作 | 默认预览，或点「源码」；预览/源码视觉轨道可 38px，但触达 ≥44px；页面不整体横滚 |
| 立刻看到 | 文件名、切换、刷新、受限提示与两个返回在外层；inline CSS 和允许的 data 图片可看 |
| 慢 / 空 / 失败 / 断线 | 加载、空、失败各自有文字；`truncated=true` 不画成功网页，说明并可看源码；断线保留已读内容 |
| 键盘与焦点 | 切换有选中语义；iframe 不获得 Kin 会话/快捷键；返回始终在外层 |
| 离开再回来 | 刷新重取同一 source 文件，不执行 agent/写文件；切换视图不增加 Back 历史 |

认证文本仍走 `readWorkspaceViewFile`，经 `iframe.srcdoc` 在 opaque-origin sandbox 渲染，无 allow-same-origin/scripts/forms/popups/top-navigation，不新增后端接口。文档从开头带严格 CSP，只允许声明的 inline 样式与 data 图片，禁其他网络、frame、object、media、字体与 worker。

在 srcdoc 前用元素/属性 allowlist 构造 inert 文档：移除 a/script/base/form/iframe/object/embed 等主动或导航元素、事件属性和主动 URL；http-equiv 只允许明确无害值，排除 refresh。img 仅在每个 URL 都是校验过的 `data:image/...` 时保留，srcset 默认移除，除非逐项同等校验。CSS 只保留不含 `@import` / `url()` 的 inline 声明，避免样式成为外部请求入口；本版不支持 CSS background/mask/filter 等 URL 图像。不执行 HTML 解析器里的脚本。沙盒/CSP 不是唯一导航边界：链接和 meta refresh 不能留在文档里。

只承诺**自包含静态 HTML**：相对、protocol-relative、远程图片/CSS 不代取，可能缺资源；统一受限提示不声称能枚举全部缺失。源码使用现有只读展示；本故事不扩大文件编辑能力。

### 3. 执行、监控、修改与收尾

| 项 | 预期 |
|---|---|
| 起点 | 文件列表、HTML 预览或本地 generation diff，可能冷启动 |
| 动作 | 逐级返回/关闭到对话；刷新重试；从消息或 Files 再打开 |
| 立刻看到 | 对话消息/草稿/流式不中断，文件工作区/机器不暗改 |
| 慢 / 空 / 失败 / 断线 | 返回/关闭不等待文件请求；离线或无权限仍可回对话 |
| 键盘与焦点 | 回原触发器；冷启动有确定性 Files/消息流 fallback；Mac 隐藏控件不抢键盘 |
| 离开再回来 | source URL 可恢复；本地 generation/diff 不宣称可深链；任务缓存语义不变 |

## 各面差异

| 面 | 这一面怎么呈现 | 为什么不同 |
|---|---|---|
| Mac | 文件列表与详情双栏；source URL 可恢复选择；关闭回对话 | 大屏保留文件上下文，无手机页面栈 |
| 手机 | 对话 / 文件列表 / 文件详情三态，文字「文件」「对话」均 ≥44px；详情内部滚动 | 不让 iframe/diff 吞掉导航出口 |
| 两面 | 同一 source 文件深链、文件权限与 HTML 安全边界 | 内容和权限不因设备改变 |

## 设计

设计稿：`KIN-RESULT-002.figma/frames/`（3 张 SVG）与 `KIN-RESULT-002.review.html`。

Job map：定义/定位＝状态机与深链；准备/确认＝文件读取与安全预览；执行/监控/修改/收尾＝预览、切换、重试与返回，合并在第 3 步六项中。三帧覆盖这些步骤的公共外壳；错误/截断用文字状态合同。它是独立的小故事，不属于或实现 CONTINUE-003。

## Do not

- 不恢复 Artifacts，不加全机文件管理，不把 `file://` 当深链。
- 不允许 file 脱离 task cwd，不把另一设备的本机绝对路径读成 Hub 路径。
- 不用现有 JSON/raw URL 导航 HTML；不给它 Kin token、脚本、应用桥或任意网络。
- 不隐藏返回；不把关闭藏在横向溢出里；不让 iframe 持有唯一导航出口。
- 不把 source file URL 套到 generation；不改 leaveGuard、通知或 TaskSessionHost 缓存语义。

## 验收

| 层级 | 位置 | Given / When / Then |
|---|---|---|
| 路由 | `ui/src/lib/workspaceDeepLink.test.ts`（拟建） | Given 对话/列表/详情、绝对/逃逸/URI file、focus When 解析/生成/清理 Then 三态和 source-only 边界正确；无 cwd/token；隐藏 pane 不动 URL |
| 历史 | `ui/src/pages/TaskDetailPage.dom.test.tsx` | Given 对话进入、连续换文件、冷启动详情、generation state When Back/Forward/关闭/刷新 Then source 详情→列表→对话一致；generation state 可 Back/Forward 但刷新只回列表；无环/盲退；换 generation 取消旧读取 |
| 登录 | `ui/src/components/AccountScreen.dom.test.tsx` | Given `/tasks/id?panel=files&file=a%20b.html#frag` When 两种 OIDC 开始 Then returnTo 保留完整同源地址，拒绝外部 origin |
| 手机 | `ui/src/components/workspace/WorkspacePanel.preview.dom.test.tsx` | Given 文件/diff/HTML When 查看/返回 Then 两出口和切换触达 ≥44px，焦点/滚动归原行；失败出现新重试 |
| HTML | `ui/src/components/workspace/FilePreview.dom.test.tsx`（拟建） | Given 简单、空、含主动标记的 HTML When 预览/源码 Then sandbox 权限正确，inert 文档无导航/主动节点，源码仍可读 |
| 资源 | `ui/src/components/workspace/htmlPreview.test.ts`（拟建） | Given inline CSS/data 图片与相对/远程/refresh/base/script When 构造 Then 仅允许被动内嵌内容，其他内容不发请求/导航；现有文件 API 不变 |
| 截断 | Workspace preview tests | Given `truncated=true`、本地/远程不同上限、无效文本/离线 When 打开 Then 不画半截成功页，给源码/重试 |
| 回归 | Workspace / phoneNavigation / TaskSessionHost tests | Given generation diff、可编辑文件、focus、草稿流式 When 开关预览 Then 原缓存/leaveGuard/权限不变，隐藏 pane 无 URL 副作用 |
| 真浏览器 | 390×844 / 1100×760 | Given 设计 HTML 深链及含 link/meta-refresh 的 fixture When 预览、Back/Forward Then 不离开预览/发请求；两返回、登录回跳、Mac 双栏可用，无整体横滚 |

拟建路径不代表覆盖；draft 的 registry tests 为空。批准后先建立带 KIN-RESULT-002 的失败测试并登记实际文件，再实现。最终 Hub 真机链接和截图是交付证据。

## 证据

- 现状：工作区无文件 URL，HTML 走 CodeViewer，手机返回是小图标；Mac `file://` 在 Kin 手机不可用。
- 用户 2026-11-14 明确要求修返回、HTML 和 Kin 文件直达链接。
- 独立复审指出：同路径 phonePush 历史、OIDC 查询丢失、资源承诺冲突、inert 导航、truncated 判断、source/generation 与 IA owner；本版逐项收紧。

## P7 走查（2026-11-18）

结论：验收表**未被整表走查覆盖**，本轮（P7）状态保持 `approved`。J13 在 390×844 真浏览器走通了下面「已证」的五条；「未证」的条目仍只由既有测试或契约文字承担，registry 与 COVERAGE 不变。**2026-11-19 的 P8 走查补上了下面第一条硬阻塞（#340 实现 replace+push 队列）并整表结算，见下；状态以 P8 的 `covered` 为准。**

已证（`rsi/runtime/ux/journeys/J13.json`，`./scripts/journeys-smoke.sh --journeys J13`：8 屏、0 硬失败）：

- 冷启动 `/tasks/<id>?panel=files&file=notes.md` 落在该源文件，正文可读，地址仍指向该文件。
- 面板内「返回文件」把地址写回 `?panel=files`（无 file），文件列表重新出现，且没有把旧文件重新打开。
- 面板关闭（「关闭文件面板」）把地址写回 `/tasks/<id>`（无 panel/file），`data-phone-view` 消失，回到对话。
- 从列表打开自包含 `preview.html`：默认 iframe 预览、「预览」按下；点「源码」后 iframe 消失、「源码」按下、源码可读；点回「预览」后 iframe 回来；两次切换地址都不变。
- 再次打开 `?panel=files&file=notes.md` 仍恢复同一文件。

未证：

- **浏览器/系统 Back 从文件列表回到对话**：冷启动深链的合成父级是 `/sessions`（`synthesizePhoneParent`），第二次 Back 落到会话列表而不是对话；本故事写的 replace+push 队列尚未实现。因此 J13 用面板自己的关闭作为对话出口，不声称系统 Back 可达。
- 「普通打开 Files 不重放旧文件」没有单独走查。
- Mac 双栏、登录回跳、`truncated`、空/失败/断线，以及 ≥44px 触达与焦点恢复，J13 不断言，仍由既有 DOM 测试与验收表文字承担。
- 走查顺带修的两处：面板「返回文件」原本只改组件状态、不写地址，现在经 `onSelectPath(cwd)` 把列表地址 replace 回来；预览文档 CSP 里的 `frame-ancestors` 在 `<meta>` 中无效并抛出控制台错误，已移除（`htmlPreview.ts`，沙盒与 `default-src 'none'` 仍在）。

## P8 走查（2026-11-19）

结论：验收表九行全部有证据，状态 `approved` → `covered`。手机上的文件深链、返回队列与 HTML 预览/源码切换由 J13 在 390×844 真浏览器整条走通（`hardFail: []`），其余行由带 `KIN-RESULT-002` 的已登记测试承担。P7 记的硬阻塞「replace+push 队列尚未实现」已由 #340 `106995e8` 实现：冷启动深链现在合成 `/sessions → 对话 → 文件列表 → 文件详情` 四级队列，J13 的三次系统 Back 依次回到文件列表、对话、会话列表（截图 `history-back-*`）。P8 另补了验收表要求、此前缺失的读取失败「重试」按钮（`WorkspacePanel.tsx`：错误态就地重读同一文件；不可请求的路径不给假重试）。

走查命令：`bash rsi/runtime/ux-walk.sh "$PWD" <out> J13`（throwaway daemon、seeded fake agent、390×844），`walk.json` 的 `hardFail` 为空，13 张截图；本文引用的截图在 `rsi/state/shots/result-002-covered/walk/`。

| 验收行 | 证据 |
|---|---|
| 路由 | `ui/src/lib/workspaceDeepLink.test.ts`（对话/列表/详情三态解析、生成与清理；绝对路径、`..` 逃逸、URI、反斜线与空白拒绝）；`ui/src/pages/TaskDetailPage.workspaceLink.dom.test.tsx`（到达只读地址、不加 history entry；不安全 link 只丢 `file`、保留列表） |
| 历史 | J13 三次 `history-back`：`history-back-file` → `history-back-list`（`?panel=files`）→ `history-back-conversation`（`/tasks/<id>`）→ `history-back-sessions`（`/sessions`）；`ui/src/lib/phoneDeepLinkParent.test.ts`（冷启动合成整条队列）；`ui/src/pages/TaskDetailPage.workspaceLink.dom.test.tsx`（Back/Forward 按 URL 恢复、连续两次 Back 各自生效、开关面板各恰好一个 entry） |
| 登录 | `ui/src/components/AccountScreen.test.tsx` 与 `ui/src/lib/returnTo.test.ts`（`/tasks/id?panel=files&file=a%20b.html#frag` 原样往返；外部 origin 拒绝） |
| 手机 | `ui/src/components/workspace/WorkspacePanel.paths.dom.test.tsx`（两个出口 `h-11 w-11` = 44px；开文件后焦点到返回、回列表后焦点回原行）；`ui/src/components/workspace/WorkspacePanel.preview.dom.test.tsx`（读取失败显示原因与「重试」，重试重读同一文件；不可请求的路径不给重试）；`ui/src/components/workspace/FilePreview.dom.test.tsx`（预览/源码切换 44px） |
| HTML | `ui/src/components/workspace/FilePreview.dom.test.tsx`（sandbox 无脚本/同源；预览→源码→预览；空文件与截断不画页面）；J13 的 `html-preview` / `html-source` / `html-preview-again` |
| 资源 | `ui/src/components/workspace/htmlPreview.test.ts`（inline CSS 与 data 图保留；script/link/form/iframe、meta refresh、远程 URL 移除；严格 CSP） |
| 截断 | `ui/src/components/workspace/FilePreview.dom.test.tsx`（`truncated=true` 的 HTML 只给提示与源码）；`ui/src/components/workspace/WorkspacePanel.preview.dom.test.tsx`（表格被读取截断时明说可能缺行） |
| 回归 | `ui/src/components/workspace/WorkspacePanel.selectLink.dom.test.tsx`（到达脉冲不写地址；面板内选择只写一次）；`ui/src/pages/TaskDetailPage.workspaceLink.dom.test.tsx`（隐藏/keep-alive pane 不消费别的对话的 link；`focus` 参数原样保留；PR/发布切面保留打开的文件） |
| 真浏览器 | 390：J13 全条（13 张截图，含三次 `history-back`、Files 不重放旧文件、HTML 三态）；1100 半边：`ui/src/components/workspace/WorkspacePanel.paths.dom.test.tsx` 的「shows both panes when the container is wide enough」（列表与详情同屏、手机返回控件不画）。J13 的契约明确只跑 phone，不加 mac 宽度 |

红证（`scripts/mutants.py`，逐字节还原）：把 `ui/src/lib/phoneDeepLinkParent.ts` 的 `trail.forEach` 改成 `trail.slice(0, 0).forEach`，冷启动只合成 `[/sessions, 文件]`，丢掉对话与列表两级 → J13 第一次 Back 直接落到 `/sessions`，`search ^\?panel=files$` 断言变红；还原后 `shasum -a 256` 与改动前一致。日志与 shasum 见 PR body。

仍未由走查覆盖、仍由测试承担：Mac 1100 没有真浏览器走查（J13 契约 `test_j13_contract_rejects_a_mac_width` 明确拒绝 mac 宽度），双栏证据是上面的容器宽度测试；登录回跳、资源白名单、离线/断线、焦点与滚动恢复由各自 DOM/单元测试承担，不在本轮走查结论内。

## 变更记录

- 2026-11-14 创建为独立文件工作区故事，不启动全局 IA；按独立复审补齐导航、登录、安全与范围合同。
- 2026-11-19 P8 结算：J13 三次 `history-back`、Files 不重放、HTML 三态走通，九行验收表逐行映射到走查步骤或已登记测试；补上读取失败的重试按钮与两条 DOM 测试；`registry.json` 登记 10 个带 `KIN-RESULT-002` 的测试并翻 `covered`，`COVERAGE.md` 由脚本重生成。
