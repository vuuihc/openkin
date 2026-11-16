# SessionFilters

**对话列表的状态与范围过滤。** 一个 chip，点开在它下面展开一块面板，两个宽度
同一个形状。

## 用它 / 别用它

用它：

- 对话列表（`SessionsPage` / 左栏）的状态过滤和归档范围。
- 过滤条件需要写进地址栏、刷新后还在的场景。

别用它：

- 别的列表。这不是通用过滤器——状态词表属于对话（TASTE 第 1、4 条：一份列表
  一个搜索框，一个东西只有一个列表）。
- 需要搜索的过滤。搜索框属于列表本身，不塞进过滤器面板。

## 为什么状态进 URL

`?status=` 发给 daemon 过滤，不只是筛已加载的那一页。已加载页是 100 行，只筛
这一页会对“还有没有在跑的对话”给出错误答案。未知或缺失的 `?status=` 一律当作
“全部”，不是一个什么都匹配不上的过滤器（`normalizeStatusFilter`）。

导入的 agent 会话没有状态，所以设了状态过滤时列表会隐藏它们。

## 词表

`running` / `waiting_approval` / `waiting_input` / `succeeded` / `failed` /
`canceled`。

`queued` 和 `retrying` 故意不在里面：它们是两个状态之间的瞬间，为一个只持续
一秒的状态做过滤器，等于做一个几乎永远空着的控件。`canceled` 相反——它是持久的，
而且行首的状态点不为它画任何东西，这里是不开抽屉也能找到它的唯一入口。

## 行为

- **原地展开，不是 sheet。** `Sheet` 是 `md:hidden`，用它就得再做一个桌面专属
  表面，于是有两个机会对“选了什么”给出不同答案。触发点下面的面板是两个宽度
  下的同一个控件。
- **展开时按钮变成摘要。** 有过滤时 chip 显示“失败 · 已归档”和一个数字角标；
  数字本身对屏幕阅读器隐藏，另有一句完整的播报。
- **Escape 关闭并把焦点还给 chip。**
- **有过滤时才出现“清除”。**

## 键盘

| 键 | 归属 |
|---|---|
| Enter / Space | 展开或收起 |
| Tab | 在面板内的选项间移动 |
| Escape | 关闭，焦点回到 chip |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 展开状态 | 4.1.2 | `aria-expanded` + `aria-controls` 指向面板 | 打开 / 关闭 |
| 分组名称 | 1.3.1 Info and Relationships | 两组选项各用 `role="group"` + `aria-labelledby` | 打开 |
| 选中状态 | 4.1.2 | 选中项由 `Option` 自己表达，不只靠颜色 | 打开 |
| 计数播报 | 4.1.3 | 角标数字 `aria-hidden`，另有一句含名词的完整播报 | 有过滤 |
| 触控目标 | 2.5.8 | 基准 `min-h-9`（36px，桌面密度）；手机上 AppShell 根节点的 `.touch-lg` 地板把 chip 与“清除”抬到 44px | 手机 |

## 契约

```ts
type Props = {
  status: SessionStatusFilter;   // "" 表示全部
  scope: SessionScopeFilter;     // "active" | "archived"
  onChange: (next: { status: SessionStatusFilter; scope: SessionScopeFilter }) => void;
};
```

受控组件：自己不开状态，`open` 是唯一的内部状态。URL 读写归页面，不归这里。
