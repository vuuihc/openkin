/**
 * KIN-CONTRACT-001 — the four-page surface contract, as data.
 *
 * The console had fifteen routes and about ten real pages; each of them was
 * good at one half of one journey. The contract below is the owner's
 * 2026-11-22 call: four pages — the device → project → task list (a routine
 * run is a task row), task detail, routines (a list, not a run feed), and
 * settings — with `/new` modelled as the task detail's draft state rather
 * than a fifth page.
 *
 * Two tables live here, and both are checked against the story itself in
 * `surfacesContract.KIN-CONTRACT-001.test.ts`:
 *
 * - `CONTRACT_PAGES` is what may exist after the reduction.
 * - `EXIT_ROWS` is the retirement table: one row per old path or old piece of
 *   a page, where it lands, where its ability went, and who finishes it. A row
 *   with no owner cannot be deleted from the table, and a route-shaped `from`
 *   may never name a page the contract keeps.
 *
 * This module is data on purpose: `routes.contract.test.ts` reads `App.tsx`
 * and refuses an unlisted route. It is green before the deletions begin
 * because every route in today's tree is already a contract page, the draft
 * route, or a retirement row, so each later deletion is checked against it.
 */

export interface ContractPage {
  /** Route pattern as written in `ui/src/App.tsx`. */
  readonly path: string;
  /** The one-line name a person uses for this page. */
  readonly title: string;
}

export interface ExitRow {
  /** The old path, or the old piece of a page, verbatim from the story's table. */
  readonly from: string;
  /** Where a person lands now. */
  readonly to: string;
  /** Where the ability went. */
  readonly ability: string;
  /** The story or slice that finishes the move; never empty. */
  readonly owner: string;
}

export const CONTRACT_PAGES: readonly ContractPage[] = [
  { path: "/sessions", title: "列表" },
  { path: "/tasks/:id", title: "任务详情" },
  { path: "/routines", title: "例行任务" },
  { path: "/settings", title: "设置" },
];

/**
 * `/new` is a draft of the task detail, not a fifth page: it shares the shell
 * and becomes `/tasks/:id` when the first message is sent.
 */
export const CONTRACT_DRAFT_ROUTE = "/new";

/**
 * The retirement table, row for row from `KIN-CONTRACT-001.md` §设计. Keep the
 * order: the story is the source, and this list is asserted equal to it.
 */
export const EXIT_ROWS: readonly ExitRow[] = [
  {
    from: "/projects",
    to: "/sessions",
    ability: "列表的项目层级",
    owner: "R-delete-pages",
  },
  {
    from: "/projects/:id",
    to: "/sessions",
    ability: "项目行展开可读工作说明（只读，编辑走「⋯」）",
    owner: "R-delete-pages",
  },
  {
    from: "/inbox、/approvals",
    to: "/sessions",
    ability: "列表每行写「等你处理」",
    owner: "已落地",
  },
  {
    from: "/agents",
    to: "/settings?tab=operations",
    ability: "Agent Ops 留在 operations tab",
    owner: "已落地",
  },
  {
    from: "/usage",
    to: "/settings?tab=operations",
    ability: "用量界面不动（composer footer 的 popover 仍是入口）",
    owner: "已落地",
  },
  {
    from: "/routines 里的运行列表",
    to: "/sessions",
    ability: "每个运行是一条任务行，带例行任务名；「看运行」带筛选跳转",
    owner: "本条",
  },
  {
    from: "/agent-sessions/:id",
    to: "/sessions?agent=<id>",
    ability: "旧整页 URL 落到列表，该会话的 sheet 开在列表上方；继续即落到 /tasks/<id>",
    owner: "已落地",
  },
  {
    from: "/machines/:device/tasks/:id",
    to: "/tasks/:id?device=",
    ability: "同一份任务详情",
    owner: "本条",
  },
  {
    from: "Settings 的 agents 安装检测（探测状态与能力徽标）",
    to: "/settings?tab=agents",
    ability: "导入会话与角色默认保留；探测重做后再决定展示什么",
    owner: "R-agents-detect（独立 story）",
  },
  {
    from: "/",
    to: "/sessions",
    ability: "入口 redirect（手机回列表，桌面回上次任务或 /new），不是页面",
    owner: "已落地",
  },
  {
    from: "*",
    to: "/new",
    ability: "已登记的兜底 redirect：未匹配路径回新对话，不是页面",
    owner: "已落地",
  },
  {
    from: "/dev/components",
    to: "不在生产路由",
    ability: "仅 dev build",
    owner: "本条",
  },
];
