import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, Upload } from "../../api/client";
import {
  authenticatedURL,
  formatBytes,
  isImageMime,
  MAX_UPLOAD_BYTES,
  uploadFile,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { agentDisplayName } from "../../lib/agentMention";
import { agentCatalogState } from "../../lib/agentCatalog";
import { useAppStore } from "../../store/appStore";
import { IconAlert, IconFile, IconImage, IconSend, IconSpinner, IconStop, IconX } from "../icons";

type Props = {
  placeholder?: string;
  disabled?: boolean;
  busy?: boolean;
  /** Current round is running — show Stop and allow insert-guide submits. */
  running?: boolean;
  stopping?: boolean;
  onStop?: () => void | Promise<void>;
  /** Prefill once (e.g. deep-link /new?q=). */
  initialValue?: string;
  /** Restore already-uploaded files when a draft composer remounts. */
  initialAttachments?: Upload[];
  /** Fired whenever the textarea value changes (for draft persistence). */
  onValueChange?: (value: string) => void;
  /** Fired whenever uploaded attachments change (for draft persistence). */
  onAttachmentsChange?: (attachments: Upload[]) => void;
  /** Available agents for @mention menu. */
  agents?: AgentInfo[];
  /** Current session host; used only for mention role labels. */
  hostAgentId?: string;
  /**
   * Fired on send. `interrupt` asks the daemon to cut the running round short and
   * answer this message next instead of at the turn boundary — which also denies
   * the round's pending approvals, so it is only ever set by the explicit action.
   */
  onSubmit: (text: string, opts?: { interrupt?: boolean }) => void | Promise<void>;
};

type Attachment = Upload & {
  /** Local blob URL for immediate image preview (no auth needed). */
  previewUrl?: string;
};

/**
 * Chat composer: @agent menu for multi-agent delegation.
 * Enter sends; Shift/⌘/Ctrl+Enter inserts a newline.
 * Arrow keys navigate the @mention menu; Enter selects; Esc closes.
 */
export default function Composer({
  placeholder,
  disabled,
  busy,
  running,
  stopping,
  onStop,
  initialValue = "",
  initialAttachments = [],
  onValueChange,
  onAttachmentsChange,
  agents = [],
  hostAgentId,
  onSubmit,
}: Props) {
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const resolvedPlaceholder = placeholder ?? tr("composer.placeholder");
  const [value, setValue] = useState(initialValue);
  const [menu, setMenu] = useState<"slash" | "mention" | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);
  const [uploading, setUploading] = useState(false);
  const [focused, setFocused] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Which of the two send buttons was pressed. Both are submit buttons in one
  // form, and the form's submit event does not say which — Enter lands here too,
  // and Enter means the default action, which is queueing.
  const submitIntent = useRef<"queue" | "interrupt">("queue");

  useEffect(() => {
    if (initialValue) setValue(initialValue);
  }, [initialValue]);

  /** Grow with content up to CSS max-height, then scroll. Shrinks when cleared. */
  function adjustTextareaHeight() {
    const el = textareaRef.current;
    if (!el) return;
    // Collapse first so scrollHeight tracks the true content size.
    el.style.height = "auto";
    const maxH = parseFloat(getComputedStyle(el).maxHeight);
    const contentH = el.scrollHeight;
    const capped = Number.isFinite(maxH) && maxH > 0 ? Math.min(contentH, maxH) : contentH;
    el.style.height = `${capped}px`;
    // Only show a scrollbar once we actually hit the cap.
    el.style.overflowY = contentH > capped ? "auto" : "hidden";
  }

  useEffect(() => {
    adjustTextareaHeight();
  }, [value]);

  // Re-clamp when the viewport (and thus max-height: 40vh) changes.
  useEffect(() => {
    const onResize = () => adjustTextareaHeight();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Revoke blob previews when attachments are removed / unmounted.
  useEffect(() => {
    return () => {
      for (const a of attachments) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup on unmount only
  }, []);

  const available = agents.filter((a) => a.available);
  const mentionMatches = useMemo(
    () => available.filter((a) => a.id.toLowerCase().includes(mentionQuery.toLowerCase())),
    [available, mentionQuery],
  );

  // Keep highlighted index in range when the filtered list changes.
  useEffect(() => {
    setMentionIndex((i) => {
      if (mentionMatches.length === 0) return 0;
      return Math.min(i, mentionMatches.length - 1);
    });
  }, [mentionMatches.length, mentionQuery]);

  async function addFiles(files: FileList | File[] | null) {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    setUploading(true);
    try {
      for (const f of list) {
        if (f.size > MAX_UPLOAD_BYTES) {
          pushToast(
            tr("composer.fileTooLarge", {
              name: f.name || "file",
              max: String(MAX_UPLOAD_BYTES >> 20),
            }),
            "error",
          );
          continue;
        }
        const up = await uploadFile(f);
        const previewUrl = isImageMime(up.mime || f.type) ? URL.createObjectURL(f) : undefined;
        setAttachments((prev) => {
          const next = [...prev, { ...up, previewUrl }];
          onAttachmentsChange?.(next);
          return next;
        });
      }
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : tr("composer.uploadFailed");
      // Prefer short toast; strip raw JSON bodies.
      const clean = msg.replace(/^\{.*"error"\s*:\s*"([^"]+)".*$/s, "$1");
      pushToast(clean || tr("composer.uploadFailed"), "error");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      const next = prev.filter((a) => a.id !== id);
      onAttachmentsChange?.(next);
      return next;
    });
  }

  /** Append absolute paths so coding CLIs / Kin tools can read the files. */
  function withAttachments(text: string): string {
    if (attachments.length === 0) return text;
    const lines = attachments
      .map((a) => {
        const label = a.name || a.id;
        return `- ${label}: ${a.path}`;
      })
      .join("\n");
    const noun =
      attachments.length === 1 ? (isImageMime(attachments[0].mime) ? "image" : "file") : "files";
    const block = `Attached ${noun}:\n${lines}`;
    return text ? `${text}\n\n${block}` : block;
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = value.trim();
    // Allow send while running: a running task queues the message and answers it
    // when the round ends. Only hard-disable when parent says so.
    // Sending is allowed with only attachments (no text), but never mid-upload.
    if ((!text && attachments.length === 0) || disabled || busy || stopping || uploading) return;
    // Read and clear before the await: the intent belongs to the send that is
    // happening now, and a later Enter must not inherit the interrupt.
    const interrupt = submitIntent.current === "interrupt";
    submitIntent.current = "queue";
    const payload = withAttachments(text);
    // Snapshot so a failed send can restore the composer + draft persistence.
    const prevValue = value;
    const prevAttachments = attachments;
    // Revoke previews after we capture payload.
    for (const a of attachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    setValue("");
    onValueChange?.("");
    setMenu(null);
    setMentionQuery("");
    setMentionIndex(0);
    setAttachments([]);
    onAttachmentsChange?.([]);
    try {
      await onSubmit(payload, interrupt ? { interrupt: true } : undefined);
    } catch (err) {
      // Restore text/attachments so the user does not lose a failed follow-up.
      // Drop blob previews (already revoked); remote upload urls still work.
      const restored = prevAttachments.map(({ previewUrl: _p, ...rest }) => rest);
      setValue(prevValue);
      onValueChange?.(prevValue);
      setAttachments(restored);
      onAttachmentsChange?.(restored);
      // Parent handlers usually toast; never let an unhandled rejection
      // leave the composer in a cleared-but-failed state without feedback.
      useAppStore.getState().pushToast(err instanceof Error ? err.message : "Send failed", "error");
    }
  }

  /** Match @token immediately before the caret (not only end-of-string). */
  function onChange(v: string, caret?: number) {
    setValue(v);
    onValueChange?.(v);
    const upto = caret == null ? v : v.slice(0, caret);
    const at = upto.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
    if (at) {
      setMentionQuery(at[1] ?? "");
      setMenu("mention");
    } else if (v === "/") {
      setMenu("slash");
    } else if (menu === "slash" && !v.startsWith("/")) {
      setMenu(null);
    } else if (menu === "mention") {
      setMenu(null);
      setMentionQuery("");
      setMentionIndex(0);
    }
    if (v.length === 0) {
      setMenu(null);
      setMentionQuery("");
      setMentionIndex(0);
    }
  }

  function insertMention(agentId: string) {
    // Prefer replacing the @partial immediately before caret / end.
    const re = /(?:^|\s)@([a-zA-Z0-9_-]*)$/;
    let next = value;
    if (re.test(value)) {
      next = value.replace(re, (m) => {
        const lead = m.startsWith(" ") || m.startsWith("\n") ? m[0] : "";
        return `${lead}@${agentId} `;
      });
    } else {
      // Mid-string: replace the active query token if present.
      const idx = value.toLowerCase().lastIndexOf(`@${mentionQuery.toLowerCase()}`);
      if (idx >= 0) {
        next = value.slice(0, idx) + `@${agentId} ` + value.slice(idx + 1 + mentionQuery.length);
      } else {
        next = `${value}@${agentId} `;
      }
    }
    setValue(next);
    onValueChange?.(next);
    setMenu(null);
    setMentionQuery("");
    setMentionIndex(0);
    // Restore focus so the user can keep typing.
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      adjustTextareaHeight();
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Mention menu keyboard navigation.
    if (menu === "mention" && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        const pick = mentionMatches[mentionIndex] ?? mentionMatches[0];
        if (pick) insertMention(pick.id);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const pick = mentionMatches[mentionIndex] ?? mentionMatches[0];
        if (pick) insertMention(pick.id);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        setMentionQuery("");
        setMentionIndex(0);
        return;
      }
    }

    // Enter → send. Shift+Enter → newline (textarea default).
    // ⌘/Ctrl+Enter → newline (inserted manually; textareas don't by default).
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart, selectionEnd } = el;
      const next = value.slice(0, selectionStart) + "\n" + value.slice(selectionEnd);
      onChange(next, selectionStart + 1);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = selectionStart + 1;
        adjustTextareaHeight();
      });
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  const expanded = Boolean(value.trim()) || attachments.length > 0 || focused || uploading;

  return (
    <form onSubmit={submit} className="relative">
      {menu === "slash" && (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl bg-kin-elevated shadow-e2 overflow-hidden z-20">
          <div className="px-3 py-2 text-caption font-semibold uppercase tracking-label text-kin-muted">
            {tr("composer.slashActions")}
          </div>
          <div className="px-3 py-2.5 text-strong text-kin-secondary">
            {tr("composer.slashTip")}
          </div>
        </div>
      )}
      {menu === "mention" && mentionMatches.length > 0 && (
        <div
          className="absolute bottom-full left-0 right-0 mb-2 rounded-xl bg-kin-elevated shadow-e2 overflow-hidden z-20"
          role="listbox"
          aria-label={tr("composer.mentionTitle")}
        >
          <div className="px-3 py-2 text-caption font-semibold uppercase tracking-label text-kin-muted flex items-center justify-between">
            <span>{tr("composer.mentionTitle")}</span>
            <span className="normal-case tracking-normal font-normal text-caption">
              ↑↓ {tr("composer.mentionNav")} · ↵ {tr("composer.mentionSelect")}
            </span>
          </div>
          {mentionMatches.map((a, i) => {
            const active = i === mentionIndex;
            return (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={active}
                className={
                  "w-full flex items-center gap-3 px-3 py-2.5 text-left text-strong " +
                  (active ? "bg-kin-blue/15 text-kin-text" : "hover:bg-[var(--kin-fill-strong)]")
                }
                onMouseEnter={() => setMentionIndex(i)}
                onClick={() => insertMention(a.id)}
              >
                <span className="font-mono text-kin-blue-ink font-semibold">@{a.id}</span>
                <span className="text-kin-secondary">
                  {agentDisplayName(a.id)}
                  {hostAgentId && a.id === hostAgentId
                    ? ` · ${tr("composer.roleMain")}`
                    : ` · ${tr("composer.roleWorker")}`}
                  {agentCatalogState(a) === "generic" ? ` · ${tr("agentCatalog.generic")}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div
        className={[
          "rounded-xl border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] focus-within:border-kin-blue/40 transition-[padding] duration-150",
          expanded ? "px-3 py-2.5" : "px-2.5 py-1.5",
        ].join(" ")}
      >
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => {
              const image = isImageMime(a.mime);
              const src = a.previewUrl || authenticatedURL(a.url);
              return (
                <div
                  key={a.id}
                  className={
                    image
                      ? "relative group w-14 h-14 rounded-lg overflow-hidden border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill-strong)]"
                      : "relative group flex items-center gap-2 max-w-[220px] rounded-lg border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill-strong)] px-2 py-1.5"
                  }
                  title={`${a.name} (${formatBytes(a.size)})`}
                >
                  {image ? (
                    <img src={src} alt={a.name} className="w-full h-full object-cover" />
                  ) : (
                    <>
                      <IconFile size={14} className="text-kin-muted shrink-0" />
                      <div className="min-w-0">
                        <div className="text-body text-kin-text truncate">{a.name}</div>
                        <div className="text-caption text-kin-muted">{formatBytes(a.size)}</div>
                      </div>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    data-touch-mini
                    className={
                      // `text-white` on a black scrim, not `-on-brand`: the
                      // backdrop is the user's own image, not a token fill, and
                      // white-over-scrim is the one pairing that survives an
                      // arbitrary photograph in either scheme.
                      image
                        ? "touch-mini absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        : "touch-mini ml-1 w-4 h-4 rounded-full bg-black/40 text-white flex items-center justify-center opacity-70 hover:opacity-100 shrink-0"
                    }
                    aria-label={tr("composer.removeFile")}
                    title={tr("composer.removeFile")}
                  >
                    <IconX size={10} strokeWidth={2.5} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void addFiles(e.target.files)}
        />
        <div className={expanded ? "flex flex-col" : "flex items-center gap-1.5"}>
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={disabled || busy || stopping}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length > 0) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            onChange={(e) => {
              onChange(e.target.value, e.target.selectionStart ?? undefined);
              // Sync height in the same frame as typing for snappy growth.
              requestAnimationFrame(adjustTextareaHeight);
            }}
            onClick={(e) =>
              onChange(e.currentTarget.value, e.currentTarget.selectionStart ?? undefined)
            }
            onKeyUp={(e) => {
              // Don't re-open / clobber menu index after Arrow keys handled in keydown.
              if (
                menu === "mention" &&
                (e.key === "ArrowDown" ||
                  e.key === "ArrowUp" ||
                  e.key === "Enter" ||
                  e.key === "Tab" ||
                  e.key === "Escape")
              ) {
                return;
              }
              onChange(e.currentTarget.value, e.currentTarget.selectionStart ?? undefined);
            }}
            onKeyDown={onKeyDown}
            onInput={adjustTextareaHeight}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={resolvedPlaceholder}
            className={[
              "kin-scroll resize-none bg-transparent text-strong text-kin-text placeholder:text-kin-muted outline-none max-h-[min(40vh,280px)] overflow-y-auto transition-[min-height] duration-150",
              expanded ? "w-full min-h-11 leading-ui" : "flex-1 min-w-0 min-h-7 leading-ui",
            ].join(" ")}
          />
          <div
            className={["flex items-center gap-1.5", expanded ? "mt-2" : "mt-0 flex-none"].join(
              " ",
            )}
          >
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={disabled || busy || stopping || uploading}
              className={[
                // 44pt while the phone shell is in charge, desktop size from `md`
                // up. A 24px target is not hittable with a thumb. (`sm:w-6` alone
                // would not restore the desktop size: the floor is a two-class
                // selector and outranks it.)
                "rounded-lg text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] flex items-center justify-center disabled:opacity-40",
                expanded ? "w-11 h-11 sm:w-7 sm:h-7 sm:-ml-1" : "w-11 h-11 sm:w-6 sm:h-6",
              ].join(" ")}
              aria-label={tr("composer.attachFile")}
              title={tr("composer.attachFile")}
            >
              <IconImage size={expanded ? 15 : 14} />
            </button>
            {uploading && (
              <span className="text-caption text-kin-muted">{tr("composer.uploading")}</span>
            )}
            <span
              className={[
                "text-caption text-kin-muted items-center gap-1",
                expanded ? "inline-flex" : "hidden",
              ].join(" ")}
            >
              <kbd className="rounded border border-[var(--kin-hairline-strong)] px-1 font-semibold">
                @
              </kbd>
              {tr("composer.agent")}
            </span>
            <span
              className={[
                "text-caption text-kin-muted items-center gap-1",
                expanded ? "hidden sm:inline-flex" : "hidden",
              ].join(" ")}
            >
              <kbd className="rounded border border-[var(--kin-hairline-strong)] px-1 font-semibold">
                ⌘↵
              </kbd>
              {tr("composer.send")}
            </span>
            {running && onStop ? (
              <button
                type="button"
                onClick={() => void onStop()}
                disabled={stopping || busy}
                className="ml-auto w-11 h-11 sm:w-7 sm:h-7 rounded-lg bg-kin-red/15 text-kin-red-ink flex items-center justify-center disabled:opacity-40 border border-kin-red/35"
                aria-label={tr("composer.stop")}
                title={tr("composer.stop")}
              >
                <IconStop size={13} strokeWidth={2} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={
                  disabled ||
                  busy ||
                  stopping ||
                  uploading ||
                  (!value.trim() && attachments.length === 0)
                }
                className="ml-auto w-11 h-11 sm:w-7 sm:h-7 rounded-lg bg-kin-blue text-kin-on-brand flex items-center justify-center disabled:opacity-40"
                aria-label={busy ? tr("composer.sending") : tr("composer.send")}
              >
                {busy ? (
                  <IconSpinner size={15} strokeWidth={2} />
                ) : (
                  <IconSend size={15} strokeWidth={2} />
                )}
              </button>
            )}
            {running && value.trim() ? (
              <>
                {/* Explicit, and second: cutting the round short also denies the
                    approvals it is waiting on, so it is never the easy accident
                    next to the default send. */}
                <button
                  type="submit"
                  onClick={() => {
                    submitIntent.current = "interrupt";
                  }}
                  disabled={disabled || busy || stopping}
                  className="w-11 h-11 sm:w-7 sm:h-7 rounded-lg border border-kin-orange/40 bg-kin-orange/15 text-kin-orange-ink flex items-center justify-center disabled:opacity-40"
                  aria-label={tr("composer.interruptSend")}
                  title={tr("composer.interruptSend")}
                >
                  <IconAlert size={13} strokeWidth={2} />
                </button>
                <button
                  type="submit"
                  onClick={() => {
                    submitIntent.current = "queue";
                  }}
                  disabled={disabled || busy || stopping}
                  className="w-11 h-11 sm:w-7 sm:h-7 rounded-lg bg-kin-blue text-kin-on-brand flex items-center justify-center disabled:opacity-40"
                  aria-label={tr("composer.send")}
                  title={tr("composer.sendQueuedHint")}
                >
                  {busy ? (
                    <IconSpinner size={15} strokeWidth={2} />
                  ) : (
                    <IconSend size={15} strokeWidth={2} />
                  )}
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </form>
  );
}
