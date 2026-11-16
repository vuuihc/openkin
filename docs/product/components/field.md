# Field / TextInput / Textarea

**一个带标签的输入。** `TextInput` 是单行，`Textarea` 是多行，`Field` 是不走这两种
控件的字段外壳（选择器、组合行）。三者共用同一套标签、提示、错误和 id 关系，
实现都在 Astryx 的 `TextInput`/`TextArea`/`Field` 之上。

## 用它 / 别用它

用它：

- 需要人输入文字：名字、地址、搜索词、一段说明。
- 需要把标签、提示、错误一次说清，并且让辅助技术也拿到同样的关系。
- 表单里需要 `required`、`disabled`、`readOnly` 的字段。

别用它：

- 二到五个固定选项。用菜单或分段按钮（TASTE 第 5 条）；原生 `<select>` 不许新增
  （TASTE 第 14 条）。
- 只是展示一段文字。用段落，不要只读输入框。
- 想要自己拼 `<label>`/`<input>`。这样 id 和 `aria-describedby` 会各写一份。

## 行为

- **一个标签，一份描述。** 标签由 Astryx 的字段层画；hint 和 error 由 Kin 渲染，
  id 分别是 `<id>-hint`、`<id>-error`，控件通过 `aria-describedby` 指向它们。
  不把 hint/error 同时交给 Astryx 的 `description`/`status`，否则会出现第二份。
- **错误就是无效。** 有 `error` 时控件带 `aria-invalid="true"`，错误文字进入描述；
  没有错误时不渲染错误节点，也不写 `aria-invalid`。
- **Enter 与 Shift+Enter。** `TextInput` 的 Enter 调 `onEnter`；`Textarea` 的 Enter
  是换行，只有 Shift+Enter 调 `onEnter`，并且**不** `preventDefault`——换行照常
  插入。
- **输入法优先。** 两个 `onEnter` 都先过 `ui/src/lib/ime.ts` 的
  `isImeKeyEvent`：`isComposing` 与 `keyCode === 229` 两条信号都读，只读一条会把
  半个中文词当成完成。
- **原生属性照传。** `name`、`autoComplete`、`inputMode`、`placeholder`、
  `maxLength` 等原生输入属性直接落到输入元素；`ref` 指向原生
  `HTMLInputElement` / `HTMLTextAreaElement`。
- **禁用与必填是原生的。** `disabled`、`readOnly`、`required` 同时传给 Astryx 的
  `isDisabled`/`isReadOnly`/`isRequired` 和原生属性，表单语义与辅助技术都成立。

## 键盘

| 键 | 归属 |
|---|---|
| Tab | 进入 / 离开，标签先被读出，焦点环可见 |
| Enter（单行） | 调 `onEnter`；在表单里仍按原生规则提交 |
| Enter（多行） | 插入换行，不调 `onEnter` |
| Shift+Enter（多行） | 调 `onEnter`，换行照常插入 |
| 输入法组合中的 Enter | 不调 `onEnter`——见 `lib/ime.ts` |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 名称 | 4.1.2 Name, Role, Value | 可见 `<label>` 指向控件 id | 全部 |
| 描述 | 1.3.1 Info and Relationships | hint 与 error 的 id 在 `aria-describedby` 里 | 有 hint / error |
| 错误 | 3.3.1 Error Identification | 错误文字在描述里，控件 `aria-invalid="true"` | 有 error |
| 必填 | 3.3.2 Labels or Instructions | 原生 `required`，标签带必填标记 | required |
| 禁用 | 4.1.2 | 原生 `disabled` | disabled |
| 焦点可见 | 2.4.7 Focus Visible | token 焦点环 | 键盘 |
| 点按区 | 2.5.8 Target Size | 手机上不低于 44px（主题的粗指针地板） | 手机 |

## 平台差异

| | 手机 | Mac |
|---|---|---|
| 高度 | 44px 地板（主题 `pointer: coarse`） | 主题的常规控件高度 |
| 键盘 | 系统键盘，Enter 常常是“前往/发送” | 物理键盘，Shift+Enter 可用 |
| 自动聚焦 | 不主动抬键盘 | 由调用方决定 |

## 契约

```ts
type TextInputProps = {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string, event: ChangeEvent<HTMLInputElement>) => void;
  onEnter?: () => void;            // 输入法组合中不触发
  type?: "text" | "password" | "email" | "search" | "tel" | "url";
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
  ref?: Ref<HTMLInputElement>;
} & 原生 input 属性;

type TextareaProps = Omit<TextInputProps, "type" | "ref"> & {
  rows?: number;
  onEnter?: () => void;            // 只在 Shift+Enter 触发
  ref?: Ref<HTMLTextAreaElement>;
};

type FieldProps = {
  id: string;                      // 控件的 id，标签指向它
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
};
```

不变量：`label` 必填；`id` 省略时由 `useId` 生成，hint/error 的 id 由它派生；
`className` 追加，不替换字段的字号和间距；不新增视觉变体——错误态是 token 色，
不是第二套控件。
