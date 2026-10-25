import {
  listTaskSourceTree,
  listWorkspaceTree,
  readTaskSourceFile,
  readWorkspaceFile,
  writeWorkspaceFile,
  type TaskEvent,
  type TaskWorkspaceEntry,
  type WorkspaceFileResponse,
  type WorkspaceGeneration,
  type WorkspaceTreeResponse,
} from "../../api/client";

export type WorkspaceView =
  | {
      kind: "source";
      workspaceId: null;
      editable: boolean;
    }
  | {
      kind: "generation";
      workspaceId: string;
      generationState: string | null;
      editable: boolean;
    };

const SOURCE_VIEW: WorkspaceView = {
  kind: "source",
  workspaceId: null,
  editable: false,
};

export function resolveWorkspaceView(
  selectedWorkspaceId: string | null | undefined,
  currentWorkspaceId?: string | null,
  generations: readonly WorkspaceGeneration[] = [],
): WorkspaceView {
  if (selectedWorkspaceId === null) {
    return SOURCE_VIEW;
  }
  const workspaceId =
    selectedWorkspaceId ?? currentWorkspaceId ?? preferredWorkspaceID(generations);
  if (!workspaceId) return SOURCE_VIEW;
  const generation = generations.find((candidate) => candidate.id === workspaceId) ?? null;
  return {
    kind: "generation",
    workspaceId,
    generationState: generation?.state ?? null,
    editable: workspaceId === currentWorkspaceId && isWritableWorkspaceState(generation?.state),
  };
}

function isWritableWorkspaceState(state: string | undefined): boolean {
  return state === "active" || state === "merge_blocked" || state === "finalize_blocked";
}

/**
 * The identity of a workspace view, for anything that remembers something about
 * one place rather than about a session.
 *
 * Today that is the lens in front (`lib/workspaceLens`), and the property it
 * needs is the one this string has: two views are the same place exactly when
 * they are the same generation, so a change of generation is a change of key.
 * The source view's key is a bare word because there is only one of it per
 * session, and it cannot collide with a generation's — an id is never empty.
 *
 * The session is not in the key: callers that need it carry the task id beside
 * this (see `LensPick`), so one string does not have to mean two things.
 */
export function workspaceViewKey(view: WorkspaceView): string {
  return view.kind === "generation" ? `generation:${view.workspaceId}` : "source";
}

export function writeWorkspaceViewFile(
  view: WorkspaceView,
  taskId: string,
  path: string,
  content: string,
): Promise<WorkspaceFileResponse> {
  if (!view.editable || view.kind !== "generation") {
    return Promise.reject(new Error("workspace view is read-only"));
  }
  return writeWorkspaceFile(taskId, view.workspaceId, path, content);
}

export function listWorkspaceViewTree(
  view: WorkspaceView,
  taskId: string,
  path?: string,
): Promise<WorkspaceTreeResponse> {
  if (view.kind === "source") {
    return listTaskSourceTree(taskId, path);
  }
  return listWorkspaceTree(taskId, view.workspaceId, path);
}

export function readWorkspaceViewFile(
  view: WorkspaceView,
  taskId: string,
  path: string,
): Promise<WorkspaceFileResponse> {
  if (view.kind === "source") {
    return readTaskSourceFile(taskId, path);
  }
  return readWorkspaceFile(taskId, view.workspaceId, path);
}

export function workspaceTreeEntries(response: WorkspaceTreeResponse): TaskWorkspaceEntry[] {
  const base = response.path === "." ? "" : response.path.replace(/^\.?\//, "");
  return response.entries.map((entry) => ({
    name: entry.name,
    path: base ? `${base}/${entry.name}` : entry.name,
    type: entry.type === "tree" ? "dir" : "file",
    size: entry.size,
  }));
}

export function preferredWorkspaceID(generations: readonly WorkspaceGeneration[]): string | null {
  const preferred = [...generations]
    .sort((a, b) => b.generation - a.generation)
    .find((generation) => generation.state !== "orphaned");
  return preferred?.id ?? null;
}

export function effectiveCurrentWorkspaceID(
  currentWorkspaceId: string | null | undefined,
  generations: readonly WorkspaceGeneration[],
): string | null {
  const persisted = currentWorkspaceId
    ? generations.find((generation) => generation.id === currentWorkspaceId)
    : undefined;
  if (
    currentWorkspaceId &&
    (!persisted || (persisted.state !== "released" && persisted.state !== "orphaned"))
  ) {
    return currentWorkspaceId;
  }
  const current = [...generations]
    .sort((a, b) => b.generation - a.generation)
    .find((generation) => generation.state !== "released" && generation.state !== "orphaned");
  return current?.id ?? null;
}

export function workspaceLifecycleRefreshKey(
  events: readonly TaskEvent[] | undefined,
  currentWorkspaceId: string | null | undefined,
): string {
  let lifecycleEvent = "";
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = events?.[index];
    if (event?.type.startsWith("workspace_")) {
      lifecycleEvent = `${event.event_epoch}:${event.seq}:${event.type}`;
      break;
    }
  }
  return `${currentWorkspaceId ?? ""}:${lifecycleEvent}`;
}
