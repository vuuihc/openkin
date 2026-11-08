# 设计系统中间层：从手写控件到有契约的组件库

状态：**进行中 · G0 完成**
建立：2026-11-08
配套：[`../product/TASTE.md`](../product/TASTE.md)、[`../product/components/README.md`](../product/components/README.md)、`ui/src/design/`
测量：`python3 scripts/ui_inventory.py` —— §2 的盘点数字由它生成，不手抄；其他数字标注了出处

## 0. 一句话

Kin 已经有 token 层和规则层，缺的是中间层：没有 Button、Input、Field、Select、Menu、Dialog、Tabs 这些**有 props、有契约、能被 lint 强制使用**的组件。本计划不换设计系统，只把已有的视觉语言升格成组件，再用同一把尺子证明采用率真的变了。

## 1. 为什么不是「换一套设计系统」

| 层 | 现状 | 证据 |
|---|---|---|
| Token | **有，而且比多数开源系统更严** | `ui/src/design/theme.css` 14.3K；`tokens.test.ts` 68.8K 不变量（对比度、L\* 分离、焦点环） |
| 规则 | **有** | `TASTE.md` 16 条；`IA.md`；移动端排版档；交互模态规范 |
| CSS 类 | **有，但没人必须用** | `.kin-btn*`、`.kin-input`、`.kin-card`、`.kin-sheet-surface`、`.kin-row-press` |
| **组件（props + 契约）** | **没有** | `ui/src/components/ui/` 只有 3 个 |
| 目录页（能看见所有状态） | **没有** | 无 Storybook / Ladle |

所以问题不是「视觉语言不存在」，是「视觉语言没有变成 API，于是每个页面都要重新决定一次」。`.kin-btn` 用了 61 次、裸 `<button>` 用了 311 次，就是「可选」二字的代价。

**药方因此也不同**：不是全量替换，是「抽取 + 强制」。判断标准见 §5——如果三个月后裸 `<button>` 的文件数没降，说明问题不是缺库，换什么库都没用。

## 2. 盘点（2026-11-08）

`python3 scripts/ui_inventory.py` 的输出：

| 指标 | 出现次数 | 文件数 |
|---|---:|---:|
| 裸 `<button` | 311 | 71 |
| `kin-btn` 类 | 61 | 16 |
| `<input` | 58 | 26 |
| `kin-input` 类 | 43 | 8 |
| `<textarea` | 8 | 6 |
| 原生 `<select` | 27 | 12 |
| `<label` | 61 | 19 |
| `role="menu"` | 5 | 5 |
| `role="listbox"` | 11 | 6 |
| `role="dialog"` | 11 | 7 |
| `role="tab"` | 7 | 5 |
| `role="status"` | 26 | 17 |
| `role="alert"` | 16 | 9 |
| `useAnchoredPanel` | 9 | 3 |
| `createPortal` | 12 | 6 |
| `pushToast` | 164 | 20 |
| `rounded-* + border` 表面 | 145 | 51 |

非测试 `.tsx` 共 **98** 个；`components/ui/` 共享控件 **3** 个。

### 2.1 读法

- **按钮是最大的单一缺口。** 71/98 个文件里手写按钮，只有 16 个文件用了现成的 `.kin-btn`。高度至少有 5 种写法（`h-8`、`h-9`、`min-h-9`、`min-h-10`、`min-h-11`）——其中一部分是桌面密度与手机 44px 的合理差异，一部分是漂移。
- **浮层是第二大的。** 5 个文件各自实现 `role="menu"`（`PermissionModePicker`、`Sidebar`、`TerminalProfileMenu`、`SheetSelect`、`OpenInMenu`），7 个文件各自实现 `role="dialog"`（`CommandPalette`、`DispatchSelector`、`MachineBrowser`、`Sheet`、`ShareDialog`、`FileQuickOpen`、`TaskDetailPage`）。`useAnchoredPanel` 只有 3 个文件在用，`createPortal` 有 6 个。
- **表单没有包装层。** 58 个 `<input>`、19 个文件自己写 `<label>`、8 个 `<textarea>`，错误与提示的 `aria-describedby` 各写各的。
- **状态语言是散的。** 17 个文件用 `role="status"`、9 个用 `role="alert"`，空/加载/错误/断线四态没有共用组件（TASTE 第 10 条要求有，但没有强制点）。
- **原生 `<select>` 是已知例外，不是违规。** TASTE 第 14 条明确「设置页已有的原生选择器不在此列，运行设置不许新增」。盘点把它们单列，避免下一轮误伤。

