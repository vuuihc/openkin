# 文档审计：新目标下的取舍

> 审计于 2026-10-23。判据是当日重置后的目标：
> **本地优先 + 可选托管执行**，多端体验（手机 / Desktop / iOS 远程控制）对标 Codex 和 lody，
> 会话在设备间连续。
>
> 用法：这是一张勾选表。**冲突 / 过时** → 删或重写；**不变量 / 调研** → 删之前必须先把引文
> 转移到 §5，否则删掉的是会写坏数据的东西，不是观点。

## 结论先讲

**冲突仍然主要在产品文档，但 ADR 里有两份不是中立的。**

- **ADR 0022** 需要重写——不是删。十条边界里八条仍然成立，要改 D3、D4、D9、D10。
- **ADR 0004（本地终端）与目标正面冲突**，而且冲突得最刺眼：`docs/plans/2026-10-22-m1-m2-progress.md`
  已经决定要做跨设备终端，ADR 0004 却仍在写"绝不出现在手机 / LAN / Tailnet"。
- 其余 23 份 ADR 全是"中立"或"技术不变量"，只有措辞级的修正：**0001** 一条已过时的断言、
  **0005** 两处"单机 scope"的限制、**0011** 一个写错的常量、**0012** 整份降级为冻结研究笔记。
- 真正的禁区在 `PRINCIPLE.md`、`SYSTEM_DESIGN.md`、`docs/MVP_TECH_SPEC.md`、`README.md`、
  `docs/OPEN_DEVELOPMENT.md`。

要动的不是 ADR 体系，是产品文档那几段，外加 ADR 0004 和 0022 各一次重写。

## 1. 四条刻意保留的非目标——现在各自什么状态

`c533a49`（接受 ADR 0022 那次提交）的正文明确写着：

> The 2026-09-05 plan keeps four of its non-goals outright: single-writer (nothing
> becomes multi-master), no Kin-operated account or relay, no offline writes, and
> loopback-only terminal.

**这四条不能当陈旧文档处理**，因为作者是知道有张力还选择保留的。逐条：

| 非目标 | 现状 |
|---|---|
| **single-writer** | **必须原样留**。它是数据完整性不变量，不是产品观点（§5）。托管执行只会让它更关键 |
| **no Kin-operated account or relay** | **已被推翻**——但注意 §2.0：文档自己留了"traction 到了且保持可选"的口子，所以是**满足条件**，不是撕毁条款 |
| **loopback-only terminal** | **已决定推翻**，见 §1.1。决定写在计划文档里，**还没升格成 ADR** |
| **no offline writes** | **待定**，见 §1.3。建议先留着 |

### 1.1 `loopback-only terminal` —— 决定已经做了，缺的是把它写进 ADR

ADR 0004 规定集成终端绝不出现在"the normal browser, phone, tray, LAN, Tailnet, or Funnel"
（L15），且**排除在 SQLite、导出包、任务事件之外**（L17/L26）。
`SYSTEM_DESIGN.md:171` 复述同一约束。

**但相反的决定已经在 `docs/plans/2026-10-22-m1-m2-progress.md` 里做出并记了理由：**

- L1380：`pty 属于跑会话的那台机器，不属于客户端。`
- L1398–1400：终端输出变成会话流上的 item（与 ADR 0022 D8「远端执行就是一个 `adapter.Adapter`」
  同一条原则），Hub 只转发 + 分配 `seq`，控制台不需要第二条通道，重连复用现成的游标。
- **安全边界也已经想好了**：`远端终端比派发一个 turn 的洞更大（交互式 shell，没有审批通道），
  所以必须是 Node 侧一个默认关闭的显式开关（如 --allow-terminal），而不是跟着 Hub 的凭据自动获得。`

也就是说这不是"待裁决"，是**一份计划文档里做完了的决定还没升格成 ADR，而 ADR 0004 仍写着相反的结论**。
动作是：

