// @vitest-environment jsdom
// KIN-RESULT-003 — the tray's contract at the panel boundary: every queued
// comment leaves as one ordinary follow-up, a failed send keeps all of them,
// and a tray belongs to one conversation. The page owns the send path, so the
// panel is rendered with `onSendFollowUp` mocked exactly where
// TaskDetailPage wires it to the composer's follow-up.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { t } from "../../i18n";
import type { TaskEvent } from "../../api/client";
import type { ChangedFile } from "../../lib/changedFiles";
import { useAppStore } from "../../store/appStore";
import { AstryxProvider } from "../../design/AstryxProvider";
import type { DiffComment } from "./diffCommentAnchor";
import WorkspacePanel from "./WorkspacePanel";

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
const TASK = "task-1";
const STORAGE_KEY = `kin.diffComments.${TASK}`;

Element.prototype.scrollIntoView = vi.fn();

const FILES: ChangedFile[] = ["src/f1.ts", "src/f2.ts"].map((path, index) => ({
  path: `${CWD}/${path}`,
  action: "write" as const,
  tool: "claude-code",
  seq: index + 1,
  additions: 3,
  deletions: 1,
}));

// Three comments over two files, in stored order. Distinct hunk headers and
// quotes let the message assertion prove each block carries its own anchor
// rather than one shared or dropped header.
const COMMENTS: DiffComment[] = [
  {
    id: "comment-1",
    path: "src/f1.ts",
    hunkHeader: "@@ -10,3 +10,3 @@",
    quote: "const answer = 42;",
    line: 12,
    text: "why 42?",
    createdAt: 1,
  },
  {
    id: "comment-2",
    path: "src/f1.ts",
    hunkHeader: "@@ -40,2 +41,3 @@",
    quote: "return answer;",
    line: 43,
    text: "return the named constant instead.",
    createdAt: 2,
  },
  {
    id: "comment-3",
    path: "src/f2.ts",
    hunkHeader: "@@ -1,2 +1,2 @@",
    quote: "export const x = 1;",
    line: 2,
    text: "give this a name that says what it is.",
    createdAt: 3,
  },
];

/** The one message the page must receive, spelled out without the formatter. */
function expectedMessage(): string {
  const intro = t("workspace.comments.messageIntro");
  const blocks = COMMENTS.map(
    (comment) =>
      `${comment.path}:${comment.line}\n${comment.hunkHeader}\n> ${comment.quote}\n\n${comment.text}`,
  );
  return [intro, ...blocks].join("\n\n");
}

const EVENTS: TaskEvent[] = [];

function renderPanel(
  props: {
    taskId?: string;
    onSendFollowUp?: (text: string) => Promise<void>;
  } = {},
): ReturnType<typeof render> {
  return render(
    <AstryxProvider>
      <WorkspacePanel
        taskId={props.taskId ?? TASK}
        cwd={CWD}
        changedFiles={FILES}
        events={EVENTS}
        onSendFollowUp={props.onSendFollowUp}
      />
    </AstryxProvider>,
  );
}

const tray = () => screen.queryByLabelText(t("workspace.comments.trayTitle"));

/** The tray starts expanded; this only runs if that ever changes. */
function expandTrayIfCollapsed(count: number): void {
  if (tray()) return;
  const show = screen.queryByRole("button", {
    name: t("workspace.comments.showTray", { count }),
  });
  if (show) fireEvent.click(show);
}

function sendButton(count: number): HTMLElement {
  return screen.getByRole("button", {
    name: t("workspace.comments.send", { count }),
  });
}

function seed(comments: DiffComment[] = COMMENTS): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(comments));
}

function storedComments(key: string): DiffComment[] | null {
  const raw = localStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as DiffComment[]);
}

beforeEach(() => {
  // The lens is store state, so a pick belongs to the tree, not to the last test.
  useAppStore.setState({ lensPick: null });
  localStorage.clear();
  api.readTaskSourceFile.mockClear();
  api.readWorkspaceFile.mockClear();
});

