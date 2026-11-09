import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AgentInfo, Upload } from "../../api/client";
import {
  authenticatedURL,
  formatBytes,
  isImageMime,
  MAX_UPLOAD_BYTES,
  uploadFile,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { isImeKeyEvent } from "../../lib/ime";
import { filterRoles, insertRole, type AgentRole } from "../../lib/agentRoles";
import { agentDisplayName } from "../../lib/agentMention";
import { agentCatalogState } from "../../lib/agentCatalog";
import { useAppStore } from "../../store/appStore";
import {
  IconAlert,
  IconFile,
  IconImage,
  IconPlus,
  IconSend,
  IconSpinner,
  IconStop,
  IconX,
} from "../icons";

/**
 * An error a submit handler can reject with to say it has already dealt with
 * the composer — so the failure path must not restore the text the send
 * cleared. Editing a queued message refills the composer while a send is in
 * flight, and that text belongs to the refill, not to the failed send.
 */
export type SubmitFailure = Error & { keepComposer?: boolean };

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
  /**
   * Bumped when the caller moved text into the composer from somewhere else —
   * editing a queued message, say. The textarea takes the focus, so the next
   * keystroke lands where the person is looking. Setting a textarea's value
   * leaves its caret at the end, so the edit starts at the end of the message.
   * Zero is the initial render and focuses nothing.
   *
   * A phone may not raise its keyboard for this: the focus runs after a network
   * answer, and iOS only opens the keyboard from a gesture. The text is there
   * either way, and tapping it is one tap.
   */
  focusSignal?: number;
  /** Restore already-uploaded files when a draft composer remounts. */
  initialAttachments?: Upload[];
  /** Fired whenever the textarea value changes (for draft persistence). */
  onValueChange?: (value: string) => void;
  /** Fired whenever uploaded attachments change (for draft persistence). */
  onAttachmentsChange?: (attachments: Upload[]) => void;
  /** Available agents for @mention menu. */
  agents?: AgentInfo[];
  /**
   * Saved prompt shortcuts, listed by the `/` menu. A pick writes the role's
   * text into the draft, so the transcript shows exactly what the agent was
   * told — the same rule the new-chat role picker follows.
   *
   * `null` means the list is not known yet: the daemon has not answered. That
   * is not the same as an empty list, and the menu must not tell someone their
   * saved roles do not exist while the read is still in flight or has failed.
   */
  roles?: readonly AgentRole[] | null;
  /** Current session host; used only for mention role labels. */
  hostAgentId?: string;
  /**
   * Searches the task's workspace for files matching the text typed after `@`.
   *
   * Absent when there is no workspace to search — a task that has not started,
   * or a page that has no task at all — and then the menu offers agents only.
   * A search that fails is not an empty answer: the file section is dropped
   * rather than shown with nothing in it, because an empty section reads as
   * "this workspace has no such file".
   */
  fileSearch?: (query: string) => Promise<string[]>;
  /**
   * The phone's run-config face, rendered between the attach control and the
   * send control on the composer's own footer row. It is hidden from `md` up,
   * where the strip under the composer names the model, the mode and the
   * project — a second copy of the same two controls would be one too many
   * ways to change them. Between `sm` and `md` the card is already the flat
   * desktop shape and the face rides along in that row: the strip does not
   * exist yet at that width, and a control nobody can see is worse than one
   * whose form does not quite match the row it sits in.
   */
  footer?: ReactNode;
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

/** One row of the @ menu: a delegation, or a file to point the agent at. */
type MentionOption =
  { kind: "agent"; key: string; agent: AgentInfo } | { kind: "file"; key: string; path: string };

/** How long typing settles before the workspace is asked. */
const FILE_SEARCH_DEBOUNCE_MS = 200;

/**
 * The `@token` immediately before the caret.
 *
 * Anything but whitespace belongs to the token, because a path is not
 * restricted to ASCII: `@文档/说明.md` is a query a phone user will type. What
 * ends a query is decided by the tail below, not by the class.
 */
const MENTION_TOKEN_RE = /(?:^|\s)@([^\s@]*)$/;

/**
 * A token that can still grow into a path.
 *
 * A sentence-ending `@claude.` is prose, and the menu must not stay open over
 * it: Enter belongs to the message then, not to a suggestion. The tail is a
 * name character or a path separator; punctuation — `.`, `,`, `?`, a Chinese
 * full stop, a closing bracket — says the mention is finished.
 */
const MENTION_TAIL_RE = /[\p{L}\p{N}_/-]$/u;

/** Whether a just-typed `@token` is still asking to be completed. */
function isMentionQuery(token: string): boolean {
  return token === "" || MENTION_TAIL_RE.test(token);
}

/**
 * The draft as a slash token: a leading `/` and a query with no whitespace.
 *
 * A space means the person is writing prose — "or /rev" is a sentence — and
 * Enter belongs to the message again. A path such as `/usr/bin` is one token,
 * so it still opens the menu and simply matches no role; the menu says so and
 * Enter sends it. The menu opens on any paste that is still one token, not only
 * on the exact "/" keystroke.
 */
const SLASH_TOKEN_RE = /^\/(\S*)$/;

/** The list a composer with no roles prop filters: nothing to offer. */
const NO_ROLES: readonly AgentRole[] = [];

/** The first non-empty line of a saved prompt, for the menu's second line. */
function rolePreview(prompt: string): string {
  for (const line of prompt.split("\n")) {
    const text = line.trim();
    if (text) return text;
  }
  return "";
}

/**
 * Chat composer: @agent menu for multi-agent delegation.
 * Enter inserts a newline on every keyboard; ⌘/Ctrl+Enter sends.
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
  focusSignal = 0,
  onValueChange,
  onAttachmentsChange,
  agents = [],
  roles = [],
  hostAgentId,
  fileSearch,
  footer,
  onSubmit,
}: Props) {
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const resolvedPlaceholder = placeholder ?? tr("composer.placeholder");
  const [value, setValue] = useState(initialValue);
  const [menu, setMenu] = useState<"slash" | "mention" | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [fileMatches, setFileMatches] = useState<string[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
  // Which query the newest file search belongs to. An answer that arrives
  // after the caret moved on is stale, and stale answers are dropped.
  const fileSearchSeq = useRef(0);
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);
  const [uploading, setUploading] = useState(false);
  const [focused, setFocused] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionListRef = useRef<HTMLDivElement>(null);
  const slashListRef = useRef<HTMLDivElement>(null);
  // Which of the two send buttons was pressed. Both are submit buttons in one
  // form, and the form's submit event does not say which — Enter lands here too,
  // and Enter means the default action, which is queueing.
  const submitIntent = useRef<"queue" | "interrupt">("queue");
  /**
   * The key a menu answered in keydown. Its keyup must not re-read the draft:
   * the menu the key just closed (Escape) — or the one a pick replaced with a
   * prompt that itself looks like a token — would open again.
   */
  const consumedKey = useRef("");
  /**
   * The slash draft Escape declined. A caret move keeps the same value, and
   * the dismissal has to survive it; typing changes the value and asks again.
   */
  const dismissedSlash = useRef<string | null>(null);

  useEffect(() => {
    // The empty string is a value, not an absence: taking a role back out of
    // the draft asks the composer to show the cleared text, and a truthiness
    // check left the old role on screen while the draft behind it said
    // otherwise.
    setValue(initialValue);
    // A value that arrives from outside the composer is not typing. A menu
    // still pointing at the old token would pick into text it never saw — the
    // new-chat page's role row replaces the draft exactly like this. The one
    // external value that keeps a menu open is an echo of the draft already on
    // screen (the task page re-reads its saved draft on every render); a token
    // shape alone is not enough, because the same shape with a different query
    // is still text the menu never saw.
    if (initialValue !== value) {
      if (menu === "slash") closeSlash();
      else if (menu === "mention") setMenu(null);
    }
    // Runs on the value, not on the menu: a menu change must not rewrite the
    // draft the person is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue]);

  // A focus signal asks for the caret to come here. The text that came with it
  // arrives through `initialValue`, and setting a textarea's value puts its
  // caret at the end by definition, so the focus is the whole job.
  useEffect(() => {
    if (!focusSignal) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [focusSignal]);

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
  const agentMatches = useMemo(
    () => available.filter((a) => a.id.toLowerCase().includes(mentionQuery.toLowerCase())),
    [available, mentionQuery],
  );

  // A file search asks the workspace, which may be another machine: it waits
  // for typing to settle, and only the answer to the latest query lands — the
  // earlier one is a different question and the caret has moved past it.
  useEffect(() => {
    const query = mentionQuery.trim();
    const seq = ++fileSearchSeq.current;
    if (menu !== "mention" || !fileSearch || query === "") {
      setFileMatches((prev) => (prev.length === 0 ? prev : []));
      setFileSearching(false);
      return;
    }
    // The previous answer was to a shorter query. Keeping it on screen would
    // leave rows selectable that the person has already typed past.
    setFileMatches((prev) => (prev.length === 0 ? prev : []));
    setFileSearching(true);
    const timer = window.setTimeout(() => {
      void fileSearch(query)
        .then((files) => {
          if (seq === fileSearchSeq.current) setFileMatches(files);
        })
        .catch(() => {
          // No checkout here, or the machine that has one is away. The menu
          // offers no file section rather than an empty one.
          if (seq === fileSearchSeq.current) setFileMatches([]);
        })
        .finally(() => {
          if (seq === fileSearchSeq.current) setFileSearching(false);
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [mentionQuery, menu, fileSearch]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = agentMatches.map((a) => ({
      kind: "agent",
      key: `agent:${a.id}`,
      agent: a,
    }));
    for (const path of fileMatches) options.push({ kind: "file", key: `file:${path}`, path });
    return options;
  }, [agentMatches, fileMatches]);

  // A new query is a new list, so the highlight starts at its best row rather
  // than at an index that happened to point at the old list's row three.
  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  // Keep highlighted index in range when the list changes.
  useEffect(() => {
    setMentionIndex((i) => {
      if (mentionOptions.length === 0) return 0;
      return Math.min(i, mentionOptions.length - 1);
    });
  }, [mentionOptions.length]);

  // Arrow keys move the highlight, and the list may be taller than the space
  // above the composer — a phone's keyboard leaves little of it. The row being
  // chosen has to be the row on screen.
  useEffect(() => {
    const active = mentionListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    // jsdom lays nothing out and has no scrollIntoView; a browser has both.
    active?.scrollIntoView?.({ block: "nearest" });
  }, [mentionIndex, mentionOptions.length]);

  // The `/` menu lists the saved prompt shortcuts, narrowed as the token grows.
  // An unknown list (`null`) offers nothing, but it does not claim to be empty.
  const roleList = roles ?? NO_ROLES;
  const slashMatches = useMemo(() => filterRoles(roleList, slashQuery), [roleList, slashQuery]);

  // A new query is a new list, so the highlight starts at its best row.
  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  // Keep the highlight in range when the list changes: the roles can arrive
  // after the menu opened, and a save can replace them while it stays open.
  useEffect(() => {
    setSlashIndex((i) => (slashMatches.length === 0 ? 0 : Math.min(i, slashMatches.length - 1)));
  }, [slashMatches.length]);

  // Same rule as the mention list: the chosen row has to be on screen.
  useEffect(() => {
    const active = slashListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView?.({ block: "nearest" });
  }, [slashIndex, slashMatches.length]);

  function closeSlash() {
    // Any close but Escape is a new situation when the menu reopens; Escape
    // records its own dismissal after closing (see onKeyDown).
    dismissedSlash.current = null;
    setMenu(null);
    setSlashQuery("");
    setSlashIndex(0);
  }

  /**
   * Put the highlighted prompt shortcut into the draft.
   *
   * The slash token is the whole draft while the menu is open, so the role's
   * text replaces it. The draft is the truth: the transcript shows exactly
   * this text, and editing it afterwards is allowed — the same contract as the
   * new-chat role picker.
   */
  function pickSlashRole(index = slashIndex) {
    const role = slashMatches[index] ?? slashMatches[0];
    if (!role) return;
    const next = insertRole(value.replace(SLASH_TOKEN_RE, ""), role);
    setValue(next);
    onValueChange?.(next);
    closeSlash();
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      adjustTextareaHeight();
    });
  }

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
    // Read and clear before anything can return: the intent belongs to the send that
    // is happening now, and a refused send must not leave `interrupt` armed for the
    // next one. The next one is usually a plain Enter, which carries no intent of its
    // own -- it would cut the round short and, along with it, deny the approvals and
    // answer the questions the round was waiting on, on the user's behalf.
    const interrupt = submitIntent.current === "interrupt";
    submitIntent.current = "queue";
    // Allow send while running: a running task queues the message and answers it
    // when the round ends. Only hard-disable when parent says so.
    // Sending is allowed with only attachments (no text), but never mid-upload.
    if ((!text && attachments.length === 0) || disabled || busy || stopping || uploading) return;
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
    setSlashQuery("");
    setSlashIndex(0);
    dismissedSlash.current = null;
    setAttachments([]);
    onAttachmentsChange?.([]);
    try {
      await onSubmit(payload, interrupt ? { interrupt: true } : undefined);
    } catch (err) {
      // Restore text/attachments so the user does not lose a failed follow-up —
      // unless the submit handler says it has taken the composer over. That is
      // the edit-a-queued-message case: the refill lands while the POST is in
      // flight, and putting this send's text back would delete the message the
      // person is now holding.
      if (!(err as SubmitFailure | undefined)?.keepComposer) {
        // Drop blob previews (already revoked); remote upload urls still work.
        const restored = prevAttachments.map(({ previewUrl: _p, ...rest }) => rest);
        setValue(prevValue);
        onValueChange?.(prevValue);
        setAttachments(restored);
        onAttachmentsChange?.(restored);
      }
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
    const at = upto.match(MENTION_TOKEN_RE);
    const slash = SLASH_TOKEN_RE.exec(v);
    if (at && isMentionQuery(at[1] ?? "")) {
      setMentionQuery(at[1] ?? "");
      setMenu("mention");
    } else if (slash) {
      // Escape declined this exact draft, and moving the caret is not a new
      // question. Typing changes the value, which asks again.
      if (dismissedSlash.current === v) {
        setMenu(null);
        setSlashQuery("");
      } else {
        dismissedSlash.current = null;
        setMenu("slash");
        setSlashQuery(slash[1]);
      }
    } else if (menu === "slash") {
      // The token became prose (a space, a newline) or was deleted.
      closeSlash();
    } else if (menu === "mention") {
      setMenu(null);
      setMentionQuery("");
      setMentionIndex(0);
    }
    if (v.length === 0) {
      setMenu(null);
      setMentionQuery("");
      setMentionIndex(0);
      setSlashQuery("");
      setSlashIndex(0);
      // Clearing the draft is not the draft Escape declined: a fresh token
      // pasted into an empty box is a new question, even if it is the same
      // text character for character.
      dismissedSlash.current = null;
    }
  }

  /** Replace the `@partial` before the caret with `@token `. */
  function insertMentionToken(token: string) {
    let next = value;
    if (MENTION_TOKEN_RE.test(value)) {
      next = value.replace(MENTION_TOKEN_RE, (m) => {
        const lead = m.startsWith(" ") || m.startsWith("\n") ? m[0] : "";
        return `${lead}@${token} `;
      });
    } else {
      // Mid-string: replace the active query token if present.
      const idx = value.toLowerCase().lastIndexOf(`@${mentionQuery.toLowerCase()}`);
      if (idx >= 0) {
        next = value.slice(0, idx) + `@${token} ` + value.slice(idx + 1 + mentionQuery.length);
      } else {
        next = `${value}@${token} `;
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

  /** Insert whatever row is highlighted — an agent id or a file path. */
  function pickMention() {
    const pick = mentionOptions[mentionIndex] ?? mentionOptions[0];
    if (!pick) return;
    insertMentionToken(pick.kind === "agent" ? pick.agent.id : pick.path);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // An IME owns the keyboard while it composes: Enter confirms the candidate
    // and the arrows walk the candidate list. Taking either would pick a menu
    // row — or send the draft — under the composition the person is still
    // writing, which is the one way this composer breaks for a language that
    // types through an IME.
    if (isImeKeyEvent(e.nativeEvent)) return;

    // Holding Enter repeats the keydown; by the second one the menu has already
    // picked and closed, so the repeat would send the prompt the first keydown
    // just wrote into the draft. A held key is never a second decision.
    if (e.repeat && (e.key === "Enter" || e.key === "Tab")) return;

    /** Answer a key for a menu: its keyup is not a reason to re-read the draft. */
    function consume() {
      e.preventDefault();
      consumedKey.current = e.key;
    }

    // `/` prompt shortcuts. Enter picks a row instead of sending: the draft is
    // still the token, and sending "/rev" to the agent is never what the menu
    // looks like it will do.
    if (menu === "slash") {
      if (e.key === "Escape") {
        consume();
        closeSlash();
        // Recorded after the close: `closeSlash` clears it for every other
        // caller.
        dismissedSlash.current = value;
        return;
      }
      if (slashMatches.length > 0) {
        if (e.key === "ArrowDown") {
          consume();
          setSlashIndex((i) => (i + 1) % slashMatches.length);
          return;
        }
        if (e.key === "ArrowUp") {
          consume();
          setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
          return;
        }
        if (
          (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) ||
          (e.key === "Tab" && !e.shiftKey)
        ) {
          consume();
          pickSlashRole();
          return;
        }
      }
    }

    // Mention menu keyboard navigation. One list, both kinds of row: the arrow
    // keys do not stop at the boundary between agents and files.
    if (menu === "mention" && mentionOptions.length > 0) {
      if (e.key === "ArrowDown") {
        consume();
        setMentionIndex((i) => (i + 1) % mentionOptions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        consume();
        setMentionIndex((i) => (i - 1 + mentionOptions.length) % mentionOptions.length);
        return;
      }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        consume();
        pickMention();
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        consume();
        pickMention();
        return;
      }
      if (e.key === "Escape") {
        consume();
        setMenu(null);
        setMentionQuery("");
        setMentionIndex(0);
        return;
      }
    }

    // Enter → newline, on every keyboard: the textarea does this itself, and
    // it has to, because a phone's software keyboard has no Shift — "Shift+Enter
    // for a newline" would leave a phone unable to write a second line and send
    // half a sentence on the first pause. Sending is the send button, or
    // ⌘/Ctrl+Enter where there is one; the legend beside the composer reads ⌘↵,
    // and this branch is what makes that true.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  const expanded = Boolean(value.trim()) || attachments.length > 0 || focused || uploading;
  // "agents & files" only when a file row is on screen or on its way. A search
  // that failed leaves an agent menu, and a title promising files would name a
  // section that is not there.
  const menuTitle =
    fileSearch && (fileMatches.length > 0 || fileSearching)
      ? "composer.mentionTitleFiles"
      : "composer.mentionTitle";

  return (
    <form onSubmit={submit} className="relative">
      {menu === "slash" && (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl bg-kin-elevated shadow-e2 overflow-hidden z-20">
          <div className="px-3 py-2 text-caption font-semibold uppercase tracking-label text-kin-muted flex items-center justify-between">
            <span>{tr("composer.slashActions")}</span>
            {slashMatches.length > 0 && (
              <span className="normal-case tracking-normal font-normal text-caption">
                ↑↓ {tr("composer.mentionNav")} · ↵ {tr("composer.mentionSelect")}
              </span>
            )}
          </div>
          {roleList.length === 0 ? (
            <div className="px-3 py-2.5 text-strong text-kin-secondary">
              {tr(roles === null ? "composer.slashRolesUnavailable" : "composer.slashNoRoles")}
            </div>
          ) : slashMatches.length === 0 ? (
            <div className="px-3 py-2.5 text-strong text-kin-secondary">
              {tr("composer.slashNoMatch")}
            </div>
          ) : (
            /* The rows scroll; the header and the hint below stay put. */
            <div
              ref={slashListRef}
              role="listbox"
              aria-label={tr("composer.slashActions")}
              className="max-h-[min(40vh,18rem)] overflow-y-auto kin-scroll"
            >
              {slashMatches.map((role, i) => {
                const active = i === slashIndex;
                return (
                  <button
                    key={role.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={
                      "w-full flex flex-col items-start gap-0.5 px-3 py-2.5 text-left text-strong " +
                      (active
                        ? "bg-kin-blue/15 text-kin-text"
                        : "hover:bg-[var(--kin-fill-strong)]")
                    }
                    onMouseEnter={() => setSlashIndex(i)}
                    onClick={() => pickSlashRole(i)}
                  >
                    <span className="w-full truncate font-semibold text-kin-text">{role.name}</span>
                    <span className="w-full truncate text-caption text-kin-muted">
                      {rolePreview(role.prompt)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {slashMatches.length > 0 && (
            <div className="border-t border-[var(--kin-hairline)] px-3 py-2 text-caption text-kin-muted">
              {tr("composer.slashTip")}
            </div>
          )}
        </div>
      )}
      {menu === "mention" && (mentionOptions.length > 0 || fileSearching) && (
        <div
          className="absolute bottom-full left-0 right-0 mb-2 rounded-xl bg-kin-elevated shadow-e2 overflow-hidden z-20"
          role="listbox"
          aria-label={tr(menuTitle)}
        >
          <div className="px-3 py-2 text-caption font-semibold uppercase tracking-label text-kin-muted flex items-center justify-between">
            <span>{tr(menuTitle)}</span>
            <span className="normal-case tracking-normal font-normal text-caption">
              ↑↓ {tr("composer.mentionNav")} · ↵ {tr("composer.mentionSelect")}
            </span>
          </div>
          {/* The rows scroll; the header above stays put. Fifty answers is the
              daemon's cap, and a phone keyboard leaves the menu less than half
              a screen to grow into. */}
          <div ref={mentionListRef} className="max-h-[min(40vh,18rem)] overflow-y-auto kin-scroll">
            {mentionOptions.map((option, i) => {
              const active = i === mentionIndex;
              const rowClass =
                "w-full flex items-center gap-3 px-3 py-2.5 text-left text-strong " +
                (active ? "bg-kin-blue/15 text-kin-text" : "hover:bg-[var(--kin-fill-strong)]");
              // The file rows sit under one heading, above the first of them —
              // including when they are the only rows, because then the heading
              // is the only thing that says what kind of path is being offered.
              const heading =
                option.kind === "file" && mentionOptions[i - 1]?.kind !== "file" ? (
                  <div
                    key={`${option.key}:heading`}
                    className="px-3 py-1.5 text-caption font-semibold uppercase tracking-label text-kin-muted border-t border-[var(--kin-hairline)]"
                  >
                    {tr("composer.fileMentionTitle")}
                  </div>
                ) : null;
              const row =
                option.kind === "agent" ? (
                  <button
                    key={option.key}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={rowClass}
                    onMouseEnter={() => setMentionIndex(i)}
                    onClick={() => insertMentionToken(option.agent.id)}
                  >
                    <span className="font-mono text-kin-blue-ink font-semibold">
                      @{option.agent.id}
                    </span>
                    <span className="text-kin-secondary">
                      {agentDisplayName(option.agent.id)}
                      {hostAgentId && option.agent.id === hostAgentId
                        ? ` · ${tr("composer.roleMain")}`
                        : ` · ${tr("composer.roleWorker")}`}
                      {agentCatalogState(option.agent) === "generic"
                        ? ` · ${tr("agentCatalog.generic")}`
                        : ""}
                    </span>
                  </button>
                ) : (
                  <button
                    key={option.key}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={rowClass}
                    onMouseEnter={() => setMentionIndex(i)}
                    onClick={() => insertMentionToken(option.path)}
                  >
                    <IconFile size={14} className="text-kin-muted shrink-0" />
                    <span className="font-mono text-kin-text truncate">{option.path}</span>
                  </button>
                );
              return heading ? [heading, row] : row;
            })}
            {fileSearching && fileMatches.length === 0 ? (
              <div className="px-3 py-2.5 text-caption text-kin-muted">
                {tr("composer.fileMentionSearching")}
              </div>
            ) : null}
          </div>
        </div>
      )}

      <div
        className={[
          // Phone: the elevated card the reference composer uses — its own
          // surface, a 2xl radius and a drop, so the input reads as a thing you
          // hold rather than a hole cut in the transcript. Desktop keeps the
          // flat bordered box it has always had.
          //
          // The phone card is raised, so it does not draw a hairline as well:
          // the drop is what separates it from the transcript, and a line under
          // a raised box is the same box drawn twice. The border stays in the
          // list as `transparent` so the desktop hairline (`sm:`) has a border
          // to switch on and the two widths keep the same box metrics.
          "rounded-2xl border border-transparent bg-kin-elevated px-2.5 py-2 max-sm:shadow-e2 transition-[padding] duration-150",
          "focus-within:border-kin-blue/40 sm:rounded-xl sm:border-[var(--kin-hairline-strong)] sm:bg-[var(--kin-fill)]",
          expanded ? "sm:px-3 sm:py-2.5" : "sm:px-2.5 sm:py-1.5",
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
        <div
          className={
            expanded ? "flex flex-col" : "flex flex-col sm:flex-row sm:items-center sm:gap-1.5"
          }
        >
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
              // The keydown that answered this key already decided what the
              // menu should be. Reading the draft again here would reopen the
              // menu it just closed — or the one a pick just replaced with a
              // prompt that itself looks like a token.
              if (consumedKey.current === e.key) {
                consumedKey.current = "";
                return;
              }
              // Don't re-open / clobber menu index after Arrow keys handled in keydown.
              if (
                (menu === "mention" || menu === "slash") &&
                (e.key === "ArrowDown" || e.key === "ArrowUp")
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
              // A phone types into a 44pt row: the attachment and send buttons
              // beside it are already that tall, and a 28px textarea inside a
              // 44px row clipped the second line of its own placeholder. The
              // `kin-composer-input` half covers the coarse-pointer widths the
              // `sm` breakpoint would otherwise drop back to 28px.
              expanded
                ? "w-full min-h-11 leading-ui"
                : "kin-composer-input w-full min-w-0 min-h-11 flex-none py-[11px] leading-ui sm:flex-1 sm:min-h-7 sm:py-0",
            ].join(" ")}
          />
          <div
            className={[
              "flex min-w-0 items-center gap-1.5",
              expanded ? "mt-2" : "mt-1.5 sm:mt-0",
            ].join(" ")}
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
              {/* A plus on the phone, the picture mark on desktop: at the
                  touch step the control opens the file picker, not an image
                  gallery, and a plus is what every phone composer uses for
                  it. `sm:` rather than a pointer query, because the width at
                  which the box becomes a flat inline strip is the width at
                  which the picture mark fits again. */}
              <IconPlus size={expanded ? 18 : 17} className="sm:hidden" strokeWidth={2} />
              <IconImage size={expanded ? 15 : 14} className="hidden sm:block" />
            </button>
            {footer ? <div className="min-w-0 flex-1 md:hidden">{footer}</div> : null}
            {uploading && (
              <span className="text-caption text-kin-muted">{tr("composer.uploading")}</span>
            )}
            <span
              className={[
                "text-caption text-kin-muted items-center gap-1",
                // `@` is not a desktop key: a phone keyboard has one, and this
                // is the only place the delegation feature is named. The ⌘↵
                // legend below it is the one that gets the `sm` gate.
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
                className="ml-auto h-11 w-11 rounded-full border border-kin-red/35 bg-kin-red/15 text-kin-red-ink flex items-center justify-center disabled:opacity-40 sm:h-7 sm:w-7 sm:rounded-lg"
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
                // The phone's primary action is the reference's ink disc with
                // an up arrow — the strongest thing in the card, and the one
                // control the thumb goes to without reading. Desktop keeps the
                // brand-blue square it has always had.
                className="ml-auto h-11 w-11 rounded-full bg-kin-text text-kin-bg flex items-center justify-center disabled:opacity-40 sm:h-7 sm:w-7 sm:rounded-lg sm:bg-kin-blue sm:text-kin-on-brand"
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
                  // uploading is in here for the same reason as on the send button
                  // above: a send that cannot happen yet must not be armable, or the
                  // intent outlives the click that set it.
                  disabled={disabled || busy || stopping || uploading}
                  className="h-11 w-11 rounded-full border border-kin-orange/40 bg-kin-orange/15 text-kin-orange-ink flex items-center justify-center disabled:opacity-40 sm:h-7 sm:w-7 sm:rounded-lg"
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
                  // uploading is in here for the same reason as on the two buttons
                  // above: a send that cannot happen yet must not be armable.
                  disabled={disabled || busy || stopping || uploading}
                  className="h-11 w-11 rounded-full bg-kin-text text-kin-bg flex items-center justify-center disabled:opacity-40 sm:h-7 sm:w-7 sm:rounded-lg sm:bg-kin-blue sm:text-kin-on-brand"
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