1. 重写 ADR 0004——产品面（L15/L17/L26）删掉，按上面的结论改写。
2. 把 L16/L24 的权限不变量**映射到 `--allow-terminal` 开关上，而不是直接删**：
   L16 的"每个终端路由都要真 loopback 对端"在新模型下变成"远端终端需要 Node 操作者显式开启"，
   L24 的"带着有效 token 走 LAN 进来也吃 403"变成"Hub 的凭据不自动授予终端"。
3. `SYSTEM_DESIGN.md:171` 同步改。

代码上这条还没做（`--allow-terminal` 不存在），所以**现阶段 0004 描述的仍是实际行为，
它是"已决定要作废"而不是"已经作废"**——重写 ADR 时要把这个时间差写清楚，
否则会有人读着新 ADR 却找不到对应的开关。

### 1.2 托管执行环境的凭据 —— ADR 0022 D4 的诚实性分水岭

D4 原文：*"Secrets never leave a Node. Provider API keys, agent credentials, and the
local secret store do not travel to the Hub."*

要原样保留的内核：凭据绝不进 prompt / 审计 / 日志；Hub 只存非敏感能力元数据；被动设置页不读密钥。

要重写的是"不 travel to the Hub"这半句的适用范围：**托管执行环境必须以某种受用户授权的方式
拿到凭据**（短期作用域凭据，或用户显式投放）。这个决定不能靠沉默滑过去——它同时是
"密钥不出设备"这个信任故事的存亡点。

### 1.3 `no offline writes` —— 待定

本地优先 + 手机场景下这条要重新想。保留它的成本是移动端断网即不可写；
放开它的成本是引入冲突解决机制，而这正是 ADR 0022 用单写者设计刻意避开的。
**建议：先保留，等移动端真出现这个摩擦再决定**——理由与 §5.11 第 2 项当初的措辞一致。

## 2. 冲突 —— 建议删或重写

### 2.0 先说一个好消息：文档里本来就留了口子

这两处**不是**绝对禁止，只要满足它们自己写的条件就成立：

- `SYSTEM_DESIGN.md` **L144**：`**Explicitly out (unless future traction demands it, and it
  stays optional):** Kin-account relay, Kin-operated message bus as the only path.`
  → 括号里的条件正好就是"可选托管执行"：需求到了，且它保持可选。
- `SYSTEM_DESIGN.md` **L71**：`Kin-operated relay / content cloud — relay only if traction
  demands it and it stays optional`
  → 同一句话的另一种写法。
- `PRINCIPLE.md` **§12 第 9 条 L426**：`Core use without any Kin account`
  → 关键词是 **Core**。托管执行不是 core use，所以这条**不冲突**——我上一版把它当成逐字冲突，是读错了。

而且这两份文档都把线画在了正确的位置：L144 排除的是
**"Kin-operated message bus as the only path"**（唯一通道），不是"任何托管"。
"可选"正是新方向要的形态。

**所以 `SYSTEM_DESIGN.md` §5 不需要重写，只需要一条修正**：把 Hub/Node 与
`--role hub --domain`、`--relay` 两个档位补进梯子表，并说明"可选托管执行"就是 L144 括号里那个条件被满足的实例。

`PRINCIPLE.md` **§5.11 L265–266**（`A future proposal that needs §5.11 relaxed again must cite
its own ADR`）同理：它是**程序性门槛，不是禁令**——写那份 ADR 就满足了，**不要删它**。
删掉它等于把"预支未来"的记账机制拆了，而新方向恰恰需要这个机制来自证清白。

### 2.1 真正冲突的（绝对措辞，没有口子）

