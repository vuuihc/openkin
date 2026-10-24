# P1 — 设计系统重建

> 上游：`2026-10-23-lody-parity.md` §6 P1。本文是 P1 的施工图。
> 原则来源：`PRINCIPLE.md`、parity 计划 §4.2 第 5 条（排版纪律）、§5（先问正确形状）。
> 分支：`feat/p1-design-system`。基线：`main@7e6d369`。

## 1. 目的与验收

**目的**：控制台的表现层现在是三套颜色词汇、18 个任意字号、四个手抄四遍的主题块堆起来的。
P2（会话视图升级）要在这层上面建组件，所以先把这层做成**一套**：一个令牌来源、一套阶梯、
一个能自动发现缺口的测试。

**验收**（parity 计划 §6 P1 原文，数字已按实测修正）：

| | 原文 | 实测修正 |
|---|---|---|
| A1 | 删掉 `ui/src/index.css` 里全部 89 个手写变量 | 实为 **76 行 / 19 个 token × 4 个主题块**。目标：`index.css` 里 **0 行**手写变量，令牌层移到 `src/design/theme.css`，**每个 token 只写一次**（两块：dark / light） |
| A2 | 控制台视觉不回退 | 见 §6：不改的地方要有像素证据，改的地方要逐条列出来并逐条看过 |
| A3 | gallery 测试能报出未被呈现的 token | `src/design/tokens.test.ts` + `/design` 页；另外三组守卫见 §5 |

## 2. 现状实测（2026-10-24，`main@7e6d369`）

### 2.1 颜色：三套词汇并存

| 词汇 | 规模 | 例子 |
|---|---|---|
| `--kin-*` CSS 变量 | 19 个 token，**手抄 4 遍**（`index.css` 76 行） | `--kin-panel: #2c2c2e` |
| className 里的裸值 | **42 个不同的裸色值** | `bg-[rgba(255,69,58,.08)]`×13、`text-[#ff8a80]`×13、`bg-[#3a1214]` |
| Tailwind 默认调色板 | **38 色 / 131 处** | `text-zinc-500`×13、`bg-amber-950`、`text-indigo-400` |

后两套**完全不随明暗切换**。实测对比度（WCAG，正文需 4.5:1）：

| 用法 | 亮色下的实际对比度 | 出现次数 |
|---|---|---|
| `text-[#ff8a80]`（错误文字）在白底 | **2.28:1** | 13 |
| `text-[#ffb4ad]`（diff 删除）在白底 | **1.70:1** | 5 |
| `text-[#8de4a0]`（diff 新增）在白底 | **1.53:1** | 2 |
| `text-[#ffb340]`（警告）在白底 | **1.78:1** | 4 |
| `text-kin-orange`（status 色写死在 config）在白底 | **2.06:1** | 20 |
| `text-kin-green` 在白底 | **2.02:1** | 17 |
| `text-kin-blue` 在白底 | **3.65:1** | 75 |
| `text-kin-red` 在白底 | **3.41:1** | 41 |
| `text-kin-muted`（暗）在 `#1a1a1c` | **3.43:1** | 358 |
| `text-kin-muted`（亮）在白底 | **3.26:1** | 同上 |

即：**亮色模式下所有语义色都是暗色模式的值**，13 处错误文字在亮色下基本读不出来。
`--kin-muted` 是全局第二常用的墨色（358 处），两套主题下都低于 AA。

### 2.2 表面：阶梯是对的，但被抄了四遍，还带着同义词

`index.css` 的注释声称"修好了亮色下 sidebar/main/inspector 几乎同灰"。实测（CIE L\*）：

| 槽位 | 暗色 | L\* | 亮色 | L\* |
|---|---|---|---|---|
| page | `#0e0e10` | 4.0 | `#d8d8dc` | 86.4 |
| sidebar | `#141416` | 6.4 | `#ececf0` | 93.5 |
| bg / chat | `#1a1a1c` | 9.3 | `#ffffff` | 100.0 |
| inspector | `#222226` | 13.4 | `#ebebf0` | **93.2** |
| elevated / panel | `#2c2c2e` | 18.1 | `#f4f4f6` | 96.2 |

暗色最小间距 2.37 L\*；亮色下每个槽位与 `base` 差 6.5–13.6 L\*。**先说结论：阶梯本身是好的**
（`index.css` 注释声称修好的"sidebar/main/inspector 同灰"，对照 base 确实修好了——首版本文档曾把
"sidebar 93.5 vs inspector 93.2 只差 0.32"写成缺陷，截图核对后撤回：两者中间隔着 chat 栏，
从不相接，同色是合理的）。

真正的问题是别的三件：

- **同一套阶梯被抄了四遍**（76 行），改一处要记得改四处，且**没有任何检查**；
- **3 组同义词**：`--kin-bg`≡`--kin-chat`（两套主题都逐字节相同）、`--kin-surface` 是 `--kin-panel` 的别名、
  暗色下 `--kin-elevated`≡`--kin-panel`（亮色下不同：`#f4f4f6` vs `#ffffff`，这一组不是同义词）；
- 亮色 inspector（93.2）与 elevated（96.2）之间只差 3.0 L\*，两者相接时几乎看不出——
  目前没有这种布局，但阶梯本身没有下界。

### 2.3 字号：18 个任意值 + 6 个命名值

`text-[...]` 共 28 个不同值 / 735 处，其中**字号 18 个 / 696 处**（其余 39 处是颜色）：

```
11px 177   12px 134   13px  90   11.5px 75   12.5px 65   10px 54   10.5px 31
14px  18   15px  14   13.5px 13    22px 10    9px  5    16px  4    17px  2
28px   1   32px   1   14.5px  1     8px  1
```

外加命名值 **166 处**：`text-xs`(12px) 113、`text-sm`(14px) 43、`text-base` 3、`text-lg` 2、`text-xl` 3、`text-2xl` 2。
（本节数字在 S2 结束时重数过一遍：初稿的 728/30/687 与 169 是同一个漏掉多行模板字符串的扫描给出的，
逐字复核后改为 735/28/696 与 166；总量 862 处尺寸，与 S2 的提交信息一致。）
**11/11.5/12/12.5/13/13.5 六档挤在 3px 里**，正是 §4.2 第 5 条要禁的形态。

### 2.4 其它阶梯：命名值与任意值两套并行

| 轴 | 命名值（处） | 任意值 |
|---|---|---|
| 圆角 | `lg`123 `xl`74 `md`61 `full`42 `2xl`19 | 10 个值 / 36 处（`[8px]`×9 `[7px]`×6 `[12px]`×6 `[10px]`×5 …） |
| 阴影 | `window`7 `lg`5 `sm`4 `xl`3 `card-*`6 | 6 个值（含 3 个 `0 0 0 3px rgba(...)` —— 那是 focus ring，不是阴影） |
| 高度 | `h-*` / `min-h-*`（Tailwind 4px 阶梯） | `min-h-[44px]`×52 `[40px]`×16 `[36px]`×13 `[32px]`×12 …共 17 值 / 117 处 |
| 字距 | `wide`59 `tight`9 `normal`3 | 3 个（`[0.08em]`×4 `[0.06em]` `[0.2em]`） |
| 行高 | `relaxed`27 `snug`3 | 5 个（`[14px]` `[12px]` `[1.45]` `[1.35]` `[1.32]`） |
| 间距 | Tailwind 4px 阶梯（唯一一套，保持） | `gap-[3px]` `pl-[18px]` `pl-[23px]` —— 3 处 |

