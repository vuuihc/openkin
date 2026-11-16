# Button

**一个动作。** 页面里所有的按钮都从这里出，不用裸 `<button>` 拼。外观仍是
Kin 的 `.kin-btn-*`，行为由 Astryx 的 `Button` 提供；两套样式靠层顺序共存，不是
二选一。

## 用它 / 别用它

用它：

- 提交、发送、取消、停止，以及一行里的小动作（附件、筛选）。
- 按钮里只有文字或图标 + 文字，动作点下去立刻发生或明确进入加载。

别用它：

- 跳转到另一个页面。用链接，浏览器的新标签页、右键和地址栏才成立。
- 二到五个互斥选项。用菜单或分段按钮（TASTE 第 5 条）——选项不是动作。
- 一屏里第二个实心主按钮。`default` 一屏只有一个（TASTE 第 6 条）。

## 行为

- **三种重量。** `default` 是唯一的实心动作；`secondary` 是有边框的同级动作；
  `quiet` 是行内、字段里的弱动作，只在 hover 时上底色。
- **默认不提交表单。** `type` 默认 `button`；要提交必须显式写
  `type="submit"`。
- **加载不改名字。** `isLoading` 时按钮带 `aria-busy="true"`，可访问名仍是调用方
  给的那个（`aria-label`，否则字符串 children）。加载中的视觉由 Astryx 提供，
  Kin 不再叠一个自己的 spinner。
- **禁用是原生的。** `disabled` 同时传给 Astryx 的 `isDisabled` 和原生
  `disabled` 属性：前者只写 `aria-disabled`，后者才是平台自己的禁用态、表单语义
  和 `disabled:` 样式的依据。
- **类和焦点环归 Kin。** `kin-btn`、`min-h-11 sm:min-h-0`、变体类与
  `focus-visible:outline-kin-focus-ring` 始终在元素上；`components`/`utilities`
  层排在 `astryx-base`/`astryx-theme` 之后，所以 Kin 的形状赢。

## 键盘

| 键 | 归属 |
|---|---|
| Enter / Space | 触发按钮（原生 `<button>` 语义） |
| Tab | 进入 / 离开，焦点环可见 |
| 输入法组合中的 Enter | 不触发提交——由表单和输入框的守卫处理，不是按钮的职责 |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 名称 | 4.1.2 Name, Role, Value | 有可访问名：`aria-label` 或可见文字 | 全部 |
| 角色 | 4.1.2 | 原生 `button`，不用 `div` 模拟 | 全部 |
| 焦点可见 | 2.4.7 Focus Visible | token 焦点环，不被实心底色吞掉 | 键盘 |
| 禁用 | 4.1.2 | 原生 `disabled` + Astryx 的 `aria-disabled` | 禁用 |
| 加载 | 4.1.3 Status Messages | `aria-busy="true"`，名称不变 | 加载 |
| 点按区 | 2.5.8 Target Size | 手机上不低于 44px（`min-h-11`） | 手机 |

## 平台差异

| | 手机 | Mac |
|---|---|---|
| 高度 | 44px 地板 | 紧凑高度，`sm:min-h-0` |
| 焦点环 | 键盘 / 外接键盘时才出现 | 键盘走到才出现 |
| hover | 无 | `quiet` 在 hover 时上底色 |

## 契约

```ts
type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "quiet"; // 默认 default
  isLoading?: boolean;                        // aria-busy，名称不变
};
```

不变量：`type` 默认 `button`；`ref` 指向原生 `HTMLButtonElement`；调用方的
className 追加在 Kin 的类之后，不用它替换形状；不加尺寸变体——尺寸是主题和
`min-h-11` 的事。