| 位置 | 原文要点 | 为什么冲突 |
|---|---|---|
| **ADR 0004** L15 / L17 / L26 | 终端**绝不**出现在 browser / phone / tray / LAN / Tailnet / Funnel；**排除在 SQLite、导出包、任务事件之外** | `m1-m2-progress.md` L1380/L1398–1400 已决定相反方向（终端输出作为会话流 item、pty 归跑任务那台机器、Hub 转发并分配 `seq`）。0004 正在禁止一个已经决定要做的功能 |
| `SYSTEM_DESIGN.md` L171 | 复述 0004：桌面主窗口独有、true-loopback-only | 同上。§1.1 |
| `SYSTEM_DESIGN.md` §1 **L22** | 架构图 `Remote access (ladder) ← LAN → tailnet / Funnel; **never a Kin cloud**` | 图里这句是绝对的，没有 L144 的括号。同节 **L23** `multi-device via same daemon` 也要改 |
| `PRINCIPLE.md` §12 **L412 / L423** | 标题 `no vendor relay`；must-have 第 6 条 `... full tailnet; **never a Kin cloud**` | 同 L22，绝对措辞。注意**只有这两处**——第 9 条的 "Core use" 不算 |
| `PRINCIPLE.md` §13 L454 | 多端连续标记为 "**(v2)**" | 它现在就是目标本身，不是 v2 |
| `PRINCIPLE.md` §4 L110 | "not primarily for zero-configuration mass consumers" | 托管执行的用户画像正落在这句排除的人群里 |
| `PRINCIPLE.md` §6.2.1 L305 | 多端阅读"访问**同一 daemon**，而不是 Kin 托管网盘" | 与 §5.11 同源。**注意它说的是"不是托管网盘"**——托管执行不是网盘，这条要不要动取决于你打算托管什么 |
| `SYSTEM_DESIGN.md` §9 L204 | 摘要 "on your own network" | 把产品锁在自有网络内 |
| `docs/MVP_TECH_SPEC.md` §0 L15 | "MUST NOT build: … **user accounts, a Kin cloud/relay** …" | 对实现者是"MUST NOT，不得即兴"，杀伤力最大。账户与 relay 都已实现 |
| `docs/OPEN_DEVELOPMENT.md` §4 L72 | "Avoid: … **multi-device demos before single-machine excellence**" | 全仓库对多端最直白的一句话禁令 |
| `docs/OPEN_DEVELOPMENT.md` §3 L59 | "Poor early help: **Phase-3 multi-device platforms** …" | 把多端列为不受欢迎的贡献方向 |
| `README.md` L13 | "**No vendor relay, no OpenKin account.**" | 与新目标直接对撞（"no account" 那半句；relay 见 §2.0） |
| `README.md` L59 | "User-owned — local-first; **no OpenKin account**; export and leave" | 同上（"local-first" 可留，账户半句必须改） |
| `README.md` L9 | "Self-hosted." 单独出现 | 排除托管 → 改 "Self-hosted or hosted." |
| `README.zh.md` L9 / L13 | 同 EN 的同款 | 同上 |

## 3. 需要修改（内核留，边界改）

| 位置 | 怎么改 |
|---|---|
| **ADR 0022 D9**（L109–112） | 保留"单一调度器 / 单一事件写入者 / `seq` 单一分配者"；放开 "A separate local-execution fast path is not permitted" 的绝对禁令 |
| **ADR 0022 D10**（L113–122） | 保留"信任边界要写明、不宣称做不到的 operator-blind relay"；重写 "no vendor sits in the path" 与"Hub 部署在不可信主机 out of scope"两句 |
| **ADR 0022 D3**（L84–88） | 前提从"能解析已有 anchor"扩成"有 anchor **或** 被授权从声明的远端物化它"；保留"绝不静默替换设备或 agent" |
| **ADR 0020** L11–13 / L31–34 | 重写"加托管账户会违反 local-first 边界"这个前提；L26–29 的撤销与 TTL 语义原样留 |
| **ADR 0011** L32 | `DefaultMaxConcurrent = 4` → 实际是 **16**（`internal/task/engine.go:42`），且第 4 条已被 0016 改写 |
| **ADR 0012** | 降级为冻结研究笔记：前提（memory → continuous learning 路线图）不在新目标内，且它描述的东西大半不存在（API 只支持 cold、无 memory 表、无 eval 页面）。**但 L33/L34/L36/L82/L84 的方法学是真调研成果，别一起删** |
| **ADR 0001** L56 | 删掉 `No automatic routing/fallback between providers yet (explicit user switch only)`——`SYSTEM_DESIGN.md:154–157` 明说自动路由、同 agent provider/model fallback、可审计路由决策**都已上线**。纯过时，与新目标无关 |
| **ADR 0003** L46–47 | 只有当托管执行要接管 artifacts 时才回看。L22 `Kin does not become a content cloud` 与新方向一致，保留 |
| **ADR 0005** L13 / L67 | 松绑两处"单机 scope"措辞：L67 `exceeds Kin's current single-machine scope` 与 L13 的 `without introducing containers`。**L36–L40 的 checkpoint/restore 语义一个字都不许动**（见 §5） |
| **ADR 0007** / **ADR 0008** / **ADR 0009** | **不用改**。0007 的 L40–41 已就地写下 0022 与 ACP 的修订；0008 的 L85"多用户/指派"管的是 multi-user，与 multi-device 不冲突；0009 与新目标无交集 |
| **ADR 0025 第 2 条** | 我自己写的那条 "ADR 0022 D9 is upheld without exception" 随 D9 一起改；Context 段与 build-tags 备选段也引了 D9，共三处 |
| `SYSTEM_DESIGN.md` §2 L52 / L69 / L70 / L72 | 梯子缺 Hub/Node 与 `--relay` 档位；"先 Web 后原生"的排序已无对象（iOS 壳已存在） |
| `SYSTEM_DESIGN.md` §4 L108–120 | 组件表缺 Hub/Node、accounts、relay、connectors、browser worker、routines |
| `docs/REMOTE_ACCESS.md` L5–11 | 梯子表补 `--relay` 与 `--role hub --domain` 两档 |
| `README.md` L60 / L82 | "Artifacts, next" 与"计划采用 Apache-2.0（待确认）"都已过时 |

