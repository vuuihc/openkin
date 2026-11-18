// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_LOCALE, setLocale, t } from "../../i18n";
import type { TaskWorkspaceFileResponse } from "../../api/client";

/**
 * The viewer's header is a row of actions, and every one of them is an action:
 * two layout toggles, two hunk steps, two markdown toggles, discard, keep and
 * save. They belong on the console's one button facade so they inherit its
 * focus ring, its disabled treatment, its phone touch floor and the same
 * approve/secondary/default weights the rest of the console draws — not three
 * hand-copied `.kin-btn-*` strings and a local focus outline.
 */

const mocks = vi.hoisted(() => ({
  writeTaskWorkspaceFile: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  goToDiff: vi.fn(),
}));

/**
 * The pieces of the editor the comment path reads. Monaco cannot run in
 * jsdom, so the stub below records the handlers the viewer registers and the
 * tests drive them the way a tap would.
 */
const editorState = vi.hoisted(() => ({
  lineChanges: [] as {
    originalStartLineNumber: number;
    originalEndLineNumber: number;
    modifiedStartLineNumber: number;
    modifiedEndLineNumber: number;
  }[],
  lineText: {} as Record<number, string>,
  /** The modified model's full contents, 0-based like `getLinesContent()`. */
  lines: [] as string[],
  cursorHandler: null as ((event: { position: { lineNumber: number } }) => void) | null,
  mouseDownHandler: null as
    ((event: { target: { type: number; position?: { lineNumber: number } } }) => void) | null,
  /** `onDidUpdateDiff`'s handler — fired when a rerun changes the diff. */
  diffHandler: null as (() => void) | null,
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    writeTaskWorkspaceFile: mocks.writeTaskWorkspaceFile,
    writeWorkspaceFile: mocks.writeWorkspaceFile,
  };
});

vi.mock("./monacoSetup", () => ({}));

/**
 * Monaco cannot run in jsdom. The header is the subject here, so the two
 * editor surfaces only have to be identifiable; the plain one takes typing so
 * the save path can be exercised the way a reader would trigger it.
 */
vi.mock("@monaco-editor/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    default: ({ value, onChange }: { value?: string; onChange?: (value: string) => void }) => (
      <textarea
        data-testid="editor"
        value={value ?? ""}
        onChange={(event) => onChange?.(event.target.value)}
      />
    ),
    DiffEditor: (props: {
      modified?: string;
      options?: { renderSideBySide?: boolean };
      onMount?: (editor: unknown, monaco: unknown) => void;
    }) => {
      // The viewer wires its comment gutter from onMount — line changes,
      // cursor and click events, the ⌥C command. Monaco mounts after the
      // first render, and the stub carries every method that path touches so
      // the real component runs unmodified against it. The mount is deferred
      // for the same reason: the viewer resets its line changes in a
      // `[path]` effect on mount, and real Monaco reports its diff only after
      // that effect has run.
      const { onMount } = props;
      React.useEffect(() => {
        const disposable = { dispose: () => {} };
        let timer: number | undefined;
        const modifiedEditor = {
          createDecorationsCollection: () => ({ clear: () => {}, set: () => {} }),
          onDidChangeCursorPosition: (
            handler: (event: { position: { lineNumber: number } }) => void,
          ) => {
            editorState.cursorHandler = handler;
            return disposable;
          },
          onMouseDown: (
            handler: (event: {
              target: { type: number; position?: { lineNumber: number } };
            }) => void,
          ) => {
            editorState.mouseDownHandler = handler;
            return disposable;
          },
          addCommand: () => {},
          getModel: () => ({
            getLineContent: (line: number) => editorState.lineText[line] ?? "",
            getLinesContent: () => editorState.lines,
          }),
          getPosition: () => null,
          // Real Monaco moves the cursor and emits the same change event; the
          // viewer's opening auto-select goes through this one path.
          setPosition: (position: { lineNumber: number; column: number }) => {
            editorState.cursorHandler?.({ position });
          },
        };
        timer = window.setTimeout(() => {
          // The viewer's diff editor owns its models now (see
          // `OwnedDiffEditor`), so the stub exposes the two calls that
          // ownership uses.
          const model = { dispose: () => {}, isDisposed: () => false };
          onMount?.(
            {
              getModel: () => ({ original: model, modified: model }),
              setModel: () => {},
              getModifiedEditor: () => modifiedEditor,
              getLineChanges: () => editorState.lineChanges,
              onDidUpdateDiff: (handler: () => void) => {
                editorState.diffHandler = handler;
                return disposable;
              },
              onDidDispose: () => disposable,
              goToDiff: mocks.goToDiff,
            },
            {
              Range: class {},
              editor: { MouseTargetType: { GUTTER_GLYPH_MARGIN: 6 } },
              KeyMod: { Alt: 1 },
              KeyCode: { KeyC: 1 },
            },
          );
        }, 0);
        // Mount once, like Monaco itself.
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return (
        <div data-testid="diff-editor" data-side-by-side={String(props.options?.renderSideBySide)}>
          {props.modified}
        </div>
      );
    },
  };
});