### 2.5 引用不存在的 token：至少 6 处（正是缺口测试该抓的）

| 位置 | 写了什么 | 实际效果 |
|---|---|---|
| `components/chat/ChatStream.tsx:1030` | `accent-[var(--kin-blue)]` | `--kin-blue` 从未定义 → 该属性无效，继承 |
| ~~`components/workspace/WorkspacePanel.tsx`~~ | ~~`w-[var(--kin-ws-sidebar)]`~~ | **撤回**（S1 期间查清）：它和同一元素上的 `style={{ "--kin-ws-sidebar": … }}` 是同一个名字，**这条一直是生效的**——只是这个名字不属于 `theme.css` 的命名空间。S1 把它改名为 `--ws-sidebar` 并写了注释，满足"`--kin-*` 必须在 theme.css 里定义"的守卫，而不是修了一个坏引用 |
| `pages/AgentsPage.tsx` | `var(--kin-red,#ff453a)` `var(--kin-yellow,#ffd60a)` | 靠 fallback 兜住，说明写的人也不确定 |
| `cards/LimitCard.tsx:173`、`cards/UserQuestionCard.tsx:91,108,145`、`chat/BranchPicker.tsx:350` | `text-kin-primary` ×5 | `kin.primary` 在 config 里不存在 → 类不生成 → 颜色继承 |
| `pr/PullRequestPanel.tsx:446` | `text-kin-purple` ×1 | 同上 |

`--kin-*` 的定义/引用全表：19 个定义中 **0 个** 未被引用；**4 个被引用但未定义**
（上表第 1、3、4、5 行；第 2 行已撤回）。也就是说这一层今天没有任何一处自洽性检查。

### 2.6 工程量

`ui/src` 下 90 个文件、~44k 行；受影响 class **约 1,300 处**，其中**真正需要改动的约 350 处**
（字号 snap 268、裸色 100+、圆角 36、控制件高度 11、字距 65、行高 6、阴影/ring 37）。
S2 结束后按同一口径重数了一遍，两条估计被实测取代：控制件高度要移动的不是 20 处而是 11 处
（117 处 `min-h-[Npx]` 里 32/36/40/44/48 五档都真实存在，其余只是改名，见 §3.4），字距不是 3 处而是 65 处
（`tracking-wide` 59 处也要并进 `label`）。

## 3. 目标形状

**一句话**：一个文件写颜色，一个文件写阶梯，两处都只写一次；引用由测试和 lint 保证可解析。

```
ui/src/design/theme.css        唯一的色值来源。两块：:root（dark）、:root[data-theme="light"]
ui/tailwind.config.ts          唯一的阶梯来源。只引用 var()，不再出现任何色值字面量；
                               字号从 design/type.ts 取，S2 起由 tsc 检查
ui/src/design/type.ts          字号阶梯（px + 字重 + 墨色）。config 与画廊读同一份
ui/src/design/tokens.test.ts   守卫（§5），vitest 跑，无需浏览器
ui/src/design/tailwind.test.ts 把 config 真正跑一遍 postcss：阶梯没生效就是红
ui/src/pages/DesignSystemPage.tsx  /design 画廊：每个 token、每级阶梯都在页面上出现（A3）
ui/eslint.config.js            局部规则：禁止新写裸值 / 未定义 token（§5.6）
```

### 3.1 为什么是「CSS 写一套 + 测试解析」而不是「TS 生成 CSS」

考虑过的形状是 `design/tokens.ts` 生成 `theme.css` + 生成 tailwind 片段。放弃，理由：

- 生成物需要"是否同步"的测试，同步测试本身又是一份真相。CSS 直接就是真相时，**没有漂移这个失败模式**。
- 已实测：Tailwind 3 用 jiti 加载 config，`.js` 与 `.ts` 的 config 都能 `import` 一个 `.ts`
  （`npx tailwindcss` 成功求值，抛错可见）。S2 顺势把 config 自己也改成 `.ts`，
  于是 `fontSize: FONT_SIZE` 这句由 `tsc` 检查，而不是靠人眼。所以 config、画廊与测试共享
  同一个模块——但共享的只有**阶梯**（结构值），颜色仍是 CSS 变量，两边都不需要生成器。
- 画廊和守卫要的是"token 名单"，从 CSS 里正则解析 38 行 Decl 是确定性的，且不可能与真相不一致。

### 3.2 明暗切换：删掉两个 `@media` 块（纯删除，零视觉变化）

`lib/theme.ts:applyTheme()` 无论哪种模式都**同时**写 `data-theme` 和 `.light`/`.dark` 类：

```
mode=system → data-theme="system" + class light|dark
mode=light  → data-theme="light"  + class light
mode=dark   → data-theme="dark"   + class dark
```

而 `index.css` 的选择器是 `html.light, html[data-theme="light"]`——`.light` 已经命中。
所以 `@media (prefers-color-scheme: light) { html[data-theme="system"] {...} }` 与
`@media (prefers-color-scheme: dark) { html[data-theme="system"] {...} }` 两块（38 行）**永远不会
是唯一生效的规则**。改动：`applyTheme` 把 `data-theme` 写成**解析后**的值（`dark`/`light`，
偏好值本来也不被任何代码读取，只存在 localStorage），两块 `@media` 删除。
`terminalTheme.ts` 同时看类与属性，不受影响。

于是令牌层从「19 × 4 = 76 行」变成「19 × 2 = 38 行，每行只出现一次」。

### 3.3 颜色令牌目录

**表面阶梯（6 个令牌）**——S1 落地的名字与初稿不同，以**落地为准**（下表即 `theme.css` 的实际内容）：

| 槽 | 暗 | 亮 | 谁在用 |
|---|---|---|---|
| `--kin-page` | `#0e0e10` | `#d8d8dc` | body 底、窗口外沿 |
| `--kin-sidebar` | `#141416` | `#ececf0` | 侧栏 |
| `--kin-bg` | `#1a1a1c` | `#ffffff` | 主区（`--kin-chat` 已删，指到这里） |
| `--kin-inspector` | `#222226` | `#ebebf0` | inspector |
| `--kin-elevated` | `#2c2c2e` | `#f4f4f6` | 浮层卡片、popover、选中的 tab |
| `--kin-panel` | `#2c2c2e` | `#ffffff` | 弹层/模态 |

初稿打算改成 5 槽并按"离内容多远"命名（`sunken`/`base`/`raised`/`overlay`），S1 没有采纳：
`elevated` 与 `panel` **没有合并**，因为亮色下卡片必须在灰上（`#f4f4f6`）、模态必须在白上
（`#ffffff`）——合并会丢掉这个区别；改名则要动 100+ 处引用，换来的只是"不按组件命名"这条审美。
留下的事实是：`sidebar` 与 `inspector` 是这套槽位里唯一两个**组件名**，若以后有第三个调用方需要
它们中间的那一级，再按那时的用途命名。

**墨色阶梯（3 级）**——合并 `tertiary` 进 `muted`，并把 `muted` 提到 AA 以上
（数字是「`--kin-bg` / `--kin-elevated` 上」两格，守卫对四个表面全量）：