## 4. 过时（描述已不成立）

`docs/MVP_TECH_SPEC.md` 整份基本是历史文档：§0 L18 "Implement milestones in order"（M0–M4 均已完成）、
§1 L25–45 仓库布局（现为 33 个包）、§1 L47 桌面壳"out of scope"（已打包）、§3 L74–114 schema
（已扩张到 users / device / hub_seq 等）、§5 L178–180 并发与重启语义、§6 L189–202 路由清单、
§7 L210–218 远程访问模式表、§10 里程碑、§12 待维护者提供的 8 项人工输入（全部已解决）。
**建议归档，但 §10 的 M2/M3 验收场景值得先转成端到端回归测试再删。**

## 5. 不可丢失——删任何东西之前先转移到这里

这些是"忘了会静默写坏数据"或"重查一遍很贵"的内容。建议抽到一份 `docs/INVARIANTS.md`，
或就地标注"不变量，改动需新 ADR"。

### 数据完整性

- **`events.seq` 的单写者构造**（ADR 0022 L41–46）：`MAX(seq)+1` 在插入事务内分配、
  靠 `MaxOpenConns(1)` 串行化。**任何让多于一个进程写同一段会话事件日志的设计都是不可靠的。**
  代码锚点 `internal/store/store.go:37`。
- **`hub_seq` 单调 + tombstone 做地板**（ADR 0024 L38–46）：只在活任务上取 `MAX+1` 会在最高编号
  任务被删后**倒退**，所有持该游标的客户端**静默漏变更**。删任务必须写 `task_tombstones`。
  代码锚点 `internal/store/store.go:572–580`。
- **每一次任务行写入都必须 `touchTaskHubSeq`**（ADR 0024 L30–36）：状态翻转、工作区重绑、
  项目挂载、routine 已读标记、重试、孤儿清理都要。**新增写路径漏 touch 是要盯的失效模式。**
- **游标只由 feed 推进**（ADR 0024 L48–56）：推送帧不得推进游标。客户端顺序必须是
  "先开流，再 drain feed"——反过来会存在无人投递的窗口。
- **feed 不得过滤**（ADR 0024 L74–76）：过滤会让游标越过客户端从未见过的变更。
- **迁移的诚实性**（ADR 0024 L72–73）：迁移 035 按创建顺序编号历史任务，升级库不得产生空 feed。

### 账目正确性（ADR 0006）

