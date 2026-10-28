# 手机端整体重构：把 Lody 的移动设计语言装进 Kin

> 来源：2026-10-28 用户对比截图（Kin 深色 vs Lody 浅色）后的要求——"找一个 mobile UI design
> 的 Skill，整体重构产品 UI，不快，但彻底"。
> 参考实现：`~/Workspace/works/Lody` 的 `packages/components/src/components/mobile/`
> 与 `packages/ui/src/tokens/`。本仓库已有的 Ionic 交互层保留，视觉层重做。

## 1. 差距诊断（截图 + 源码对照）

Lody 看起来"像一个 App"，不是因为某个组件好看，而是因为五条规则从头到尾一致：

| 规则 | Lody | Kin 重构前 |
|---|---|---|
| 一个画布，一张卡片 | 页面底色 + 白色/深灰卡片，组与组之间靠留白 | 每个元素都描边，边框噪声大 |
| 行节奏 | 44px 行高、16px 边距、15–16px 标题 + 12px 元信息 | 行高 52–64px 但字号 13px，信息挤 |
| 字号对比 | 落地页 30px，行标题 15px，数字 11px | 全站 12–16px，层级扁平 |
| 浮层 chrome | 毛玻璃头部 + 悬浮胶囊 dock + 独立 FAB | 贴边 48px 头部 + 贴底三格 tab bar |
| 表单即 sheet | 分组卡片行 + 行内选择器，只有一个主按钮 | 原生 `<select>` 堆在带边框的盒子里 |

具体到用户截图的四处：

1. **抽屉**：每个项目展开后有三个 44px 全宽按钮（封面/置顶/归档），一路铺到屏幕外，
   底部被裁掉；项目名被挤到 0px。→ 收进项目行尾的 `⋯` 动作表。
2. **新会话页**：顶部 44px 条塞了"主持 Agent · 机器 · 重新检测"，中间一大片空白 +
   虚线占位框。→ 去掉控制条（信息进运行设置 sheet），落地页改为大标题 + 上下文卡 + 输入卡。
3. **运行设置 sheet**：原生 select、每组一个描边盒子、底部一颗蓝色大按钮。→ 分组卡片行 +
   行内 picker，主按钮只有一个。
4. **会话页/chrome**：头部是汉堡 + 标题 + 搜索 + 加号，底部是带分隔线的三格 tab。
   → 毛玻璃头部（三段式）+ 悬浮 dock + FAB。

## 2. 设计语言（Kin 版）

不改品牌色，不改桌面端密度。手机端（`<md`）采用下面这套；桌面保持现有布局。

### 2.1 表面

复用既有 token，不新增颜色：

| 角色 | token | 用法 |
|---|---|---|
| 画布 | `--kin-page` | shell 根、列表底色 |
| 卡片 | `--kin-panel` + `shadow-e1` + hairline | 分组列表、设置组、上下文卡 |
| 井 | `--kin-fill` | 输入框、chip、分段控件底 |
| 浮层 | `--kin-panel` + `shadow-e3` | sheet、抽屉、dock |
| 毛玻璃 | `rgb(var(--kin-panel-rgb) / 0.78)` + `blur(20px)` | 头部、dock |

浅色下 panel 是白、page 是灰 → 白卡浮在灰底上，就是 iOS 分组列表；深色下 panel 比 page
亮一档，同样成立。

### 2.2 字号

在 `design/type.ts` 增加一档 `display`（28px / 600 / text），只用于手机落地页标题；
其余沿用现有七档。行标题用 `text-subtitle font-medium`（16px），行内说明 `text-caption`
（12px），分区标题 `text-strong`（14px）常规字重、muted —— 不再全大写。

### 2.3 组件词汇（新增 `ui/src/components/mobile/`）

- `MobileScreen`：页面滚动容器，顶部大标题/说明 + 内容 + 底部 dock 余量。
- `MobileSection` / `MobileCard` / `MobileRow`：分区标题 + 圆角卡片 + 分隔行。
  所有列表页、设置页共用这一套。
- `MobileHeader`：三段式毛玻璃头部（左 44 / 中标题 / 右 44），列表路由使用。
- `MobileDock`：悬浮胶囊，三项（会话/收件箱/设置），高 56，选中项 20% 蓝底；
  右下角 56px FAB 新建会话。替代 `MobileTabBar`。
