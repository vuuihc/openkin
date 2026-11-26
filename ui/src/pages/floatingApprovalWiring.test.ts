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
const tray = source("src/pages/TrayPage.tsx");

describe("the floating approval's wiring", () => {
  it("asks for a measured offset only where a band exists", () => {
    expect(shell).toMatch(/expectsBottomChrome=\{measuredBottomBand\}/);
    // The screens that pin a composer: a conversation and the draft. The
    // draft is a band like the conversation's (amended KIN-START-001,
    // 2026-11-21), so its box is measured too. The imported-session page was
    // the third until 5b deleted it; the sheet over the list has no band (the
    // list is the surface). Bound to the assignment itself — a clause creeping
    // back in is the regression this comparison exists to catch.
    const assignment = shell.match(/const measuredBottomBand =[\s\S]*?;\n/)?.[0] ?? "";
    // Exactly the known routes, no third clause: this comparison is the one
    // thing a hand-edited condition cannot slip past. The single line is the
    // form the repo's prettier produces for the two-term condition.
    expect(assignment).toBe("const measuredBottomBand = selectedTaskId !== null || draftActive;\n");
    expect(assignment).not.toBe("");
    expect(assignment).toMatch(/selectedTaskId !== null/);
    expect(assignment).toMatch(/draftActive/);
    expect(assignment).not.toMatch(/agent-sessions/);
    expect(assignment).not.toMatch(/artifacts|detailRoute/);
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
    // area) and while the card would cover a changed-file row, so every term
    // is pinned, not only the phone one.
    expect(floating).toMatch(/const stripOnly = raised \|\| panelOpen \|\| covered;/);
    // The third term is measured, not declared: `covered` comes from the
    // overlap loop over the rows and reading content the page marks, so the
    // card gives way only while something is actually under it.
    expect(floating).toMatch(/if \(hit !== covered\) setCovered\(hit\);/);
    expect(floating).toContain('"[data-kin-hit-row]"');
    // Reading content is the same measured rule, and the pill itself is not a
    // fallback that gets to stay: when its own box covers a cell — or a
    // conversation row or project heading on the list — the whole surface is
    // unmounted (`hidden`), not `stripOnly`. The pill is for screens with no
    // conversation list; where the list is the screen, the row is the entry.
    // Session rows carry `data-session-row` and project headings carry the
    // shared `data-kin-hit-row` marker, so the yield is one selector over both
    // kinds of row.
    expect(floating).toContain('"[data-kin-reading], [data-session-row], [data-kin-hit-row]"');
    expect(floating).toMatch(/if \(stripHit !== hidden\) setHidden\(stripHit\);/);
    // The yield has to be measured on a phone tab root too: the card is not
    // mounted there (`raised`), but the strip is, so `raised` must not
    // short-circuit the measurement.
    expect(floating).toMatch(/if \(!currentId \|\| panelOpen\) return;/);
    expect(floating).not.toMatch(/if \(!currentId \|\| raised \|\| panelOpen\) return;/);
    // …but only the visible surface: the hidden branch still renders the
    // arrival live region, sr-only and outside the `aside`, so an approval
    // that lands while the reader is on a table or the list is announced. The
    // label it carries is computed before the guard.
    expect(floating).toMatch(
      /if \(hidden && !panelOpen\) \{[\s\S]*?<ApprovalStatus className="sr-only">[\s\S]*?\n  \}/,
    );
    const labelAt = floating.indexOf("const stripLabel = [");
    const hiddenAt = floating.indexOf("if (hidden && !panelOpen)");
    expect(labelAt).toBeGreaterThan(-1);
    expect(labelAt).toBeLessThan(hiddenAt);
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

  it("keeps the strip out of an open panel's own bottom controls", () => {
    const floating = source("src/components/cards/FloatingApproval.tsx");
    const surface = source("src/components/layout/PanelSurface.tsx");

    // The column's width is the offset the strip has to clear; the store
    // counts it per shape, and the container registers the shape it drew.
    expect(floating).toMatch(/usePanelColumnOpen\(\)/);
    expect(floating).toContain("lg:right-[calc(380px+1.5rem)]");
    expect(surface).toMatch(/addPanel\(shape\)/);
    expect(surface).toMatch(/removePanel\(shape\)/);

    // A covering panel must not measure the conversation's band behind it;
    // it clears the panel's own docked regions instead.
    expect(floating).toMatch(/panelOpen && !\(panelColumn && window\.innerWidth >= 1024\)/);
    expect(floating).toContain("\"[role='complementary'] section[aria-label]\"");
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
    // The retired imported-session page was the third band; 5b deleted it, and
    // the sheet that replaced it marks none — the list is the surface, and the
    // sheet's composer scrolls in its own body. Only the draft pins a band
    // now, so the floating approval can sit above it instead of over the
    // field the reader is typing in.
    expect(draft).toMatch(/data-kin-bottom-chrome/);
  });

  it("marks the transcript's band only for the pane on screen", () => {
    // `TaskSessionHost` keeps visited conversations mounted and hides them with
    // `display:none`. An unconditional marker lets the card measure a hidden
    // pane's zero-size box and put itself off the top of the screen.
    expect(dock).toMatch(/data-kin-bottom-chrome=\{active \? "" : undefined\}/);
  });
});
