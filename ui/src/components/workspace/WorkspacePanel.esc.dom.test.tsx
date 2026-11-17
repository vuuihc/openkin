// @vitest-environment jsdom
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { t } from "../../i18n";
import type { ChangedFile } from "../../lib/changedFiles";
import Button from "../ui/Button";
import WorkspacePanel from "./WorkspacePanel";

// The viewer is the only thing that loads monaco, which jsdom cannot resolve.
// Opening a file is what these cases are about, not what draws it.
vi.mock("./CodeViewer", () => ({
  default: () => null,
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

Element.prototype.scrollIntoView = vi.fn();

// jsdom has no layout, and the panel asks its own container how wide it is
// rather than the viewport. `clientWidth` is 0 there, so a case that cares
// says what its container measures.
function stubContainerWidth(width: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width,
  });
}

function restoreContainerWidth() {
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
}

const changed: ChangedFile = {
  path: `${CWD}/src/a.ts`,
  action: "write",
  tool: "claude-code",
  seq: 1,
};

/**
 * The panel is drawn by a caller that owns the button which opened it. Escape
 * has to hand focus back to that button, so the harness owns one and keeps the
 * panel behind a state flag the way `TaskPanels` does.
 */
function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <Button ref={triggerRef} onClick={() => setOpen(true)}>
        open files
      </Button>
      <button type="button" data-testid="outside">
        outside
      </button>
      {open && (
        <WorkspacePanel
          taskId="task-1"
          cwd={CWD}
          changedFiles={[changed]}
          events={[]}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        />
      )}
    </div>
  );
}

/** Open the panel the way a reader does: focus the trigger, then press it. */
function openPanel(onClose = vi.fn()) {
  const view = render(<Harness onClose={onClose} />);
  const trigger = screen.getByRole("button", { name: "open files" });
  trigger.focus();
  fireEvent.click(trigger);
  return { ...view, trigger, onClose };
}

const fileRow = () => screen.getByTitle(changed.path);
const back = () => screen.queryByRole("button", { name: t("workspace.backToFiles") });
const closeButton = () => screen.getByRole("button", { name: t("workspace.close") });

describe("KIN-RESULT-001: Escape unwinds one layer", () => {
  beforeEach(() => {
    readTaskSourceFile.mockReset();
    readWorkspaceFile.mockReset();
    readTaskSourceFile.mockResolvedValue({ path: "src/a.ts", content: "hi", binary: false });
    readWorkspaceFile.mockResolvedValue({ path: "src/a.ts", content: "hi", binary: false });
  });
  afterEach(() => restoreContainerWidth());

  it("KIN-RESULT-001: Escape on the file list closes the panel and puts focus back on the trigger", () => {
    stubContainerWidth(380);
    const { trigger, onClose } = openPanel();

    fireEvent.keyDown(fileRow(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("KIN-RESULT-001: Escape on an open file returns to the list, and only the next Escape closes", async () => {
    stubContainerWidth(380);
    const { trigger, onClose } = openPanel();

    fireEvent.click(fileRow());
    await waitFor(() => expect(back()).not.toBeNull());

    fireEvent.keyDown(back() as HTMLElement, { key: "Escape" });

    expect(back()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(fileRow()));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("KIN-RESULT-001: Escape in the split layout closes the panel", async () => {
    stubContainerWidth(1200);
    const { trigger, onClose } = openPanel();

    fireEvent.click(fileRow());
    await waitFor(() => expect(readTaskSourceFile).toHaveBeenCalled());

    // No second layer exists in the split: both panes are visible, so there is
    // no "back to the list" the key could mean.
    expect(back()).toBeNull();
    fileRow().focus();
    fireEvent.keyDown(fileRow(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("KIN-RESULT-001: Escape does not close the panel when focus is outside it", () => {
    stubContainerWidth(380);
    const { onClose } = openPanel();

    const outside = screen.getByTestId("outside");
    outside.focus();
    fireEvent.keyDown(outside, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("KIN-RESULT-001: a layer above keeps its own Escape", () => {
    stubContainerWidth(380);
    const { onClose } = openPanel();

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);

    fireEvent.keyDown(fileRow(), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    menu.remove();
    fireEvent.keyDown(fileRow(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("KIN-RESULT-001: Escape already claimed by an inner control is left alone", () => {
    stubContainerWidth(380);
    const { onClose } = openPanel();

    const claimed = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    claimed.preventDefault();
    act(() => {
      fileRow().dispatchEvent(claimed);
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("KIN-RESULT-001: Escape during IME composition does nothing", () => {
    stubContainerWidth(380);
    const { onClose } = openPanel();

    fireEvent.keyDown(fileRow(), { key: "Escape", isComposing: true });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("KIN-RESULT-001: the close button also returns focus to the trigger", () => {
    stubContainerWidth(380);
    const { trigger, onClose } = openPanel();

    // A real press focuses the control; jsdom's synthetic click does not.
    // Focus it first so this case actually covers the focus that the panel
    // takes with it when it closes.
    closeButton().focus();
    fireEvent.click(closeButton());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });
});
