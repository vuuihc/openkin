# KIN-NOTIFY-001 · Figma 设计源

这一目录是 `../KIN-NOTIFY-001.review.html` 的设计源帧（2026-11-01 版），每个界面一个 SVG，Figma 可直接导入。审阅页以这些帧为主体，每帧下面写六段用户流程。**视觉以这里的帧为准**；流程文字、边界和验收以 `../KIN-NOTIFY-001.md` 为准。

D1 已定：通知只走 macOS 通知中心和 APNs，Bark / ntfy / Web Push 删除；设置帧只画"这台设备"，决策板上的 D1 写的是删除。

手机审阅看 `../KIN-NOTIFY-001.review.html`（`figma-flow-v1`，在 Lody 里用 Browser 打开）；这一目录给 Figma / 桌面看完整 1100×760 和 390×844 帧。

## 文件

| 文件 | 内容 |
|---|---|
| `KIN-NOTIFY-001.board.svg` | 全图：MECE、现在→之后、六屏、状态板、修改/收尾板、待拍板项。2240 × 6744。 |
| `frames/00-overview.svg` | MECE + 现在→之后 |
| `frames/01-mac-settings.svg` | Mac 1100×760 · 设置 → 通知（只这台 Mac） |
| `frames/02-phone-settings.svg` | iPhone 390×844 · 设置 → 通知（只这台 iPhone） |
| `frames/03-phone-lock.svg` | iPhone 390×844 · 锁屏通知 |
| `frames/04-mac-notification-center.svg` | Mac 1100×760 · 右上角通知 |
| `frames/05-phone-inbox.svg` | iPhone 390×844 · 收件箱落点 |
| `frames/06-mac-inbox.svg` | Mac 1100×760 · 收件箱落点 |
| `frames/07-states.svg` | 十种状态 |
| `frames/08-change-quiet.svg` | 关闭 / 重新开启 / 处理完 / 没处理完 |
| `frames/09-decisions.svg` | D1–D5 + 签字 |

## 导入 Figma

1. 新建 Figma 文件。
2. 把 `KIN-NOTIFY-001.board.svg` 拖进画布。整张图是一个大组；选中某一屏后按 `Cmd+Opt+G`（Frame selection）即可变成 Frame。
3. 想逐屏编辑，把 `frames/` 里的 SVG 逐个拖进去；每个是一个组，尺寸就是文件名标注的 1100×760 / 390×844，状态板是 2240 宽。

## 注意

- SVG 里的文字按文本导出；Figma 通常导入为文本层，若提示缺字体，选 **PingFang SC**（macOS 自带）。
- 这是线框，不含真实数据、真实截图、主机名或账号。
- 改设计直接改这些 SVG 帧（或在 Figma 里改完导出 SVG 覆盖），再同步 `../KIN-NOTIFY-001.review.html` 的流程文字和 `../KIN-NOTIFY-001.md` 的合同；三处对不上就是没改完。
- 签字看 `../KIN-NOTIFY-001.review.html`：把故事状态改成 `approved`，并写一句“按此设计开发”。
