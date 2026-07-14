# Open Development

[中文要点](#中文要点)

**Status:** Draft v0.1  
**Default docs language:** English (optional `.zh.md` companions)

How Kin practices “build in public” without turning the repo into a stream of half-finished thoughts.

Aligned with [PRINCIPLE §5.11](../PRINCIPLE.md) (small by default) and [§10](../PRINCIPLE.md) (real open core).

---

## 1. What “open” means here

Outsiders should be able to:

- understand the product bet,
- follow **real** progress,
- eventually run, fork, and extend the agent **without a vendor cloud**.

It does **not** mean every sketch, strategy debate, or personal note is public.

| Default public | Default private |
|----------------|-----------------|
| Principles, license, README | Exploratory design still thrashing |
| Draft architecture at **theme** level | Day-by-day plans, uncommitted bets |
| Shipped (or about-to-ship) code & ADRs | Security detail useful only to attackers |
| Changelog / demos when something runs | Dogfood transcripts, personal memory dumps |
| Issues for bugs and accepted work | API keys, private user data |

> Publish if a stranger can correctly decide whether Kin is for them.  
> Hold back if they would only watch you reverse the decision next week.

---

## 2. Cadence

Prefer steady, high-signal updates over loud empty launches.

- **When coding:** short changelog notes; occasional demo when a theme lands  
- **Milestones:** what shipped, what is explicitly out, known sharp edges  
- **Channels:** GitHub is source of truth; other posts link back to something runnable when possible  

Avoid: daily noise without artifacts; calendar promises we cannot keep; recruiting for vapor architecture.

---

## 3. Trials and contributions (rules of thumb)

**Trials** make sense when someone can install, complete one real confirmed tool task, and export or delete data **without** a private walkthrough—and maintainers can support via public issues.

**Contributions** make sense when interfaces exist on disk, non-goals are visible, and issues touch real files—not redesigns of unbuilt platforms.

Until then, open development is **visible progress**, not a growth campaign.

Good early help (when code exists): docs clarity, translations, provider adapters, small tools, tests.  
Poor early help: Phase-3 multi-device platforms, unbounded “computer use” products, identity rewrites.

---

## 4. Narrative

Promote difference, not autonomy hype:

- One Kin across models; memory you can inspect  
- Local-first; leave anytime  
- Authority you can see  
- Small on purpose  

Avoid: “fully autonomous,” “replaces you,” “OS for everything,” multi-device demos before single-machine excellence.

---

## 中文要点

- **公开**原则、主题级架构、可运行进展与演示；**不公开** thrash 中的探索、日更空承诺、隐私 dogfood、未修复的安全细节。  
- **节奏**弱信号、高信息量；GitHub 为源。  
- **试用 / 贡献**等可安装、可完成真实确认任务、可用 issue 支持之后；先欢迎文档与小适配，不招人做未验证的大平台。  
- 现在适合「方向可见」，不适合「增长运动」。  

Principles: [PRINCIPLE.md](../PRINCIPLE.md) · [中文](../PRINCIPLE.zh.md).
