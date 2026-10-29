// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { t } from "../../i18n";
import type { ChangedFile } from "../../lib/changedFiles";
import WorkspacePanel from "./WorkspacePanel";

// The viewer is the only thing that loads monaco, which jsdom cannot resolve.
// Opening the file is what this test is about, not what draws it.
vi.mock("./CodeViewer", () => ({
  // It draws the panel's own error state, which is what the refusal shows.
  default: ({ error }: { error?: string | null }) => (error ? <div>{error}</div> : null),
}));

const readTaskSourceFile = vi.fn();
const readWorkspaceFile = vi.fn();

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    readTaskSourceFile: (...args: unknown[]) => readTaskSourceFile(...args),
    readWorkspaceFile: (...args: unknown[]) => readWorkspaceFile(...args),
    listTaskSourceTree: () =>
      Promise.resolve({ path: ".", entries: [{ name: "a.ts", type: "file", size: 1 }] }),
    listWorkspaceTree: () =>
      Promise.resolve({ path: ".", entries: [{ name: "a.ts", type: "file", size: 1 }] }),
    listTaskWorkspaces: () => Promise.resolve([]),
    getTaskSourceChanges: () => Promise.resolve({ changes: [] }),
    getWorkspaceDiff: () => Promise.resolve({ files: [] }),
  };
});

const CWD = "/Users/owner/project";

// jsdom has no layout, so the change list's auto-scroll into view has nothing
// to call.
Element.prototype.scrollIntoView = vi.fn();

const changed: ChangedFile = {
  // What claude-code and the ACP adapters report: an absolute path. The file
  // API is rooted at the workspace and refuses it, so the row used to open the
  // file as a 400.
  path: `${CWD}/src/a.ts`,
  action: "write",
  tool: "claude-code",
  seq: 1,
};

function renderPanel(files: ChangedFile[] = [changed]) {
  return render(<WorkspacePanel taskId="task-1" cwd={CWD} changedFiles={files} events={[]} />);
}

describe("opening a file named by the change list", () => {
  beforeEach(() => {
    readTaskSourceFile.mockReset();
    readWorkspaceFile.mockReset();
    readTaskSourceFile.mockResolvedValue({ path: "src/a.ts", content: "hi", binary: false });
    readWorkspaceFile.mockResolvedValue({ path: "src/a.ts", content: "hi", binary: false });
  });

  it("reads it by its workspace-relative path", async () => {
    renderPanel();

    fireEvent.click(screen.getByTitle(changed.path));

    await waitFor(() => expect(readTaskSourceFile).toHaveBeenCalled());
    expect(readTaskSourceFile).toHaveBeenCalledWith("task-1", "src/a.ts");
  });

  it("says a file outside the workspace cannot be read here", async () => {
    // A tool that reports a path somewhere else on the machine is not an error
    // the daemon should have to phrase: the panel cannot open it at all.
    renderPanel([{ ...changed, path: "/Users/owner/elsewhere/a.ts" }]);

    fireEvent.click(screen.getByTitle("/Users/owner/elsewhere/a.ts"));

    await waitFor(() => expect(screen.getByText(t("workspace.viewer.readFailed"))).toBeTruthy());
    expect(readTaskSourceFile).not.toHaveBeenCalled();
  });
});

describe("the file finder's way in", () => {
  it("sits beside the tab strip, not inside it", () => {
    const onFindFile = vi.fn();
    render(
      <WorkspacePanel
        taskId="task-1"
        cwd={CWD}
        changedFiles={[]}
        events={[]}
        onFindFile={onFindFile}
      />,
    );

    const button = screen.getByRole("button", { name: t("workspace.find.action") });
    // A tablist holds tabs. A search button inside it reads as a third tab to a
    // screen reader, and the arrow keys that walk the tab strip would stop on it.
    expect(button.closest('[role="tablist"]')).toBeNull();

    fireEvent.click(button);
    expect(onFindFile).toHaveBeenCalledTimes(1);
  });
});
