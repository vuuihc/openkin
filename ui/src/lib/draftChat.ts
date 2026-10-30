/** Client-only draft chat slot (one "new chat" at a time). */

import type { Upload } from "../api/client";

const CWD_KEY = "kin_draft_cwd";
const MACHINE_KEY = "kin_draft_machine";
const PROMPT_KEY = "kin_draft_prompt";
const ATTACHMENTS_KEY = "kin_draft_attachments";

const DRAFT_EVENT = "kin:draft";

function notifyDraft(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DRAFT_EVENT));
}

export function getDraftCwd(): string {
  try {
    return localStorage.getItem(CWD_KEY) || "";
  } catch {
    return "";
  }
}

export function setDraftCwd(cwd: string): void {
  try {
    localStorage.setItem(CWD_KEY, cwd);
  } catch {
    // ignore
  }
  notifyDraft();
}

/**
 * The machine the draft is aimed at. Stored next to the cwd because the two
 * only make sense together: a path from another machine with no machine
 * recorded would quietly become a local path.
 */
export function getDraftMachine(): string {
  try {
    return localStorage.getItem(MACHINE_KEY) || "";
  } catch {
    return "";
  }
}

export function setDraftMachine(id: string): void {
  try {
    if (id) localStorage.setItem(MACHINE_KEY, id);
    else localStorage.removeItem(MACHINE_KEY);
  } catch {
    // ignore
  }
  notifyDraft();
}

export function getDraftPrompt(): string {
  try {
    return localStorage.getItem(PROMPT_KEY) || "";
  } catch {
    return "";
  }
}

export function setDraftPrompt(prompt: string): void {
  try {
    if (prompt) localStorage.setItem(PROMPT_KEY, prompt);
    else localStorage.removeItem(PROMPT_KEY);
  } catch {
    // ignore
  }
  notifyDraft();
}

export function clearDraftPrompt(): void {
  try {
    localStorage.removeItem(PROMPT_KEY);
  } catch {
    // ignore
  }
  notifyDraft();
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

export function getDraftAttachments(): Upload[] {
  try {
    const stored = localStorage.getItem(ATTACHMENTS_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter(isUpload) : [];
  } catch {
    return [];
  }
}

export function setDraftAttachments(attachments: Upload[]): void {
  try {
    if (attachments.length > 0) {
      localStorage.setItem(ATTACHMENTS_KEY, JSON.stringify(attachments));
    } else {
      localStorage.removeItem(ATTACHMENTS_KEY);
    }
  } catch {
    // ignore
  }
  notifyDraft();
}

/** Subscribe to draft cwd/prompt/attachment changes (cross-component). */
export function subscribeDraft(fn: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = () => fn();
  window.addEventListener(DRAFT_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(DRAFT_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

/** Always the same path — one draft entry in the sidebar. */
export const DRAFT_PATH = "/new";

/**
 * True when the main area is the draft chat.
 *
 * `/new` always is. `/sessions` is the conversation list on a phone, but on a
 * Mac the sidebar already holds the only list, so the main area shows the
 * draft there — unless the address asks for the archived view, which is a
 * place of its own. The draft's state (cwd, prompt, dock, header) is keyed to
 * this, so a palette row landing on `/sessions` cannot leave the shell
 * thinking no draft is open while a draft is on screen.
 */
export function draftSurfaceActive(pathname: string, wide: boolean): boolean {
  if (pathname === DRAFT_PATH) return true;
  if (!wide) return false;
  // The archived address is a filter of the one sidebar list, not a different
  // main-area surface, so it is still the draft beside it.
  return pathname.replace(/\/+$/, "") === "/sessions";
}