### 2.2 已有资产（不要重造）

| 资产 | 位置 | 用法 |
|---|---|---|
| Token + 不变量测试 | `ui/src/design/` | 所有新组件的颜色、字号、间距只能从这里来 |
| CSS 类层 | `ui/src/index.css` | `.kin-btn*` 直接成为 `Button` 的变体实现 |
| 手机面 | `ui/src/components/mobile/`（9 个） | `Sheet` 是 Dialog 的手机形态，不另起 |
| 设置页布局 | `components/settings/SettingsPrimitives.tsx` | `SettingsSection/Row/StatusPill` 是设置页的布局与展示件，不是通用控件；暂不提升 |
| Toast | `components/ToastHost.tsx` + `useAppStore.pushToast` | 已集中（164 处调用、20 个文件）；只补类型化变体 |
| 图标 | `components/icons.tsx` | 单文件，保持 |
| IME 守卫 | `ui/src/lib/ime.ts` | 所有键盘控件必须走它 |

### 2.3 按钮最多的地方（迁移从这里开始）

脚本按文件排序的前 12 名：

| 文件 | 裸 `<button>` |
|---|---:|
| `ui/src/components/layout/Sidebar.tsx` | 22 |
| `ui/src/pages/SettingsPage.tsx` | 16 |
| `ui/src/pages/ProjectDetailPage.tsx` | 15 |
| `ui/src/components/chat/ChatStream.tsx` | 14 |
| `ui/src/pages/RoutinesPage.tsx` | 13 |
| `ui/src/components/settings/ProviderSettingsSection.tsx` | 12 |
| `ui/src/pages/SessionsPage.tsx` | 9 |
| `ui/src/components/workspace/CodeViewer.tsx` | 9 |
| `ui/src/components/workspace/ChangedFilesBar.tsx` | 9 |
| `ui/src/components/chat/Composer.tsx` | 9 |
| `ui/src/components/settings/RoutingSettings.tsx` | 8 |
| `ui/src/components/chat/MachineBrowser.tsx` | 8 |

前 12 个文件占 144 个，接近一半。迁移按这张表从大到小做，不按页面新旧做。

## 3. 目标 / 非目标

**目标**

1. `ui/src/components/ui/` 成为唯一的 primitive 层；页面不再直接拼控件。
2. 每个共享控件有一份文档页，格式同 [`components/README.md`](../product/components/README.md)。
3. 每类控件上线后，旧写法在 lint 里变成 error（禁不掉的要写明理由）。
4. 一个 dev-only 的组件目录页，能一次看到所有控件的所有状态。

**非目标**

- 不替换 `--kin-*` token。它比 Astryx 更严，且有 68.8K 不变量测试，是资产不是负债。
- 不整站重写。页面在各自被改动时迁移，避免一次性 3000 行 diff。
- 不把 React 19 / Tailwind 4 升级作为本计划的前置条件。两件事解耦。
- 不做通用表格、图表、富文本，直到出现第二个真实调用方。

## 4. 抽取规则

**什么时候抽**（两条同时满足）：

1. 同一类手写出现 **≥ 3 处**；或者
2. 有一条**必须被强制**的规则（可访问性、键盘、IME、44px、token），靠自觉守不住。

**什么时候不抽**：只有 1–2 个调用方，且没有规则要强制——那是页面自己的布局，不是组件。

**抽的时候**：已有控件加变体，不叉新的（TASTE 第 13 条）。新组件必须回答「哪个已有组件长不出这个」。

## 5. 判定标准

三个月后跑 `python3 scripts/ui_inventory.py`，看这四个数：

| 指标 | 现在 | 目标 | 说明 |
|---|---:|---:|---|
| 裸 `<button>` 的文件数 | 71 | **< 25** | 不要求归零：一次性按钮可以留在页面里 |
| `kin-btn` 出现在 `Button.tsx` 之外 | 61 | **0** | 类名成为实现细节 |
| 手写 `role="menu"` / `dialog` / `tab` 的文件数 | 5 / 7 / 5 | **各 1** | 各收敛到组件内部 |
| 有文档页的共享控件 | 3 | **全部** | 与 `components/README.md` 的清单一致 |