- **幂等键 `(task_id, event_seq)`**（L27–28）：每一行都必须挂在产生它的那个持久化任务事件上。
- **`tasks.tokens_*` / `cost_usd` 是兼容读模型**（L30–31）：必须与账本**同事务**更新。
- **增量事件 vs 累计结果事件必须区分**（L53–54）：否则重复计数。
- **cache 的三态语义**（L33–34）：报告出来的 0、未知、不支持是**三种不同状态**。
- **命中率只在语义已知的记录上算，并公布覆盖率**（L36–37）；**不得从 token 总量推断订阅余量**（L39–40）。
- **provider 报的 cost 是权威**，价目表算出来的是估算、必须标注（L63–64）。

### Prompt 缓存前缀律（ADR 0002）——最容易在重构里被无声破坏

L114 定义失效条件：`前缀缓存是基于**字节完全相同**的最长公共前缀，任何对更早消息的编辑都会让它
及其之后全部失效。` 由此推出八条硬规则（L120–127），**改写 loop 或压缩逻辑前逐条对**：

- **K1** 运行中的会话，system prompt 必须稳定。
- **K2** 一个 Kin loop turn 内**只追加**——不得为常规压缩去改写更早的 RoleTool / assistant 消息。
  原文理由：`Mid-loop pruneLoopMessages that mutates old tool bodies **kills** cache for the whole transcript`。
- **K3** **先摘要再追加**（Policy C），让追加进去的 tool 消息**已经是小的、最终的**。
- **K4** 跨 turn 优先**真多轮续接**，而不是每次追问都重建一个巨型 handoff blob。
- **K5** 需要压缩时**封存一段**：追加一条不可变的摘要消息，**绝不重排或重新摘要整段过去**。
- **K6** 最新优先的预算选择只用于**离线打包 / 首次冷启动**，不得用于改写已缓存的活跃 messages 数组。
- **K7** 同一会话内 tool schemas / tool def JSON **保持逐字节相同**（很多 provider 把 tools 哈希进缓存键）。
- **K8** cache_control / provider 断点只打在**已封存的边界**上。

另：**SoT 是 SQLite 事件**（L164）；v0 的响应式裁剪只是**溢出安全网，不是设计中心**（L79）；
预算选取**永远最新优先，绝不最旧优先**（L181）。
K1–K8 删掉任何一条，表现都不是报错，而是**悄悄变贵**——所以它们必须留下。

### 工作区与并发

- **worker plan 追加语义**（ADR 0018 L13–23）：plan 必须在第一个 worker 启动前落库；
  一个 `write` 步骤独占一波，**两个 writer 永不同时改同一 active generation**。
- **工作区世代的六条硬约束**（ADR 0014 L111–272）：单一生命周期所有者、只做快进、
  **物理 worktree 绝不在快照与集成记录落盘前删除**、turn→generation 的持久映射（重试与分叉
  必须查它而不是从相邻事件推断）、review base 是快进前的目标分支头、
  **绝不静默回退到主检出上可写执行**。
- **配额唤醒的租约语义**（ADR 0015 L14–23）：一任务一行；**必须在探测或重试前事务性 claim**；
  定时器只是进程内唤醒，**持久化的 deadline 才是权威**；多条唤醒路径不得并发重放同一失败 turn。
- **Routine 公平性**（ADR 0016 L15–22）：原子 claim lease；调度器**至少预留一个交互槽**；
  容量不足时到期的 Routine **保持到期并通过积压健康上报，而不是被静默丢弃**。
- **私有 checkpoint 的构造**（ADR 0005 L36–40）：快照对象写进 `~/.kin/checkpoints/<task-id>/objects`
  **而不是用户仓库的 object database**（L66 的理由：写进用户库会把未跟踪的密钥/生成物永久留下）；
  临时 index 从 HEAD 起、`git add -A`、经 alternates 读未改对象；忽略文件排除；有单文件与总量上限；
  **跳过快照必须在任务事件里可见，且绝不阻止任务本身运行**。
- **恢复失败不得改动任何状态**（L39）：`恢复失败时，对话历史与任务状态都不许被改动`——
  先恢复 checkpoint 再截断事件，顺序反了就是不可逆的数据损坏。
