import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The ways into the file finder, and the one rule about which layer owns ⌘P.
 *
 * The finder's own behaviour is covered in `FileQuickOpen.dom.test.tsx`. What
 * is left is the wiring on the page, which no unit holds: the shortcut, the
 * phone's sheet row, the panel's toolbar button, and the promise that choosing
 * a file from a *source* search does not open it inside a generation.
 *
 * Source rather than DOM, like `findWiring.test.ts`: mounting this page needs a
 * daemon, a machine list and two live subscriptions.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const PAGE = readFileSync(join(UI, "src/pages/TaskDetailPage.tsx"), "utf8");
const FINDER = readFileSync(join(UI, "src/components/workspace/FileQuickOpen.tsx"), "utf8");
const PANEL = readFileSync(join(UI, "src/components/workspace/WorkspacePanel.tsx"), "utf8");

describe("the file finder's ways in", () => {
  it("claims ⌘P / Ctrl+P on the page itself, and only in the pane in front", () => {
    // A shortcut that only works from the files panel's toolbar would be a
    // button with extra steps; the point is that it works from the transcript.
    // And a pane behind the tab strip is still mounted: without the `active`
    // gate every open session would answer one keypress with its own finder.
    expect(PAGE).toContain("const canFindFile = active && Boolean(task);");
    expect(PAGE).toContain('event.key.toLowerCase() !== "p"');
    expect(PAGE).toContain("setFileFinderOpen(true)");
    expect(PAGE).toContain("event.preventDefault()");
    // Switching away closes it rather than saving a modal for the return.
    expect(PAGE).toContain("if (!active) setFileFinderOpen(false);");
  });

  it("leaves the key to a dialog that is in front", () => {
    // The command palette keeps focus in its own field. Opening the finder
    // underneath it would move the caret into a hidden input.
    expect(PAGE).toContain('target.closest(\'[role="dialog"], [role="alertdialog"]\')');
    expect(PAGE).toContain('dialog.hasAttribute("data-file-quick-open")');
    expect(FINDER).toContain('data-file-quick-open=""');
  });

  it("opens from the phone's sheet only after the sheet is gone", () => {
    // Ionic keeps keyboard focus in the action sheet until it is removed, so
    // focusing the finder's field from the row's handler shows a field that
    // never raises a keyboard. Same rule as find-in-conversation.
    expect(PAGE).toContain('tr("workspace.find.action")');
    expect(PAGE).toContain("openFileFinderAfterSheet.current = true");
    expect(PAGE).toContain("openFileFinderAfterSheet.current = false");
  });

  it("spends the open-file pulse when the panel closes", () => {
    // The panel consumes the pulse once. A closed panel that kept it would
    // replay the last "open this file" on the next open and land inside a file
    // instead of on the list, which is what a fresh open of Files means. The
    // hook runs before the page's loading return, so it reads "is this
    // session's files panel open" from the store instead of from the panel.
    expect(PAGE).toContain(
      'const filesPanelOpen = shownPanel?.view === id && shownPanel.id === "files";',
    );
    expect(PAGE).toContain("if (!filesPanelOpen) setWorkspaceOpenPath(null);");
  });

  it("offers the panel's own trigger next to its two lenses", () => {
    expect(PANEL).toContain("onFindFile?: () => void;");
    expect(PANEL).toContain('aria-label={tr("workspace.find.action")}');
    expect(PAGE).toContain("onFindFile={() => setFileFinderOpen(true)}");
  });

  it("opens a found file in the checkout the search covers", () => {
    // The search route is `/source/files`: a generation is a snapshot that may
    // not contain the path at all. Choosing a row is what opens the files
    // panel, so the panel must not be what owns the finder.
    expect(FINDER).toContain("searchTaskSourceFiles(taskId, trimmed)");
    expect(PAGE).toContain("function onQuickOpenPath(filePath: string) {");
    expect(PAGE).toContain("onOpenPath={onQuickOpenPath}");
    // A path the view refuses must not flip the panel from a generation to the
    // checkout and open nothing: the reset follows the opener's answer.
    expect(PAGE).toContain(
      "if (!onOpenWorkspacePath(filePath)) return;\n    setSelectedWorkspaceId(null);",
    );
  });

  it("keeps the page's single-letter shortcuts out of a dialog", () => {
    // 'a'/'d' approve or deny the focused approval. With the finder's Retry
    // button focused, that would decide a card the reader cannot see.
    expect(PAGE).toContain(`e.target.closest('[role="dialog"], [role="alertdialog"]')`);
  });
});