**反向指标**：如果 `components/ui/` 的控件数涨了，但上面四个数没动，说明在做「文档里的组件库」，不是在改产品——停下来重排优先级。

## 6. 每一轮的固定交付（DoD）

一个控件一轮，七件事缺一不可：

1. `ui/src/components/ui/<Name>.tsx`，props 最小化，不暴露 `className` 去改形状。
2. `docs/product/components/<name>.md`：一句话 / 用它别用它 / 行为 / 键盘 / 无障碍 / 平台差异 / 契约。
3. **键盘契约**：Enter、Space、Escape、方向键、Home/End、Tab 各归谁；IME 组合中的键走 `lib/ime.ts`。
4. **无障碍表**：WCAG 条款 + 要求值 + 适用状态。
5. **测试**：DOM 行为 + 键盘 + 焦点归还，沿用现有 `*.dom.test.tsx` 风格。
6. **lint 禁旧写法**：能禁则禁；禁不了在文档里写清为什么。
7. **目录页**：在 `/dev/components` 里能打开、能看全状态。

## 7. 轮次

一个轮次 = 一次会话 = 一次可评审的提交，1–3 小时。

### 阶段 A · 基础设施

| 轮次 | 内容 | 验收 |
|---|---|---|
| **G0** | 盘点 + 本计划 | ✅ 完成（2026-11-08） |
| **G1** | dev-only 组件目录页 `/dev/components` | 开发模式下能看到现有 3 个控件 × 全部状态；生产构建不含该路由 |

### 阶段 B · 表单

| 轮次 | 内容 | 验收 |
|---|---|---|
| **G2** | `Button` + `IconButton` 抽取 | 变体来自 `.kin-btn*`；`loading`/`disabled`/`iconOnly` 有测试；lint 禁止 `kin-btn` 出现在组件外 |
| **G3** | Button 迁移：左栏与会话列表（`Sidebar` 22、`SessionsPage` 9，共 31） | 该区域裸 `<button>` 归零；键盘与焦点测试通过；截图对比无视觉回归 |
| **G4** | Button 迁移：对话面（`ChatStream` 14、`Composer` 9、`MachineBrowser` 8，共 31） | 同上 |
| **G5** | Button 迁移：工作区与项目（`ProjectDetailPage` 15、`ChangedFilesBar` 9、`CodeViewer` 9，共 33） | 同上 |
| **G6** | Button 迁移：设置页（`SettingsPage` 16、`ProviderSettingsSection` 12、`RoutingSettings` 8，共 36） | 同上 |
| **G7** | Button 迁移：`RoutinesPage` 13 | **等并发的设备维度改动落地后再排**，避免和别人的在途 diff 打架 |
| **G8** | `Input` + `Textarea` + `Field` 抽取 | label/hint/error/`aria-describedby` 由 Field 统一；`kin-input` 收敛 |
| **G9** | 表单迁移：设置页 + 项目页 | 19 个自写 `<label>` 降到 < 5 |
| **G10** | `Select`（原生 select 的包装） | 27 个例外收进一个组件；触屏下走 `SheetSelect`；lint 禁止新增裸 `<select>` |

### 阶段 C · 浮层

| 轮次 | 内容 | 验收 |
|---|---|---|
| **G11** | `Menu` + `Popover` 抽取（基于 `useAnchoredPanel`） | 5 处手写菜单收敛到 1 个组件；翻边/夹取/焦点归还/IME 有测试 |
| **G12** | Menu 迁移：`PermissionModePicker`、`TerminalProfileMenu`、`OpenInMenu`、`Sidebar` | `role="menu"` 只剩 `Menu.tsx` |
| **G13** | `Dialog` 抽取（`Sheet` 作为手机变体） | 焦点陷阱、Escape 分层（`overlayOwnsKeyboard`）、焦点归还 |
| **G14** | Dialog 迁移：`CommandPalette`、`ShareDialog`、`MachineBrowser`、`DispatchSelector`、`FileQuickOpen` | `role="dialog"` 只剩 `Dialog.tsx` + `Sheet.tsx` |

### 阶段 D · 结构与状态

| 轮次 | 内容 | 验收 |
|---|---|---|
| **G15** | `Tabs` 抽取 + 5 处迁移 | `role="tab"` 只剩组件内部；URL 同步仍在页面层 |
| **G16** | `StateView`（空 / 加载 / 错误 / 断线） | TASTE 第 10 条变成组件默认值；`role="status"`/`role="alert"` 的用法收敛 |
| **G17** | `Card` / `Surface` | 145 处 `rounded-* border` 里的重复写法收敛到 `.kin-card` + 组件 |

