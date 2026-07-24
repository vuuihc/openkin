/** Per-task follow-up composer draft (client-only localStorage). */

import type { Upload } from "../api/client";

const KEY_PREFIX = "kin_followup_draft:";
const MAX_ENTRIES = 40;

export type FollowUpDraft = {
  prompt: string;
  attachments: Upload[];
  updatedAt: number;
};

function storageKey(taskId: string): string {
  return `${KEY_PREFIX}${taskId}`;
}

function isUpload(value: unknown): value is Upload {
  if (!value || typeof value !== "object") return false;
  const upload = value as Record<string, unknown>;
  return (
    typeof upload.id === "string" &&
    typeof upload.name === "string" &&
    typeof upload.mime === "string" &&
    typeof upload.size === "number" &&
    typeof upload.url === "string" &&
    typeof upload.path === "string"
  );
}

function emptyDraft(): FollowUpDraft {
  return { prompt: "", attachments: [], updatedAt: 0 };
}

function parseDraft(raw: string | null): FollowUpDraft {
  if (!raw) return emptyDraft();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyDraft();
    const obj = parsed as Record<string, unknown>;
    const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
    const attachments = Array.isArray(obj.attachments)
      ? obj.attachments.filter(isUpload)
      : [];
    const updatedAt =
      typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt)
        ? obj.updatedAt
        : 0;
    return { prompt, attachments, updatedAt };
  } catch {
    return emptyDraft();
  }
}

export function getFollowUpDraft(taskId: string): FollowUpDraft {
  if (!taskId) return emptyDraft();
  try {
    return parseDraft(localStorage.getItem(storageKey(taskId)));
  } catch {
    return emptyDraft();
  }
}

/**
 * Persist a follow-up draft for one task.
 * Empty prompt + no attachments removes the key.
 */
export function setFollowUpDraft(
  taskId: string,
  draft: { prompt: string; attachments?: Upload[] },
): void {
  if (!taskId) return;
  const prompt = draft.prompt ?? "";
  const attachments = draft.attachments ?? [];
  const key = storageKey(taskId);
  try {
    if (!prompt.trim() && attachments.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    const payload: FollowUpDraft = {
      prompt,
      attachments,
      updatedAt: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(payload));
    pruneFollowUpDrafts(taskId);
  } catch {
    // ignore quota / private mode
  }
}

export function clearFollowUpDraft(taskId: string): void {
  if (!taskId) return;
  try {
    localStorage.removeItem(storageKey(taskId));
  } catch {
    // ignore
  }
}

/** Keep only the newest MAX_ENTRIES drafts (plus the just-written one). */
function pruneFollowUpDrafts(keepTaskId: string): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
    }
    if (keys.length <= MAX_ENTRIES) return;

    const ranked = keys
      .map((k) => {
        const taskId = k.slice(KEY_PREFIX.length);
        const d = parseDraft(localStorage.getItem(k));
        return { k, taskId, updatedAt: d.updatedAt };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);

    for (const entry of ranked.slice(MAX_ENTRIES)) {
      if (entry.taskId === keepTaskId) continue;
      localStorage.removeItem(entry.k);
    }
  } catch {
    // ignore
  }
}
