# 故事覆盖

由 `scripts/stories.py` 生成，不要手改。改 `registry.json` 后运行
`python3 scripts/stories.py --write-coverage`。

| 编号 | 状态 | 优先级 | 旅程 | 面 | 标题 | 测试 |
|---|---|---|---|---|---|---|
| `KIN-CONTINUE-001` | approved | P0 | J1、J2 | Mac/手机 | 接着问一段对话 | 26 |
| `KIN-CONTINUE-002` | approved | P0 | J1、J2 | Mac/手机 | 手机只留一个导航面：列表页就是侧栏 | 6 |
| `KIN-CONTINUE-003` | approved | P0 | J1、J2、J3、J4、J5、J6、J7 | Mac/手机 | 统一控制台的四区导航与工作台 | 12 |
| `KIN-NOTIFY-001` | approved | P0 | J7 | Mac/手机 | 离开时被叫回来 | 14 |
| `KIN-PROJECT-002` | covered | P0 | J4 | Mac/手机 | 项目的工作目录：看清这几个目录为什么在一起，并能增删 | 5 |
| `KIN-RESULT-002` | approved | P0 | J4 | Mac/手机 | 读懂文件、预览并返回原对话 | 2 |
| `KIN-RESULT-003` | approved | P0 | J2、J1 | Mac/手机 | 对改动逐行评论并发回对话 | 4 |
| `KIN-AGENTS-001` | covered | P1 | J6 | Mac/手机 | 机器上的 agent：装了什么、能不能用、用掉多少 | 7 |
| `KIN-MANAGE-001` | approved | P1 | J5 | Mac/手机 | 整理一段对话 | 3 |
| `KIN-PROJECT-001` | covered | P1 | J4 | Mac/手机 | 一个项目的封面：看清这里发生过什么，并从这里继续 | 6 |
| `KIN-PROJECT-003` | covered | P1 | J4 | Mac/手机 | 项目的工作说明：新对话一开始就知道这里怎么干活 | 7 |
| `KIN-RESULT-001` | approved | P1 | J4 | Mac/手机 | 看它改了什么 | 3 |
| `KIN-ROUTINE-001` | covered | P1 | J4 | Mac/手机 | 让它按时跑：把一件事交给机器重复做 | 6 |
| `KIN-SETTINGS-001` | approved | P1 | J6 | Mac/手机 | 改默认设置 | 8 |
| `KIN-SETTINGS-002` | approved | P1 | J1、J6 | Mac | 桌面壳一键升级 | 3 |
| `KIN-START-001` | covered | P1 | J3 | Mac/手机 | 新建一段对话 | 6 |

## 汇总

approved 10 · covered 6
