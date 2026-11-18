// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_LOCALE, setLocale, t } from "../../i18n";

/**
 * Closing the file panel — or switching the diff layout, which remounts the
 * editor — must not raise a page error. `@monaco-editor/react@4.7.0` unmounts
 * a `DiffEditor` like this (dist/index.js, function `P`):
 *
 *   function P() {
 *     let i = p.current?.getModel();
 *     R || i?.original?.dispose();   // keepCurrentOriginalModel, default false
 *     j || i?.modified?.dispose();   // keepCurrentModifiedModel, default false
 *     p.current?.dispose();          // the DiffEditorWidget, last
 *   }
 *
 * monaco 0.52.2 reports `TextModel got disposed before DiffEditorWidget model
 * got reset` for a model the widget still holds (diffEditorWidget.js,
 * `onWillDispose`), and the report escapes as a page error: a cleanup throw is
 * outside `MonacoSafe`, which is a render error boundary. The stub below
 * reproduces that order and guard; the viewer's contract is to keep the models
 * (`keepCurrent*Model`) and detach them before disposing them.
 */

const mocks = vi.hoisted(() => ({
  writeTaskWorkspaceFile: vi.fn(),
  writeWorkspaceFile: vi.fn(),
}));

type FakeModel = {
  disposeCalls: number;
  disposed: boolean;
  dispose: () => void;
  isDisposed: () => boolean;
};

type DiffRecord = {
  original: FakeModel;
  modified: FakeModel;
  /** The models the widget currently holds; null once detached. */
  model: { original: FakeModel; modified: FakeModel } | null;
  editorDisposeCalls: number;
  /** Whether both models were alive when the widget let go of them. */
  aliveAtDetach: boolean | null;
  /** Whether the widget saw a disposed model while it still held it. */
  guardTripped: boolean;
};

const monacoState = vi.hoisted(() => ({ records: [] as DiffRecord[] }));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    writeTaskWorkspaceFile: mocks.writeTaskWorkspaceFile,
    writeWorkspaceFile: mocks.writeWorkspaceFile,
  };
});

vi.mock("./monacoSetup", () => ({}));

vi.mock("@monaco-editor/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  const makeModel = (): FakeModel => ({
    disposeCalls: 0,
    disposed: false,
    dispose() {
      this.disposeCalls += 1;
      // Real `TextModel.dispose()` is idempotent; counting calls still catches
      // a second owner trying to dispose it.
      if (!this.disposed) this.disposed = true;
    },
    isDisposed() {
      return this.disposed;
    },
  });

  return {
    default: () => <textarea data-testid="editor" />,
    DiffEditor: (props: {
      keepCurrentOriginalModel?: boolean;
      keepCurrentModifiedModel?: boolean;
      onMount?: (editor: unknown, monaco: unknown) => void;
    }) => {
      const recordRef = React.useRef<DiffRecord | null>(null);
      if (recordRef.current === null) {
        const original = makeModel();
        const modified = makeModel();
        recordRef.current = {
          original,
          modified,
          model: { original, modified },
          editorDisposeCalls: 0,
          aliveAtDetach: null,
          guardTripped: false,
        };
        monacoState.records.push(recordRef.current);
      }
      const record = recordRef.current;
      const editor = {
        getModel: () => record.model,
        setModel: (next: DiffRecord["model"]) => {
          if (next === null) {
            record.aliveAtDetach = !record.original.disposed && !record.modified.disposed;
          }
          record.model = next;
        },
        getModifiedEditor: () => ({
          // Only the calls this path makes; no diff means no glyphs or
          // cursor work to stand in for.
          onDidChangeCursorPosition: () => ({ dispose: () => {} }),
          onMouseDown: () => ({ dispose: () => {} }),
          addCommand: () => {},
          getModel: () => record.model?.modified ?? null,
        }),
        getLineChanges: () => [],
        onDidUpdateDiff: () => ({ dispose: () => {} }),
        onDidDispose: () => ({ dispose: () => {} }),
        goToDiff: () => {},
        dispose() {
          record.editorDisposeCalls += 1;
          // The guard only fires for a model the widget still holds; a
          // detached model may be disposed freely.
          if (record.model && (record.model.original.disposed || record.model.modified.disposed)) {
            record.guardTripped = true;
            throw new Error("TextModel got disposed before DiffEditorWidget model got reset");
          }
        },
      };
      React.useEffect(() => {
        // The mount path reads `monaco` for the ⌥C chord registration; the
        // glyph path never runs for a diff with no changes.
        props.onMount?.(editor, { KeyMod: { Alt: 1 }, KeyCode: { KeyC: 1 } });
        return () => {
          // `P()`: whatever the widget holds, models first unless the keep
          // flags are set, widget last.
          const held = editor.getModel();
          if (!props.keepCurrentOriginalModel) held?.original.dispose();
          if (!props.keepCurrentModifiedModel) held?.modified.dispose();
          editor.dispose();
        };
        // Mount once, like Monaco itself.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div data-testid="diff-editor" />;
    },
  };
});

import CodeViewer from "./CodeViewer";

function diffSurface() {
  return (
    <CodeViewer
      path="notes.md"
      file={null}
      loading={false}
      error={null}
      diff={{ path: "notes.md", original: "one", modified: "two", source: "write" }}
    />
  );
}

beforeEach(() => {
  setLocale("en");
  monacoState.records.length = 0;
});

afterEach(() => {
  setLocale(DEFAULT_LOCALE);
});

describe("the diff editor's model lifetime", () => {
  it("keeps both models alive until the diff editor is disposed", () => {
    const view = render(diffSurface());
    const [record] = monacoState.records;
    view.unmount();
    expect(record.guardTripped).toBe(false);
    expect(record.aliveAtDetach).toBe(true);
  });

  it("disposes both models exactly once after unmount", () => {
    const view = render(diffSurface());
    const [record] = monacoState.records;
    view.unmount();
    expect(record.editorDisposeCalls).toBe(1);
    expect(record.original.disposeCalls).toBe(1);
    expect(record.modified.disposeCalls).toBe(1);
  });

  it("takes the same order when the layout key remounts the editor", () => {
    render(diffSurface());
    const [first] = monacoState.records;
    // The side-by-side toggle changes `diffLayout`, part of the editor's key:
    // the mounted widget unmounts and a fresh one mounts.
    fireEvent.click(screen.getByRole("button", { name: t("workspace.viewer.diffSideBySide") }));
    expect(first.guardTripped).toBe(false);
    expect(first.aliveAtDetach).toBe(true);
    expect(first.original.disposeCalls).toBe(1);
    expect(first.modified.disposeCalls).toBe(1);
    expect(monacoState.records.length).toBe(2);
  });
});
