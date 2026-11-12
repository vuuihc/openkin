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
const transcript = source("src/pages/TaskDetailPage.tsx");
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
    // The list page's footer and its new-chat button are the only bottom
    // furniture on the phone; everywhere else the card keeps the lower offset.
    expect(shell).toMatch(/raised=\{pathname === "\/sessions"\}/);
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
    // The draft is not one of them: its card is in the flow, and a marker the
    // shell no longer measures would only make the approval chase a box that
    // is not a band (KIN-START-001).
    expect(draft).not.toMatch(/data-kin-bottom-chrome/);
  });

  it("marks the transcript's band only for the pane on screen", () => {
    // `TaskSessionHost` keeps visited conversations mounted and hides them with
    // `display:none`. An unconditional marker lets the card measure a hidden
    // pane's zero-size box and put itself off the top of the screen.
    expect(transcript).toMatch(/data-kin-bottom-chrome=\{active \? "" : undefined\}/);
  });
});
