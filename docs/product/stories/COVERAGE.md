# 故事覆盖

由 `scripts/stories.py` 生成，不要手改。改 `registry.json` 后运行
`python3 scripts/stories.py --write-coverage`。

| 编号 | 状态 | 优先级 | 旅程 | 面 | 标题 | 测试 |
|---|---|---|---|---|---|---|
| `KIN-AGENTS-002` | approved | P0 | J6 | Mac/手机 | 看清安装探测与会话/角色导入的边界 | 2 |
| `KIN-CONTINUE-001` | covered | P0 | J1、J2 | Mac/手机 | 接着问一段对话 | 26 |
| `KIN-CONTINUE-002` | covered | P0 | J1、J2 | Mac/手机 | 手机只留一个导航面：列表页就是侧栏 | 6 |
| `KIN-CONTINUE-003` | covered | P0 | J1、J2、J3、J4、J5、J6、J7 | Mac/手机 | 统一控制台的四区导航与工作台 | 11 |
| `KIN-CONTINUE-004` | covered | P0 | J1、J2 | 手机 | 手机列表：按最近活动排设备、每设备新建、搜索收成放大镜 | 4 |
| `KIN-CONTINUE-005` | approved | P0 | J1、J2 | 手机 | 手机底栏：玻璃与纯图标，四个区域共用 | 2 |
| `KIN-CONTINUE-006` | blocked | P0 | J1 | 手机 | 手机开屏：先用自己的控制台打开，新版本在后台整套换 | 0 |
| `KIN-CONTINUE-007` | covered | P0 | J1、J2 | Mac/手机 | 在 820 的列表里一屏扫到那条对话 | 5 |
| `KIN-CONTRACT-001` | covered | P0 | J1、J2、J4、J6 | Mac/手机 | 只留四个页面：列表、任务详情、例行任务、设置 | 3 |
| `KIN-MOBILE-001` | approved | P0 | J1、J2、J4 | 手机 | 手机用 Expo/RN 客户端承接固定面 | 1 |
| `KIN-MOBILE-002` | draft | P0 | J1、J2、J4 | 手机 | RN 视觉系统与五屏设计 | 0 |
| `KIN-NOTIFY-001` | approved | P0 | J7 | Mac/手机 | 离开时被叫回来 | 14 |
| `KIN-PROJECT-002` | covered | P0 | J4 | Mac/手机 | 项目的工作目录：看清这几个目录为什么在一起，并能增删 | 4 |
| `KIN-QUALITY-001` | covered | P0 | J1、J2 | Mac/手机 | 读完整条回答，再接着问（820 优先） | 4 |
| `KIN-RESULT-002` | covered | P0 | J4 | Mac/手机 | 读懂文件、预览并返回原对话 | 10 |
| `KIN-RESULT-003` | covered | P0 | J2、J1 | Mac/手机 | 对改动逐行评论并发回对话 | 5 |
| `KIN-AGENTS-001` | covered | P1 | J6 | Mac/手机 | 机器上的 agent：装了什么、能不能用、用掉多少 | 7 |
| `KIN-MANAGE-001` | covered | P1 | J5 | Mac/手机 | 整理一段对话 | 4 |
| `KIN-PROJECT-001` | covered | P1 | J4 | Mac/手机 | 一个项目的封面：看清这里发生过什么，并从这里继续 | 4 |
| `KIN-PROJECT-003` | covered | P1 | J4 | Mac/手机 | 项目的工作说明：新对话一开始就知道这里怎么干活 | 6 |
| `KIN-RESULT-001` | covered | P1 | J4 | Mac/手机 | 看它改了什么 | 4 |
| `KIN-ROUTINE-001` | covered | P1 | J4 | Mac/手机 | 让它按时跑：把一件事交给机器重复做 | 5 |
| `KIN-SETTINGS-001` | covered | P1 | J6 | Mac/手机 | 改默认设置 | 9 |
| `KIN-SETTINGS-002` | approved | P1 | J1、J6 | Mac | 桌面壳一键升级 | 3 |
| `KIN-START-001` | covered | P1 | J3 | Mac/手机 | 新建一段对话 | 6 |

## 汇总

approved 5 · blocked 1 · covered 18 · draft 1
