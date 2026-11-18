// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { t } from "../../i18n";
import type { TaskEvent } from "../../api/client";
import type { ChangedFile } from "../../lib/changedFiles";
import { useAppStore } from "../../store/appStore";
import { AstryxProvider } from "../../design/AstryxProvider";
import WorkspacePanel from "./WorkspacePanel";
// The source is part of the contract here: the old hand-written tab button is
// gone, not left behind unused.
import panelSource from "./WorkspacePanel.tsx?raw";

// The viewer is the only thing that loads monaco, which jsdom cannot resolve.
// The tab set and the summary line are the subject; the reader only has to be
// identifiable.
vi.mock("./CodeViewer", () => ({
  default: ({ path }: { path?: string }) => <div data-testid="code-viewer">{path}</div>,
}));

const getWorkspaceDiff = vi.fn();

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    readTaskSourceFile: () => Promise.resolve({ path: "a.ts", content: "", binary: false }),
    readWorkspaceFile: () => Promise.resolve({ path: "a.ts", content: "", binary: false }),
    listTaskSourceTree: () =>
      Promise.resolve({ path: ".", entries: [{ name: "a.ts", type: "file", size: 1 }] }),
    listWorkspaceTree: () =>
      Promise.resolve({ path: ".", entries: [{ name: "a.ts", type: "file", size: 1 }] }),
    listTaskWorkspaces: () => Promise.resolve([]),
    // Never answers: the panel asks git after a debounce, and a `{changes: []}`
    // answer would replace the prop list these tests hold still. What the
    // checkout says is `WorkspacePanel.preview`'s subject, not this one.
    getTaskSourceChanges: () => new Promise(() => {}),
    getWorkspaceDiff: (...args: unknown[]) => getWorkspaceDiff(...args),
  };
});

const CWD = "/Users/owner/project";

Element.prototype.scrollIntoView = vi.fn();

/** Seven files, +128 / −56 in all — the shape the summary line has to read. */
const SEVEN: ChangedFile[] = [20, 20, 20, 20, 20, 20, 8].map((additions, index) => ({
  path: `${CWD}/src/f${index + 1}.ts`,
  action: "write" as const,
  tool: "claude-code",
  seq: index + 1,
  additions,
  deletions: 8,
}));

/**
 * The record that marks where the current round began: the daemon writes the
 * previous round's record when the next turn captures its checkpoint, and
 * `to_seq` is the seq that closed it. Its file list describes the *previous*
 * round, so the panel does not read it — only the boundary.
 */
function roundBoundary(toSeq: number, seq = 5): TaskEvent {
  return {
    task_id: "task-1",
    event_epoch: 1,
    seq,
    ts: 1,
    type: "round_changed",
    payload: { from_seq: 1, to_seq: toSeq, total: 0, files: [] },
  };
}

/** The user message that opened the current round. */
function userMessage(seq = 10): TaskEvent {
  return {
    task_id: "task-1",
    event_epoch: 1,
    seq,
    ts: seq,
    type: "message",
    payload: { role: "user", speaker: "user", content: [{ type: "text", text: "go" }] },
  };
}

/** A file write the agent made in the current round, after the boundary. */
function toolWrite(seq: number, path: string): TaskEvent {
  return {
    task_id: "task-1",
    event_epoch: 1,
    seq,
    ts: seq,
    type: "tool_use",
    payload: { name: "write_file", input: { path, content: "x\n" } },
  };
}

/**
 * A current round that wrote the given workspace-relative paths. The boundary
 * is the user message, which is all a shared checkout ever has: the daemon
 * writes `round_changed` only for worktree tasks.
 */
function currentRound(paths: string[]): TaskEvent[] {
  return [userMessage(), ...paths.map((path, index) => toolWrite(11 + index, path))];
}

