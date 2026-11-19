import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The floating approval's wiring, as source.
 *
 * The DOM tests drive `FloatingApproval` with stub bands and hand-made props,
 * which cannot see whether a *page* marks its band, whether the shell asks for
 * a measurement on the right routes, or whether the phone still has a drawer
 * for the card to paint over. Each of those is one deleted attribute or
 * condition away from failing quietly — the last review found three of them
 * that way.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));

/** Comments are not code; a scan cannot tell a dead line from a live one. */
function source(rel: string): string {
  return readFileSync(join(UI, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const shell = source("src/components/layout/AppShell.tsx");
const dock = source("src/components/task/TaskComposerDock.tsx");
const draft = source("src/pages/NewChatPage.tsx");
const agentSession = source("src/pages/AgentSessionDetailPage.tsx");
const tray = source("src/pages/TrayPage.tsx");

describe("the floating approval's wiring", () => {
  it("asks for a measured offset only where a band exists", () => {
    expect(shell).toMatch(/expectsBottomChrome=\{measuredBottomBand\}/);
    // The two screens that pin a composer: a conversation and an agent
    // session's continue box. The draft's card sits in the page now
    // (KIN-START-001), so there is no band there to clear. Bound to the
    // assignment itself — a fourth clause (`|| detailRoute`) creeping back in
    // is the regression this round fixed.
    const assignment = shell.match(/const measuredBottomBand =[\s\S]*?;\n/)?.[0] ?? "";
    // Exactly the two known routes, no fourth clause: this comparison is the
    // one thing a "just add /new back" edit cannot slip past.
    expect(assignment).toBe(
      'const measuredBottomBand =\n    selectedTaskId !== null || location.pathname.startsWith("/agent-sessions/");\n',
    );
    expect(assignment).not.toBe("");
    expect(assignment).toMatch(/selectedTaskId !== null/);
    expect(assignment).toMatch(/startsWith\("\/agent-sessions\/"\)/);
    expect(assignment).not.toMatch(/draftActive|artifacts|detailRoute/);
  });

  it("has no drawer left to paint over the card", () => {
    // KIN-CONTINUE-002 deleted the phone drawer and the dock. The card no
    // longer has a modal sibling to hide behind, so the old `!mobileOpen`
    // wrapper must not creep back, and neither must the drawer's state.
    expect(shell).not.toMatch(/mobileOpen|MobileDock|useDrawerSwipe|kin-dock-pad/);
    // Four peer roots share the footer and its raised approval card. A detail
    // or draft still measures its own bottom surface rather than the root tab.
    expect(shell).toMatch(/raised=\{!wide && onPhoneTab\}/);
  });

  it("gives the phone tab roots a strip, never the decision card", () => {
    // `raised` is exactly the four phone tab roots (`!wide && onPhoneTab`).
    // The branch is the only thing standing between a waiting approval and
    // the conversation list it used to cover, so it is pinned as structure:
    // the strip opens the task and the card renders on the other branch.
    const floating = source("src/components/cards/FloatingApproval.tsx");
    // The strip is also the whole surface while a visible panel owns the
    // screen (the card covered the file body and the panel's own approval
    // area), so both terms are pinned, not only the phone one.
    expect(floating).toMatch(/const stripOnly = raised \|\| panelOpen;/);
    // The card body is guarded by `!stripOnly`, and the strip is the branch
    // that renders instead.
    const cardGuard = floating.indexOf("{!stripOnly && (");
    const cardAt = floating.indexOf("<ApprovalCard");
    expect(cardGuard).toBeGreaterThan(-1);
    expect(cardAt).toBeGreaterThan(cardGuard);
    const raisedAt = floating.indexOf("{stripOnly ? (");
    const elseAt = floating.indexOf(") : (", raisedAt);
    expect(raisedAt).toBeGreaterThan(-1);
    expect(elseAt).toBeGreaterThan(raisedAt);
    const strip = floating.slice(raisedAt, elseAt);
    expect(strip).toMatch(/onOpenTask\(current\.task_id\)/);
    expect(strip).toContain("aria-label={stripLabel}");
    expect(strip).toContain("min-h-11");
    // Its name carries the count, not only the visible `+N`.
    expect(floating).toMatch(/waiting > 0 \? tr\("approval\.moreWaiting"/);
    expect(cardAt).toBeGreaterThan(elseAt);
  });

  it("answers through the one shared decision path", () => {
    expect(shell).toMatch(/useApprovalDecision\(\)/);
    expect(shell).toMatch(/busy=\{approvalDecision\.busy\}/);
    expect(shell).toMatch(/approvalDecision\.decide\(id, decision\)/);
    expect(shell).toMatch(/floatingApprovals\(pendingApprovals/);
    // The tray is the other window that can answer the same approval, and its
    // own copy swallowed failures — no toast, no refetch, a 409 invisible.
    expect(tray).toMatch(/useApprovalDecision\(\)/);
    expect(tray).not.toMatch(/decideApproval/);
  });

  it("marks the band on every screen that pins one", () => {
    // The marker is an attribute of the band's `<div>`, not text inside a JSX
    // comment or behind a `false &&`.
    expect(agentSession).toMatch(/<div data-kin-bottom-chrome=""[\s>]/);
    // The draft pins its composer band too, so the floating approval can sit
    // above it instead of over the field the reader is typing in.
    expect(draft).toMatch(/data-kin-bottom-chrome/);
  });

  it("marks the transcript's band only for the pane on screen", () => {
    // `TaskSessionHost` keeps visited conversations mounted and hides them with
    // `display:none`. An unconditional marker lets the card measure a hidden
    // pane's zero-size box and put itself off the top of the screen.
    expect(dock).toMatch(/data-kin-bottom-chrome=\{active \? "" : undefined\}/);
  });
});