| 级 | 暗 | 对比度 | 亮 | 对比度 |
|---|---|---|---|---|
| `--kin-text` | `#f5f5f7` | 16.0 / 12.8 | `#1c1c1e` | 17.0 / 15.5 |
| `--kin-secondary` | `#c7c7cc` | 10.3 / 8.3 | `#3a3a3c` | 11.3 / 10.3 |
| `--kin-muted` | `#98989d` ← 原 tertiary | 6.1 / 4.9 | `#69696e` | 5.5 / 5.0 |

`--kin-tertiary` 删除（16 处 → `kin-muted`）。这是**有意的可见变化**：358 处次要文字变清楚。

**线与填充**：`--kin-hairline` / `--kin-hairline-strong` / `--kin-fill` / `--kin-fill-strong`，值不变，改为只写一次。

**语义色（4 族 × 3 档）**——今天只有一个档，被当成三种用途：

| 档 | 用途 | 暗 | 亮 |
|---|---|---|---|
| `--kin-{c}-rgb`（通道三元组） | 填充：按钮底、`bg-kin-red/40` 这种带透明度的 | 现有 `#0A84FF` `#FF9F0A` `#30D158` `#FF453A` 原值 | 同左（填充不需要换） |
| `--kin-{c}-ink-rgb` | 画在页面/浮层上的文字 | `#6cb2ff` `#ffb340` `#8de4a0` `#ff8a80` | `#0B5FCC` `#8A4B00` `#146C2E` `#B3261E`（均 ≥5.4:1） |
| `--kin-{c}-tint-rgb` | 12% 底色（`bg-kin-red/12`） | 由 fill 通道 + `/12` 表达 | 同 |

**必须是通道三元组**：`text-kin-red/40`、`border-kin-blue/50`、`bg-kin-blue/15` 这类透明度修饰
实测约 **130 处**。Tailwind 只有把颜色写成 `rgb(var(--x-rgb) / <alpha-value>)` 才支持 `/NN`；
直接写 `var(--kin-red)` 会让 `/40` **静默失效**。`kin-blue-soft` / `kin-orange-soft`
（16 处）与 `/12` 重复，删除，改用透明度修饰。

**Tailwind 默认调色板整体关闭**（`theme.colors` 用赋值而非 `extend`），只留
`transparent / current / inherit / black / white` + `kin`。131 处 `zinc/amber/indigo/emerald/sky`
按语义迁移：`zinc` → 墨色或线/填充阶梯，`amber` → warning，`red`/`emerald`/`sky` → red/green/blue，
`indigo` → 已查清（见 §7）：它在 `StatusBadge.tsx` 里是 `waiting_input`，与橙色的 `approval` 指同一件事。

### 3.4 阶梯目录（`tailwind.config.ts`：字号/字距/行高/阴影**赋值**，圆角是 Tailwind 自带刻度的六步子集，布局宽度走 `extend`）

**字号 7 级**（每级声明 px + 字重 + 墨色，即 §4.2 第 5 条的"语义角色"）：

| 角色 | px | 字重 | 墨色 | absorb |
|---|---|---|---|---|
| `micro` | 10 | 600 | muted | 8, 9, 10 |
| `caption` | 11 | 400 | secondary | 10.5, 11, 11.5 |
| `body` | 12 | 400 | text | `text-xs`, 12, 12.5 |
| `strong` | 13 | 500 | text | 13, 13.5, 14, `text-sm` |
| `subtitle` | 15 | 600 | text | 14.5, 15, 16, `text-base` |
| `title` | 17 | 600 | text | 17, `text-lg` |
| `hero` | 22 | 700 | text | `text-xl`, `text-2xl`, 22, 28, 32 |

snap 规则：就近取整；**平局取用量大的一级**（10.5 平局 → 11，11.5 → 11，12.5 → 12，13.5 → 13，14 → 13，16 → 15）。
（初稿把 14.5 写在 `strong` 一行，与这条规则矛盾：到 15 差 0.5、到 13 差 1.5，归 `subtitle`。）
结果：**696 处任意字号中 486 处不动、210 处移动**。加上命名字号，全树 862 处尺寸里
**268 处真的变了**，移动量分布：0.5px×185、1px×75、2px×6、6px×1、10px×1
（`8px`→10 一处，`28px`/`32px`→22 各一处，即 `ApprovalsPage` 那个页面标题，§7 已列为风险）。
命名字号另有 166 处（含 `index.css` 里 3 处 `@apply`），其中 `text-xs` 113 处只换名字不动尺寸。

**命名字号带 `leading`**：`text-sm` 这类命名值在 Tailwind 里同时写了行高（如 14/20）。
换成角色后行高会掉回继承的 1.5，于是 158 处补上等值的 `leading-*`（`xs`→4、`sm`→5、
`base`→6、`lg`/`xl`→7、`2xl`→8），**这一片只让字号动，行高一个字都不变**。
顺带发现 4 处 `sm:text-*` 在 snap 后与基准同值（`12px sm:12.5px` 这种 0.5px 的响应式微调
塌成了同一级），已删除；`text-strong sm:text-subtitle`（14→15）是真的阶梯，保留。
`CwdPicker` 里 `compact ? "text-[10.5px]" : "text-[11px]"` 两个分支从此同级，三元塌成常量。

**只机械替换 px**：字重与墨色是**角色的定义**，不是要写进每个元素的东西——今天这些元素各自
已经带了 `font-semibold` / `text-kin-muted`，统一注入会与既有 class 打架（Tailwind 的胜负由生成
顺序决定，不由 markdown 顺序决定）。字重与墨色进画廊，由审查对齐。

**尺寸/间距**：Tailwind 的 4px 阶梯就是阶梯，**不新造数字，也不新造名字**——高度和 `gap`/`p`/`w`
用同一把尺，这才是一套词汇。S2 期间把 `min-h-[Npx]` 按"什么控件"数了一遍（落地前共 **114** 处），
确认 32/36/40/44 四级都真实存在（不是三级），但**结论不是给它们起名**：

| 档 | px | 实测处数 | 用在哪 |
|---|---|---|---|
| — | 32 | 12 | 紧凑输入与 chip（chat 工具栏、provider 行） |
| — | 36 | 13 | 桌面默认控件 |
| — | 40 | 16 | 设置页输入/按钮，常写成 `min-h-[44px] sm:min-h-[40px]` |
| — | 48 | 5 | 配对/连接页的输入框 |
| — | 44 | 52 | 触摸下限：手机上的一切可点物，桌面上再降级到上面某级 |

所以 S3 对高度做的是**改名而不是合并**：`min-h-[44px]`→`min-h-11`、`[40px]`→`min-h-10`、
`[36px]`→`min-h-9`、`[32px]`→`min-h-8`、`[48px]`→`min-h-12`（这些都在 Tailwind 的刻度上，
已用 postcss 探针确认 `min-h-6…96` 全部真的生成 CSS）。**只有不在刻度上的值才移动**，实测 11 处：
22→24（1）、26→28（3）、34→36（4）、50→48（1）、62→64（1）、100→96（1）；
另有 `[28px]`2、`[160px]`1、`[320px]`1 本来就正好在刻度上（7/40/80），只改名。
`[480px]` 是全树唯一超出 Tailwind 尺度（最大 384）的值，保留为任意值——
守卫的写法因此是一条规则而不是例外清单：**任意 `min-h-[Npx]` 必须是 Tailwind 刻度上写不出来的值**，
而且这条规则是从**解析后的 config** 里读出刻度来判的，所以以后动 `spacing` 也不会与守卫脱节。
`min-h-<name>` 的名字本身也在同一条阶梯守卫里（`min-h-13` 这种写错的名字直接红）。

