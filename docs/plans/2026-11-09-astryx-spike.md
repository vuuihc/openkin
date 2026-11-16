# Astryx 接入 spike（2026-11-09）

状态：**完成** · 结论：固定成本比预估低一个量级，整套替换重新成为候选
2026-11-09 追加 Tailwind 4（§3.6）与布局层（§3.7）实测。
问题：整套替换 Astryx，是不是比 G2–G17「自己抽」更快、更便宜？
配套：[`2026-11-08-design-system-middle-layer.md`](2026-11-08-design-system-middle-layer.md)

## 0. 结论先说

**是，至少固定成本这一半是。** 我之前判断“整套替换要 4–7 周、自己抽 2–4 周”，依据是四条假设，其中三条被实测推翻：

| 我先前的假设 | 实测 |
|---|---|
| 要迁 Tailwind 4 才能编译 | **不用**。Astryx 发预编译 CSS，`npm install` 后三个 `@import` 即可 |
| 要接 StyleX 构建插件 | **不用**。只有 `@stylexjs/stylex` 作为运行时 peer |
| React 19 迁移是大工程 | **98 个非测试文件，只有 1 个真实类型错误**（`useRef` 的 `RefObject<T \| null>`） |
| IME 守卫、焦点归还这些行为要重新挣 | **Astryx 自带**：`dist/utils/ime.js` 的 `isComposing \|\| keyCode === 229` 和我们抽出来的完全同源；`focusReturn`、`useFocusTrap` 也在 |
| 组件要自己补一大半 | **约 110 个组件**（`dist/` 下 120 个目录，去掉 animator/gestures/hooks/i18n 等基础设施），含 BottomSheet、SnapPaging、gestures、CommandPalette、Table、TreeList、Toast |
| 主题要重做 | **约 20 行 `defineTheme`** 就接近 Kin 的暗色外观 |
| 包体积会涨很多 | Button + TextInput + Theme：**+84 kB raw / +25 kB gzip** |

唯一没被推翻的是 **CSS 共存**：Tailwind 3 的 preflight 是无层级的，会压过 Astryx 的 `@layer` 组件样式。这是这次 spike 找到的唯一结构性阻塞，也是现在真正要决策的那一件事。

## 1. 方法

隔离 worktree（`/tmp/kin-astryx-spike`，HEAD + 下列改动），不碰主工作区：

| 改动 | 内容 |
|---|---|
| `ui/package.json` | React/ReactDOM 19.3.1、`@astryxdesign/core@0.7.11`、`@astryxdesign/theme-neutral@0.7.11`、`@stylexjs/stylex@0.19.1`、`@types/react@19` |
| `ui/src/index.css` | 三行 `@import`：`reset.css` → `astryx.css` → `theme.css` |
| `ui/tailwind.config.ts` | `corePlugins: { preflight: false }`（只为验证因果，不是最终方案） |
| `ui/spike.html` + `ui/src/spike.tsx` | 一次性入口，不进军线构建 |
| `ui/src/components/ui/SheetSelect.tsx` | `buttonRef?: RefObject<HTMLButtonElement \| null>`（React 19 类型） |

## 2. 实测时间线

| 时刻 | 事件 | 耗时 |
|---|---|---|
| 00:51:56 | 建 worktree | — |
| 00:52:02 | `npm ci` | 6s |
| 00:52:16 | 安装 React 19 + Astryx + StyleX | 10s |
| 00:53:22 | `tsc --noEmit`：2 个错误（1 个是真的） | 6s |
| 00:53:58 | `vite build` 成功 | 22s |
| 00:54:15 | 第一次渲染：Astryx 按钮是裸文字 | — |
| 00:55:13 | 关掉 preflight、重启：按钮完全恢复 | 约 1 分钟 |
| 00:57:39 | 套上 Kin 主题，视觉基本对齐 | 约 2 分钟 |

**从零到“一个穿 Kin 皮的 Astryx 组件渲染出来”，墙钟 5 分 43 秒**（含两次 npm install、一次 tsc、一次 build、一次层级冲突定位）。冲突定位之所以快，是因为事先知道层叠层的优先级规则；团队第一次遇到会慢一些，但这是知识成本，不是每次都要付的工程成本。