- **路径与 Git 调用纪律**（L47 / L56–59）：原检出的未提交改动**绝不静默复制**进新 worktree；
  worktree / checkpoint 路径由**任务 ID 决定**，不由仓库名或用户输入决定；每次删除或恢复都验证目标
  在 Kin 状态目录之下；`GIT_TERMINAL_PROMPT=0`、有界 context、有界 stderr；**D+NUL 分隔做 diff 与文件枚举**；
  不记录任何环境变量或文件内容。
- **共享工作区禁令**（L60–61）：任务处于 queued / running / waiting-approval 时**拒绝**恢复与丢弃；
  **绝不**对共享工作区跑自动 `git clean` / `reset` / 删分支 / 删 worktree。

### 安全

- **`operatorOnly` 的正确性前提**（ADR 0023 L33–37）：它今天成立**只因为** Hub 在首个 claim 后
  关闭注册、不存在第二个账户。**一旦有了第二个账户，这个 kind test 必须变成 role test**——
  否则所有已登录用户都变成 daemon operator。托管/多租户一出现就直接变越权漏洞。
- **master token 绝不交给浏览器会话**（ADR 0023 L39–45）。
- **连接器凭据 fail-closed**（ADR 0019 L35–43）：凭据只以不透明 secret ref 引用，
  绝不进 prompt 或审计载荷；未启用的连接器一律 fail closed。
- **浏览器 worker 守卫集**（ADR 0021 L16–24）：域名白名单、上传目录包含、下载限长、
  审批回调、证据脱敏（表单值 / 文件路径 / 敏感 URL query）。
- **MCP 权限梯度**（ADR 0017 L15–36）：每个请求都要有 principal + client identity + 显式 scope；
  设备凭据永不提升为 master；可变调用用幂等键。ADR 0022 已要求把这条梯度扩到 REST。
- **Hub 面向网络的加固清单**（ADR 0022 L202–207）：TLS、server timeouts、按设备限流、
  read/write/admin 梯度。
- **重写 ADR 0004 时必须原样搬走的四条**——产品面可以删，这四条不能：
  - L11（**这是"为什么"**）：`Reusing that exposure for a shell would turn possession of a
    Kin token into remote command execution.`
  - L16：每个终端 REST 与 WebSocket 路由**同时**要求 Kin token **和**真实 loopback TCP 对端；
    **转发头不能授予或撤销访问**。
  - L24：带着有效 Kin token 从 LAN / Tailnet / Funnel 进来，终端路由**照样吃 `403 loopback only`**。
  - L18：后端**自己拥有一组不可变的 shell profile**；客户端只能提交后端签发的 profile ID，
    **绝不能提交可执行文件路径或参数列表**（否则"新建会话"变成任选可执行文件）。
  在新模型下 L16/L24 的语义映射到 `--allow-terminal`：**Hub 的凭据不自动授予终端**。
- **Tier-2 通用 CLI agent 的两道闸**（ADR 0009 L16–18）：**默认 unavailable**——PATH 上存在
  绝不等于可以用它派发新会话/任务；`permission_mode=default` 下**拒绝**创建 Tier 2 任务
  （没有 Kin 审批通道），必须 `accept_edits` 或 `yolo`。另 L14：**不要手改生成的
  `skills_catalog.go`**。
- **凭据只以掩码出现**（ADR 0001 L15 / L50）：`provider.api_key` 存在 settings 库，GET **永远返回掩码**，
  PUT **忽略掩码占位符**（否则一次误编辑就把真 key 写成 `sk-…abc`）。

### 昂贵的外部调研

- **账户与身份**（ADR 0022 L134–175）：账户键是 user id **绝不是 email**（OIDC Core §5.7）；
  GitHub 用数字 `id` 而非 `login`；链接第二个凭据必须已认证，**任何环节都不做按 email 自动合并**；
  所有权用打印在 Hub 终端的一次性码认领；本地密码用 argon2id + 按地址与按账户限流。
  **重写 0022 时这段最容易被误删。**