- `Sheet`：统一底部弹层（抓手、标题、滚动区、safe-area、Esc/遮罩关闭）。
  替换新会话控制面板、任务操作表、设置里的临时弹层。
- `MobileActionSheet`：继续用 `IonActionSheet`（平台行为），只补一个打开器 hook。

### 2.4 动效

- 页面进入：现有 140ms 透明度保留。
- sheet：translateY(12px) → 0，180ms `cubic-bezier(0.2,0,0,1)`；`prefers-reduced-motion` 关闭。
- 按压：行/按钮统一 `active:bg-[var(--kin-fill)]`，不用缩放。

## 3. 页面改造清单

按依赖顺序，每一片单独可验证：

1. **地基**：`type.ts` + `index.css`（`.kin-glass` / `.kin-card` / `.kin-sheet` / `.kin-press`）
   + `components/mobile/` 五个原语 + `/design` 画廊补新档位。
2. **Shell**：`AppShell` 手机头部换 `MobileHeader`；`MobileTabBar` 换 `MobileDock` + FAB；
   `<main>` 手机端底部留出 dock 空间。
3. **抽屉**：`Sidebar` 手机态——毛玻璃面板、44px 行、项目 `⋯` 动作表、搜索框 44px、
   safe-area；桌面态不变。
4. **会话列表（手机首页）**：`SessionsPage` 用 `MobileScreen` + 分区 + 行（头像/标题/项目·时间/
   状态点），去掉每行卡片边框。
5. **新会话**：`NewChatPage` 手机态去掉顶部控制条与虚线占位，改大标题 + 上下文卡 + 输入卡；
   运行设置 sheet 用 `MobileCard` 行 + `SheetSelect`（机器/权限/Agent/模型/目录/分支/例行）。
6. **会话详情**：`TaskDetailPage` 头部换 `MobileHeader`（返回 + 标题 + `⋯`）；
   composer 用卡片表面，底部 chip 行保持 32px；转录列宽不变。
7. **设置**：`SettingsLayout` 手机态 tab 条改分段控件，`SettingsSection`/`SettingsRow`
   手机态改为"标题在卡外 + 卡内分隔行"；桌面不变。
8. **其余列表页**（Tasks / Projects / Agents / Artifacts / Routines / Approvals）：
   手机态统一成 `MobileScreen` + `MobileCard` 行；桌面表格保留。
9. **验证与交付**：390×844 / 1280×900 走查、`npm run build`、`vitest`、`go test ./...`、
   同模型评审 → 修复 → 提交 → 合并 main → Hub 重新部署 → 桌面重建。

## 4. 风险与约束

- 桌面端不得回归：所有新样式默认只在 `<md` 生效，桌面断点保持原类名。
- `tokens.test.ts` 会检查新 token 必须在 `theme.css` 声明并在 `/design` 展示；
  本轮不新增颜色 token，只新增一个字号档位（画廊自动渲染）。
- `structure.css` 继续不引入；sheet/dock 自绘，不依赖 Ionic 的布局重置。
- 动效只用 opacity/transform，且不放在 `position: fixed` 的祖先上（现有约束）。
- 每个 slice 完成后跑 `vitest run`（相关文件）与 `tsc`；最后全量。

## 5. 落地记录（2026-10-28）

按上面的顺序完成，实现与计划的差异如下——每一条都是走查后改的，不是简化：

1. **地基**：新增 `display` 字号档；`.kin-glass` / `.kin-card` / `.kin-sheet-surface` /
   `.kin-row-press` 四个表面类；`Sheet` 只有一套动画与 safe-area 处理。
2. **Shell**：`MobileHeader` + `MobileDock` 上线，`MobileTabBar` 删除。
   - dock 的占位改在 shell 的 `<main>` 上（`dockVisible` 时才加），页面不再各自计算；
     否则设置页、产物库这类没走 `MobileScreen` 的页面最后一张卡会被胶囊压住。
   - FAB 只在会话页出现：设置页上它悬在最后一张卡上，等于在配置页提供"新建会话"。
   - 头部不再放加号：FAB 已经是同一动作，同一屏两颗相同按钮是自我怀疑。
   - 抽屉触发器在草稿页保留（原来被关闭 × 取代，落地页因此没有入口进设置/收件箱），
     关闭 × 移到右侧 trailing，和 iOS 撰写页的 Cancel 同位置。
