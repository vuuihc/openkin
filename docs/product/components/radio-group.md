# RadioGroup

**一行分段单选。** 三到五个互斥选项排成一条，整组只有一个 Tab 停点：
方向键同时移动选中项和焦点，`Home` / `End` 到两端。用途区间（本周 / 30 天 /
90 天）就是它；调用方持有受控的 `value`，控件持有 `role="radiogroup"` /
`role="radio"` 和键盘模型。

## 用它 / 别用它

用它：

- 三到五个互斥选项，一次看全、点一下选中（TASTE 5）。
- 选项数量固定、不需要搜索、不需要分组的选择。

别用它：

- 两个选项——那是开关。
- 很长的列表或需要搜索的单选——那是 `SheetSelect` / `SearchSelect`。
- 标签页式的并列内容切换——那是 `Tabs`：标签带表达“正在看哪一块”，不表达
  “选中了哪个值”。
- 浮层里的选择——那是第二层（TASTE 16），这里是页面内联的一行。

同样是三到五选一：选一个**值**（用途区间、粒度）用这里，选看**哪一块内容**用
`Tabs` 的 `segmented` 变体——两条路的分界是“选值”还是“换内容”，不是外观。

**为什么不是 `Tabs` 加一个变体（TASTE 13）：** 标签带必须带
`role="tab"` / `aria-selected`（`Tabs` 内部由 Astryx `TabList` 渲染），而单选要
`role="radio"` / `aria-checked`；两个角色的语义、读屏播报和测试查询都不同。
把标签带改成单选组会同时破坏标签页的语义，所以这是“已有控件长不出这个”的那一
类，不是又一个同款弹层。

## 行为

- **受控，一个 Tab 停点。** `value` / `onChange` 由调用方持有；选中的选项是组里
  唯一进 Tab 顺序的。`value` 不在 `options` 里、或指向一个禁用项时，第一个可用
  选项拿停点，且没有任何选项是选中的——不抛错。
- **方向键选中并聚焦。** 右/下到下一个可用选项，左/上到上一个，两端回绕；跳过
  `disabled`。`Home` / `End` 到第一个 / 最后一个可用选项。焦点在
  `requestAnimationFrame` 里交给目标按钮，等调用方的重渲染落地。
- **只接管自己的键。** 只对方向键和 `Home` / `End` 调 `preventDefault`；其他键
  原样放行（TASTE 16）。
- **点击选中。** `Space` / `Enter` 由原生 `<button>` 的点击语义带来。
- **不是浮层。** 不声明 menu / dialog 角色，不改变 `overlayOwnsKeyboard`。

## 键盘

| 键 | 归属 |
|---|---|
| Tab / Shift+Tab | 走进 / 离开整组；组内只有一个停点 |
| ArrowRight / ArrowDown | 选中并聚焦下一个可用选项，回绕 |
| ArrowLeft / ArrowUp | 选中并聚焦上一个可用选项，回绕 |
| Home / End | 第一个 / 最后一个可用选项 |
| Space / Enter | 选中当前聚焦的选项；`disabled` 的选项不响应 |
| 其他键 | 不拦截，留给页面 |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 组名称 | 1.3.1 | `role="radiogroup"` + `aria-label`（调用方的翻译文案） | 全部 |
| 选中状态 | 4.1.2 | `aria-checked` 由 `value` 决定 | 全部 |
| 禁用状态 | 4.1.2 | 原生 `disabled` + `aria-disabled="true"`，且不在 Tab 顺序里 | 有禁用项 |
| 触控目标 | 2.5.8 | 每个选项 `min-h-11`（44px），组高不低于 44px | 全部 |
| 焦点可见 | 2.4.7 | `focus-visible:outline-kin-focus-ring` 焦点环 | 全部 |
| 不只靠颜色 | 1.4.1 | 选中项同时加粗并抬起（`font-semibold` + `shadow-e1`），不只换底色 | 全部 |

## 平台差异

Mac 和手机是同一个形状：一行内联分段，不换成下拉、底部面板或原生 `<select>`；
选项高度两边都保持 44px 触控地板。

## 契约

```ts
export type RadioOption<T extends string | number> = {
  value: T;
  label: string;
  disabled?: boolean;
};

export type RadioGroupProps<T extends string | number> = {
  value: T;
  onChange: (next: T) => void;
  options: readonly RadioOption<T>[];
  /** 组的无障碍名称；调用方传翻译后的字符串。 */
  ariaLabel: string;
  className?: string;
};
```

不变量：`options` 的顺序即显示顺序，各项的 `value` 必须互不重复（重复值会让两个
选项同时拿到停点和选中态）；`value` 必须来自 `options` 才可能有选中项；组件不
持有状态、不读写存储、不产生新的文案——标签由调用方翻译后传入。
