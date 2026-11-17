# TextInput

**一句话。** 设置表单里的单行文本字段：标签、提示句、错误/警告句和输入框是
同一个控件，提示与状态通过 `aria-describedby` 成为输入框描述的一部分，而不是
一句读屏永远读不到的兄弟文本。

它替的是“裸 `kin-input` + 手写 `<label>`”这个组合。那个组合长不出
这个控件（TASTE 13）：提示句没有接进 `aria-describedby`，错误只能靠调用方记得
加 `aria-invalid`，手机 44px 地板要靠每个调用点自己抄 `min-h-11`，也没有一个
所有者能替所有字段回答“标签多大、提示在哪”。Astryx 的 `TextInput` 同样长不出
它：它按类型拒绝根 `className`，`controlClassName` 又只落在视觉外壳上、明确不
是原生 `<input>`，所以 `.kin-input` 会离开它一直待着的元素。

## 用它 / 别用它

用它：

- 设置页和表单里的单行文本字段（文本、URL、密码、搜索），需要可见标签。
- 需要一行提示句或一个错误/警告槽的字段。
- 行内紧凑、视觉上不想要标签、但读屏仍须有名字的字段（`isLabelHidden`，
  `RolesSection` 的角色名）。

别用它：

- 多行文本 → 等 `TextArea` facade；`RolesSection` 的 prompt 仍在用它自己的
  `<textarea>`。
- 选择器、checkbox、`time` / `number` / `datetime-local` → 用
  `SearchSelect` / `SheetSelect` 或跟进里的专用输入；这些控件的键盘、步进和
  移动端键盘不是单行文本框能给的。
- 只有装饰或布局意义的裸输入（组件内部的搜索框） → 先确认它真的是一个需要
  标签的字段，再决定。

## 行为

- **标签始终渲染。** `label` 必填；`htmlFor` 指向输入框的 `id`。调用方传
  `id` 就用它，否则组件用 `useId` 生成。`isLabelHidden` 只把标签变成
  `sr-only`，名字不丢。
- **提示句在输入框下方一行。** 有 `hint` 才渲染节点；节点 id 进
  `aria-describedby`。提示句可以是节点，因为 base URL 的 `/v1` 片段仍包在
  `<code>` 里；常见的字符串就是字符串。
- **状态槽在提示句之后。** `error` 用 `text-kin-red-ink` 并设
  `aria-invalid="true"`；`warning` 用 `text-kin-orange-ink`，不设 invalid。
  两种状态的消息都进 `aria-describedby`。
- **类名固定，地板可让位。** 输入框永远带 `kin-input`，默认再带 `min-h-11`。
  调用方在 `className` 里给出自己的高度（`min-h-*`、`h-*`、`[min-height:…]`）
  时，默认地板整个不出现，而不是两个类在 CSS 里打架——Tailwind 把
  `.min-h-11` 排在 `.min-h-10` 之后，拼在一起只会让紧凑行永远是 44px。
  响应式覆盖（`sm:min-h-0`）不算，手机地板保留，只改桌面高度。
- **不受控的输出。** 组件不读 store、不发请求、不自己存值；`value` /
  `onChange` 全部透传。它不是表单，只是字段。
- **宽度交给容器。** 输入框是 `w-full`；组件外面只有一个普通 `<div>`
  （有可见标签时是 `space-y-1`），不画卡片、不留白。

## 键盘

| 键 | 归属 |
|---|---|
| Tab / Shift+Tab | 输入框，按 DOM 顺序 |
| Enter | 平台：表单里的默认提交，或调用方的 `onKeyDown` |
| 其余按键 / 输入法 | 输入框和平台；组件不监听键盘 |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 名称 | 4.1.2 Name, Role, Value | 可见标签（或 `sr-only` 标签）就是输入框的名字，不需要另一句 `aria-label` | 全部 |
| 描述 | 1.3.1 Info and Relationships | 提示句与状态消息的 id 合进 `aria-describedby`，顺序是提示、状态 | 全部 |
| 错误识别 | 3.3.1 Error Identification | `error` 同时设 `aria-invalid="true"`；不只用红色表达 | error |
| 状态区分 | 1.4.1 Use of Color | warning 是橙色文字加一句完整的话，不是只换颜色 | warning |
| 对比度 | 1.4.3 Contrast | 标签 `text-kin-secondary`、提示 `text-kin-muted`、错误 `text-kin-red-ink`、警告 `text-kin-orange-ink`，全部走 token | 全部 |
| 目标尺寸 | 2.5.8 Target Size | 默认 `min-h-11`（44px）；紧凑覆盖由调用方负责且必须仍有可用面积 | 手机 |
| 焦点可见 | 2.4.7 Focus Visible | `.kin-input` 的 `focus:ring-1` 使用 `--kin-focus-ring` | 全部 |

## 平台差异

| | 手机 | Mac |
|---|---|---|
| 高度 | 默认 44px（`min-h-11`） | 同样 44px；设置页的紧凑行用 `className` 降到 36/40px |
| 键盘 | `type="url"` / `email` / `tel` 唤起对应软键盘 | 不适用 |
| 标签与提示 | 同一套排版，不折叠 | 同一套排版 |

## 契约

```ts
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  label: string;            // 必填；可访问名
  isLabelHidden?: boolean;  // 只隐藏视觉标签，名字保留
  hint?: ReactNode;         // 可见提示句，并进入 aria-describedby
  status?: { type: "error" | "warning"; message: string };
  className?: string;       // 追加到输入框类名之后
};
```

不变量：

- `label` 必填，输入框一定有一个可访问名。
- `hint` / `status.message` 为空时不渲染节点，也不产生空的
  `aria-describedby`；有内容时其 id 一定进入描述，并与调用方传入的
  `aria-describedby` 合并。
- `status.type === "error"` 一定设 `aria-invalid="true"`；`warning` 不设，
  并保留调用方自己的 `aria-invalid`。
- `kin-input` 永远在原生 `<input>` 上；默认再带 `min-h-11`，调用方给出自己的
  高度时默认地板不出现。`className` 不会替换 `kin-input`，也不会碰焦点环。
- 不新增 i18n key；标签、提示、状态文案全部由调用方传入。
