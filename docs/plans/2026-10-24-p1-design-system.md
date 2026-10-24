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

`text-[Npx]` 共 30 个不同值 / 728 处，其中字号 18 个：

```
11px 175   12px 131   13px  88   11.5px 75   12.5px 65   10px 53   10.5px 31
14px  18   15px  14   13.5px 13    22px  9    9px  5    16px  4    17px  2
28px   1   32px   1   14.5px  1     8px  1
```

外加命名值 `text-xs`(12px) 113、`text-sm`(14px) 42、`text-base` 3、`text-lg` 2、`text-xl` 3、`text-2xl` 2。
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
| `components/workspace/WorkspacePanel.tsx` | `w-[var(--kin-ws-sidebar)]` | 同上 → 宽度变成 `auto` |
| `pages/AgentsPage.tsx` | `var(--kin-red,#ff453a)` `var(--kin-yellow,#ffd60a)` | 靠 fallback 兜住，说明写的人也不确定 |
| `components/chat/BranchPicker.tsx:352`、`cards/UserQuestionCard.tsx:105` | `text-kin-primary` ×5 | `kin.primary` 在 config 里不存在 → 类不生成 → 颜色继承 |
| `components/pr/PullRequestPanel.tsx:472` | `text-kin-purple` | 同上 |

`--kin-*` 的定义/引用全表：19 个定义中 **0 个** 未被引用；**4 个被引用但未定义**。
也就是说这一层今天没有任何一处自洽性检查。

### 2.6 工程量

`ui/src` 下 90 个文件、~44k 行；受影响 class **约 1,300 处**，其中**真正需要改动的约 350 处**
（字号 snap 215、裸色 100+、圆角 36、高度 20、字距/行高 9、阴影 10）。

## 3. 目标形状

**一句话**：一个文件写颜色，一个文件写阶梯，两处都只写一次；引用由测试和 lint 保证可解析。

```
ui/src/design/theme.css        唯一的色值来源。两块：:root（dark）、:root[data-theme="light"]
ui/tailwind.config.js          唯一的阶梯来源。只引用 var()，不再出现任何色值字面量
ui/src/design/tokens.test.ts   守卫（§5），vitest 跑，无需浏览器
ui/src/pages/DesignSystemPage.tsx  /design 画廊：每个 token、每级阶梯都在页面上出现（A3）
ui/eslint.config.js            局部规则：禁止新写裸值 / 未定义 token（§5.6）
```

### 3.1 为什么是「CSS 写一套 + 测试解析」而不是「TS 生成 CSS」

考虑过的形状是 `design/tokens.ts` 生成 `theme.css` + 生成 tailwind 片段。放弃，理由：

- 生成物需要"是否同步"的测试，同步测试本身又是一份真相。CSS 直接就是真相时，**没有漂移这个失败模式**。
- 已实测：Tailwind 3 用 jiti 加载 config，`tailwind.config.js` **可以** `import` 一个 `.ts`
  （`npx tailwindcss` 成功求值，抛错可见）。所以 config 与被测代码可以共享同一个模块——
  但共享的只有**阶梯**（结构值），颜色仍是 CSS 变量。这样两边都不需要生成器。
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

**表面阶梯（5 槽）**——按"离内容多远"命名，不按组件命名：

| 槽 | 暗 | 亮 | 谁在用 |
|---|---|---|---|
| `--kin-page` | `#0e0e10` | `#d8d8dc` | body 底、窗口外沿 |
| `--kin-sunken` | `#141416` | `#ececf0` | 侧栏（取代 `--kin-sidebar`） |
| `--kin-base` | `#1a1a1c` | `#ffffff` | 主区（合并 `--kin-bg` + `--kin-chat`） |
| `--kin-raised` | `#222226` | `#ebebf0` | inspector（值不变，只改名并去掉重复） |
| `--kin-overlay` | `#2c2c2e` | `#f4f4f6` | 浮层卡片/弹层（合并 `elevated` + `panel`） |

**墨色阶梯（3 级）**——合并 `tertiary` 进 `muted`，并把 `muted` 提到 AA 以上：

| 级 | 暗 | 对比度 | 亮 | 对比度 |
|---|---|---|---|---|
| `--kin-text` | `#f5f5f7` | 16.0 | `#1c1c1e` | 17.0 |
| `--kin-secondary` | `#c7c7cc` | 10.3 | `#3a3a3c` | 11.4 |
| `--kin-muted` | `#98989d` ← 原 tertiary | 6.05 | `#6e6e73` ← 原暗色 muted | 5.1 |

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
`indigo` → 先查清它在 `StatusBadge.tsx` 里表示什么状态，再决定归入哪一族或新增一族。

### 3.4 阶梯目录（`tailwind.config.js`，`theme.X` 赋值而非 `extend`，旧名不再存在）

**字号 7 级**（每级声明 px + 字重 + 墨色，即 §4.2 第 5 条的"语义角色"）：

| 角色 | px | 字重 | 墨色 | absorb |
|---|---|---|---|---|
| `micro` | 10 | 600 | muted | 8, 9, 10 |
| `caption` | 11 | 400 | secondary | 10.5, 11, 11.5 |
| `body` | 12 | 400 | text | `text-xs`, 12, 12.5 |
| `strong` | 13 | 500 | text | 13, 13.5, 14, 14.5 |
| `subtitle` | 15 | 600 | text | 15, 16 |
| `title` | 17 | 600 | text | 17 |
| `hero` | 22 | 700 | text | 22, 28, 32 |

