import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fileTreeSource from "./FileTree.tsx?raw";
import generationPickerSource from "./WorkspaceGenerationPicker.tsx?raw";
import workspacePanelSource from "./WorkspacePanel.tsx?raw";
import {
  listWorkspaceViewTree,
  effectiveCurrentWorkspaceID,
  preferredWorkspaceID,
  readWorkspaceViewFile,
  resolveWorkspaceView,
  workspaceLifecycleRefreshKey,
  workspaceTreeEntries,
} from "./workspaceView";

const fetchMock = vi.fn<typeof fetch>();
const generationBase = {
  task_id: "task-1",
  source_root: "/repo",
  scope: ".",
  created_at: 1,
  updated_at: 1,
};

beforeEach(() => {
  fetchMock.mockImplementation(async () =>
    new Response(
      JSON.stringify({
        view: "source",
        path: ".",
        entries: [],
        size: 0,
        content: "",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("workspace view selection", () => {
  it("uses source endpoints and stays read-only for a null selection", async () => {
    const view = resolveWorkspaceView(null);

    await listWorkspaceViewTree(view, "task/1", "src dir");
    await readWorkspaceViewFile(view, "task/1", "README.md");

    expect(view).toMatchObject({
      kind: "source",
      workspaceId: null,
      editable: false,
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/tasks/task%2F1/source/tree?path=src+dir",
      "/api/tasks/task%2F1/source/file?path=README.md",
    ]);
  });

  it("uses generation endpoints and defaults to read-only when selected", async () => {
    const view = resolveWorkspaceView("generation/1");

    await listWorkspaceViewTree(view, "task/1", "src dir");
    await readWorkspaceViewFile(view, "task/1", "README.md");

    expect(view).toMatchObject({
      kind: "generation",
      workspaceId: "generation/1",
      editable: false,
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/tasks/task%2F1/workspaces/generation%2F1/tree?path=src+dir",
      "/api/tasks/task%2F1/workspaces/generation%2F1/file?path=README.md",
    ]);
  });

  it("allows edits only for a current generation in a writable state", () => {
    const generation = (state: string) => [
      { ...generationBase, id: "g1", generation: 1, state },
    ];

    for (const state of ["active", "merge_blocked", "finalize_blocked"]) {
      expect(resolveWorkspaceView("g1", "g1", generation(state)).editable).toBe(
        true,
      );
    }
    for (const state of [
      "provisioning",
      "ready",
      "finalizing",
      "integrated",
      "released",
      "orphaned",
      "legacy_pending",
    ]) {
      expect(resolveWorkspaceView("g1", "g1", generation(state)).editable).toBe(
        false,
      );
    }
    expect(
      resolveWorkspaceView("g1", "g2", generation("active")).editable,
    ).toBe(false);
  });

  it("keeps automatic selection dynamic and explicit source selection stable", () => {
    const generations = [
      { ...generationBase, id: "g1", generation: 1, state: "released" },
      { ...generationBase, id: "g2", generation: 2, state: "active" },
    ];

    const inferredCurrent = effectiveCurrentWorkspaceID(null, generations);
    expect(resolveWorkspaceView(undefined, inferredCurrent, generations)).toEqual({
      kind: "generation",
      workspaceId: "g2",
      generationState: "active",
      editable: true,
    });
    expect(resolveWorkspaceView(undefined, "g2", generations)).toEqual({
      kind: "generation",
      workspaceId: "g2",
      generationState: "active",
      editable: true,
    });
    expect(resolveWorkspaceView(null, "g2", generations)).toEqual({
      kind: "source",
      workspaceId: null,
      editable: false,
    });
  });

  it("does not infer a released generation as current", () => {
    const generations = [
      { ...generationBase, id: "g1", generation: 1, state: "released" },
    ];
    expect(effectiveCurrentWorkspaceID(null, generations)).toBeNull();
  });

  it("replaces a stale released current pointer with the open generation", () => {
    const generations = [
      { ...generationBase, id: "g1", generation: 1, state: "released" },
      { ...generationBase, id: "g2", generation: 2, state: "active" },
    ];
    expect(effectiveCurrentWorkspaceID("g1", generations)).toBe("g2");
  });

  it("keeps the repository scope in child paths", () => {
    expect(
      workspaceTreeEntries({
        view: "source",
        path: "ui/src",
        entries: [{ name: "App.tsx", type: "blob", size: 10 }],
      }),
    ).toEqual([
      { name: "App.tsx", path: "ui/src/App.tsx", type: "file", size: 10 },
    ]);
  });

  it("prefers the latest non-orphaned generation", () => {
    expect(
      preferredWorkspaceID([
        { ...generationBase, id: "g1", generation: 1, state: "released" },
        { ...generationBase, id: "g2", generation: 2, state: "orphaned" },
        { ...generationBase, id: "g3", generation: 3, state: "active" },
      ]),
    ).toBe("g3");
  });

  it("changes the refresh key for current workspace and lifecycle updates", () => {
    const event = (seq: number, type: string) => ({
      task_id: "task-1",
      event_epoch: 1,
      seq,
      ts: seq,
      type,
      payload: {},
    });
    const base = workspaceLifecycleRefreshKey([event(1, "message")], "g1");

    expect(workspaceLifecycleRefreshKey([event(1, "message")], "g2")).not.toBe(
      base,
    );
    expect(
      workspaceLifecycleRefreshKey(
        [event(1, "message"), event(2, "workspace_ready")],
        "g1",
      ),
    ).not.toBe(base);
    expect(
      workspaceLifecycleRefreshKey(
        [event(1, "message"), event(2, "tool_result")],
        "g1",
      ),
    ).toBe(base);
  });
});

describe("workspace view integration", () => {
  it("routes tree, file, and editability through the shared view model", () => {
    expect(fileTreeSource).toContain("listWorkspaceViewTree");
    expect(fileTreeSource).not.toContain("listTaskWorkspace");
    expect(workspacePanelSource).toContain("readWorkspaceViewFile");
    expect(workspacePanelSource).not.toContain("readTaskWorkspaceFile");
    expect(workspacePanelSource).toContain("view={workspaceView}");
    expect(workspacePanelSource).toContain("editable={workspaceView.editable}");
  });

  it("owns live generation data in the panel without pinning automatic selection", () => {
    expect(workspacePanelSource).toContain("listTaskWorkspaces");
    expect(workspacePanelSource).toContain("workspaceLifecycleRefreshKey");
    expect(generationPickerSource).not.toContain("listTaskWorkspaces");
    expect(generationPickerSource).not.toContain("onChange(preferred)");
  });
});