44px 这条下限**不做成令牌**：它是约束不是档位，写进本节与 §6 逐屏检查（手机上一个可点物
的 `min-h` 不小于 `min-h-11`）。今天没有自动守卫，§7 已记为待办。
`h-[Npx]` 那一批（17/18/22/26/28/32/34px 共 19 处）是**图标尺寸**，没有图标阶梯，
本片不动，也不在"未命名高度"里假装修好了——§7 记一笔，留给 S6 的 lint 决定要不要管。

**圆角**：Tailwind 自带的 `sm`2 / `md`6 / `lg`8 / `xl`12 / `2xl`16 / `full` 就是阶梯
（`lg`128 处、`xl`74 处本来就在用）。删掉 config 里的 `card`(=xl) 与 `pill`(=full)；
**38** 处任意值 snap 进这五级：`[8px]`9 / `[7px]`6 / `[10px]`5 / `[9px]`2 →`lg`8，
`[12px]`6 / `[13px]`2 →`xl`12，`[6px]`2 / `[5px]`1 / `rounded-br-[5px]`1 →`md`6，
`[18px]`1 / `rounded-t-[20px]`1 →`2xl`16（20 到 16 与 24 等距，按"平局取用量大的一级"取 `2xl`），
`[2px]`2 →`rounded-sm`（精确）。落地后树里只剩 `sm/md/lg/xl/2xl/full` 加裸 `rounded`，
侧向写法（`rounded-t`、`rounded-br-md`）一并按阶梯检查。

这六级是一份**选定子集**，不是 config 里的键：config 里根本没有 `borderRadius` 这一项
（只从 `extend` 里删掉了 `card`/`pill`），Tailwind 默认刻度上的其它名字（零半径、
`2xl` 往外那几级）照样解析得出来。所以守卫在这一轴上**不能**从 config 读允许名单——
读了就是读整个默认刻度，永远不会红；允许名单写在守卫里，另有一条用例把名单压回 config
（每个名字必须是解析后 `borderRadius` 的键），这样名单不会烂成一个不存在的名字。
38 处里按"渲染值有没有变"数是 **19** 处真的变了（`10→8`×5、`13→12`×2、`18→16`、
`20→16`、`7→8`×6、`9→8`×2、`5→6`、`br[5px]→6`），另 19 处只是从任意值换成同值的名字。

**阴影 3 级 + 无**：`theme.boxShadow` **赋值**为 `{ e1, e2, e3 }`，`sm`→`e1`、`card`/`lg`→`e2`、
`xl`/`window`→`e3`。实测 **25** 处具名：`window`7 `lg`5 `sm`4 `xl`3 `card-amber`3 `card`2 `card-blue`1，
外加 6 个任意值（其中 `CommandPalette` 那个 →`e3`，剩 5 个是 S4 的状态色），
另加 **1 处裸 `shadow`**（`CodeViewer` 的错误提示条）——它就是"赋值后静默失效"的活样本：
源码里看着有阴影，赋值 `boxShadow` 之后那个类一个声明都不产出，元素是平的。
落地后树里 27 处走 `e1`/`e2`/`e3`。取值不是新调的：
`e2` 就是原来 `card` 的值、`e3` 就是原来 `window` 的值（用得最多的那一档），只有 `e1` 从 Tailwind
的 `sm`（5% 黑）提到 24% 黑——在一个近黑底上 5% 等于没有。赋值而非扩展，所以
`shadow-md/2xl/inner/none` 这些名字也不再解析，守卫照旧"搜到就报错"。

**顺带删掉 `shadow-black/30`**（`AccountScreen`、`ConnectScreen` 各一处，原为 `shadow-xl shadow-black/30`）：
它是 shadow **颜色**工具类，在旧值（`xl` 默认 10% 黑）下是"加深"，在 `e3`（70% 黑）下变成"变浅"，
语义反了；分层阴影该由层级自己带颜色。这是守卫逼出来的一个真 bug，不是清理。

**focus ring 收成一个令牌**：**21** 处焦点指示今天各自写颜色，三种拼法：

| 拼法 | 处数 | 今天写的颜色 | 改成 |
|---|---|---|---|
| `focus:ring-1` / `focus-visible:ring-2` | **11** | `ring-kin-blue/40`、`/50` | `ring-kin-focus-ring`（宽度不动） |
| 同上 | **5** | `ring-accent`（`AccountScreen` 4 + `ConnectScreen` 1） | 同上 |
| `focus-visible:outline focus-visible:outline-2` | **5** | `outline-kin-blue`（`ChangedFilesBar` 2、`CodeViewer` 2、`TaskUsageSummary` 1） | `outline-kin-focus-ring`（`outline-2` 不动） |

`ring-accent` 与 `outline-kin-blue` 都是写死的品牌蓝 `#0A84FF`，两个主题同一个值。
那 5 处 outline 是**第二轮 review** 才发现的，两次漏掉是同一个形状：处数是按**codemod 的模式**数的，
不是按**性质**数的——第一轮的表只认 `ring-kin-blue/*`（漏掉 `ring-accent`），
第二轮的守卫只看 `ring-` 前缀（漏掉 `outline-`）。所以守卫最后按性质写：
`(?:focus|focus-within|focus-visible):(ring|outline)-` 后面那一段如果是颜色，只能是这个令牌。

按 WCAG 1.4.11（非文字 ≥3:1）量了一遍，这些指示现在是**不合格的**——
而且把六个表面都量了以后，初稿的"暗色用 70% 透明"也是错的：那个值在 `--kin-elevated`
（比 `--kin-bg` 亮，而 ring 会跟着变亮）只有 2.55，比在 `--kin-page` 上的 3.12 低得多。

| 候选 | page | sidebar | bg | panel | elevated |
|---|---|---|---|---|---|
| 暗：今天 @0.4 / @0.5 | 1.76 / 2.13 | 1.77 / 2.12 | 1.76 / 2.10 | 1.66 / 1.92 | 1.66 / 1.92 |
| 暗：初稿 @0.7 | 3.12 | 3.05 | 2.95 | 2.55 | **2.55 ✗** |
| 暗：落地 `#0A84FF` 不透明 | 5.29 | 5.04 | 4.76 | 3.82 | **3.82** |
| 亮：今天 @0.4 / @0.5 | 1.49 / 1.64 | 1.58 / 1.77 | 1.66 / 1.89 | 1.66 / 1.89 | 1.61 / 1.82 |
| 亮：那 10 处不透明的品牌蓝（5 ring + 5 outline） | **2.57 ✗** | 3.10 | 3.65 | 3.65 | 3.32 |
| 亮：落地 `#0B6FE0` 不透明 | **3.39** | 4.08 | 4.81 | 4.81 | 4.38 |

暗色要过的是**最亮**的那块表面（elevated），亮色要过的是**最暗**的那块（page）——方向相反，
一张表就能看出为什么"一个值两个主题通用"是做不到的。第五行也正是那 10 处的病：
品牌蓝在暗色下恰好**等于**落地值（所以看不出问题），到亮色下每一格都更差，page 上直接不合格。

所以两个主题给**两个不同的不透明值**（暗 `#0A84FF`、亮 `#0B6FE0`），不透明是结论不是省事：
亮色下品牌蓝全不透明也只有 2.57，只能换更深的蓝；暗色下半透明过不了最亮的那个表面。
21 处颜色引用改成 `ring-kin-focus-ring` / `outline-kin-focus-ring`，宽度不动
（1px 的仍是 1px，`outline-2` 仍是 2px）。