function renderPanel(
  props: {
    changedFiles?: ChangedFile[];
    events?: TaskEvent[];
    selectedWorkspaceId?: string | null;
    /** Which of the panel's surfaces is in front. */
    surface?: "files" | "pr" | "publish";
    /** The pull-request body the panel shows when `surface` is `"pr"`. */
    prPane?: ReactNode;
    /** The publish body the panel shows when `surface` is `"publish"`. */
    publishPane?: ReactNode;
    onOpenPr?: () => void;
    /** Defining it is what puts the publish tab in the strip. */
    onOpenPublish?: () => void;
    onShowFiles?: () => void;
    onClose?: () => void;
  } = {},
) {
  // Spies the assertions can read; an injected handler still wins.
  const onOpenPr = vi.fn(props.onOpenPr ?? (() => {}));
  const onShowFiles = vi.fn(props.onShowFiles ?? (() => {}));
  const view = render(
    // The tab strip is Astryx's surface behind the Kin facade, the way the
    // console mounts it.
    <AstryxProvider>
      <WorkspacePanel
        taskId="task-1"
        cwd={CWD}
        changedFiles={props.changedFiles ?? SEVEN}
        events={props.events ?? []}
        selectedWorkspaceId={props.selectedWorkspaceId}
        onClose={props.onClose}
        surface={props.surface}
        prPane={props.prPane}
        publishPane={props.publishPane}
        onOpenPr={onOpenPr}
        onOpenPublish={props.onOpenPublish}
        onShowFiles={onShowFiles}
      />
    </AstryxProvider>,
  );
  return { ...view, onOpenPr, onShowFiles };
}

const tabs = () => screen.getAllByRole("tab");
const summary = () => screen.queryByTestId("workspace-turn-summary");

beforeEach(() => {
  // The lens is store state, so a pick belongs to the tree, not to the last test.
  useAppStore.setState({ lensPick: null });
  getWorkspaceDiff.mockReset();
  getWorkspaceDiff.mockResolvedValue({ changes: [] });
});

