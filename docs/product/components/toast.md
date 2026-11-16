# Toast

**一行即时结果，浮在当前页面底部。** 一个动作刚完成（已保存、已复制、运行失败），
结果一眼就够、不需要留在页面上的，用它。它是纯展示：toast 列表、增删、计时都由
调用方持有，`Toast` 只负责一列礼貌播报的区域、一套语气和一个真能点中的关闭按钮。

`ToastHost` 是它的临时前身，也是"哪个已有控件长不出这个"的答案：`ToastHost`
直接读 store、写死 `Dismiss`、只有 error 一种语气，并且是挂在应用根部的单例；
它没法被一个自己持有 toast 列表的调用方使用。两者描述的是同一种 toast；迁移那
一轮会让 `ToastHost` 用 `Toast` 渲染，但要一并决定两处已知差异：宽屏下关闭目标
的高度回到内容（手机仍是 44px），以及层级从 `ToastHost` 的 `z-[60]` 换成共享的
`z-50`（打开中的浮层可能因此盖住 toast）。

## 用它 / 别用它

用它：

- 动作已经完成、结果一句话说得完、用户不需要回应（已复制、已保存）。
- 失败要立刻说，但不值得占一块页面（上传失败、连接断了）。

别用它：

- 需要用户确认或选择 → 对话框 / `Sheet`。
- 结果要留在页面上（任务终态、保存状态）→ 放在对象自己的行或卡片里。
- 页面或列表加载失败且可以重试 → 页面内的错误状态（TASTE 10），不是几秒后消失的 toast。
- 字段校验错误 → 字段旁边，用户要看着它改。

## 行为

- **纯受控。** `toasts` 和 `onDismiss` 都由调用方持有；组件不排队、不去重、
  不自动消失、不做退场动画。点击关闭只报告 id，移除由调用方做——调用方不理会，
  toast 就还在。
- **每条 toast 是自己的 live region。** `role="status"` + `aria-live="polite"`；
  插入一条播报一条，删掉邻居不会把剩下的重读一遍。条带**不再**套一层 live
  region：嵌套会让部分读屏器把同一条消息读两遍。每次插入的 toast 都是新建的
  status 节点，能否可靠播报取决于读屏器；如果真实读屏器上不可靠，迁移轮引入
  常驻播报区域，而不是在外层再套一个区域。
- **空列表返回 `null`。** 没有状态可播报，也不留下一个空区域。
- **底部居中，一次一列。** 宽屏限宽 28rem；手机贴底并让出安全区。
- **不挡点击。** 容器 `pointer-events-none`，每张卡片收回 `pointer-events-auto`：
  toast 之间的空隙不会截走本该落到页面的点击。
- **实现。** Astryx 0.7.16 的 `Toast`/`ToastViewport` 自带自动消失计时、手势和
  视口队列，生命周期归它自己，和这里"调用方持有列表"相反；因此保留 Kin 自己的
  标记结构，只借用它的两种语气命名（`info` / `error`）和"每条 toast 一个播报
  单元"的思路。Astryx 另外用一个常驻的视口播报区域解决首条播报；这一层留给
  迁移轮在真实读屏器上验证后再决定。颜色、字体和间距全部来自 Kin 的 token，
  不引入 Astryx 的主题。

## 键盘

| 键 | 归属 |
|---|---|
| Tab / Shift+Tab | 进入每条 toast 的关闭按钮；按列表顺序在 toast 之间移动 |
| Enter / Space | 激活聚焦的关闭按钮（原生 `<button>`） |
| Escape | 不归 toast；浮层打开时 Escape 属于当前浮层，toast 不去抢 |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 状态播报 | 4.1.3 Status Messages | 每条 `role="status"` + `aria-live="polite"`，不抢焦点 | 全部 |
| 关闭按钮名称 | 4.1.2 | `aria-label` 取调用方的 `dismissLabel`，随界面语言变 | 全部 |
| 多条同时出现 | 4.1.2 | 关闭按钮共用同一个名称；需要区分时在迁移轮引入按条目的名称或 `aria-describedby` | 已知限制 |
| 触控目标 | 2.5.8 Target Size | 关闭按钮 ≥44×44px（`min-h-11 min-w-11`） | 手机 |
| 焦点可见 | 2.4.7 | `focus-visible:outline-kin-focus-ring`，2px 外描边 | 键盘 |
| 不只靠颜色 | 1.4.1 | 语气由边框和文字色共同表达，文案本身说明结果 | 全部 |
| 安全区 | — | 底部内边距 `max(1rem, env(safe-area-inset-bottom))` | 手机 |

## 平台差异

| | 手机 | 宽屏 + 粗指针 | 桌面鼠标 |
|---|---|---|---|
| 位置 | 贴底居中，让出底部安全区 | 同手机 | 贴底居中，28rem 上限 |
| 关闭目标 | 44px 见方 | 44px 宽，高度回到内容 | 44px 宽，高度回到内容 |
| 语气与播报 | 同 | 同 | 同 |

## 契约

```ts
type ToastTone = "info" | "success" | "error";

type ToastItem = {
  id: string;              // 同一条 toast 的身份，用于 key 和 dismiss
  message: ReactNode;      // 调用方的文案或组合内容
  tone?: ToastTone;        // 默认 "info"
};

type Props = {
  toasts: ToastItem[];
  onDismiss: (id: string) => void; // 只报告 id；移除由调用方做
  dismissLabel: string;            // 关闭按钮的可访问名称，调用方翻译
  className?: string;              // 只用于放置，不换语气
};
```

不变量：组件不读 store、不读 i18n、不装计时器、不自己改 `toasts`；消息文字来自
`message`，关闭按钮的可访问名称来自 `dismissLabel`。