守卫生效后还发现两种**以前能通过**的写法，它们比"颜色写错"更糟，因为看着像对的：
`focus:ring-[#0A84FF]`（任意 hex，同一支没进令牌的蓝）与 `focus:ring-kin-focus-ring/50`
（在 `var()` 颜色上加不透明度修饰，Tailwind 会**整个类不产出**——等于没有焦点指示）。
守卫因此按 `[^"'\s;]+` 取整个值槽，而不是取"像名字的部分"。

`ChatStream` 里那 2 处**裸** `ring-1 ring-kin-blue/40`（选中态）不是 focus，归 S4。

一处已知的观感副作用（§7 有完整条目）：设置页 tab 的**选中态**本身就是 `bg-kin-blue`，
而暗色的环恰好也是 `#0A84FF`，于是焦点落在它上面时是一圈光晕而不是一条能看出内缘的边。
环的对比度是对表面量的、六格全过，所以不为它改令牌；要分开，正解是 `ring-offset-1`，
与 P2 的组件层一起定。

**守卫量的是不透明表面**：上面六格都是不透明色。环若画在半透明填充里就不在这个保证内——
`--kin-fill-strong`（10% 白）叠在 `elevated` 上，暗色下这个值只有 2.79:1。
今天没有一处环落在这种容器里（最薄的一处是 `AgentModelPicker` 的
`bg-transparent` + `ring-inset` 叠在 `fill/45` 上），但这是个**未被测量**的边界，§7 记了一行。

剩下 5 个任意值**不归 S3**：
- 3 处 `shadow-[0_0_0_3px_rgba(...)]` **不是** focus ring，是"键盘选中的那张卡"的强调环，
  蓝/靛/琥珀三色分别对应三种卡（`ApprovalCard` / `UserQuestionCard` / `LimitCard`）——
  它是状态色，跟 S4 一起改；
- 2 处 indigo/amber 的强调光晕 `0_8px_24px_rgba(...,.12)`，同理；
- `CommandPalette` 的 `0_40px_100px_-20px_rgba(0,0,0,.8)` → `e3`（这一处归 S3）。

**字距**：实测 77 处，词 71（`wide`59 `tight`9 `normal`3）+ 任意 6（`[0.08em]`4 `[0.06em]`1 `[0.2em]`1）。
`theme.letterSpacing` 赋值三级：

| 级 | 值 | 用途 | 处数 |
|---|---|---|---|
| `tight` | -0.025em | 页面标题、品牌名 | 9（不动） |
| `label` | 0.06em | 大写小节标题（唯一的"标签"决定） | 65（`wide`59 + `[0.08em]`4 + `[0.06em]`1 + `[0.2em]`1） |
| `normal` | 0 | 在 label 内部复位 | 3（不动） |

一个是 `AccountScreen` 的字段名 `[0.2em]`，并进 `label` 后明显变窄——有意收敛，一个习惯只留一个值。

**行高**：实测 192 处。这里**两套词汇各有各的活**，S3 只给它们划边界、清掉任意值，不互相吞并：

- **px 阶梯保持不变**（S2 引入的 158 处：`body`+`leading-4`×107、`strong`+`leading-5`×40、
  `subtitle`+`leading-6`×3、`title`/`hero`+`leading-7`×5、`hero`+`leading-8`×2）。它们是
  **定高**场合（chip、单行行、列表行）的几何，和 `min-h-*`/`gap-*` 用的是同一把 4px 尺。
- **相对阶梯三级**，接的是"文案"场合——相对值必须跟着字号走，这正是它和 px 阶梯的分工：

| 级 | 值 | 替掉 | 处数 |
|---|---|---|---|
| `prose` | 1.625 | `relaxed` | 28（数值相同，只换名） |
| `ui` | 1.375 | `snug` | 3（数值相同，只换名） |
| `flush` | 1.0 | `none` | 1（数值相同，只换名） |

- 剩下 6 处任意值：`[12px]`（micro 10px）→`leading-3`（精确）、`[14px]`（caption 11px）→`leading-4`
  （卡片高 2px）、`[1.35]`/`[1.45]`（composer）与 `[1.32]`（SessionsPage 15px 两行截断）→`ui`
  （每行变动 ≤1px）。**真正移动的只有这 6 处。**
- `theme.lineHeight` 同样**赋值**，而且**不展开** Tailwind 的默认值：写出来的就是
  `3/4/5/6/7/8` 六级 px 加三级相对值（`leading-9/10` 没有任何字号需要，`tight/normal/loose`
  也没人用）。所以 `tight`/`normal`/`relaxed`/`snug`/`loose` 一起不再解析，守卫继续用"搜到就报错"。

**布局**：`sidebar`=248、`conversation`=720、`sheet`=420、`inspector`=min(40%,18rem)。
这四个是走 `extend.width` / `extend.maxWidth` 的（唯一一组不"赋值"的阶梯，理由见 config 头注释：
它们要替换的字面量还只在四处，而"一屏多宽"是 P2 的决定），守卫因此只按**名字**管
（名字必须在阶梯上）；被替掉的那四个字面量（`w-[248px]`、`max-w-[720px]`×11、
`max-w-[min(100%,420px)]`、`max-w-[min(40%,18rem)]`）现在有专门的守卫不许回来。
`w-[var(--kin-ws-sidebar)]`（未定义，§2.5）在 S1 已修。
容器宽度另有 5 个值（`600`/`640`/`760`/`920`/`1100`）没有名字，是 P2 的活（§7）。

### 3.5 「无边框」表面分离（规则，不是删边框）

今天 215 处 border，其中 141 处是 `border-[var(--kin-hairline)]`。规则：

> **两个不同层级的表面相接，不画线；同一层级内部的两个面，画线。**

- 侧栏（`--kin-sidebar`）贴主区（`--kin-bg`）：层级不同 → **删线**，靠 L\* 分离。
- 主区里的一张卡（`--kin-elevated`）浮在 `--kin-bg` 上：层级不同 → **删线**，靠 L\* + `e2` 阴影。
- 列表行与列表行：同一层级 → **保留 hairline**。
- 输入框自己的边：同一层级内部 → **保留 hairline-strong**。

所以不是"删掉 141 处"，而是**每一处都要能说出它属于哪一类**；§6 的截图对照逐屏检查。
另外让 §2.2 的 L\* 间距成为测试（同方案内不同槽位 ≥2 L\*），这类"看起来一样"就不能再悄悄发生。

## 4. 切片（每片一个可独立验证的提交）