import CodeViewer from "./CodeViewer";

function textFile(name: string, content: string): TaskWorkspaceFileResponse {
  return { root: "/work", path: name, size: content.length, truncated: false, content };
}

function diffSurface(actionsBusy: boolean, onDiscard: () => void, onKeep: () => void) {
  return (
    <CodeViewer
      path="a.ts"
      file={null}
      loading={false}
      error={null}
      diff={{ path: "a.ts", original: "one", modified: "two", source: "write" }}
      reviewActions
      actionsBusy={actionsBusy}
      onDiscard={onDiscard}
      onKeep={onKeep}
    />
  );
}

beforeEach(() => {
  setLocale("en");
  mocks.writeTaskWorkspaceFile.mockReset();
  mocks.writeWorkspaceFile.mockReset();
  mocks.goToDiff.mockReset();
  mocks.writeTaskWorkspaceFile.mockResolvedValue(textFile("a.ts", "const a = 1;x"));
  editorState.lineChanges = [];
  editorState.lineText = {};
  editorState.lines = [];
  editorState.cursorHandler = null;
  editorState.mouseDownHandler = null;
  editorState.diffHandler = null;
});

afterEach(() => {
  setLocale(DEFAULT_LOCALE);
});

describe("the code viewer's action row", () => {
  it("puts the viewer's toggles and actions on the shared facade", async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();
    const onKeep = vi.fn();

    const diff = render(diffSurface(true, onDiscard, onKeep));

    // -- The two diff-layout toggles: one quiet weight, their pressed state and
    //    their click behaviour intact.
    const inline = screen.getByRole("button", { name: t("workspace.viewer.diffInline") });
    const sideBySide = screen.getByRole("button", {
      name: t("workspace.viewer.diffSideBySide"),
    });
    for (const toggle of [inline, sideBySide]) {
      expect(toggle.className).toContain("kin-btn");
      expect(toggle.className).toContain("text-caption");
      expect(toggle.className).not.toContain("kin-btn-primary");
    }
    expect(inline.getAttribute("aria-pressed")).toBe("true");
    expect(inline.getAttribute("title")).toBe(t("workspace.viewer.diffInline"));
    expect(screen.getByTestId("diff-editor").getAttribute("data-side-by-side")).toBe("false");

    await user.click(sideBySide);
    expect(sideBySide.getAttribute("aria-pressed")).toBe("true");
    expect(inline.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("diff-editor").getAttribute("data-side-by-side")).toBe("true");

    // -- The two hunk steps keep their names and still move the diff.
    const previous = screen.getByRole("button", { name: t("workspace.viewer.prevHunk") });
    const next = screen.getByRole("button", { name: t("workspace.viewer.nextHunk") });
    expect(previous.className).toContain("kin-btn");
    expect(next.className).toContain("kin-btn");
    expect(previous.getAttribute("title")).toBe(t("workspace.viewer.prevHunk"));

    await user.click(previous);
    await user.click(next);
    expect(mocks.goToDiff.mock.calls).toEqual([["previous"], ["next"]]);

    // -- Discard is the bordered peer; keep is the one filled action.
    const discard = screen.getByRole("button", {
      name: t("workspace.changed.discard"),
    }) as HTMLButtonElement;
    const keep = screen.getByRole("button", {
      name: t("workspace.changed.keep"),
    }) as HTMLButtonElement;
    expect(discard.className).toContain("kin-btn-secondary");
    expect(keep.className).toContain("kin-btn-primary");
    // The 12px icon and the label share Astryx's label span; without the flex
    // selector each action becomes a two-line, taller button (jsdom has no
    // layout, so the class is the pin).
    for (const action of [discard, keep]) {
      expect(action.className).toContain("[&>span>span]:flex");
      expect(action.className).toContain("[&>span>span]:items-center");
    }
    expect(discard.getAttribute("title")).toBe(t("workspace.changed.discardHint"));
    expect(keep.getAttribute("title")).toBe(t("workspace.changed.keepHint"));

    // A busy review disables both, and a click runs nothing.
    expect(discard.disabled).toBe(true);
    expect(keep.disabled).toBe(true);
    await user.click(discard);
    await user.click(keep);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onKeep).not.toHaveBeenCalled();

    diff.rerender(diffSurface(false, onDiscard, onKeep));
    await user.click(screen.getByRole("button", { name: t("workspace.changed.discard") }));
    await user.click(screen.getByRole("button", { name: t("workspace.changed.keep") }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onKeep).toHaveBeenCalledTimes(1);
    diff.unmount();

    // -- The markdown view toggles keep their pressed pairing.
    const markdown = render(
      <CodeViewer
        path="README.md"
        file={textFile("README.md", "# Hi")}
        loading={false}
        error={null}
      />,
    );
    const preview = screen.getByRole("button", { name: t("workspace.viewer.preview") });
    const code = screen.getByRole("button", { name: t("workspace.viewer.code") });
    expect(preview.className).toContain("kin-btn");
    expect(code.className).toContain("kin-btn");
    expect(preview.getAttribute("aria-pressed")).toBe("true");

    await user.click(code);
    expect(code.getAttribute("aria-pressed")).toBe("true");
    expect(preview.getAttribute("aria-pressed")).toBe("false");
    markdown.unmount();

    // -- Save is the plain view's one filled action and still writes the file.
    const onSaved = vi.fn();
    render(
      <CodeViewer
        path="a.ts"
        file={textFile("a.ts", "const a = 1;")}
        loading={false}
        error={null}
        editable
        taskId="task-1"
        onSaved={onSaved}
      />,
    );
    const save = screen.getByRole("button", {
      name: t("workspace.viewer.save"),
    }) as HTMLButtonElement;
    expect(save.className).toContain("kin-btn-primary");
    expect(save.className).toContain("[&>span>span]:flex");
    expect(save.disabled).toBe(true);

    await user.type(screen.getByTestId("editor"), "x");
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mocks.writeTaskWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeTaskWorkspaceFile).toHaveBeenCalledWith("task-1", "a.ts", "const a = 1;x");
  });

  /**
   * The diff surface has one filled action at a time. `保留` is it while the
   * person is reviewing the file; once comments are queued, the tray's send is
   * the next step and keep steps back so the two blue buttons cannot compete.
   */
  it("steps keep back to a bordered peer while comments are queued", () => {
    render(
      <CodeViewer
        path="a.ts"
        file={null}
        loading={false}
        error={null}
        diff={{ path: "a.ts", original: "one", modified: "two", source: "write" }}
        reviewActions
        reviewPrimary={false}
        onDiscard={vi.fn()}
        onKeep={vi.fn()}
      />,
    );

    const keep = screen.getByRole("button", { name: t("workspace.changed.keep") });
    expect(keep.className).toContain("kin-btn-secondary");
    expect(keep.className).not.toContain("kin-btn-primary");
  });

  /**
   * `保留` belongs on the file's own row. In a 380px pane the old single
   * wrapping row pushed it alone onto a third header line; the diff paid for
   * that line with its own height.
   */
  it("keeps the review decision on the file's row, off the controls row", () => {
    render(diffSurface(false, vi.fn(), vi.fn()));

    const path = screen.getByTitle("a.ts");
    const fileRow = path.parentElement as HTMLElement;
    const keep = screen.getByRole("button", { name: t("workspace.changed.keep") });
    const inline = screen.getByRole("button", { name: t("workspace.viewer.diffInline") });

    expect(fileRow.contains(keep)).toBe(true);
    expect(fileRow.contains(inline)).toBe(false);
  });

  /**
   * KIN-RESULT-003's phone path. On a touch screen there is no hover, so the
   * entry to the comment box has to be a control that is always visible and
   * tappable: the same header action as the line's gutter glyph over a line
   * the cursor is on, and the diff opens with the cursor already on its first
   * changed line. The gutter glyph itself is hit through Monaco's mouse-down,
   * which a touch also emits.
   */
  it("reaches the comment entry from the header action with no hover — the phone path", async () => {
    const user = userEvent.setup();
    const onCommentLine = vi.fn();
    editorState.lineChanges = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 2,
      },
    ];
    editorState.lineText = { 2: "  return `See you later, ${name}`;" };

    render(
      <CodeViewer
        path="a.ts"
        file={null}
        loading={false}
        error={null}
        diff={{ path: "a.ts", original: "one", modified: "two", source: "write" }}
        onCommentLine={onCommentLine}
      />,
    );

    // Monaco mounts after the viewer's own mount-time resets.
    await waitFor(() => expect(editorState.cursorHandler).not.toBeNull());

    const action = screen.getByRole("button", {
      name: t("workspace.comments.action"),
    }) as HTMLButtonElement;
    // The shared facade carries the 44px phone touch floor onto this action;
    // `h-auto!` drops the fixed height, not the floor.
    expect(action.className).toContain("kin-btn");
    expect(action.className).toContain("min-h-11");
    // A diff opens with the cursor on its first changed line, so the entry is
    // enabled without a tap — and a touch screen has no hover to explain a
    // disabled control. It says what it does, not why it is unavailable.
    await waitFor(() => expect(action.disabled).toBe(false));
    expect(action.getAttribute("title")).toBe(t("workspace.comments.actionHint"));

    // Moving off a changed line disables it and says why, for the readers who
    // can see a tooltip.
    await act(async () => {
      editorState.cursorHandler?.({ position: { lineNumber: 1 } });
    });
    await waitFor(() => expect(action.disabled).toBe(true));
    expect(action.getAttribute("title")).toBe(t("workspace.comments.notChanged"));

    // A tap on the line moves the cursor; nothing here involves hover.
    await act(async () => {
      editorState.cursorHandler?.({ position: { lineNumber: 2 } });
    });
    await waitFor(() => expect(action.disabled).toBe(false));
    expect(action.getAttribute("title")).toBe(t("workspace.comments.actionHint"));

    const anchor = {
      path: "a.ts",
      line: 2,
      hunkHeader: "@@ -1,1 +2,1 @@",
      quote: "  return `See you later, ${name}`;",
    };
    await user.click(action);
    expect(onCommentLine).toHaveBeenCalledWith(anchor);

    // The gutter glyph is the same entry, hit by the same pointer-down a tap
    // produces.
    act(() => {
      editorState.mouseDownHandler?.({
        target: { type: 6, position: { lineNumber: 2 } },
      });
    });
    expect(onCommentLine).toHaveBeenCalledTimes(2);
    expect(onCommentLine).toHaveBeenLastCalledWith(anchor);
  });

  /**
   * KIN-RESULT-003 part 2: the viewer owns the live diff, so it is the one
   * place that can say where a saved comment points now. It reports; the panel
   * remembers.
   */
  it("re-anchors saved comments for the open file whenever the diff updates", async () => {
    const onCommentsReanchored = vi.fn();
    const saved = {
      id: "dc_saved",
      path: "a.ts",
      hunkHeader: "@@ -10,3 +10,4 @@",
      quote: "const title = settings.title;",
      line: 11,
      text: "This should fall back to the default title.",
      createdAt: 1,
    };

    render(
      <CodeViewer
        path="a.ts"
        file={null}
        loading={false}
        error={null}
        diff={{ path: "a.ts", original: "one", modified: "two", source: "write" }}
        comments={[saved]}
        onCommentsReanchored={onCommentsReanchored}
      />,
    );

    // The rerun moved the hunk: same quoted line, a new block and line number.
    await waitFor(() => expect(editorState.diffHandler).not.toBeNull());
    const lines = Array.from({ length: 50 }, () => "");
    lines[40] = "const title = settings.title;";
    editorState.lineChanges = [
      {
        originalStartLineNumber: 30,
        originalEndLineNumber: 32,
        modifiedStartLineNumber: 40,
        modifiedEndLineNumber: 42,
      },
    ];
    editorState.lines = lines;

    act(() => {
      editorState.diffHandler?.();
    });

    await waitFor(() =>
      expect(onCommentsReanchored).toHaveBeenLastCalledWith([
        { id: "dc_saved", line: 41, stale: false },
      ]),
    );
  });

  it("does not report stale comments in the plain file view", async () => {
    const onCommentsReanchored = vi.fn();

    render(
      <CodeViewer
        path="a.ts"
        file={textFile("a.ts", "const a = 1;")}
        loading={false}
        error={null}
        comments={[
          {
            id: "dc_saved",
            path: "a.ts",
            hunkHeader: "@@ -10,3 +10,4 @@",
            quote: "const title = settings.title;",
            line: 11,
            text: "This should fall back to the default title.",
            createdAt: 1,
          },
        ]}
        onCommentsReanchored={onCommentsReanchored}
      />,
    );

    // No diff, no line changes, no answer: a plain file read must never turn
    // a saved comment into 「该行已变化」.
    await waitFor(() => expect(screen.getByTestId("editor")).toBeTruthy());
    expect(onCommentsReanchored).not.toHaveBeenCalled();
  });
});