describe("one shared tab set", () => {
  it("renders one tab set: changes, files and PR, and no second strip", () => {
    renderPanel();

    // One tablist for the panel: the lenses and the pull request are the only
    // things that are tabs — the PR is a tab of this panel, not a second sheet.
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    const rows = tabs();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain(t("workspace.tabChanges"));
    expect(rows[1]?.textContent).toContain(t("workspace.tabFiles"));
    expect(rows[2]?.textContent).toContain(t("pr.title"));

    // The strip is `ui/Tabs`, not another hand-written one: the facade's own
    // class contract sits on the tablist (or its own wrapper) inside the
    // facade's `min-w-0` root, so the assertion survives Astryx moving the
    // class one node without the strip stopping being this primitive.
    const strip = screen.getByRole("tablist");
    expect(strip.closest(".overflow-x-auto")).toBeTruthy();

    // And no raw `role="tab"` button survives in the source — the local
    // `TabButton` was deleted, not left behind unused.
    expect(panelSource).toContain("<Tabs");
    expect(panelSource).not.toContain("TabButton");
    expect(panelSource).not.toMatch(/<button[^>]*role="tab"/);
  });

  it("selecting a tab still picks the lens", async () => {
    renderPanel();

    const tree = tabs()[1]!;
    fireEvent.click(tree);

    await waitFor(() => expect(tree.getAttribute("aria-selected")).toBe("true"));
    // The same pick the old buttons made: one place, one lens.
    expect(useAppStore.getState().lensPick).toEqual({
      taskId: "task-1",
      view: "source",
      lens: "files",
    });
    // …and the content follows the lens: the change list is gone.
    await waitFor(() => expect(screen.queryByTitle(SEVEN[0]!.path)).toBeNull());

    const changes = tabs()[0]!;
    fireEvent.click(changes);

    await waitFor(() => expect(changes.getAttribute("aria-selected")).toBe("true"));
    expect(useAppStore.getState().lensPick).toEqual({
      taskId: "task-1",
      view: "source",
      lens: "changes",
    });
    await waitFor(() => expect(screen.getByTitle(SEVEN[0]!.path)).toBeTruthy());
  });

  it("keeps the disabled Changes tab when there is nothing to show", () => {
    renderPanel({ changedFiles: [] });

    const [changes, tree] = tabs();
    expect(changes?.getAttribute("aria-disabled")).toBe("true");
    expect(tree?.getAttribute("aria-selected")).toBe("true");

    // A disabled tab is inert: clicking it does not pick a lens.
    fireEvent.click(changes!);
    expect(useAppStore.getState().lensPick).toBeNull();
    expect(tree?.getAttribute("aria-selected")).toBe("true");
  });

  it("shows the PR pane and marks the PR tab selected when the surface is the pull request", () => {
    renderPanel({
      surface: "pr",
      prPane: <div data-testid="pr-pane">pull request body</div>,
    });

    // The PR body is the panel's content, in the same container as the lenses.
    expect(screen.getByTestId("pr-pane")).toBeTruthy();
    // …and the strip says where the reader is.
    const [changes, tree, pr] = tabs();
    expect(pr?.getAttribute("aria-selected")).toBe("true");
    expect(changes?.getAttribute("aria-selected")).not.toBe("true");
    expect(tree?.getAttribute("aria-selected")).not.toBe("true");
    // The lens strip is still the one strip; no second one appears for PR.
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });

  it("publish is the fourth tab beside changes, files and pr", () => {
    renderPanel({
      surface: "publish",
      onOpenPublish: () => {},
      publishPane: <div data-testid="publish-pane">publish body</div>,
    });

    // One strip, four tabs — the two lenses, the read-only pull request and
    // publish — and the tab says where the reader is.
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    const rows = tabs();
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain(t("workspace.tabChanges"));
    expect(rows[1]?.textContent).toContain(t("workspace.tabFiles"));
    expect(rows[2]?.textContent).toContain(t("pr.title"));
    expect(rows[3]?.textContent).toContain(t("publish.title"));
    expect(rows[3]?.getAttribute("aria-selected")).toBe("true");

    // The publish body is the panel's own content, under this panel's strip —
    // not a second surface of its own. WorkspacePanel draws no landmark, so the
    // one `PanelSurface` the page mounts stays the only one.
    const pane = screen.getByTestId("publish-pane");
    expect(pane.closest('[role="complementary"]')).toBeNull();
    expect(screen.queryAllByRole("complementary")).toHaveLength(0);
    expect(
      screen.getByRole("tablist").compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("asks for the publish surface when the publish tab is picked", () => {
    const onOpenPublish = vi.fn();
    renderPanel({ onOpenPublish });

    fireEvent.click(tabs()[3]!);

    // The page owns the panel address, so the tab asks rather than flipping
    // anything here — the same contract the PR tab has.
    expect(onOpenPublish).toHaveBeenCalledTimes(1);
  });

  it("asks for the files surface and keeps the remembered lens when a lens tab is picked from PR", () => {
    // A lens was picked earlier in this place; going through PR must not erase
    // it — the tabs are views of one panel, and the pick is the place's memory.
    useAppStore.setState({
      lensPick: { taskId: "task-1", view: "source", lens: "files" },
    });
    const { onShowFiles } = renderPanel({
      surface: "pr",
      prPane: <div data-testid="pr-pane" />,
    });

    fireEvent.click(tabs()[0]!);

    // The page owns the panel address, so the panel asks rather than flips it.
    expect(onShowFiles).toHaveBeenCalledTimes(1);
    // The new lens is the one remembered for this place, not a per-tab map.
    expect(useAppStore.getState().lensPick).toEqual({
      taskId: "task-1",
      view: "source",
      lens: "changes",
    });
  });

  it("keeps PR available when there are no changes, and the Changes tab disabled", () => {
    const { onOpenPr } = renderPanel({ changedFiles: [] });

    const [changes, , pr] = tabs();
    expect(changes?.getAttribute("aria-disabled")).toBe("true");
    expect(pr?.getAttribute("aria-disabled")).not.toBe("true");

    // The PR tab is how the page is asked for that surface.
    fireEvent.click(pr!);
    expect(onOpenPr).toHaveBeenCalledTimes(1);
  });

  it("keeps the keyboard on the selected tab when a surface switch rebuilds the strip", async () => {
    // The strip moves to a different parent on the PR surface, so the tab that
    // had focus is unmounted. A keyboard user must land on the tab that is now
    // selected — otherwise the panel has lost them and Escape no longer closes.
    const onClose = vi.fn();
    function SurfaceSwitch() {
      const [surface, setSurface] = useState<"files" | "pr">("files");
      return (
        <AstryxProvider>
          <WorkspacePanel
            taskId="task-1"
            cwd={CWD}
            changedFiles={SEVEN}
            events={[]}
            surface={surface}
            prPane={<div data-testid="pr-pane" />}
            onOpenPr={() => setSurface("pr")}
            onShowFiles={() => setSurface("files")}
            onClose={onClose}
          />
        </AstryxProvider>
      );
    }
    render(<SurfaceSwitch />);

    const tree = tabs()[1]!;
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowRight" });

    await waitFor(() => expect(screen.getByTestId("pr-pane")).toBeTruthy());
    const prTab = tabs().find((tab) => tab.getAttribute("aria-selected") === "true");
    expect(prTab?.textContent).toContain(t("pr.title"));
    await waitFor(() => expect(document.activeElement).toBe(prTab));

    // Focus is inside the panel again, so Escape still unwinds it.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pr to publish to files keeps one strip and one close", async () => {
    function SurfaceSwitch() {
      const [surface, setSurface] = useState<"files" | "pr" | "publish">("pr");
      return (
        <AstryxProvider>
          <WorkspacePanel
            taskId="task-1"
            cwd={CWD}
            changedFiles={SEVEN}
            events={[]}
            surface={surface}
            prPane={<div data-testid="pr-pane" />}
            publishPane={<div data-testid="publish-pane" />}
            onOpenPr={() => setSurface("pr")}
            onOpenPublish={() => setSurface("publish")}
            onShowFiles={() => setSurface("files")}
            onClose={vi.fn()}
          />
        </AstryxProvider>
      );
    }
    render(<SurfaceSwitch />);

    // PR in front: one strip, one close.
    expect(tabs()).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: t("pr.close") })).toHaveLength(1);

    // PR -> publish: the same strip and the same close, a different body.
    fireEvent.click(tabs()[3]!);
    await waitFor(() => expect(screen.getByTestId("publish-pane")).toBeTruthy());
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(tabs()).toHaveLength(4);
    expect(tabs()[3]?.getAttribute("aria-selected")).toBe("true");
    // The one close says what it closes: the publish panel now, not the files
    // panel the reader came from.
    expect(screen.getAllByRole("button", { name: t("publish.close") })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: t("pr.close") })).toBeNull();

    // publish -> files: one tab switch, the lens is picked, and the panel's
    // body is the lenses' again — nothing was closed and reopened.
    fireEvent.click(tabs()[1]!);
    await waitFor(() => expect(screen.queryByTestId("publish-pane")).toBeNull());
    expect(useAppStore.getState().lensPick).toEqual({
      taskId: "task-1",
      view: "source",
      lens: "files",
    });
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(tabs()).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: t("workspace.close") })).toHaveLength(1);
  });
});