### 阶段 E · 难组件

| 轮次 | 内容 | 验收 |
|---|---|---|
| **G18** | 评估 combobox / data table / date-time picker：自建、React Aria、Radix、Astryx | 写一份对比，给出每类的选型结论；不写代码 |

一轮如果超过 ~40 处替换，拆成两次会话——大 diff 的评审成本会吃掉抽取的收益。

## 8. 现在的位置

| 项 | 状态 | 证据 |
|---|---|---|
| G0 盘点 | 🟢 完成 | `scripts/ui_inventory.py` 输出；§2 的表 |
| G1 目录页 | ⚪ 未开始 | — |
| G2 Button 抽取 | ⚪ 未开始 | — |
| G3–G7 Button 迁移 | ⚪ 未开始 | — |
| G8–G10 表单 | ⚪ 未开始 | — |
| G11–G14 浮层 | ⚪ 未开始 | — |
| G15–G17 结构 | ⚪ 未开始 | — |
| G18 选型 | ⚪ 未开始 | — |

每轮结束后更新这张表：绿=有测试名或提交号，红=试过但失败，灰=未验证。

## 9. 风险

| 风险 | 表现 | 对策 |
|---|---|---|
| **两套并存** | 新组件写好了，页面继续手写 | 每类上线必须同时加 lint；没有 lint 的抽取不算完成 |
| **抽象过早** | 为 1 个调用方造一个组件，props 越加越多 | §4 的两条门槛；不够就不抽 |
| **迁移期视觉回归** | 换组件时顺手改了间距/颜色 | 迁移提交只换实现，不改样式；每个面截图对比 |
| **并发改动** | 多个会话同时改同一批页面 | 一轮只碰一类控件、一组页面；小 diff，易重放 |
| **目录页腐烂** | 组件加了，目录页没加，半年后又看不见 | DoD 第 7 条；目录页缺一个状态就算没交付 |
| **Astryx 版本漂移** | 上游 0.7.x 变动，参考的文档失效 | 只借格式与清单，不 pin 代码；选型留到 G18 |

## 10. 开放问题

| # | 问题 | 当前倾向 | 何时定 |
|---|---|---|---|
| Q1 | 是否引入无样式底层（React Aria / Radix）？ | 阶段 A–D 不引入；难组件时再评估 | G18 |
| Q2 | 组件目录页用 `/dev/components` 还是 Ladle/Storybook？ | 先 `/dev/components`：零依赖、dev-only、不增加构建面 | G1 |
| Q3 | `SettingsPrimitives` 要不要提升到 `ui/`？ | 暂不：它是设置页布局，不是通用控件 | G8 之后回看 |
| Q4 | 原生 `<select>` 的 27 处要不要全迁？ | 先包一层 `Select`，触屏走 `SheetSelect`；不强行改设置页布局 | G10 |
| Q5 | 是否把 `docs/product/components/` 扩成完整清单？ | 是：每加一个控件加一行 | 持续 |

## 11. 与 Astryx 的关系

借三样，不借一样：

| 借 | 怎么用 |
|---|---|
| 组件清单 | 决定「还缺哪些控件」，避免拍脑袋 |
| `*.doc.mjs` 契约格式 | 已经是 `components/README.md` 的格式来源 |
| 状态分类法（用户 / 系统 / agent） | 已经用于 [`../product/design/agentic-states.md`](../product/design/agentic-states.md) |

**不借**：它的样式与 token 模型。Astryx 是带样式的系统，接进来就要换掉 `--kin-*`，而 Kin 的 token 约束更严、有测试。只有当一个组件自建成本明显高于迁移成本时（G18 的 combobox / table / date picker），才单独评估它的代码。

## 12. 怎么维护这份文档

- 数字只从 `scripts/ui_inventory.py` 来；手抄的数字一律视为过期。
- 每轮结束改两处：§8 的状态表、[`components/README.md`](../product/components/README.md) 的「现有」清单。
- 决策定了就写进 §10，并把「当前倾向」改成结论和日期。
- 计划外的新发现进 [`../product/LESSONS.md`](../product/LESSONS.md) 或 `gap-log.md`，不要顺手扩大本轮范围。
