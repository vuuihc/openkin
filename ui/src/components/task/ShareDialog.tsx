import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createSessionShare,
  getSessionShare,
  revokeSessionShare,
  ApiError,
  type SessionShareState,
} from "../../api/client";
import { useT } from "../../i18n/react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Share one conversation as a link anyone can read.
 *
 * The daemon keeps only a digest of the token, so the URL exists in exactly one
 * place: the response that minted it. That is why this surface says so plainly
 * instead of pretending the link can be shown again later — a person who closes
 * the dialog without copying it needs to know that creating another one is the
 * way back, and that it closes the one they lost.
 */
export default function ShareDialog({
  open,
  onClose,
  taskId,
}: {
  open: boolean;
  onClose: () => void;
  taskId: string;
}) {
  const tr = useT();
  const [state, setState] = useState<SessionShareState | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // The parent passes a fresh closure each render; depending on it would tear
  // the effect down mid-dialog and restore focus to the opener while the person
  // is still typing in the link field.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // A read that resolves after a create would otherwise undo it: the create
  // mints a link, and a slower "is anything live?" answer from before the mint
  // says no. Only the newest request may write state.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const next = await getSessionShare(taskId);
      if (seq !== loadSeq.current) return;
      setState(next);
      // Someone revoked it from another device: the URL this dialog is holding
      // is dead, and showing it beside "Create link" would invite a copy of a
      // link that answers 404.
      if (!next.active) setUrl("");
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setState(null);
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [taskId]);

  // The dialog stays mounted while the reader moves between tasks, so a link
  // minted for the previous one has to go: the state below is about the new
  // task, and a URL beside it that opens a different conversation is the worst
  // thing this surface could show.
  useEffect(() => {
    setUrl("");
  }, [taskId]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCopied(false);
    // A URL minted in this session survives a close/reopen; the daemon cannot
    // return it again, and dropping it here would be the one place it is lost.
    setState(null);
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A frame, not synchronously: the panel mounts in this commit, and focusing
    // before it is laid out scrolls the page to it.
    const focusTimer = window.setTimeout(() => panelRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      // `aria-modal` claims the page behind is inert, so Tab must not walk into
      // it. Same light trap as `Sheet`'s, for the same reason.
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === panelRef.current)) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown, true);
      restoreRef.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  async function create() {
    setBusy(true);
    setError(null);
    // Any read still in flight describes the world before this link existed.
    loadSeq.current++;
    try {
      const created = await createSessionShare(taskId);
      // The link is opened by whoever receives it, so it is built from the
      // address this console was reached on — the Hub when the phone shared it,
      // the machine itself when the desktop did.
      setUrl(`${window.location.origin}/s/${created.token}`);
      setState({ active: true, created_at: created.created_at, expires_at: created.expires_at });
      // The button that was just pressed is gone (it became "Revoke link"), and
      // a keyboard user would otherwise be dropped to the body. The field
      // selects on focus, so the copy is one keystroke away.
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await revokeSessionShare(taskId);
      setState({ active: false });
      setUrl("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        throw new Error("clipboard unavailable");
      }
      setCopied(true);
    } catch {
      // Denied or unavailable: select the text so the reader can copy it the
      // old way rather than being told "copied" when nothing was.
      inputRef.current?.select();
      setCopied(false);
    }
  }

  const active = state?.active === true;
  // A failed read is not "still checking": the error line below says what
  // happened, and a status that keeps saying "Checking…" under it reads as a
  // second, contradictory fact.
  const status =
    state !== null
      ? active
        ? tr("task.shareActive")
        : tr("task.shareInactive")
      : error
        ? null
        : tr("task.shareLoading");

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        className="kin-scrim-enter absolute inset-0 bg-black/55"
      />
      {/* `kin-sheet-surface` rather than a panel colour plus a hairline: the
          panel is a step above a full-screen scrim, so the drop separates it
          and a 1px edge would be the same box drawn twice. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={tr("task.shareTitle")}
        tabIndex={-1}
        className="kin-sheet-surface kin-sheet-enter relative z-10 flex max-h-[85dvh] w-full flex-col overflow-y-auto rounded-t-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none md:max-w-md md:rounded-2xl md:pb-4 kin-scroll"
      >
        <h2 className="text-subtitle font-semibold text-kin-text">{tr("task.shareTitle")}</h2>
        <p className="mt-1 text-body text-kin-muted">{tr("task.shareDesc")}</p>

        {url ? (
          <div className="mt-3 space-y-2">
            <label className="block">
              <span className="text-caption font-medium uppercase tracking-label text-kin-muted">
                {tr("task.shareLinkLabel")}
              </span>
              <input
                ref={inputRef}
                readOnly
                value={url}
                onFocus={(event) => event.target.select()}
                aria-label={tr("task.shareLinkLabel")}
                className="kin-input mt-1 w-full font-mono text-body"
              />
            </label>
            <p className="text-caption text-kin-muted">{tr("task.shareOnlyOnce")}</p>
            <button
              type="button"
              onClick={() => void copy()}
              className="kin-btn-secondary min-h-11 w-full"
            >
              {copied ? tr("task.shareCopied") : tr("task.shareCopy")}
            </button>
          </div>
        ) : (
          status && (
            <p className="mt-3 text-body text-kin-secondary" role="status">
              {status}
            </p>
          )
        )}

        {error && <p className="mt-2 text-body text-kin-red-ink">{error}</p>}

        <div className="mt-4 flex flex-wrap gap-2">
          {!active ? (
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              className="kin-btn-primary min-h-11 flex-1 disabled:opacity-50"
            >
              {busy ? tr("task.shareCreating") : tr("task.shareCreate")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void revoke()}
              disabled={busy}
              className="min-h-11 flex-1 rounded-xl border border-kin-red/35 px-4 text-strong font-medium text-kin-red-ink hover:bg-kin-red/10 disabled:opacity-50"
            >
              {busy ? tr("task.shareRevoking") : tr("task.shareRevoke")}
            </button>
          )}
          <button type="button" onClick={onClose} className="kin-btn-secondary min-h-11">
            {tr("common.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