describe("the turn summary", () => {
  it("leads with a turn summary above the file list", () => {
    renderPanel();

    const line = summary();
    expect(line).toBeTruthy();
    // The sentence is one line: how much, and how many files.
    const text = line?.textContent ?? "";
    expect(text).toContain("7");
    expect(text).toContain("128");
    expect(text).toContain("56");
    // It belongs to the list, not to the tab strip: an action inside a
    // tablist reads as a third tab.
    expect(line?.closest('[role="tablist"]')).toBeNull();
    // Above the list it summarizes.
    const firstRow = screen.getByTitle(SEVEN[0]!.path);
    expect(line!.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The tab counts what the list holds.
    expect(tabs()[0]?.textContent).toContain("7");
  });

  it("keeps the summary out of the way when the tree is showing", async () => {
    renderPanel();

    fireEvent.click(tabs()[1]!);

    await waitFor(() => expect(summary()).toBeNull());
  });
});

// The scope control only exists when the stream carries a turn boundary the
// list can honour. The panel's events do carry one — the user message that
// opened the current round, and on a worktree task the daemon's `round_changed`
// record naming the same seq — so the round scope is offered; a stream without
// one offers nothing, because a control that cannot change the list is worse
// than no control.
describe("the scope control", () => {
  it("offers no scope when the stream has no round boundary", () => {
    renderPanel();

    expect(summary()).toBeTruthy();
    expect(screen.queryByRole("button", { name: t("chat.evidence.title") })).toBeNull();
  });

  it("narrows the list to the current round and back", async () => {
    // The tools name paths relative to the checkout; the list holds absolute
    // ones. The scope compares them in the workspace's own form, exactly: the
    // round wrote the root "README.md", and "docs/README.md" is not that file.
    const decoy: ChangedFile = {
      path: `${CWD}/docs/README.md`,
      action: "write",
      tool: "claude-code",
      seq: 8,
      additions: 1,
      deletions: 0,
    };
    renderPanel({
      changedFiles: [...SEVEN, decoy],
      events: currentRound(["src/f1.ts", "src/f2.ts", "src/f3.ts", "README.md"]),
    });

    const all = screen.getByRole("button", { name: t("workspace.tabChanges") });
    const turn = screen.getByRole("button", { name: t("chat.evidence.title") });
    // All changes is what the list already shows, so it starts pressed.
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(turn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(turn);

    expect(turn.getAttribute("aria-pressed")).toBe("true");
    // The list is the three files this round touched under src/, and the
    // summary agrees.
    await waitFor(() => expect(screen.queryByTitle(SEVEN[6]!.path)).toBeNull());
    expect(screen.queryByTitle(decoy.path)).toBeNull();
    expect(screen.getByTitle(SEVEN[0]!.path)).toBeTruthy();
    expect(screen.getByTitle(SEVEN[2]!.path)).toBeTruthy();
    const text = summary()?.textContent ?? "";
    expect(text).toContain("3");
    expect(text).toContain("60");
    expect(text).toContain("24");
    expect(tabs()[0]?.textContent).toContain("3");

    fireEvent.click(all);

    expect(all.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(screen.getByTitle(SEVEN[6]!.path)).toBeTruthy());
    expect(screen.getByTitle(decoy.path)).toBeTruthy();
    expect(summary()?.textContent ?? "").toContain("8");
  });

  it("reads the daemon's recorded boundary when there is one", () => {
    // A worktree task's stream has the record as well as the user message; the
    // newest boundary wins either way.
    renderPanel({
      events: [userMessage(10), roundBoundary(10, 11), toolWrite(12, "src/f1.ts")],
    });

    expect(screen.getByRole("button", { name: t("chat.evidence.title") })).toBeTruthy();
  });

  it("closes a file the round scope leaves out and returns to the list", async () => {
    renderPanel({ events: currentRound(["src/f1.ts", "src/f2.ts", "src/f3.ts"]) });

    // Open the newest file, which this round did not touch.
    fireEvent.click(screen.getByTitle(SEVEN[6]!.path));
    await waitFor(() => expect(screen.getByTestId("code-viewer").textContent).toBe(SEVEN[6]!.path));

    fireEvent.click(screen.getByRole("button", { name: t("chat.evidence.title") }));

    // The list is the answer to the press: a file outside the scope has no row,
    // so it must not keep its viewer (or its keep/discard controls) either.
    await waitFor(() => expect(screen.queryByTestId("code-viewer")).toBeNull());
    expect(screen.getByText(t("workspace.viewer.empty"))).toBeTruthy();
    expect(screen.getByTitle(SEVEN[0]!.path)).toBeTruthy();
    expect(screen.queryByTitle(SEVEN[6]!.path)).toBeNull();
    // Focus is inside the list, not on the <body> the closed pane left behind:
    // the back control was the focused element on a phone.
    await waitFor(() => expect(document.activeElement).toBe(tabs()[0]));
  });

  it("keeps the open file when the round includes it", async () => {
    renderPanel({ events: currentRound(["src/f1.ts", "src/f2.ts", "src/f3.ts"]) });

    fireEvent.click(screen.getByTitle(SEVEN[0]!.path));
    await waitFor(() => expect(screen.getByTestId("code-viewer").textContent).toBe(SEVEN[0]!.path));

    fireEvent.click(screen.getByRole("button", { name: t("chat.evidence.title") }));

    await waitFor(() => expect(screen.queryByTitle(SEVEN[6]!.path)).toBeNull());
    expect(screen.getByTestId("code-viewer").textContent).toBe(SEVEN[0]!.path);
  });

  it("offers no scope when the round covers the whole list", () => {
    // Two scopes that show the same list are one control too many.
    const every = SEVEN.map((file) => file.path.replace(`${CWD}/`, ""));
    renderPanel({ events: currentRound(every) });

    expect(summary()).toBeTruthy();
    expect(screen.queryByRole("button", { name: t("chat.evidence.title") })).toBeNull();
  });

  it("offers no scope over a snapshot", async () => {
    // A generation's diff is a snapshot of one round, not the checkout's live
    // list; "this round" is a fact about the checkout, so the scope stays off.
    getWorkspaceDiff.mockResolvedValue({
      changes: [
        { path: "src/f1.ts", status: "modified", additions: 20, deletions: 8 },
        { path: "src/f2.ts", status: "modified", additions: 20, deletions: 8 },
        { path: "src/f3.ts", status: "modified", additions: 20, deletions: 8 },
        { path: "src/f4.ts", status: "modified", additions: 8, deletions: 8 },
      ],
    });
    renderPanel({
      changedFiles: [],
      events: currentRound(["src/f1.ts", "src/f2.ts"]),
      selectedWorkspaceId: "gen-1",
    });

    await waitFor(() => expect(summary()).toBeTruthy());
    expect(screen.queryByRole("button", { name: t("chat.evidence.title") })).toBeNull();
  });
});

describe("the summary without line counts", () => {
  it("says the size is unknown instead of ±0", () => {
    // A bodyless delete is a changed file whose counts nobody sent; drawing
    // "±0" would claim it changed by nothing.
    renderPanel({
      changedFiles: [{ path: `${CWD}/src/gone.ts`, action: "delete", tool: "claude-code", seq: 1 }],
    });

    expect(summary()?.textContent ?? "").toContain(t("workspace.changed.noLineDelta"));
  });
});