| 片 | 内容 | 视觉预期 |
|---|---|---|
| **S0** | 本文档；Prettier 配置 + 全树一次格式化 | 零变化（纯空白） |
| **S1** | `design/theme.css`；`applyTheme` 写解析值；删两个 `@media` 块；tailwind config 只留 `var()`；删 `bg`/`chat`、`surface` 两组同义词；`tertiary` 并入 `muted` 且 `muted` 提到 AA | 有意变化：358 处次要文字变清楚 |
| **S2** | 字号 7 级 + 696 处 `text-[Npx]` 与 166 处命名字号 snap | 268 处移动；除 2 处外都在 2px 内 |
| **S3** | 圆角 / 控制件高度 / 字距 / 行高 / 布局宽度；阴影 3 级 + focus ring | 圆角 38（19 处变值）、控制件高度 11（另 102 只改名）、字距 65 处收进 `label`、行高 6（另 32 只改名）、阴影 **27** 处落地（25 具名 + 1 处裸 `shadow` + `CommandPalette` 的 1 个任意值）、焦点指示 21（11 `ring-kin-blue/*` + 5 `ring-accent` + 5 `outline-kin-blue`） |
| **S4** | 语义色三档；42 个裸色值 + 131 处默认调色板 → 令牌 | 有意变化：亮色下错误/diff/警告文字从 1.5–2.3:1 提到 ≥5:1 |
| **S5** | 无边框规则逐屏应用 | 结构性边框减少，层级靠 L\* 与阴影 |
| **S6** | ESLint（含两条局部规则）+ Prettier 进 CI；`/design` 画廊；守卫全开 | 零变化 |

S6 放最后是刻意的：规则落地时**不允许有例外清单**，所以迁移必须先做完。

## 5. 守卫（`src/design/tokens.test.ts`，全部无浏览器）

1. **引用可解析**：`src/**` 与 `tailwind.config.ts` 里每个 `var(--kin-*)` 都有定义（今天会抓到 4 个，§2.5）。
2. **每个定义的 token 都在画廊里出现**（A3；画廊源码即证据）。
3. **两块主题声明同一批 token 名**（今天手抄四遍靠人眼，没有任何检查）。
4. **表面阶梯**：同一方案内每个非 `base` 槽位与 `base` 差 ≥2 L\*（回归守卫——今天成立，
   但 §2.1 的注释说明这种"看起来一样"曾经发生过，而当时没有任何东西能发现）。
5. **墨色阶梯**：每级在 `base` 与 `overlay` 上都 ≥4.5:1。
6. **字号阶梯**：没有两级共享同一组 `(px, 字重, 墨色)`；相邻级（差 1px）必须在字重或墨色上不同。
7. **不留裸值**：`src/**` 里没有 `-[数字+单位]` / `-[#hex]` / `-[rgba(...)]` 形态的 class；
   允许函数式（`min()`/`max()`/`calc()`）、百分比、`dvh`/`vh`/`vw`、`env()`。
8. **类名有定义**：`src/**` 里用到的每个 `kin-*` class 都由 config 产出（今天会抓到 `text-kin-primary`、`text-kin-purple`）；
   实现上 import config 走 `theme.colors`，不起 Tailwind 进程。

已经落地的（S2/S3）：

9. **字号不留旧名**（S2）：`src/**` 里没有默认字号名或任意 px 字号。
10. **阶梯式守卫**（S3）：一张表七条轴——`leading` / `tracking` / `shadow` / `rounded` / `min-h` / `max-w` / `w`，
    每条的**允许名单从 `resolveConfig(config)` 里读**（不是抄一遍，所以改 config 不会与守卫脱节），
    `src/**` 里任何不在名单上的名字都报错；另加"裸 `shadow`"一条。
11. **任意高度只在刻度外**（S3）：`min-h-[Npx]` 通过当且仅当 N 不是 `theme.minHeight` 能表达的值
    （规则而非例外清单；`[480px]` 靠这条通过）。
12. **改名后的字面量不许回来**（S3）：`w-[248px]`、`max-w-[720px]`、`max-w-[min(100%,420px)]`、
    `max-w-[min(40%,18rem)]` 四个已命名的值。
13. **焦点指示可量**（S3）：`--kin-focus-ring` 必须在 `page`/`bg`/`elevated`/`panel`/`sidebar`/`inspector`
    六个表面上都 ≥3:1（`page` 是最坏的那格，也是亮色值的决定者；`inspector` 是后加的，今天过，加它是为了不让调值把它悄悄弄坏），
    且必须**不透明**（`rgb()` 解析器拒收带 alpha 的值——半透明正是旧指示的病）。
    注意它量的是**不透明**表面：环画在半透明填充里不在这个保证内（§7 有数值）。
14. **阶梯真的产出 CSS**（`tailwind.test.ts`）：把每种工具类跑一遍真的 postcss，逐条比对声明
    （`tracking-label` → `letter-spacing: 0.06em`、`ring-kin-focus-ring` → `--tw-ring-color: var(--kin-focus-ring)`、
    `outline-kin-focus-ring` → `outline-color: var(--kin-focus-ring)`…），
    并确认被替换掉的旧名字**一个 CSS 都不产出**。理由与 S2 同：一个不再解析的名字是静默失败，
    截图看不出来。
15. **焦点指示的颜色只许是那个令牌**（S3，两轮 review 后成型）：**按性质**扫，不按拼法扫——
    `(?:focus|focus-within|focus-visible):(ring|outline)-` 后面的值槽，只能是 `kin-focus-ring`，
    或该轴的宽度（从 `theme.ringWidth` / `theme.outlineWidth` 读）与 `inset`/`none`。
    值槽取 `[^"'\s;]+`（整个值，不是"像名字的部分"），因为 `ring-[#0A84FF]` 与
    `ring-kin-focus-ring/50`（后者 Tailwind 整个类不产出）都能骗过按名字取值的写法。
    守卫 13 量的是令牌本身，量不到"某个指示根本没在用令牌"——两轮各 5 处就是从这个缝里漏过去的。
16. **圆角必须是选定的那六级**（S3，review 后补）：守卫 10 的 `rounded` 轴用的是手写子集
    （`sm/md/lg/xl/2xl/full` + 侧向字母），不是 `Object.keys(theme.borderRadius)`——后者是
    Tailwind 的整个默认刻度，读了就永远不会红（`2xl` 往外那几级、零半径都能过）。
    另有一条用例把这份子集压回 config：每个名字必须是解析后 `borderRadius` 的键。
17. **有词的轴上不许出现任意值**（S3，review 后补）：`leading`/`tracking`/`rounded` 三轴的
    `X-[…]` 一律报错（字号那一轴在守卫 9 里同理）。理由是这三轴是**词汇**不是尺子：
    落地后树里每个值都有名字，所以任意值不是"超出刻度"，是"没有词"。不在名单里的三轴各有原因：
    `min-h` 有活着的幸存者（480px）走的是守卫 11 的**规则**；`shadow` 有 5 个状态光晕是 S4 的；
    布局宽度是 P2 的（栏目阶梯还没写，此时禁掉第四个宽度没有理由）。

上面 9–13、15–17 的扫描范围是 Tailwind 自己扫的那一套（`content` 里的 `index.html` + `src/**`，补上 `.js/.jsx` 与 `.css`），
不是只扫 `src/**`：守卫读的文件集必须与 build 读的一致，否则 `index.html` 就是一个守卫看不见的角落
（`src/api/generated/` 因此也**不**跳过——它在 Tailwind 的 content 里。14 不在此列，它是 postcss 编译，不读文件）。
一条已知代价：`shadow` 那一轴是"搜到就报错"，所以被扫文件里的**注释**也不能写那个裸词（写"elevation step"）。

**ESLint 两条局部规则**（`ui/eslint-rules/index.js`，用 `RuleTester` 自测）：
`kin/no-arbitrary-literal`（同守卫 7，编辑期就拦住）与 `kin/no-undefined-token`（同守卫 8）。
另外 `no-restricted-syntax` 禁止 `src/**`（`design/` 除外）出现裸 hex/rgba 字面量。

## 6. 验证方法