- **Claude Code CLI 行为**（MVP_TECH_SPEC §4.1 L144–155）：stream-json、`--permission-prompt-tool`、
  `--resume`，现已新增 `--permission-mode` / `--allowedTools` 分层。
- **裸连路径**（`docs/REMOTE_ACCESS.md` §4 frp 全演练、§5 Cloudflare Tunnel）：大陆网络下
  Tailscale 不可达时的实测路径，重做成本极高。
- **ADR 0010 的 provider 行为约束**：Kin 的 `claude-code` adapter 启动 `claude -p` 时
  **没有 stdin 通道**，任何设计都不得依赖它 headless 工作。

### 中断与终态

- **中断必须同时解决待答问题**（ADR 0010 L51–54）：`FollowUpWith` 的中断路径必须解决待处理的
  user question（不只是 approval），否则阻塞的长轮询与背后的 `claude` 进程会挂死。
- **过期扫描必须覆盖问题与审批两者**（ADR 0010 L74–76）：无人值守的问题不得永久挂住任务。
- **断连 turn 的终态**（ADR 0022 L197–200）：必须是确定的终态、保留部分 transcript、
  **绝不自动批准待处理权限请求**。

## 6. 中文文档集整体落后一个版本

`c533a49`（2026-10-22）加入了 ADR 0022 的撤回标记，**只改了英文版，没碰任何 `.zh.md`**。

- `PRINCIPLE.zh.md`：`ADR 0022` / `2026-10-22` / `撤回` 出现次数**全是 0**。最后改动停在
  `c0e22c4`，早于 `c533a49`。**它至今在告诉读者"多设备编排是被否决的方向"。**
- `SYSTEM_DESIGN.zh.md`：§2 把 EN 的两条 bullet（撤回标记 + Hub 单属主）压成一条旧文案，
  仍把"完整同步产品"列为"明确后置——或永不做"。
- `README.zh.md`：**整节缺失** EN 的 `## Quick start`，没有安装命令、**也完全没有 iOS 那一行**。
  对一个"多端体验对标"的目标，中文首页读起来像另一个产品。

**任何删除动作必须两个文件同时做**，否则中文版会继续把新目标描述成被否决的路线。

## 7. 最该先动的 5 处

1. 删 `docs/OPEN_DEVELOPMENT.md` §4 L72 与 §3 L59 —— 一句话级障碍，代价最低。
2. `SYSTEM_DESIGN.md` **§5 只加一小段**（把 Hub/Node 与 `--role hub --domain`、`--relay` 补进梯子表，
   并说明 L144 括号里的条件已被满足），**§1 L22/L23 改绝对措辞**。§5 是全篇上游，所以排第二。
3. 修 `SYSTEM_DESIGN.zh.md` §2 L71 与 `PRINCIPLE.zh.md` —— 否则中文版仍在明文禁止新目标。
4. 改 `docs/MVP_TECH_SPEC.md` §0 L15 —— 从 MUST NOT 清单里去掉 `user accounts` 与 `a Kin cloud/relay`。
5. 改 `README.md` L9 / L13 / L59 —— 把 "No vendor relay, no OpenKin account" 改成
   "默认本地优先，可选用托管执行"。

随后立即：**重写 ADR 0004**（跨设备终端，§1.1 的决定照着 `m1-m2-progress.md` 落成 ADR）、
**修订 ADR 0022 D3/D4/D9/D10 与 ADR 0025 的三处引用**，以及**写 §5.11 要求的那份 ADR**
（`must cite its own ADR`——写它就是满足它，**不是删它**）。

## 附 A：25 份 ADR 全名单（勾选用）

**要动的只有 5 份**（0022、0004、0012、0020、0011），其余 20 份**保留**。

