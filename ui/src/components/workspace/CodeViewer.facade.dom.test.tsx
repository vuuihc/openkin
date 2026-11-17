// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
      // the real component runs unmodified against it.
      const { onMount } = props;
      React.useEffect(() => {
        const disposable = { dispose: () => {} };
        const modifiedEditor = {
          createDecorationsCollection: () => ({ clear: () => {}, set: () => {} }),
          onDidChangeCursorPosition: () => disposable,
          onMouseDown: () => disposable,
          addCommand: () => {},
          getModel: () => ({ getLineContent: () => "" }),
          getPosition: () => null,
        };
        onMount?.(
          {
            getModifiedEditor: () => modifiedEditor,
            getLineChanges: () => [],
            onDidUpdateDiff: () => disposable,
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
        // Mount once, like Monaco itself.
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
});