- **A2 的"不回退"要有证据**：S0 前先给全部路由在 390×844 与 1440×900 各截一遍存 `/tmp/p1-before/`；
  每片结束后重截。像素对照用 `sips -s format bmp`（已验证：32bpp、top-down、偏移 138）
  转成裸像素，再用 stdlib Python 算差异像素比例——不引入任何依赖。
- 每片跑：`npx tsc --noEmit`、`npm test`、`npx vite build`；S1 起加 `npm run check:api`。
- 有意变化的清单写在每片的提交信息里，截图对照后逐条确认。
- 最后跑 parity 计划要求的整机验证：`./scripts/desktop-rebuild.sh`，手机宽度下过一遍主要页面。

## 7. 风险与未决

| 风险 | 处理 |
|---|---|
| **亮色 `muted` 变清楚**是 358 处的可见变化，可能被认为"回退" | 单独列出 + 截图对照；对比度是可量化的改善（3.26→5.1） |
| `hero` 把 `text-[32px]` 收到 22px（1 处） | 改前先看 `ApprovalsPage.tsx:135` 的实际语境；若确属"页面级大标题"，22 与 9 处页面标题一致 |
| 无边框化是最主观的一片 | 只按 §3.5 的规则改，每一处能说出归属；拿不准的保留线 |
| Prettier 全树格式化的 diff 很大 | 单独一片、单独提交，放在最前，之后的 diff 才干净 |
| `ui/node_modules` 现在是软链到主 checkout | 加 ESLint/Prettier 依赖前必须在 worktree 里**真装一次**（`rm` 软链 + `npm install`），提交 `package-lock.json` |
| 亮色 `kin-blue` 填充配白字 4.02:1，仍低于 4.5 | 不在本次范围：填充色的取舍（品牌色 vs AA）留到 P2 组件层决定，本次只保证"文字墨色"达标 |
| `indigo` 的语义已查清 | 只用在「agent 在等你」这一件事上：`StatusBadge` 的 `waiting_input`、`UserQuestionCard` 整张卡（边框/图标/选中态/主按钮）。但**同一状态在 `taskCardStatus.ts` 里是橙的**——`approval` 一档同时收 `waiting_input` 与 `waiting_approval`，用 `kin-orange` 与 `rgba(255,159,10,…)` 渐变。即今天「等你」既是橙又是靛。S4 按「一处状态一个颜色」合并：以卡片那套（橙 = warning）为准，删掉靛；若届时认为「问句」与「审批」必须两色，那它们是两个状态、两族色，而不是两个组件各写一个 |
| 44px 触摸下限**没有自动守卫** | 它现在是 §3.4/§6 的一条人工规则。想自动化需要一个"哪些元素在手机上可点"的判断，容易写成假守卫；S6 加 lint 时一并评估 |
| 图标尺寸（`h-[17px]`…`h-[34px]`，19 处）没有阶梯 | 本片明确不动：没有图标阶梯时把它们 snap 到 4px 是**看得见的变化**（17→16、22→20），收益不明。§2.6 的"未命名尺寸"里不算已解决 |
| `[480px]` 是全树唯一超出 Tailwind 尺度的任意高度 | 保留；守卫**已落地**成规则（"任意 min-h 必须是刻度上写不出的值"），刻度本身从解析后的 config 读，不是例外清单 |
| 阴影三层是**黑透明**，不随主题切换 | 暗色下没问题（0.24/0.45/0.7 黑压在近黑底上）；亮色下 0.7 黑偏重。不在 S3 改：分层阴影是层级的函数，不是主题的函数，而亮色到底要不要更浅的阴影属于 S5「无边框分离」的取舍（那时才有亮色层级的实际判断依据）。截图会显示它是否已经难看 |
| `index.css` 里的**手写 CSS 声明**不在阶梯守卫范围内 | `border-radius: 4px`、`min-height: 44px`、`max-width: 100%` 这些是文件自己的几何（滚动条、触摸下限），不是工具类词汇，目前靠人工对齐。S6 的 lint 可以扩到声明层，但要先决定「哪些声明算词汇」——现在没有依据，所以不写假守卫 |
| 5 个任意阴影仍是状态色 | 3 个卡片强调环 + 2 个强调光晕，跟 S4 的语义色一起改；S3 的守卫只查阴影**名字**，不查任意值，这是刻意的（见 §3.4） |
| 页面容器宽度还有 5 个值（`600`/`640`/`760`/`920`/`1100`）没有命名 | **交给 P2**：P2 的活就是对话栏与导航布局，"一屏多宽"是它的决定，S3 只命名四个已经确定的（`sidebar`248 / `conversation`720 / `sheet`420 / `inspector`min(40%,18rem)）。S6 的 lint 在此之前不能把宽度轴写成硬规则。已落地的四个名字有守卫（改名后的字面量不许回来），其余宽度只受"名字必须在 maxWidth 阶梯上"约束 |
| 暗色下**环与填充同色**：设置页 tab 的选中态是 `bg-kin-blue`，而暗色 `--kin-focus-ring` 恰好也是 `#0A84FF` | 于是键盘焦点落在这个 tab 上时是"一圈更亮的光晕"而不是一条能看出内缘的边。这是 S3 换令牌后的**新**观感（旧值 `ring-kin-blue/50` 与填充也不同色，但旧值本身不合格）。**不为它改令牌**：环的对比度是对它所在的表面量的，`page`/`bg`/`elevated`/`panel`/`sidebar`/`inspector` 六格都过了，而 tab 是唯一把环画在填充色上的地方。真要分开，正解是 `ring-offset-1`（拿表面色垫一圈）而不是换个蓝；留给 P2 组件层一起定，已在 §3.4 记名 |
| 焦点指示的对比度只对**不透明**表面量过 | `--kin-fill-strong`（10% 白）叠在 `elevated` 上，暗色下 `--kin-focus-ring` 只有 **2.79:1**（`--kin-fill` 6% 是 3.16:1），低于令牌被认证的那条线。今天没有一处焦点指示落在这种容器里（最薄的一处是 `AgentModelPicker` 的 `bg-transparent` + `ring-inset` 叠在 `fill/45` 上），所以这是一个**未被测量**的边界而不是一个已知缺陷。要自动化它需要一个"这个元素身后叠了什么"的判断，容易写成假守卫，S6 的 lint 一并评估；`theme.css` 的不变量里已写明六格都是不透明表面 |
| 填充控件（`.kin-btn*`）**只有浏览器默认的 outline** 作为焦点指示，没有作者样式 | `index.css` 的 `.kin-btn` / `.kin-btn-primary` / `.kin-btn-secondary` 没有 `focus-visible:` 任何东西，键盘用户看到的是 UA 的 outline。**不顺手加一个环**：按钮底就是 `bg-kin-blue`，暗色下加同色的环等于没加（同上一条的观感问题），而 `ring-offset-2` 需要先决定"垫的那圈该用哪个表面色"——那是 S4「状态色 + 填充」里的判断。今天 UA outline 至少是**存在**的，所以这里不构成回退；S4 要给填充控件一个明确答案（`outline-kin-focus-ring` 大概率是对的，因为它不依赖填充色） |
| 16 处焦点环里有 1 处是死代码 | `SettingsPrimitives.tsx` 的 `IconButton` 在全树没有调用点，所以"21 处焦点指示"里活的是 20 处。它本身不是 S3 引入的（组件库导出），删除它属于清理而不是本片目标——登记在此，S4 改设置页组件时一并处理 |
| `index.html` 的 `theme-color` 是**手写 hex**（`#0f1115`），与 `--kin-page` 的 `#0e0e10` 不等 | meta 的 `content` 不支持 `var()`，只能由 JS 在切主题时改写（或删掉交给浏览器默认）。它不在 S3 的类名轴上，但它是 S1「每个颜色值都写在 `theme.css`」这条不变量的一处**例外**，登记在此；同一文件里的 `body` 还带 `text-zinc-100`（默认调色板）与 `bg-surface`（legacy 别名）——都归 S4 的"131 处默认调色板 → 令牌"。顺带：`index.html` 现在**在**守卫的扫描范围内了（原先只扫 `src/**`），S4 的守卫会直接看到它 |

