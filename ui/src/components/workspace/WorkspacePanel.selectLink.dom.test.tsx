// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { t } from "../../i18n";
import type { TaskEvent } from "../../api/client";
import type { ChangedFile } from "../../lib/changedFiles";
import { toWorkspaceRelativePath } from "../../lib/paths";
import { useAppStore } from "../../store/appStore";
import { AstryxProvider } from "../../design/AstryxProvider";
import WorkspacePanel from "./WorkspacePanel";

/**
 * KIN-RESULT-002 b2: a file chosen *inside* the panel is a user action.
 *
 * The panel reports the choice to the page (which writes the address) and
 * loads the file itself. The link-arrival pulse is the other way in, and it
 * must stay silent: an arrival is the address talking, not the reader, so
 * reporting it would push a second history entry for a page that only read
 * its own URL.
 */

vi.mock("./CodeViewer", () => ({
  default: ({ path }: { path?: string }) => <div data-testid="code-viewer">{path}</div>,
}));

const api = vi.hoisted(() => ({
  readTaskSourceFile: vi.fn(async () => ({ path: "a.ts", content: "", binary: false })),
  readWorkspaceFile: vi.fn(async () => ({ path: "a.ts", content: "", binary: false })),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    readTaskSourceFile: api.readTaskSourceFile,
    readWorkspaceFile: api.readWorkspaceFile,
    listTaskSourceTree: () =>
      Promise.resolve({ path: ".", entries: [{ name: "a.ts", type: "file", size: 1 }] }),
    listWorkspaceTree: () =>
      Promise.resolve({ path: ".", entries: [{ name: "a.ts", type: "file", size: 1 }] }),
    listTaskWorkspaces: () => Promise.resolve([]),
    // Never answers: the panel asks git after a debounce, and an answer would
    // replace the prop list these tests hold still.
    getTaskSourceChanges: () => new Promise(() => {}),
    getWorkspaceDiff: () => Promise.resolve({ changes: [] }),
  };
});

const CWD = "/Users/owner/project";

Element.prototype.scrollIntoView = vi.fn();

// jsdom has no layout, and the panel measures its own container rather than
// the viewport. Zero keeps the wide fallback, so a phone case says what its
// container measures — the same stub WorkspacePanel.paths.dom.test.tsx uses.
function stubContainerWidth(width: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width,
  });
}

function restoreContainerWidth() {
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
}

afterEach(() => restoreContainerWidth());

const FILES: ChangedFile[] = ["src/f1.ts", "src/f2.ts"].map((path, index) => ({
  path: `${CWD}/${path}`,
  action: "write" as const,
  tool: "claude-code",
  seq: index + 1,
  additions: 3,
  deletions: 1,
}));

const COMMENT = {
  id: "comment-1",
  path: "src/other.ts",
  hunkHeader: "@@ -10,3 +10,3 @@",
  quote: "const answer = 42;",
  line: 12,
  text: "why 42?",
  createdAt: 1,
};

const EVENTS: TaskEvent[] = [];

function renderPanel(
  props: {
    openPath?: string;
    openNonce?: number;
    showListNonce?: number;
    onSelectPath?: (path: string) => void;
  } = {},
): ReturnType<typeof render> {
  return render(
    <AstryxProvider>
      <WorkspacePanel
        taskId="task-1"
        cwd={CWD}
        changedFiles={FILES}
        events={EVENTS}
        openPath={props.openPath}
        openNonce={props.openNonce}
        showListNonce={props.showListNonce}
        onSelectPath={props.onSelectPath}
      />
    </AstryxProvider>,
  );
}

const tabs = () => screen.getAllByRole("tab");

beforeEach(() => {
  // The lens is store state, so a pick belongs to the tree, not to the last test.
  useAppStore.setState({ lensPick: null });
  localStorage.clear();
  localStorage.setItem("kin.diffComments.task-1", JSON.stringify([COMMENT]));
  api.readTaskSourceFile.mockClear();
  api.readWorkspaceFile.mockClear();
});

