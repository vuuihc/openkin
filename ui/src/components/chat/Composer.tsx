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
import { useAppStore } from "../../store/appStore";
import { IconFile, IconImage, IconSend, IconStop, IconX } from "../icons";

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
  /** Fired whenever the textarea value changes (for draft persistence). */
  onValueChange?: (value: string) => void;
  /** Available agents for @mention menu. */
  agents?: AgentInfo[];
  /** Current session host; used only for mention role labels. */
  hostAgentId?: string;
  onSubmit: (text: string) => void | Promise<void>;
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
  onValueChange,
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    const capped =
      Number.isFinite(maxH) && maxH > 0 ? Math.min(contentH, maxH) : contentH;
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
    () =>
      available.filter((a) =>
        a.id.toLowerCase().includes(mentionQuery.toLowerCase()),
      ),
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
        const previewUrl = isImageMime(up.mime || f.type)
          ? URL.createObjectURL(f)
          : undefined;
        setAttachments((prev) => [...prev, { ...up, previewUrl }]);
      }
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : tr("composer.uploadFailed");
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
      return prev.filter((a) => a.id !== id);
    });
  }

  /** Append absolute paths so coding CLIs / Kin tools can read the files. */
  function withAttachments(text: string): string {
    if (attachments.length === 0) return text;
    const lines = attachments.map((a) => {
      const label = a.name || a.id;
      return `- ${label}: ${a.path}`;
    }).join("\n");
    const noun =
      attachments.length === 1
        ? isImageMime(attachments[0].mime)
          ? "image"
          : "file"
        : "files";
    const block = `Attached ${noun}:\n${lines}`;
    return text ? `${text}\n\n${block}` : block;
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = value.trim();
    // Allow send while running (insert guide / interrupt). Only hard-disable when parent says so.
    // Sending is allowed with only attachments (no text), but never mid-upload.
    if ((!text && attachments.length === 0) || disabled || busy || stopping || uploading) return;
    const payload = withAttachments(text);
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
    try {
      await onSubmit(payload);
    } catch (err) {
      // Parent handlers usually toast; never let an unhandled rejection
      // leave the composer in a cleared-but-failed state without feedback.
      useAppStore
        .getState()
        .pushToast(
          err instanceof Error ? err.message : "Send failed",
          "error",
        );
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
        next =
          value.slice(0, idx) +
          `@${agentId} ` +
          value.slice(idx + 1 + mentionQuery.length);
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
        setMentionIndex(
          (i) => (i - 1 + mentionMatches.length) % mentionMatches.length,
        );
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
      const next =
        value.slice(0, selectionStart) + "\n" + value.slice(selectionEnd);
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

  return (
    <form onSubmit={submit} className="relative">
      {menu === "slash" && (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-[var(--kin-hairline-strong)] bg-kin-elevated shadow-card overflow-hidden z-20">
          <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
            {tr("composer.slashActions")}
          </div>
          <div className="px-3 py-2.5 text-[13px] text-kin-secondary">
            {tr("composer.slashTip")}
          </div>
        </div>
      )}
      {menu === "mention" && mentionMatches.length > 0 && (
        <div
          className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-[var(--kin-hairline-strong)] bg-kin-elevated shadow-card overflow-hidden z-20"
          role="listbox"
          aria-label={tr("composer.mentionTitle")}
        >
          <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-kin-muted flex items-center justify-between">
            <span>{tr("composer.mentionTitle")}</span>
            <span className="normal-case tracking-normal font-normal text-[10.5px]">
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
                  "w-full flex items-center gap-3 px-3 py-2.5 text-left text-[13px] " +
                  (active
                    ? "bg-kin-blue/15 text-kin-text"
                    : "hover:bg-[var(--kin-fill-strong)]")
                }
                onMouseEnter={() => setMentionIndex(i)}
                onClick={() => insertMention(a.id)}
              >
                <span className="font-mono text-kin-blue font-semibold">
                  @{a.id}
                </span>
                <span className="text-kin-secondary">
                  {agentDisplayName(a.id)}
                  {hostAgentId && a.id === hostAgentId
                    ? ` · ${tr("composer.roleMain")}`
                    : ` · ${tr("composer.roleWorker")}`}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="rounded-[13px] border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-3 py-2.5 focus-within:border-kin-blue/40">
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
                    <img
                      src={src}
                      alt={a.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <>
                      <IconFile size={14} className="text-kin-muted shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[12px] text-kin-text truncate">
                          {a.name}
                        </div>
                        <div className="text-[10.5px] text-kin-muted">
                          {formatBytes(a.size)}
                        </div>
                      </div>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    className={
                      image
                        ? "absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        : "ml-1 w-4 h-4 rounded-full bg-black/40 text-white flex items-center justify-center opacity-70 hover:opacity-100 shrink-0"
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
          placeholder={resolvedPlaceholder}
          className="kin-scroll w-full resize-none bg-transparent text-[14px] leading-[1.45] text-kin-text placeholder:text-kin-muted outline-none min-h-[44px] max-h-[min(40vh,280px)] overflow-y-auto"
        />
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled || busy || stopping || uploading}
            className="w-7 h-7 -ml-1 rounded-lg text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] flex items-center justify-center disabled:opacity-40"
            aria-label={tr("composer.attachFile")}
            title={tr("composer.attachFile")}
          >
            <IconImage size={15} />
          </button>
          {uploading && (
            <span className="text-[11.5px] text-kin-muted">{tr("composer.uploading")}</span>
          )}
          <span className="text-[11.5px] text-kin-muted inline-flex items-center gap-1">
            <kbd className="rounded border border-[var(--kin-hairline-strong)] px-1 font-semibold">
              @
            </kbd>
            {tr("composer.agent")}
          </span>
          <span className="text-[11.5px] text-kin-muted hidden sm:inline-flex items-center gap-1">
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
              className="ml-auto w-7 h-7 rounded-lg bg-[rgba(255,69,58,.16)] text-[#ff8a80] flex items-center justify-center disabled:opacity-40 border border-[rgba(255,69,58,.35)]"
              aria-label={tr("composer.stop")}
              title={tr("composer.stop")}
            >
              <IconStop size={13} strokeWidth={2} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={
                disabled || busy || stopping || uploading ||
                (!value.trim() && attachments.length === 0)
              }
              className="ml-auto w-7 h-7 rounded-lg bg-kin-blue text-white flex items-center justify-center disabled:opacity-40"
              aria-label={tr("composer.send")}
            >
              <IconSend size={15} strokeWidth={2} />
            </button>
          )}
          {running && value.trim() ? (
            <button
              type="submit"
              disabled={disabled || busy || stopping}
              className="w-7 h-7 rounded-lg bg-kin-blue text-white flex items-center justify-center disabled:opacity-40"
              aria-label={tr("composer.sendGuide")}
              title={tr("composer.sendGuide")}
            >
              <IconSend size={15} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      </div>
    </form>
  );
}
