# TextArea

**一句话。** 设置表单里的多行文本字段：和 `TextInput` 同一份标签、提示句、
错误/警告句契约，但没有单行字段的 44px 高度地板——多行框的高度由 `rows` 和
调用方自己的类决定。

它替的是“裸 `kin-input` `<textarea>` + 手写 `aria-label`”这个组合。那个组合
长不出这个控件（TASTE 13）：名字只能靠每个调用点记得写一句 `aria-label`，
提示句和错误句接不进 `aria-describedby`，错误也只能靠调用方记得加
`aria-invalid`。`TextInput` 也不是答案：它的 `min-h-11` 是单行触控地板，套到
多行框上会和 `rows` 打架。

## 用它 / 别用它

用它：

- 设置页和表单里的多行文本字段（JSON、prompt、备注），需要可见标签或
  `isLabelHidden` 的行内标签。
- 需要一行提示句或一个错误/警告槽的多行字段。
- 区块标题已经命名了字段、视觉上不想重复标签的字段（把标题文案传给
  `label` 并加 `isLabelHidden`，标题本身保留）。

别用它：

- 单行文本、URL、密码、搜索 → 用 [`TextInput`](text-input.md)。
- 自动增高的对话输入框（`Composer`）→ 那是聊天编辑器，高度跟着内容长，
  不是表单字段。
- 只有装饰或布局意义的裸文本框 → 先确认它真的是一个需要标签的字段。

**为什么不是 `TextInput` 的 `multiline` 变体（TASTE 13）：** 两个原生元素的
属性集不同（textarea 没有 `type`，但有 `rows` 和缩放手柄），高度模型也不同：
单行框有 44px 地板，多行框由行数和调用方决定。做成两个组件，`TextInput` 的
“调用方给了高度就让出地板”那套判断不必为一个它不渲染的元素负责，多行框也
不必继承一条对它没有意义的地板。

## 行为

- **标签始终渲染。** `label` 必填；`htmlFor` 指向文本框的 `id`。调用方传
  `id` 就用它，否则组件用 `useId` 生成。`isLabelHidden` 只把标签变成
  `sr-only`，名字不丢。区块标题已经命名字段时，传标题自己的文案并隐藏标签，
  **不要**再留一个 `aria-labelledby`——同一个名字只由一个来源提供。
- **提示句在文本框下方一行。** 有 `hint` 才渲染节点；节点 id 进
  `aria-describedby`，排在调用方自己的 `aria-describedby` 之后。
- **状态槽在提示句之后。** `error` 用 `text-kin-red-ink` 并设
  `aria-invalid="true"`；`warning` 用 `text-kin-orange-ink`，不设 invalid。
  两种状态的消息都进 `aria-describedby`。
- **没有默认高度地板。** 文本框永远带 `kin-input`，但**不**带 `min-h-11`；
  高度由 `rows` 和调用方 `className` 里的 `min-h-*` 决定。这是和 `TextInput`
  唯一一处有意的差别：`min-h-11` 是单行触控地板，多行字段至少比它高。
- **类名只追加。** 调用方的 `className` 接在 `kin-input` 之后，不替换它，
  也不碰焦点环。
- **不受控的输出。** 组件不读 store、不发请求、不自己存值；`value` /
  `onChange` / `rows` / `maxLength` 全部透传。它不是表单，只是字段。
- **宽度交给容器。** 文本框是 `w-full`；组件外面只有一个普通 `<div>`
  （有可见标签时是 `space-y-1`），不画卡片、不留白。

## 键盘

| 键 | 归属 |
|---|---|
| Tab / Shift+Tab | 文本框，按 DOM 顺序 |
| Enter | 文本框：插入换行；不提交表单（除非调用方自己处理） |
| Cmd/Ctrl+Enter | 调用方；组件不监听 |
| 其余按键 / 输入法 | 文本框和平台；组件不监听键盘 |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 名称 | 4.1.2 Name, Role, Value | 可见标签（或 `sr-only` 标签）就是文本框的名字，不需要另一句 `aria-label` | 全部 |
| 描述 | 1.3.1 Info and Relationships | 调用方的 `aria-describedby` 在前，提示与状态消息的 id 在后，合并成一个描述 | 全部 |
| 错误识别 | 3.3.1 Error Identification | `error` 同时设 `aria-invalid="true"`；不只用红色表达 | error |
| 状态区分 | 1.4.1 Use of Color | warning 是橙色文字加一句完整的话，不是只换颜色 | warning |
| 对比度 | 1.4.3 Contrast | 标签 `text-kin-secondary`、提示 `text-kin-muted`、错误 `text-kin-red-ink`、警告 `text-kin-orange-ink`，全部走 token | 全部 |
| 焦点可见 | 2.4.7 Focus Visible | `.kin-input` 的 `focus:ring-1` 使用 `--kin-focus-ring` | 全部 |

没有“目标尺寸 2.5.8”一行：多行字段没有默认地板，触控面积由 `rows` 和调用方
的高度类负责；正常的多行字段天然高于 44px，但这是调用方的决定，不是控件偷偷
加上的。

## 平台差异

Mac 和手机是同一个形状：同一个 `<textarea>`、同一套标签 / 提示 / 状态排版，
`rows` 决定初始高度。组件不做自动增高，也不在手机上换用别的控件；软键盘的
换行键就是文本框自己的 Enter。

## 契约

```ts
type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & {
  label: string;            // 必填；可访问名
  isLabelHidden?: boolean;  // 只隐藏视觉标签，名字保留
  hint?: ReactNode;         // 可见提示句，并进入 aria-describedby
  status?: { type: "error" | "warning"; message: string };
  className?: string;       // 追加到文本框类名之后
};
```

不变量：

- `label` 必填，文本框一定有一个可访问名；`isLabelHidden` 不改变名字。
- `hint` / `status.message` 为空时不渲染节点，也不产生空的
  `aria-describedby`；有内容时其 id 一定进入描述，并排在调用方传入的
  `aria-describedby` 之后。
- `status.type === "error"` 一定设 `aria-invalid="true"`；`warning` 不设，
  并保留调用方自己的 `aria-invalid`。
- `kin-input` 永远在原生 `<textarea>` 上；**没有**默认 `min-h-*` 地板，
  `rows` 和调用方的 `className` 拥有高度。
- 不新增 i18n key；标签、提示、状态文案全部由调用方传入。