## 3. 关键发现

### 3.1 唯一的阻塞：Tailwind 3 的 preflight 压过 Astryx 的层

计算样式证据（未关 preflight）：

```json
{ "background": "rgba(0, 0, 0, 0)", "color": "rgb(0, 0, 0)", "padding": "0px", "height": "32px" }
```

命中的规则：

- `button, input:where(...) { background-color: transparent }` — **UNLAYERED**（Tailwind 3 preflight）
- `.x1ewilqj:not(#\#):not(#\#):not(#\#) { background-color: var(--color-accent) }` — `@layer astryx-base`

无层级声明优先于任何层，所以 Astryx 的组件样式被 preflight 剥掉了。关掉 preflight 并重启后：

```json
{ "background": "rgb(27, 27, 27)", "color": "rgb(255, 255, 255)", "padding": "8px 12px", "radius": "10px" }
```

这就是 README 里 Tailwind 示例坚持用 Tailwind 4 的原因：Tailwind 4 的 preflight 在 `layer(base)` 里，可以和 `astryx-base` 排序。

**两条解法，成本不同：**

| 方案 | 工作 | 风险 |
|---|---|---|
| A. 关 preflight + 把 Kin 依赖的基线规则放进真实 `@layer kin-base`（排在 Astryx 层之前） | 0.5–1 天 | 全局基线变了，17 个页面要过一遍视觉回归 |
| B. 升 Tailwind 4 | 2–3 天 | 11.8K 配置迁到 CSS-first、透明度/阴影/ring 语义变化、token 测试重验 |

### 3.2 主题能穿上 Kin 的皮

`defineTheme({ name, extends: neutralTheme, tokens })`，10 组 token 映射：

```ts
"--color-accent": ["#0a84ff", "#0a84ff"],
"--color-background-body": ["#ffffff", "#1a1a1c"],
"--color-background-surface": ["#f4f4f6", "#2c2c2e"],
"--color-text-primary": ["#1c1c1e", "#f5f5f7"],
"--color-border": ["rgba(0,0,0,0.09)", "rgba(255,255,255,0.08)"],
"--radius-container": "12px"
```

截图结果：主按钮就是 Kin 蓝，次按钮是 Kin 的 `--kin-elevated`，输入框是暗色 + 发丝边。**和 `kin-btn` 并排看，差异已经小于“两个不同页面之间的差异”。**

差异仍在：圆角比 Kin 的 `rounded-lg` 略大、字体栈不同、危险色不是 Kin 的取值——都是映射表能收掉的。

### 3.3 暗色跟的是 `color-scheme`，不是 `data-theme`

Astryx 的 token 用 `light-dark()`，由 `color-scheme` 决定。Kin 用 `data-theme` 切主题，两者不自动对接。spike 里在容器上加 `style={{ colorScheme: "dark" }}` 就解决了。**桥接成本：约半天，写成一个 Provider。**

### 3.4 行为资产是重复的，不是互补的

`dist/utils/ime.js` 的注释几乎和我们 `ui/src/lib/ime.ts` 同源：两条信号、229 兜底、不要在没有浏览器矩阵审计前删掉。焦点归还、焦点陷阱、BottomSheet 栈也都有。

**含义：自己抽的 G2–G17，有相当一部分是在重写 Astryx 已经写好的东西。** 这是本次 spike 对我先前判断最大的一次修正。

### 3.5 体积

| 指标 | 基线 | 接入后 | 差 |
|---|---:|---:|---:|
| `index-*.js` raw | 2,217.48 kB | 2,301.40 kB | **+83.9 kB** |
| `index-*.js` gzip | 564.37 kB | 589.43 kB | **+25.1 kB** |
| CSS | 未测 | 371.10 kB | — |

只引了 Button、TextInput、Theme 三个入口，tree-shaking 正常。

### 3.6 Tailwind 4 实测（2026-11-09 追加）

在独立 worktree（`/tmp/kin-tw4`，HEAD `de467411`）把主仓库升到 `tailwindcss@4.3.5` + `@tailwindcss/postcss@4`，逐步记录：