**未决**：`--kin-warning` 与 `kin-orange` 是同一个语义（都是琥珀），S1 合并为一族，除非找到反例。

## 8. 进展

每片一片一提交，提交后在这里记一行；验收数字都是实测，不是估计。

| 片 | 提交 | 结果 |
|---|---|---|
| **S0** | `9e43f63` | Prettier 3 + `printWidth 100`，全树一次格式化（纯空白）；CI 的 UI 步骤改为 `format:check` + `tsc` + `test` + `build`（原先只有 build） |
| **S1** | `daa490d` | 76 行手抄变量 → 0；`index.css` 只剩两个 `@import` 与 `@tailwind`；`--kin-muted` 3.26:1 → 暗 6.1 / 亮 5.5；两个永不生效的 `@media` 块删除；4 处悬空引用修掉；5 个守卫全部红验过（改坏就变红，恢复就绿）；11 路由 × 2 宽 × 2 主题共 44 张截图对照：44/44 有差异，但差异**只落在字形像素上**（热力图上只有文字行），表面像素逐点比对完全相同（暗 `#0e0e10`/`#141416`、亮 `#d8d8dc`/`#ececf0` 改前改后一致），无位移。差异 0.10%–1.72%，与「358 处次要文字换色」一致
| **S1 修正** | `609084e` | 撤回一条我自己写错的发现（"亮色下 sidebar 与 inspector 同色"）：两条面板在布局上并不相邻，截图不支持这个结论，守卫 #4 改成对 `base` 的回归守卫 |
| **S1 证据** | 同上 | 截图工具：`sips -s format bmp` + stdlib Python 逐像素比对（零依赖）。补记：`project-detail__390__light` 的基线本身就是一张空白页（内容未加载完就截了），41.8% 的差异来自「基线没内容」，不是回退；该路由以 S1 那张为准，内容正常 |
| **S2** | `0a57d79` | 字号 7 级；862 处尺寸全部落到阶梯（任意值 696 + 命名 166），268 处真的变了（0.5px×185、1px×75、2px×6、6px×1、10px×1），158 处补了等值 `leading-*`；`tailwind.config.ts` 现在由 `tsc` 检查；5 个新守卫红验过 |
| **S2 证据** | 同上 | 44 张截图（11 路由 × 2 宽 × 2 主题）对照 S1：43/44 有差异，**差异全部来自文字重排**——最大的两条是 `task-detail__390`（20%）与 `project-detail__390`（11%）：前者气泡文字 14px→13px 后刚好一行放下，于是原来被顶出可视区的 `You` 标签露出来了；后者是同一段落换了断行点、热力图整体上移几像素。逐张看过，没有溢出、裁切或控件变形。唯一 0.00% 的是 `sessions__390__light`——该宽度下这个页面本来就没有变动的字号。`/design` 画廊另拍（373 行全页）：七级角色与它声明的 `px · weight · ink`、`absorbed` 全部渲染正确（截图只在 `/tmp`，不入库） |
| **S2 手滑** | 同上 | S2 提交前误在未提交的树上跑了 S3 的 codemod，两个切片混在一个工作区里。处理方式：用 S1 提交 + S2 codemod + 逐条手工补丁**重建** S2 状态，再验证「重建状态 + S3 codemod == 混在一起的那棵树」逐字节成立（55 个文件全等），最后 `tsc` / `prettier` / **491 个测试** 全绿才提交。教训：`git checkout -- <path>` 从 index 恢复，误以为会丢的工作可能还在 index 里 |
| **S3** | `45dc918` | 圆角 38（19 处变值）、控制件高度 11（另 102 只改名）、字距 65 → `tracking-label`、行高 6（另 32 只改名）、阴影 27 处 → `e1/e2/e3`、焦点指示 21 处 → `--kin-focus-ring`；守卫从 8 条加到 17 条（新增阶梯 7 轴、任意值规则、圆角子集、焦点指示按性质扫）；`/design` 画廊加焦点环组（5 个表面）；52 个文件被 codemod 改过 |
| **S3 证据** | 同上 | 48 张截图（11 路由 × 2 宽 × 2 主题 + 4 张画廊）对照 S2：48/48 有差异，最小 0.19%（`design__1440__dark`）、最大 8.57%（`task-detail__390__light`），只有 6 张 >1.5%——`task-detail` 两个宽度与 `sessions__390` 两张。`task-detail__390` 那张的差异是本片 11 处 2px 高度 snap 的汇聚点（`[34px]`→36、`[28px]`→32 等），热力图显示是整块内容位移而不是溢出或裁切。焦点环另拍一组（`design-focus__{390,1440}__{dark,light}`，滚动到画廊那一节）：五个表面上的 1px 环都清楚可见，暗 `#0a84ff` / 亮 `#0b6fe0`，与 §3.4 的表一致 |
| **S3 守卫红验** | 同上 | 每条守卫都"改坏变红、恢复变绿"验过，包括两处**以前根本红不了**的：焦点指示守卫（`focus-within:ring-kin-blue/40`、`ring-[#0A84FF]`、`ring-kin-focus-ring/50`、`outline-kin-blue` 四种拼法各报一条；同一轴写对的四种写法全绿）、圆角子集守卫（`rounded-3xl`/`rounded-none` 现在会红）；另用"把 `--kin-inspector` 调成灰"证明新增的 ink/环两行真的在循环里（只有那一格红） |
| **S3 复查** | 同上 | 两轮高级模型复查，六条 major 全是真问题、全部修在本提交里。第一轮：焦点指示守卫只认 `ring` 不认 `outline`，漏掉 5 处 `outline-kin-blue`（与更早漏掉的 5 处 `ring-accent` 是同一个形状的错）；圆角其实不是"赋值阶梯"，`rounded` 轴读的是 Tailwind 默认全集，`rounded-3xl`/`rounded-none`/`rounded-[10px]` 三种都绿——守卫**永远不会红**，而我自己在配置文件头和计划标题里都写了"圆角是赋值阶梯"；守卫看不见 `focus-within:`、任意 hex 和 `/50`（后者根本不产出任何 CSS）。第二轮：截断的字号名单（漏 `5xl`…`9xl`）、`--kin-inspector` 在两份表面清单里都缺、守卫跳过 `generated/` 而 Tailwind 会扫它、`--kin-page` 的理由写错。修法不是逐个补漏，而是把守卫改成**按性质**扫（`focus*:` 后面那个颜色槽位是什么），这一类漏检在结构上不再可能 |
| **S3 顺带改正** | 同上 | 计划里"20 处变值"实际是 19；`text-kin-primary` ×5 / `text-kin-purple` ×1 的 file:line 清单按实际重写 |