| ADR | 判定 | 动作 |
|---|---|---|
| 0001 Cognition Provider | 保留 | 删 L56（自动路由早已上线） |
| 0002 Context management | **保留** | 无。K1–K8 是 cache 前缀律，见 §5 |
| 0003 Artifacts | 保留 | 无（托管要接管 artifacts 时才回看 L46–47） |
| **0004 Local integrated terminal** | **重写** | 产品面 L15/L17/L26 删；四条不变量搬进 §5 |
| 0005 Isolated task workspaces | 保留 | 松绑 L13 / L67 的"单机 scope"措辞 |
| 0006 Usage ledger | **保留** | 无。账目正确性见 §5 |
| 0007 Pluggable agent runtime | 保留 | 无需改（L40–41 已自行记下 0022 的修订） |
| 0008 Project one-pager | 保留 | 无需改（L85 管 multi-user，与 multi-device 不冲突） |
| 0009 Generic CLI tier | 保留 | 无需改（L16/L18 是闸门，别顺手删） |
| 0010 ask-user-question | 保留 | 无。中断/终态不变量见 §5 |
| 0011 Routines | 保留 | 改 L32：`DefaultMaxConcurrent = 4` → **16**；第 4 条已被 0016 改写 |
| **0012 Continuous learning / eval** | **降级** | 改成冻结研究笔记；L33/L34/L36/L82/L84 的方法学**留下** |
| 0013 Prompt recipes | 保留 | 无 |
| 0014 Workspace generations | **保留** | 无。六条硬约束见 §5 |
| 0015 Durable quota wakeups | **保留** | 无。租约语义见 §5 |
| 0016 Routine fairness | **保留** | 无。公平性语义见 §5 |
| 0017 Public MCP authority | **保留** | 无。权限梯度见 §5 |
| 0018 Persisted worker steps | **保留** | 无。plan 追加语义见 §5 |
| 0019 Skills / connector boundaries | **保留** | 无。fail-closed 见 §5 |
| 0020 User-owned worker leases | 保留主体 | 改 L11–13 / L31–34 的前提（"加托管账户违反 local-first"）；L26–29 语义**原样留** |
| 0021 Browser worker boundaries | **保留** | 无。守卫集见 §5 |
| **0022 Hub/Node multi-device** | **重写** | 只改 D3 / D4 / D9 / D10；**D1、D2、D5–D8 五条原样留**；L134–175 账户调研**一个字都别删** |
| 0023 Hub owner authority | **保留** | 无改动，**但它是托管执行的硬前置**：见下 |
| 0024 Session sync cursor | **保留** | 无。游标语义见 §5 |
| 0025 Hub build boundary | 保留 | 随 D9 改三处 D9 引用（Context 段、第 2 条、build-tags 备选段） |

> **0023 是这张表里唯一有"定时炸弹"性质的一条。**
> `operatorOnly` 今天正确，**只因为** Hub 在首次 claim 后关闭注册、世界上只有一个账户。
> **一旦托管执行带来第二个账户，这个 kind test 必须变成 role test**——
> 否则每个已登录用户都自动变成 daemon operator，直接是越权漏洞。
> 动托管之前先改这里。

## 附 B：ADR 0022 D1–D10 逐条判定

| | 决定 | 判定 |
|---|---|---|
| D1 | 单写者，只有 Hub 分配 `events.seq` | **仍然成立**（托管执行只会增加写入者，这条比原来更关键） |
| D2 | 每会话同一时刻一个 active turn | **仍然成立**（同时承担跨端不打架） |
| D3 | 执行跟着 workspace 走 | **需要修改**（托管环境里 workspace 事先不存在，要先物化） |
| D4 | 密钥不出 Node | **需要修改**（见 §1.2，这是诚实性分水岭） |
| D5 | Kin 自己的 transcript 权威 | **仍然成立**（"会话跨设备连续"的前提） |
| D6 | native agent session id 是设备作用域的 | **仍然成立**（删掉会出现跨设备 resume 别人的 sessionId） |
| D7 | 不新增会话实体 | **仍然成立**（多端驱动同一批会话正需要它） |
| D8 | HTTP cursor 是真相，realtime 是加速器 | **仍然成立**（与 ADR 0024 是同一约束的两面） |
| D9 | 本地与远程只有一条执行路径，禁止独立本地快速路径 | **需要修改 / 严格读法是直接矛盾**（见 §3） |
| D10 | Hub 是权威不是中继，信任边界要写明 | **需要修改**（见 §3） |
