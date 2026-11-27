# Kin 手机端设计（RN）

Read: 给 owner 的远程 coding-agent 驾驶舱——Mac 上的 agent 在跑,人在路上用手机看进度、批准、补一句指令。专家用户、碎片时间、单手操作,冷静、密实、可操作。iOS 先行,外观跟随系统(明暗两套都已设计)。

Platforms: iPhone 390–440pt 宽竖屏优先;iPad 820 竖屏沿用同一套 token,布局按 KIN-CONTINUE-007 的 304px 列表规则,不另画一张皮。中英双语。

Dials: variance 4 · motion 3 · density 7（重复性操作界面,密实优先;动效只在状态变化与按压反馈）

Signature: **活动脊**。对话里每一轮 agent 工作在左缘带一条 3pt 状态脊——运行中蓝、已完成绿、失败/打断红、等待批准橙——长对话可以只扫脊线。列表行的状态同样是形状+颜色双编码:蓝点运行、橙三角待批(带计数)、红方块失败、灰点已完成。这是这个产品被记住的东西:别处是聊天软件,这里是"工作的流水线"。

Color roles（端口自 `ui/src/design/theme.css`,web 与手机同一套视觉语言）:

| 角色 | 暗 | 亮 | 对比 |
|---|---|---|---|
| page 窗底 | #0e0e10 | #e0e0e5 | — |
| bg 内容面 | #1a1a1c | #ffffff | — |
| elevated 卡/sheet | #2c2c2e | #f4f4f6 | 距 bg ≥2 L* |
| text / secondary / muted | #f5f5f7 / #c7c7cc / #98989d | #1c1c1e / #3a3a3c / #5c5c61 | 全部 ≥4.5:1(theme.css 已证) |
| hairline / fill | rgba(255,255,255,.08/.06) | rgba(0,0,0,.09/.04) | — |
| blue fill / ink | #0a84ff / #6cb2ff | #0a84ff / #0a52b4 | ink ≥4.5:1 |
| orange fill / ink | #ff9f0a / #ffb340 | #ff9f0a / #7d4400 | 同上 |
| green fill / ink | #30d158 / #8de4a0 | #30d158 / #105c27 | 同上 |
| red fill / ink | #ff453a / #ff8a80 | #ff453a / #a51f18 | 同上 |
| bubble-user | #0a84ff(白字) | #007aff(白字) | ≥4.5:1 |
| agent 身份色 | claude #d97757 · codex #10a37f 等,两 scheme 同值 | 同 | 按 theme.css |

Type roles（iOS 系统字阶,跟随 Dynamic Type;`allowFontScaling` 不关闭）:

| 角色 | 规格 |
|---|---|
| large-title(列表根) | 28pt bold |
| nav-title / 行标题 | 17pt semibold |
| body 正文/回答 | 15–17pt regular,行高 1.45 |
| sub 行副标题 | 13pt regular secondary |
| caption 元信息 | 12pt regular muted |
| mono 工具行/命令/代码 | SF Mono 12–13pt |
| 数字 | tabular figures(token 数、金额) |

Spacing / radius / elevation: 4pt 基线 4/8/12/16/20/24/32;气泡 10、卡片与 sheet 内层 12、sheet 顶角 20、composer 22(胶囊);嵌套角同心。层级:page → bg → elevated → sheet,不用投影堆叠,分隔靠 hairline 与 scrim;玻璃只给浮在滚动内容上的条(nav bar、composer 底),用系统材质(expo-glass-effect / BlurView),不手搓半透明卡片。

Motion: 系统 push/sheet 默认;状态变化才动(脊变色、计数增减);按压反馈统一轻微加深或 scale 0.97,不弹;流式文本追加不做入场动画;Reduce Motion 时全部退化为即时切换。批准成功 medium impact + success notification 各一次(expo-haptics),失败 error notification。

Voice: 直说、简短、用动词。"还没有对话"不道歉;错误说清什么坏了+现在能做什么;不用"无缝""强大""轻松"。

House rules:
- 列表用分组列表(标题+hairline),不用卡片;卡片只留给真正独立的可点对象(审批卡)。
- 一屏一个实心主按钮:待批的「批准」优先于 composer 的「发送」;发送在草稿为空时不是实心。
- 不放底部 tab bar:RN 只有一个一级页(列表),用量是 sheet、审批在对话里;等例行任务/运维进 RN 再加玻璃底栏(沿用 KIN-CONTINUE-005 的材质)。
- 局域网 http Hub:不静默放行,显式「不安全」确认一次,文案说明凭据会走明文。