describe("a file picked inside the panel asks the page for its address", () => {
  it("selecting a file in the tree asks the page for its address once", async () => {
    const onSelectPath = vi.fn();
    renderPanel({ onSelectPath });

    fireEvent.click(tabs()[1]!);
    const row = await screen.findByTitle("a.ts");
    fireEvent.click(row);

    await waitFor(() => expect(api.readTaskSourceFile).toHaveBeenCalledTimes(1));
    expect(api.readTaskSourceFile).toHaveBeenCalledWith("task-1", "a.ts");
    expect(onSelectPath).toHaveBeenCalledTimes(1);
    expect(onSelectPath).toHaveBeenCalledWith("a.ts");
  });

  it("selecting a row in the changed list asks the page for its address once", async () => {
    const onSelectPath = vi.fn();
    renderPanel({ onSelectPath });

    fireEvent.click(screen.getByTitle(FILES[0]!.path));

    await waitFor(() => expect(api.readTaskSourceFile).toHaveBeenCalledTimes(1));
    expect(api.readTaskSourceFile).toHaveBeenCalledWith("task-1", "src/f1.ts");
    expect(onSelectPath).toHaveBeenCalledTimes(1);
    expect(onSelectPath).toHaveBeenCalledWith(FILES[0]!.path);
  });

  it("jumping to a comment in another file asks the page for that file's address", async () => {
    const onSelectPath = vi.fn();
    renderPanel({ onSelectPath });

    fireEvent.click(
      screen.getByRole("button", {
        name: t("workspace.comments.jumpToRow", { path: COMMENT.path, line: COMMENT.line }),
      }),
    );

    await waitFor(() => expect(api.readTaskSourceFile).toHaveBeenCalledTimes(1));
    expect(api.readTaskSourceFile).toHaveBeenCalledWith("task-1", COMMENT.path);
    expect(onSelectPath).toHaveBeenCalledTimes(1);
    expect(onSelectPath).toHaveBeenCalledWith(COMMENT.path);
  });

  it("a pick the page writes back as openPath is read once", async () => {
    // The page's answer to a pick is to record the workspace-relative path as
    // the address, which re-fires the arrival pulse with that path. The panel
    // must recognise the pick as already handled, or it reads the same file
    // twice and throws the first answer away.
    const onSelectPath = vi.fn();
    function PageLoop() {
      const [openPath, setOpenPath] = useState<string | null>(null);
      return (
        <AstryxProvider>
          <WorkspacePanel
            taskId="task-1"
            cwd={CWD}
            changedFiles={FILES}
            events={EVENTS}
            openPath={openPath}
            openNonce={0}
            showListNonce={0}
            onSelectPath={(path) => {
              onSelectPath(path);
              // Mirrors the page: the address names the path relative to the
              // checkout, and an absolute changed-row path is normalized.
              setOpenPath(toWorkspaceRelativePath(CWD, path));
            }}
          />
        </AstryxProvider>
      );
    }
    render(<PageLoop />);

    fireEvent.click(screen.getByTitle(FILES[0]!.path));

    await waitFor(() => expect(screen.getByTestId("code-viewer")).toBeTruthy());
    expect(onSelectPath).toHaveBeenCalledTimes(1);
    expect(api.readTaskSourceFile).toHaveBeenCalledTimes(1);
    expect(api.readTaskSourceFile).toHaveBeenCalledWith("task-1", "src/f1.ts");
  });

  it("the link-arrival pulse loads the file without asking the page for an address", async () => {
    const onSelectPath = vi.fn();
    // The page passes its counter from the first render, so an arrival mounts
    // with the file pulse and that counter set in the same commit. The pulse
    // must survive it, or a refresh on `?panel=files&file=…` lands on the list.
    renderPanel({ openPath: "src/a.ts", openNonce: 1, showListNonce: 0, onSelectPath });

    await waitFor(() => expect(api.readTaskSourceFile).toHaveBeenCalledTimes(1));
    expect(api.readTaskSourceFile).toHaveBeenCalledWith("task-1", "src/a.ts");
    expect(screen.getByTestId("code-viewer").textContent).toBe("src/a.ts");
    // An arrival is the address talking. Reporting it would push the entry the
    // reader just arrived on.
    expect(onSelectPath).not.toHaveBeenCalled();
  });

  it("the phone's Back to files asks the page for the list's own address", async () => {
    stubContainerWidth(390);
    const onSelectPath = vi.fn();
    renderPanel({ onSelectPath });

    fireEvent.click(tabs()[1]!);
    const row = await screen.findByTitle("a.ts");
    fireEvent.click(row);
    await waitFor(() => expect(api.readTaskSourceFile).toHaveBeenCalledTimes(1));

    // The file pane is in front and its header carries the way back.
    const back = screen.getByRole("button", { name: t("workspace.backToFiles") });
    fireEvent.click(back);

    // The workspace root is the list in this panel's address model, so the
    // page can stop the URL naming a file the reader has left. Without this
    // the address kept the file and a refresh reopened it.
    expect(onSelectPath).toHaveBeenLastCalledWith(CWD);
    expect(screen.queryByRole("button", { name: t("workspace.backToFiles") })).toBeNull();
  });

  it("a click that only re-opens the file already shown still asks the page", async () => {
    const onSelectPath = vi.fn();
    renderPanel({ onSelectPath });

    const row = screen.getByTitle(FILES[0]!.path);
    fireEvent.click(row);
    await waitFor(() => expect(api.readTaskSourceFile).toHaveBeenCalledTimes(1));

    // A re-click is still a user action; the page's own "same address" guard
    // makes the write a no-op, which is the page's business, not the panel's.
    fireEvent.click(row);
    await waitFor(() => expect(api.readTaskSourceFile).toHaveBeenCalledTimes(2));
    expect(onSelectPath).toHaveBeenCalledTimes(2);
  });
});

describe("an applied list address", () => {
  it("drops the open file without reading it again", async () => {
    const view = renderPanel({ openPath: "src/a.ts", openNonce: 1 });
    await waitFor(() => expect(screen.getByTestId("code-viewer").textContent).toBe("src/a.ts"));
    expect(api.readTaskSourceFile).toHaveBeenCalledTimes(1);

    // Back onto `?panel=files`: the page bumps the nonce because the address
    // now says the list. The panel returns to the list; nothing is re-read.
    view.rerender(
      <AstryxProvider>
        <WorkspacePanel
          taskId="task-1"
          cwd={CWD}
          changedFiles={FILES}
          events={EVENTS}
          openPath={null}
          showListNonce={1}
        />
      </AstryxProvider>,
    );

    await waitFor(() => expect(screen.queryByTestId("code-viewer")).toBeNull());
    expect(screen.getByText(t("workspace.viewer.empty"))).toBeTruthy();
    expect(api.readTaskSourceFile).toHaveBeenCalledTimes(1);
  });
});