| 步骤 | 结果 | 耗时 |
|---|---|---|
| 安装 | 4.3.5 + PostCSS 插件 | 19s |
| `postcss.config.js` | 换成 `@tailwindcss/postcss` | 1 行 |
| `index.css` | `@tailwind *` → `@import "tailwindcss"` + `@config` | 1 行 |
| `@apply kin-btn` | v4 不认自定义类，展开成共享选择器 | ~10 行 |
| 构建 | 成功 | 19.9s |
| `tsc --noEmit` | 4 个错误，全在两个测试文件 | — |
| 测试 | 1814 通过 / 6 失败（2 个文件） | 16s |

**v4 确实解掉了 preflight 冲突**：不关 preflight，Astryx 按钮也能正常渲染（Kin 蓝、`8px 12px` 内边距、8px 圆角）。但必须显式声明层顺序，否则会反向出事：

```css
@layer reset, theme, base, astryx-base, astryx-theme, components, utilities;
```

不加这一行时，Astryx 的 `reset` 层排在 Tailwind `utilities` 之后，把 `.kin-btn` 的 background/padding 全压回 0（实测：背景透明、padding 0、高度 24px）。

**真正的成本不在构建，在语义：**

1. **测试工具链**：`tokens.test.ts` 和 `tailwind.test.ts` 依赖 v3 的 `tailwindcss/resolveConfig` 与 `postcss([tailwindcss({ content })])`，v4 都已移除；要用 `@tailwindcss/node` 的 `compile()` + `build(candidates)` 重写。6 个失败用例全在这里，`tsc` 的 4 个错误也全在这里。
2. **无层级规则反转**：v3 里未加层的 `body { background: var(--kin-page) }` 和工具类按特异性竞争，`.bg-kin-bg` 赢；v4 里工具类进了 `@layer utilities`，**无层级规则无条件获胜**，body 背景从 `--kin-bg` (#1a1a1c) 变成 `--kin-page` (#0e0e10)。`index.css` 里所有「原本可以被工具类覆盖」的无层级规则都要审一遍。
3. **默认值变化**：`rounded-sm` 2px→4px（4 处）；默认 placeholder 色改为 `currentColor` 50%；`outline-none` 语义变化（forced-colors 下的透明轮廓没了）。边框默认色改 `currentColor` 在本仓库无影响——662 处 `border` 全部显式给了颜色。
4. **产物**：CSS 87.6K → 108.9K（+21.3K，+24%）；JS 不变。
5. **视觉对比**：token 门页 v3 vs v4，几何几乎一致（卡片 3px 下移、高 6px），像素差 3.78%、平均通道差 2.09——主要是文字抗锯齿；确定的结构差异只有第 2 条的 body 背景。

修正后的估算：机械升级约 **0.5 天**（原估的 2–3 天在这部分偏保守），但测试重写 + 无层级规则审计 + 17 页视觉回归合计仍在 **~2 天**。

### 3.7 布局层：Astryx 不只有控件

布局不是示例页，是组件：

| 层 | 组件 |
|---|---|
| 应用外壳 | `AppShell`（header / sideNav / main；默认 `md` 以下自动切 MobileNav 抽屉；`wash`/`surface`/`section`/`elevated` 四种导航底色） |
| 页面骨架 | `Layout`（header / start / content / end / footer 五槽）、`Section`、`Divider` |
| 排布 | `Grid`（含 `GridSpan`）、`Stack` / `HStack` / `VStack`、`Center`、`AspectRatio`、`ScrollableArea`、`Resizable` |
| 导航 | `SideNav`、`TopNav`、`MobileNav`、`NavMenu` / `NavItem`、`Breadcrumbs`、`TabList`、`Toolbar` |
| 浮层 | `Drawer`、`BottomSheet`、`Dialog`、`Overlay`、`Popover`、`ContextMenu` |

和 antd 的差别：antd 给 `Layout.Header/Sider/Content/Footer` 四件套加示例页；Astryx 的 `AppShell` 把断点、移动端抽屉、导航变体做进了组件，`Layout` 是五槽通用骨架。包内注释还提到 CLI 带 `templates/blocks/components/AppShell/` 的 showcase blocks（未安装 CLI，未验证内容）。

对 Kin 的含义：`ui/src/components/layout/` 那套手写外壳（`Sidebar` 22 个裸按钮）是它的直接替代对象；G0.5 除 `SettingsPage` 外应把外壳作为第二个验证面。

## 4. 还没验证的

| 项 | 为什么重要 | 怎么验 |
|---|---|---|
| 移动端 44px | Astryx 按钮是 28/32/36px，低于 Kin 的手机地板 | 390px 视口渲染，`themeAdaptations`/compact 或全局 `pointer: coarse` 覆盖 |
| 完整 token 映射 | 65 个 Kin token 对 Astryx 的 token 集，缺一个就有一处颜色不对 | 生成映射表，逐项对比 + 跑 `tokens.test.ts` 的等价断言 |
| i18n 归属 | Astryx 自带 i18n 模块和 `intl-messageformat`，Kin 也有一套 | 看它哪些组件强制自己的文案，能否注入 |
| 一页端到端 | 单组件能渲染 ≠ 一页能迁 | 拿 `SettingsPage`（16 个按钮、27 个原生 select 里的一部分）整页迁一次并计时 |
| preflight 方案 A 的回归面 | 关掉 preflight 会改全局基线 | 17 个页面截图对比 |
| preflight 方案 B 的无层级审计 | v4 让无层级规则反过来压过工具类（§3.6 第 2 条） | 列出 `index.css` 全部无层级规则，逐条判断是否该进 `@layer base` |
| 0.7.x 的 API 稳定性 | 上游每个月都在发版 | 读 CHANGELOG 的破坏性变更频率 |

## 5. 对原计划的修订建议

原计划把 Astryx 放在 G18「只评估难组件」。spike 之后，这个位置不对了：**先决定组件层要不要整体采用，再决定是自己抽还是迁移**，否则 G2–G17 可能白做。

建议在 G1 之前插一个 **G0.5 决策轮**：

1. 定 preflight 方案（A 或 B）。**实测后 B 的机械部分是 0.5 天、完整成本 ~2 天**（§3.6），A 是 0.5–1 天但回归面未知；两者都要额外加层顺序声明。
2. 用选定方案把 `SettingsPage` 整页迁到 Astryx（含 Kin 主题、i18n、390px 验收）。
3. 计时 + 截图 + 回归。
4. 决策：
   - **通过** → 计划改写为“迁移轮次”，G2–G17 的控件清单仍然有用（它变成迁移顺序表）。
   - **不通过** → 按原计划自己抽，本 spike 的结论作为“为什么不整套换”的记录。

预计 G0.5 本身 1–2 天。它买到的是：避免在错误的路线上投入 3–5 周。

## 6. 复现

spike worktree 保留在 `/tmp/kin-astryx-spike`（临时目录，重启可能被清）。复现步骤：

```bash
git worktree add --detach /tmp/kin-astryx-spike HEAD
cd /tmp/kin-astryx-spike/ui
npm ci
npm install react@^19 react-dom@^19 @astryxdesign/core@0.7.11 \
  @astryxdesign/theme-neutral@0.7.11 @stylexjs/stylex@^0.19
npm install -D @types/react@^19 @types/react-dom@^19
# 三行 CSS import + corePlugins.preflight=false + spike.html/spike.tsx
npx vite --port 5199
# 打开 http://localhost:5199/spike.html
```

截图在仓库根的 `.playwright-mcp/`（已 gitignore）：`spike-desktop.png`（冲突态）、`spike-no-preflight.png`（修复态）、`spike-kin-theme.png`（Kin 主题）。

Tailwind 4 的复现（§3.6）：

```bash
git worktree add --detach /tmp/kin-tw4 HEAD
cd /tmp/kin-tw4/ui && npm ci
npm install tailwindcss@^4 @tailwindcss/postcss@^4
# postcss.config.js → { plugins: { "@tailwindcss/postcss": {} } }
# src/index.css 顶部：
#   @layer reset, theme, base, astryx-base, astryx-theme, components, utilities;
#   @import "tailwindcss";
#   @import "@astryxdesign/core/reset.css";      # 顺序在 tailwindcss 之后
#   @import "@astryxdesign/core/astryx.css";
#   @import "@astryxdesign/theme-neutral/theme.css";
#   @config "../tailwind.config.ts";
npx vite build
npx vitest run
```
