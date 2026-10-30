// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import { useAppStore } from "../store/appStore";

/**
 * Deleting a conversation from the phone list.
 *
 * A delete is permanent, so what is pinned here is the sequence: nothing is
 * sent before the confirmation, a row leaves every surface only after the
 * daemon said it is gone, and a batch that half-failed says how many actually
 * went — and which ids survived, so the caller can keep just those selected.
 */
const client = vi.hoisted(() => ({ deleteTask: vi.fn() }));
const resources = vi.hoisted(() => ({ applyMessage: vi.fn() }));
const scroll = vi.hoisted(() => ({ clearSessionScroll: vi.fn() }));
const drafts = vi.hoisted(() => ({ clearFollowUpDraft: vi.fn() }));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  ...client,
}));
vi.mock("../api/liveResources", () => ({ liveResources: resources }));
vi.mock("../lib/sessionScroll", () => scroll);
vi.mock("../lib/followUpDraft", () => drafts);

import { useSessionDeletion } from "./useSessionDeletion";

beforeEach(() => {
  client.deleteTask.mockReset();
  client.deleteTask.mockResolvedValue(undefined);
  resources.applyMessage.mockReset();
  scroll.clearSessionScroll.mockReset();
  drafts.clearFollowUpDraft.mockReset();
  useAppStore.setState({ pushToast: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSessionDeletion", () => {
  it("asks before deleting one, and names the conversation in the question", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { result } = renderHook(() => useSessionDeletion());

    let deleted: boolean | undefined;
    await act(async () => {
      deleted = await result.current.deleteOne({ id: "task-1", title: "Nightly build" });
    });

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Nightly build"));
    expect(client.deleteTask).toHaveBeenCalledWith("task-1");
    expect(resources.applyMessage).toHaveBeenCalledWith({
      kind: "task_deleted",
      data: { id: "task-1" },
    });
    // The conversation's scroll position and unsent draft go with it, the way
    // the session page's own delete clears them.
    expect(scroll.clearSessionScroll).toHaveBeenCalledWith("task-1");
    expect(drafts.clearFollowUpDraft).toHaveBeenCalledWith("task-1");
    expect(useAppStore.getState().pushToast).toHaveBeenCalledWith(t("task.deleted"), "info");
    expect(deleted).toBe(true);
  });

  it("sends nothing when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { result } = renderHook(() => useSessionDeletion());

    let deleted: boolean | undefined;
    await act(async () => {
      deleted = await result.current.deleteOne({ id: "task-1", title: "Keep me" });
    });

    expect(client.deleteTask).not.toHaveBeenCalled();
    expect(resources.applyMessage).not.toHaveBeenCalled();
    expect(scroll.clearSessionScroll).not.toHaveBeenCalled();
    expect(drafts.clearFollowUpDraft).not.toHaveBeenCalled();
    expect(useAppStore.getState().pushToast).not.toHaveBeenCalled();
    expect(deleted).toBe(false);
  });

  it("keeps the row when the daemon refuses, and says why", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    client.deleteTask.mockRejectedValue(new Error("task is running"));
    const { result } = renderHook(() => useSessionDeletion());

    let deleted: boolean | undefined;
    await act(async () => {
      deleted = await result.current.deleteOne({ id: "task-1", title: "Busy" });
    });

    expect(resources.applyMessage).not.toHaveBeenCalled();
    expect(scroll.clearSessionScroll).not.toHaveBeenCalled();
    expect(useAppStore.getState().pushToast).toHaveBeenCalledWith("task is running", "error");
    expect(deleted).toBe(false);
  });

  it("asks once for a batch, with the count", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { result } = renderHook(() => useSessionDeletion());

    let outcome: { deleted: number; failed: string[] } | null | undefined;
    await act(async () => {
      outcome = await result.current.deleteMany(["task-1", "task-2"]);
    });

    expect(confirm).toHaveBeenCalledWith(t("sessions.deleteSelectedConfirm", { count: "2" }));
    expect(client.deleteTask).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().pushToast).toHaveBeenCalledWith(
      t("sessions.deletedCount", { count: "2" }),
      "info",
    );
    expect(outcome).toEqual({ deleted: 2, failed: [] });
  });

  it("answers null for a declined batch, so the caller keeps the selection", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { result } = renderHook(() => useSessionDeletion());

    let outcome: { deleted: number; failed: string[] } | null | undefined;
    await act(async () => {
      outcome = await result.current.deleteMany(["task-1"]);
    });

    expect(outcome).toBeNull();
    expect(client.deleteTask).not.toHaveBeenCalled();
  });

  it("reports how many went when the batch half-failed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    client.deleteTask.mockImplementation((id: string) =>
      id === "task-2" ? Promise.reject(new Error("task-2 is running")) : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => useSessionDeletion());

    let outcome: { deleted: number; failed: string[] } | null | undefined;
    await act(async () => {
      outcome = await result.current.deleteMany(["task-1", "task-2"]);
    });

    // Only the row that actually went is dropped: task-2 is still there, and a
    // `task_deleted` for it would hide a session that survived. The surviving
    // id comes back so the caller can leave exactly that row selected.
    expect(resources.applyMessage).toHaveBeenCalledTimes(1);
    expect(resources.applyMessage).toHaveBeenCalledWith({
      kind: "task_deleted",
      data: { id: "task-1" },
    });
    expect(scroll.clearSessionScroll).toHaveBeenCalledTimes(1);
    expect(drafts.clearFollowUpDraft).toHaveBeenCalledTimes(1);
    const pushToast = vi.mocked(useAppStore.getState().pushToast);
    expect(pushToast).toHaveBeenCalledWith(t("sessions.deletedCount", { count: "1" }), "info");
    expect(pushToast).toHaveBeenCalledWith("task-2 is running", "error");
    expect(outcome).toEqual({ deleted: 1, failed: ["task-2"] });
  });

  it("keeps every row selected when the whole batch failed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    client.deleteTask.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useSessionDeletion());

    let outcome: { deleted: number; failed: string[] } | null | undefined;
    await act(async () => {
      outcome = await result.current.deleteMany(["task-1", "task-2"]);
    });

    expect(resources.applyMessage).not.toHaveBeenCalled();
    const pushToast = vi.mocked(useAppStore.getState().pushToast);
    expect(pushToast).not.toHaveBeenCalledWith(t("sessions.deletedCount", { count: "0" }), "info");
    // Two failures cannot be named one by one in one line, so the count leads
    // and the first error follows as the reason.
    expect(pushToast).toHaveBeenCalledWith(
      t("sessions.deleteFailedCount", { count: "2", error: "offline" }),
      "error",
    );
    expect(outcome).toEqual({ deleted: 0, failed: ["task-1", "task-2"] });
  });

  it("does not ask, or call, for an empty selection", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { result } = renderHook(() => useSessionDeletion());

    let outcome: { deleted: number; failed: string[] } | null | undefined;
    await act(async () => {
      outcome = await result.current.deleteMany([]);
    });

    expect(outcome).toEqual({ deleted: 0, failed: [] });
    expect(confirm).not.toHaveBeenCalled();
    expect(client.deleteTask).not.toHaveBeenCalled();
  });
});
