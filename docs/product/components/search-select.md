# SearchSelect

**可搜索的单选。** 选项多到需要按名字找时用它；手机打开盖住当前面板的一层，
Mac 打开贴着触发点、可上下翻的浮层。

## 用它 / 别用它

用它：

- 选项超过一屏，或者用户会按名字找（模型目录、agent、分支、机器）。
- 选项需要分组（每组一个标题）。
- 当前值可能不在选项里（用户手输的模型 id），这时用 `display` 显示原值。

别用它：

- 两到五个固定选项。用菜单或分段按钮——一个搜索框罩着四个选项，是列表兑现
  不了的承诺（TASTE 第 5 条）。
- 选项需要长说明。浮层里放不下，读者也不会读。

## 行为

- **两种形状，一个控件。** 窄于断点走 `Sheet`；宽屏走锚定浮层。触发按钮是同一个，
  变的只是它打开什么。
- **搜索框默认关闭。** `searchable` 是显式开启的，短列表不该出现。
- **弹出方向是偏好，不是保证。** 面板是 `fixed`，按视口坐标摆放，不受祖先
  `overflow` 影响。`placement` 只决定首选方向：首选侧不足 120px 且另一侧更宽时
  自动翻边，宽度和最大高度也按视口夹住。触发点在页面底部时可以传
  `placement="top"` 表达偏好，翻不翻仍由测量结果定。
- **打开时滚到当前项。** 目录有几十行，当前项可能在最后一行。
- **关闭后焦点回到触发按钮。** 这是所有浮层共用的约定，不是这个控件自己的。

## 键盘

| 键 | 归属 |
|---|---|
| ↑ / ↓ | 在选项间移动焦点 |
| Home / End | 跳到首 / 末项 |
| Enter | 选中当前项 |
| Tab | 关闭并把焦点交出去（手机端不关，由 `Sheet` 的焦点陷阱接管） |
| Escape | 关闭浮层，焦点回到触发按钮（手机端由 `Sheet` 拥有这一层） |
| 输入法组合中的 Enter | **不选中**——见 `lib/ime.ts` |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 触发按钮名称 | 4.1.2 Name, Role, Value | 名称含当前值 | 全部 |
| 展开状态 | 4.1.2 | `aria-expanded` 跟随开合 | 打开 / 关闭 |
| 桌面浮层（`searchable`） | 4.1.2 | 搜索框是 `combobox` + `aria-controls` + `aria-autocomplete="list"`，列表为 `listbox`/`option` | 打开 |
| 桌面浮层（不可搜索） | 4.1.2 | 没有输入框，也就**没有 `combobox`**；列表仍是 `listbox`/`option`，由触发按钮的 `aria-haspopup="listbox"` 指过来 | 打开 |
| 手机列表 | 4.1.2 | 不用 `listbox`：`Sheet` 会把任何 `listbox` 当成浮层而拒绝关闭，改用 `aria-current` 按钮 | 打开 |
| 焦点可见 | 2.4.7 Focus Visible | 环可见，`kin-focus-ring` | 键盘 |
| 结果数为空 | 4.1.3 Status Messages | `role="status"` 播报空结果 | 搜索无匹配 |

## 平台差异

| | 手机 | Mac |
|---|---|---|
| 形状 | `Sheet`，盖在当前面板上 | 贴触发点的浮层 |
| 焦点 | `Sheet` 的焦点陷阱 | 关闭时交回触发按钮 |
| 自动聚焦 | 否——不能在人读到列表前抬起键盘 | 是（仅精细指针） |

## 契约

```ts
type Props = {
  label: string;              // 可访问名，同时是面板标题
  value: string;              // 受控
  options: SearchSelectOption[];
  onChange: (id: string) => void;
  display?: string;           // 值不在 options 里时显示它
  title?: string;             // 截断的 chip 装不下的提示
  disabled?: boolean;
  bordered?: boolean;         // 在已画边框的合并控件里关掉
  className?: string;         // 宽度上限和墨色；primitive 故意不设 max-w
  placement?: "top" | "bottom";  // 默认 bottom
  searchable?: boolean;       // 默认 false
  searchPlaceholder?: string;
  emptyLabel?: string;
};
```

不变量：`className` 不参与形状（边框、圆角、内边距、字号是 primitive 的）；
primitive 不设 `max-w`，否则它会排在调用方的任意值之后赢掉级联。
