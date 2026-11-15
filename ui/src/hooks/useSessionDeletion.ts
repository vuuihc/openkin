import { useCallback } from "react";
import { deleteTask } from "../api/client";
import { liveResources } from "../api/liveResources";
import { clearFollowUpDraft } from "../lib/followUpDraft";
import { clearSessionScroll } from "../lib/sessionScroll";
import { useT } from "../i18n/react";
import { useAppStore } from "../store/appStore";

/** What a batch actually did: the ids that went, and the ids still there. */
export type BatchDeleteOutcome = {
  deleted: number;
  failed: string[];
};

/**
 * Deleting conversations from the phone list.
 *
 * A delete here is permanent — there is no archive to restore it from — so
 * every path asks first, with the title of the one being deleted, and a row
 * only leaves the list after the daemon has said it is gone: the list drops it
 * through the same `task_deleted` message a delete from the session itself
 * publishes, so every surface agrees. The conversation's scroll position and
 * unsent draft go with it, the way the session page's own delete clears them.
 *
 * A batch reports how many actually went. One failure does not undo the
 * others, and a summary that claimed "all" after a partial failure would be a
 * lie about what is still there — so the failed ids come back too, and the
 * caller can leave exactly those selected for a retry.
 */
export function useSessionDeletion() {
  const t = useT();
  const pushToast = useAppStore((s) => s.pushToast);

  const forget = useCallback((id: string) => {
    liveResources.applyMessage({ kind: "task_deleted", data: { id } });
    clearSessionScroll(id);
    clearFollowUpDraft(id);
  }, []);

  /** Asks, deletes one conversation, and drops its row. Returns whether it went. */
  const deleteOne = useCallback(
    async (task: { id: string; title?: string | null }): Promise<boolean> => {
      const title = (task.title ?? "").trim();
      if (!window.confirm(t("task.deleteConfirm") + (title ? `\n\n${title}` : ""))) {
        return false;
      }
      try {
        await deleteTask(task.id);
        forget(task.id);
        pushToast(t("task.deleted"), "info");
        return true;
      } catch (err) {
        pushToast(
          err instanceof Error && err.message ? err.message : t("task.deleteFailed"),
          "error",
        );
        return false;
      }
    },
    [t, pushToast, forget],
  );

  /**
   * Asks once for the whole selection, then deletes each. Returns what went
   * and what did not, or null when the person declined.
   */
  const deleteMany = useCallback(
    async (ids: readonly string[]): Promise<BatchDeleteOutcome | null> => {
      if (ids.length === 0) return { deleted: 0, failed: [] };
      if (!window.confirm(t("sessions.deleteSelectedConfirm", { count: String(ids.length) }))) {
        return null;
      }
      const results = await Promise.allSettled(ids.map((id) => deleteTask(id)));
      const failed: string[] = [];
      let firstError: string | null = null;
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          forget(ids[index]);
          return;
        }
        // Only the rows the daemon confirmed are dropped: a `task_deleted` for
        // one that survived would hide a session that is still there. The id
        // comes back so the caller can leave just those rows selected.
        failed.push(ids[index]);
        if (firstError === null && result.reason instanceof Error && result.reason.message) {
          firstError = result.reason.message;
        }
      });
      const deleted = ids.length - failed.length;
      if (deleted > 0) {
        pushToast(t("sessions.deletedCount", { count: String(deleted) }), "info");
      }
      if (failed.length === 1 && firstError) {
        pushToast(firstError, "error");
      } else if (failed.length > 0) {
        pushToast(
          t("sessions.deleteFailedCount", {
            count: String(failed.length),
            error: firstError ?? t("task.deleteFailed"),
          }),
          "error",
        );
      }
      return { deleted, failed };
    },
    [t, pushToast, forget],
  );

  return { deleteOne, deleteMany };
}
