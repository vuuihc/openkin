// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkspaceTreeResponse } from "../../api/client";
import FileTree from "./FileTree";
import type { WorkspaceView } from "./workspaceView";

const { listWorkspaceViewTree } = vi.hoisted(() => ({ listWorkspaceViewTree: vi.fn() }));

vi.mock("./workspaceView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspaceView")>();
  return {
    ...actual,
    // The real entries mapper stays: the test answers the tree endpoint, it
    // does not re-implement how a path is composed.
    listWorkspaceViewTree: (...args: unknown[]) => listWorkspaceViewTree(...args),
  };
});

const VIEW: WorkspaceView = { kind: "source", workspaceId: null, editable: false };

function answer(path: string, entries: Array<{ name: string; type: "tree" | "blob" }>) {
  return Promise.resolve({
    view: "source",
    path,
    entries,
    truncated: false,
  } satisfies WorkspaceTreeResponse);
}

beforeEach(() => {
  listWorkspaceViewTree.mockReset();
  listWorkspaceViewTree.mockImplementation(
    (_view: WorkspaceView, _taskId: string, path?: string) => {
      if (!path) {
        return answer(".", [
          { name: "src", type: "tree" },
          { name: "README.md", type: "blob" },
        ]);
      }
      if (path === "src") {
        return answer("src", [
          { name: "a.ts", type: "blob" },
          { name: "z.ts", type: "blob" },
        ]);
      }
      return answer(path, []);
    },
  );
});

function rows(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-workspace-row]"));
}

async function focusRow(row: HTMLElement) {
  await act(async () => {
    row.focus();
  });
}

function renderTree() {
  const onSelect = vi.fn();
  const view = render(
    <FileTree taskId="task-1" selectedPath={null} onSelect={onSelect} view={VIEW} />,
  );
  return { ...view, onSelect };
}

async function expandSrc(user: ReturnType<typeof userEvent.setup>, src: HTMLElement) {
  await focusRow(src);
  await user.keyboard("{Enter}");
  await screen.findByTitle("src/a.ts");
  await screen.findByTitle("src/z.ts");
}

describe("KIN-RESULT-001: keyboard navigation over the file tree", () => {
  it("the file tree is a single tab stop over its visible rows", async () => {
    renderTree();

    await screen.findByTitle("src");
    await screen.findByTitle("README.md");
    // The rows commit before the effect that hands the first one the tab stop,
    // so this is a settled-state assertion, not a post-findByTitle one: reading
    // it between those two commits sees every row at -1 under load.
    await waitFor(() => expect(rows().map((row) => row.tabIndex)).toEqual([0, -1]), {
      timeout: 3000,
    });
  });

  // One render proves the invariant holds; repeated renders prove it settles
  // under scheduling pressure. A tree that never hands out a tab stop times
  // this out instead of passing on a lucky screenshot.
  it.each(Array.from({ length: 20 }, (_, i) => i + 1))(
    "KIN-RESULT-001: the tree settles on one tab stop (run %i)",
    async () => {
      renderTree();

      await screen.findByTitle("src");
      await screen.findByTitle("README.md");
      await waitFor(() => expect(rows().map((row) => row.tabIndex)).toEqual([0, -1]), {
        timeout: 3000,
      });
    },
  );

  it("ArrowDown walks visible rows in reading order", async () => {
    const user = userEvent.setup();
    renderTree();

    const src = await screen.findByTitle("src");
    const readme = await screen.findByTitle("README.md");
    await expandSrc(user, src);

    // Reading order includes the rows the expansion revealed.
    const a = await screen.findByTitle("src/a.ts");
    const z = await screen.findByTitle("src/z.ts");
    expect(document.activeElement).toBe(src);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(a);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(z);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(readme);

    // The last row holds instead of wrapping to the first.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(readme);

    // Collapsed children leave the order: from the directory row the next stop
    // is the row after it, never a hidden child.
    await focusRow(src);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTitle("src/a.ts")).toBeNull());
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(readme);
  });

  it("Enter toggles a focused directory and opens a focused file", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderTree();

    const src = await screen.findByTitle("src");
    await focusRow(src);
    await user.keyboard("{Enter}");
    expect(listWorkspaceViewTree).toHaveBeenCalledWith(VIEW, "task-1", "src");
    await screen.findByTitle("src/a.ts");

    const readme = await screen.findByTitle("README.md");
    await focusRow(readme);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("README.md");
  });

  it("Home and End reach the first and last visible row of the tree", async () => {
    const user = userEvent.setup();
    renderTree();

    const src = await screen.findByTitle("src");
    await screen.findByTitle("README.md");
    await expandSrc(user, src);

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByTitle("README.md"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getByTitle("src"));
  });
});