describe("KIN-RESULT-003 · sending the tray back to the conversation", () => {
  it("sends the tray as one follow-up carrying every path, hunk and quoted line", async () => {
    seed();
    const onSendFollowUp = vi.fn(async (_text: string) => {});
    renderPanel({ onSendFollowUp });

    expandTrayIfCollapsed(COMMENTS.length);
    fireEvent.click(sendButton(COMMENTS.length));

    await waitFor(() => expect(onSendFollowUp).toHaveBeenCalledTimes(1));
    const message = onSendFollowUp.mock.calls[0]![0] as string;
    expect(message.startsWith(t("workspace.comments.messageIntro"))).toBe(true);
    // One ordinary message: intro, then one paragraph per comment in stored
    // order, each with its own path:line, hunk header, quote and words.
    expect(message).toBe(expectedMessage());

    // A delivered send empties the conversation's store...
    await waitFor(() => expect(storedComments(STORAGE_KEY) ?? []).toHaveLength(0));
    // ...says so where the tray was...
    expect(await screen.findByText(t("workspace.comments.sent"))).toBeTruthy();
    // ...and leaves no row behind.
    expect(tray()).toBeNull();
    for (const comment of COMMENTS) {
      expect(
        screen.queryByRole("button", {
          name: t("workspace.comments.jumpToRow", {
            path: comment.path,
            line: comment.line,
          }),
        }),
      ).toBeNull();
    }
  });

  it("a failed send keeps every comment and says so", async () => {
    seed();
    const onSendFollowUp = vi.fn(async (_text: string) => {
      throw new Error("offline");
    });
    renderPanel({ onSendFollowUp });

    expandTrayIfCollapsed(COMMENTS.length);
    fireEvent.click(sendButton(COMMENTS.length));

    expect(await screen.findByText(t("workspace.comments.sendFailed"))).toBeTruthy();
    // Nothing was delivered, so nothing may be dropped: same store, same rows.
    expect(storedComments(STORAGE_KEY)).toEqual(COMMENTS);
    for (const comment of COMMENTS) {
      expect(
        screen.getByRole("button", {
          name: t("workspace.comments.jumpToRow", {
            path: comment.path,
            line: comment.line,
          }),
        }),
      ).toBeTruthy();
    }

    // The button is the retry, and the retry sends the same words again.
    fireEvent.click(sendButton(COMMENTS.length));
    await waitFor(() => expect(onSendFollowUp).toHaveBeenCalledTimes(2));
    expect(onSendFollowUp.mock.calls[1]).toEqual(onSendFollowUp.mock.calls[0]);
    expect(onSendFollowUp.mock.calls[1]![0]).toBe(expectedMessage());
  });

  it("comments belong to one conversation", () => {
    seed();

    const other = renderPanel({ taskId: "task-2" });
    // Another conversation's key is empty, so this panel shows no tray at all.
    expect(tray()).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: t("workspace.comments.send", { count: COMMENTS.length }),
      }),
    ).toBeNull();
    // Reading task-2 never rewrites task-1's store.
    expect(storedComments(STORAGE_KEY)).toEqual(COMMENTS);
    other.unmount();

    // Back in the conversation that owns them, the same three rows return.
    renderPanel({ taskId: TASK });
    expect(tray()).toBeTruthy();
    expect(sendButton(COMMENTS.length)).toBeTruthy();
    for (const comment of COMMENTS) {
      expect(
        screen.getByRole("button", {
          name: t("workspace.comments.jumpToRow", {
            path: comment.path,
            line: comment.line,
          }),
        }),
      ).toBeTruthy();
    }
  });

  it("an empty tray is not a panel", () => {
    renderPanel({ onSendFollowUp: vi.fn(async () => {}) });

    expect(tray()).toBeNull();
    // No count of zero, no disabled send, no sent acknowledgement.
    expect(screen.queryByText(t("workspace.comments.showTray", { count: 0 }))).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: t("workspace.comments.send", { count: 0 }),
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: t("workspace.comments.send", { count: 1 }) }),
    ).toBeNull();
    expect(screen.queryByText(t("workspace.comments.sent"))).toBeNull();
  });
});
