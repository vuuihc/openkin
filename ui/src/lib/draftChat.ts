/** Client-only draft chat slot (one "new chat" at a time). */

const CWD_KEY = "kin_draft_cwd";
const PROMPT_KEY = "kin_draft_prompt";

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

/** Subscribe to draft cwd/prompt changes (cross-component). */
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