3. **抽屉**：项目行尾一个 44pt `⋯` → `IonActionSheet`（新建/置顶/封面/归档），
   三个 hover 按钮在手机上隐藏；行高 44、字号 16、搜索框 16px（避免 iOS 聚焦缩放）。
   动作表头部用 `kin-sheet-named` 变体：项目名是名字不是字段标签，不该被大写。
4. **会话列表**：分组卡片 + 36px 头像 + 标题/项目·时间 + 状态词；去掉重复的状态点。
5. **新会话**：
   - 手机端删掉 44px 主持条（shell 头部已经写了"新建对话"，下面标题又写了主持 agent）。
   - 标题用 `display` 28px，内容顶部对齐。
   - 没有项目封面时不再显示虚线占位（它指向一个手机上没有的侧栏）。
   - 运行设置 sheet 换成 `Sheet` + 每个控件一行（权限/例行/机器/Agent 与模型/团队分发/
     目录/分支），5.5rem 标签列 + 右侧控件。原计划的 `SheetSelect` 没有做：控件本身是
     带弹层的 picker，重写成 sheet 行会丢交互；行内放原控件即可。
6. **会话详情**：`MobileHeader`（返回 + 标题 + 副标题=运行态或项目 + `⋯`），
   原来两行 chip 条只在桌面保留。该页自己拥有顶部 inset，shell 对 `/tasks/` 不再留空。
7. **设置**：七个 tab 在 390px 上放不下（远程、通知被淡出遮住）。手机端改成
   iOS 目录式：首屏「通用」+ 底部「更多设置」列表，子页左上角返回「设置」。
   `SettingsSection` 手机端变分组卡片、标题句式化；Agent 会话区改用同一个 section 原语，
   能力 chip 在手机上独占一行（原来把名字挤成 3 个字符）。
8. **其余列表**：任务表在手机上隐藏表头、状态列收窄贴右、标题 16px；项目卡改
   52px 行 + 右侧时间/箭头；产物库与收件箱保持原有空态。
9. **验证**：390×844 与 1280×900 走查；`vitest` 886 通过；`npm run build`；
   `go test ./...`；同模型评审后提交。

### 尚未做完（下一轮）

- Agents / Routines / Approvals 三页的行还没换成 `MobileCard`（当前是桌面组件 + 手机宽度）。
- 产物库空态还是纯文字，没有用 `MobileEmpty`。
- 会话详情底部的用量条 + 变更文件条在手机上仍占两行，可考虑合并成一行。

## 6. 评审与修复

本轮评审子代理被环境里的 Codex 网关限流（`429 The usage limit has been reached`，
五次不同角度的子任务全部中断），因此没有拿到完整评审报告；按仓库约定退回到自查清单，
并把自查中确认的三处问题修掉、逐条验证：

1. **运行设置卡切掉了团队分发弹层**（自查 + 390×844 实测确认）。控件卡上的
   `overflow-hidden` 把 `DispatchSelector` 的弹层从卡片上沿切掉，模式切换只剩半行。
   卡片自身圆角由背景裁切即可，去掉 `overflow-hidden`；截图复验弹层完整。
2. **Escape 一次关掉两层**。`Sheet` 在 window 捕获阶段监听 Escape，抢在行内弹层之前，
   第一个 Escape 连 sheet 一起关掉，第二个无处可关。改为：事件目标位于嵌套
   `role="dialog"` 内时让给它，弹层自己关；实测第一次只关弹层、第二次关 sheet。
3. **远程机器上永远发不出去**（不属于本次 UI 改动，但正是 dogfood 首屏会撞上的那类）。
   设置里配了默认团队后 `dispatch.mode` 一直是 `auto`，而选了远程机器后分发控件被隐藏
   （`newChatControlGroups`），旧的提交校验 `if (dispatch.mode && !dispatchReady)` 于是
   每次都报 "dispatch incomplete"，用户没有任何办法清掉。抽出
   `dispatchBlocksSend()`：远程发送与分发无关，永不拦截；同一条选择在本地仍然拦。
   新增 4 个用例，并红验（删掉 `if (remote) return false` 后用例转红）。