snap 规则：就近取整；**平局取用量大的一级**（10.5 平局 → 11，11.5 → 11，12.5 → 12，13.5 → 13，14 → 13，16 → 15）。
结果：**694 处中 479 处不动，215 处移动，最大移动 2px**（8→10）。
`text-sm`(14) 42 处 → `strong`；`text-base`(16) → `subtitle`；`text-lg`(18)/`text-xl`(20)/`text-2xl`(24) → `title`/`hero`。

**只机械替换 px**：字重与墨色是**角色的定义**，不是要写进每个元素的东西——今天这些元素各自
已经带了 `font-semibold` / `text-kin-muted`，统一注入会与既有 class 打架（Tailwind 的胜负由生成
顺序决定，不由 markdown 顺序决定）。字重与墨色进画廊，由审查对齐。

**尺寸/间距**：Tailwind 的 4px 阶梯就是阶梯，不新造数字。只把控制件高度**按角色命名**：
`control-sm`=32 (`h-8`)、`control`=36 (`h-9`)、`control-lg`=44 (`h-11` = 触摸下限)。
17 个任意 `min-h-[Npx]` 里 26→28、34→36、50→48 三处 snap，其余直接换成既有 `min-h-*`。

**圆角**：Tailwind 自带的 `md`6 / `lg`8 / `xl`12 / `2xl`16 / `full` 就是阶梯（`lg`123 处、`xl`74 处本来就在用）。
删掉 config 里的 `card`(=xl) 与 `pill`(=full)；36 处任意值 snap 进这五级（`[7px]`/`[9px]`/`[10px]`→`lg`8，
`[5px]`/`[6px]`→`md`6，`[13px]`→`xl`12，`[18px]`→`2xl`16，`[2px]`→按元素判断）。

**阴影 4 级**：`e0` 无 / `e1`=`sm` / `e2`=`card` / `e3`=`window`。
`shadow-lg`×5 → `e2`，`shadow-xl`×3 → `e3`，`card-blue`/`card-amber` 删除（没有一个元素同时需要
"卡片阴影"和"蓝色阴影"两种语义）。
3 处 `shadow-[0_0_0_3px_rgba(...)]` 是 **focus ring**，不是阴影：改成 `ring` 令牌
（`--kin-focus-ring` + 两个 accent ring）。

**布局**：`sidebar`=248、`conversation`=720、`sheet`=420、`inspector`=min(40%,18rem)。
今天写成 `w-[248px]`、`max-w-[720px]`×11、`w-[var(--kin-ws-sidebar)]`（未定义，§2.5）。
P2 要的"居中对话栏 + 显式宽度档位"直接用这几个名字。

### 3.5 「无边框」表面分离（规则，不是删边框）

今天 215 处 border，其中 141 处是 `border-[var(--kin-hairline)]`。规则：

> **两个不同层级的表面相接，不画线；同一层级内部的两个面，画线。**

- 侧栏（sunken）贴主区（base）：层级不同 → **删线**，靠 L\* 分离。
- 主区里的一张卡（overlay）浮在 base 上：层级不同 → **删线**，靠 L\* + `e2` 阴影。
- 列表行与列表行：同一层级 → **保留 hairline**。
- 输入框自己的边：同一层级内部 → **保留 hairline-strong**。

所以不是"删掉 141 处"，而是**每一处都要能说出它属于哪一类**；§6 的截图对照逐屏检查。
另外让 §2.2 的 L\* 间距成为测试（同方案内不同槽位 ≥2 L\*），这类"看起来一样"就不能再悄悄发生。

## 4. 切片（每片一个可独立验证的提交）

| 片 | 内容 | 视觉预期 |
|---|---|---|
| **S0** | 本文档；Prettier 配置 + 全树一次格式化 | 零变化（纯空白） |
| **S1** | `design/theme.css`；`applyTheme` 写解析值；删两个 `@media` 块；tailwind config 只留 `var()`；删 `bg`/`chat`、`surface` 两组同义词；`tertiary` 并入 `muted` 且 `muted` 提到 AA | 有意变化：358 处次要文字变清楚 |
| **S2** | 字号 7 级 + 728 处 `text-[Npx]` 与 165 处命名字号 snap | 215 处移动 1–2px（`hero` 那处 32→22 单独看） |
| **S3** | 圆角 / 控制件高度 / 字距 / 行高 / 布局宽度；阴影 4 级 + focus ring | 36 + 20 + 10 处 snap |
| **S4** | 语义色三档；42 个裸色值 + 131 处默认调色板 → 令牌 | 有意变化：亮色下错误/diff/警告文字从 1.5–2.3:1 提到 ≥5:1 |
| **S5** | 无边框规则逐屏应用 | 结构性边框减少，层级靠 L\* 与阴影 |
| **S6** | ESLint（含两条局部规则）+ Prettier 进 CI；`/design` 画廊；守卫全开 | 零变化 |

S6 放最后是刻意的：规则落地时**不允许有例外清单**，所以迁移必须先做完。

## 5. 守卫（`src/design/tokens.test.ts`，全部无浏览器）

1. **引用可解析**：`src/**` 与 `tailwind.config.js` 里每个 `var(--kin-*)` 都有定义（今天会抓到 4 个，§2.5）。
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
| `indigo` 的语义未定 | S4 开工前先查 `StatusBadge.tsx` / `UserQuestionCard.tsx`，定不下来就并入最近的语义族，不新增第五族 |

**未决**：`--kin-warning` 与 `kin-orange` 是同一个语义（都是琥珀），S1 合并为一族，除非找到反例。
