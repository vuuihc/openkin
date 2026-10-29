import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The floating approval's wiring, as source.
 *
 * The DOM tests drive `FloatingApproval` with stub bands and hand-made props,
 * which cannot see whether a *page* marks its band, whether the shell asks for
 * a measurement on the right routes, or whether the drawer still lets the card
 * paint over itself. Each of those is one deleted attribute or condition away
 * from failing quietly — the last review found three of them that way.
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
    // The three screens that pin a composer: a conversation, the draft, an
    // agent session's continue box. Bound to the assignment itself — a fourth
    // clause (`|| detailRoute`) or the artifact route creeping back in is the
    // regression this round fixed.
    const assignment = shell.match(/const measuredBottomBand =[\s\S]*?;\n/)?.[0] ?? "";
    expect(assignment).not.toBe("");
    expect(assignment).toMatch(/selectedTaskId !== null/);
    expect(assignment).toMatch(/draftActive/);
    expect(assignment).toMatch(/startsWith\("\/agent-sessions\/"\)/);
    expect(assignment).not.toMatch(/artifacts|detailRoute/);
  });

  it("gets the card out of the modal drawer's way", () => {
    // The drawer and the card are both `z-40`; the card comes later in the DOM
    // and covers the drawer's scrim, so it is not rendered while it is open.
    expect(shell).toMatch(/\{!mobileOpen && \(/);
    // ...and the drawer state is closed when the viewport crosses `md`, or a
    // rotation with the drawer open would suppress the card forever.
    expect(shell).toMatch(/useCloseOnWideScreen\(mobileOpen/);
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

  it("marks the band on every composer screen", () => {
    // On its own attribute line, so a marker inside a JSX comment or behind a
    // `false &&` does not count.
    expect(draft).toMatch(/^\s*data-kin-bottom-chrome=""$/m);
    expect(agentSession).toMatch(/^\s*data-kin-bottom-chrome=""$/m);
  });

  it("marks the transcript's band only for the pane on screen", () => {
    // `TaskSessionHost` keeps visited conversations mounted and hides them with
    // `display:none`. An unconditional marker lets the card measure a hidden
    // pane's zero-size box and put itself off the top of the screen.
    expect(transcript).toMatch(/data-kin-bottom-chrome=\{active \? "" : undefined\}/);
  });
});
