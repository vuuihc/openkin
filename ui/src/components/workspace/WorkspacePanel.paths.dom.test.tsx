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

// Below md the panel is one pane at a time. The stack of list and viewer left a
// diff with about half a phone screen; opening a file now gives it the whole
// one and the header carries the way back. jsdom has no viewport, so the layout
// itself is CSS: the state assertions read `data-phone-view`, and one token
// check per pane pins the class the CSS hangs on.
describe("one pane at a time on a phone", () => {
  beforeEach(() => {
    readTaskSourceFile.mockReset();
    readWorkspaceFile.mockReset();
    readTaskSourceFile.mockResolvedValue({ path: "src/a.ts", content: "hi", binary: false });
    readWorkspaceFile.mockResolvedValue({ path: "src/a.ts", content: "hi", binary: false });
  });

  const aside = (container: HTMLElement) => container.querySelector("aside");
  const viewer = (container: HTMLElement) => container.querySelector('[data-pane="viewer"]');
  const back = () => screen.queryByRole("button", { name: t("workspace.backToFiles") });
  const paneState = (container: HTMLElement) =>
    container.querySelector("[data-phone-view]")?.getAttribute("data-phone-view");
  // Token, not substring: `overflow-hidden` is not `hidden`, and `md:flex` is
  // not `flex` at this width.
  const hasClass = (el: Element | null | undefined, token: string) =>
    (el?.className ?? "").split(/\s+/).includes(token);

  it("gives the list the whole height until a file is opened", () => {
    const { container } = renderPanel();

    expect(paneState(container)).toBe("list");
    expect(hasClass(aside(container), "hidden")).toBe(false);
    expect(hasClass(aside(container), "flex")).toBe(true);
    expect(hasClass(viewer(container), "hidden")).toBe(true);
    expect(back()).toBeNull();
  });

  it("steps the list aside for the file and offers the way back", async () => {
    const { container } = renderPanel();

    fireEvent.click(screen.getByTitle(changed.path));
    await waitFor(() => expect(readTaskSourceFile).toHaveBeenCalled());

    expect(paneState(container)).toBe("file");
    // `hidden md:flex` is the pair that keeps md+ two-pane.
    expect(hasClass(aside(container), "hidden")).toBe(true);
    expect(hasClass(aside(container), "md:flex")).toBe(true);
    expect(hasClass(viewer(container), "flex")).toBe(true);
    expect(hasClass(viewer(container), "hidden")).toBe(false);
    expect(back()).not.toBeNull();

    fireEvent.click(back() as HTMLElement);

    expect(paneState(container)).toBe("list");
    expect(hasClass(aside(container), "hidden")).toBe(false);
    expect(hasClass(viewer(container), "hidden")).toBe(true);
    expect(back()).toBeNull();
  });

  it("opens the refusal in the file pane too", () => {
    // The refusal is the viewer's answer; it belongs where the file would have
    // been, not under a list that is still in front.
    const { container } = renderPanel([{ ...changed, path: "/Users/owner/elsewhere/a.ts" }]);

    fireEvent.click(screen.getByTitle("/Users/owner/elsewhere/a.ts"));

    expect(paneState(container)).toBe("file");
    expect(back()).not.toBeNull();
    expect(screen.getByText(t("workspace.viewer.readFailed"))).toBeTruthy();
  });

  it("opens on the file when the changed-files bar sends one", async () => {
    // The bar and quick-open do not click a row: they hand the panel an
    // `openPath`, which goes through the same `loadFile`.
    const view = render(
      <WorkspacePanel taskId="task-1" cwd={CWD} changedFiles={[changed]} events={[]} />,
    );
    view.rerender(
      <WorkspacePanel
        taskId="task-1"
        cwd={CWD}
        changedFiles={[changed]}
        events={[]}
        openPath={`${CWD}/src/a.ts`}
        openNonce={1}
      />,
    );

    await waitFor(() => expect(readTaskSourceFile).toHaveBeenCalledWith("task-1", "src/a.ts"));
    expect(paneState(view.container)).toBe("file");
    expect(back()).not.toBeNull();
    // Through the same `loadFile`, so the same focus hand-off: the bar and
    // quick-open leave no row behind, but the back control still gets focus.
    await waitFor(() => expect(document.activeElement).toBe(back()));
  });

  it("does not replay the pulse when the workspace view is rebuilt", async () => {
    // A generation refetch hands the panel a new `generations` array and a new
    // view object, which used to give `loadFile` a new identity and re-run the
    // open-file command. A reader who pressed Back was dragged into the file
    // again — or into a file the new checkout does not have.
    const view = render(
      <WorkspacePanel
        taskId="task-1"
        cwd={CWD}
        changedFiles={[changed]}
        events={[]}
        openPath={`${CWD}/src/a.ts`}
        openNonce={1}
      />,
    );
    await waitFor(() => expect(readTaskSourceFile).toHaveBeenCalledTimes(1));
    fireEvent.click(back() as HTMLElement);
    expect(paneState(view.container)).toBe("list");

    view.rerender(
      <WorkspacePanel
        taskId="task-1"
        cwd={CWD}
        changedFiles={[changed]}
        events={[]}
        openPath={`${CWD}/src/a.ts`}
        openNonce={1}
        // `selectedWorkspaceId` stays undefined on purpose. `null` takes
        // `resolveWorkspaceView`'s SOURCE_VIEW early return, so the rerender
        // would hand back the same constant view and this case would stop
        // exercising the generation-view churn it exists for.
        currentWorkspaceId="ws-1"
      />,
    );

    // The view changed under the panel; the list is where the round's reset
    // says a phone starts from there, and the file is not read again.
    await waitFor(() => expect(paneState(view.container)).toBe("list"));
    expect(back()).toBeNull();
    expect(readTaskSourceFile).toHaveBeenCalledTimes(1);
    // A replay in the generation view would read through the workspace route,
    // not the task-source one, so the call count above cannot see it alone.
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("starts from the list again in another task", async () => {
    // A file from the last conversation is not a file this one has open, and
    // the pulse that clears the selection has to bring the list back with it.
    const view = render(
      <WorkspacePanel taskId="task-1" cwd={CWD} changedFiles={[changed]} events={[]} />,
    );
    fireEvent.click(screen.getByTitle(changed.path));
    await waitFor(() => expect(back()).not.toBeNull());

    view.rerender(
      <WorkspacePanel taskId="task-2" cwd={CWD} changedFiles={[changed]} events={[]} />,
    );

    expect(paneState(view.container)).toBe("list");
    expect(back()).toBeNull();
  });

  it("moves focus to the way back, then to the row that opened the file", async () => {
    // Opening a file hides the row that had focus, and the browser would drop
    // focus to <body>. Both transitions hand focus to something the reader can
    // use: the way back, then the row they came from.
    renderPanel();

    fireEvent.click(screen.getByTitle(changed.path));
    await waitFor(() => expect(document.activeElement).toBe(back()));

    fireEvent.click(back() as HTMLElement);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTitle(changed.path)));
  });
});
