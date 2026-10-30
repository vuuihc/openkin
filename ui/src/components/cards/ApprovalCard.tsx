import { useEffect, useRef } from "react";
import { type Approval, parseApprovalPayload } from "../../api/client";
import { toolInputDiff } from "../../lib/changedFiles";
import { previewFromTexts } from "../../lib/diffPreview";
import { shortPath } from "../../lib/paths";
import { approvalViaLabel, formatApprovalAttribution } from "../../lib/approvalAttribution";
import { formatRelativeTime } from "../../lib/relativeTime";
import { useT } from "../../i18n/react";
import PreviewLines from "../PreviewLines";
import { IconAlert, IconCheck, IconFile, IconX } from "../icons";

type Props = {
  approval: Approval;
  focused?: boolean;
  busy?: "approved" | "denied" | null;
  onApprove: () => void;
  onDeny: () => void;
  onOpenPath?: (path: string) => void;
  /**
   * Whether `a`/`d` answer *this* card. The transcript and the inbox bind
   * them; a card floating over some other screen does not — the letters there
   * would promise a key that decides a different approval, or nothing at all.
   */
  showKeys?: boolean;
};

export default function ApprovalCard({
  approval,
  focused,
  busy,
  onApprove,
  onDeny,
  onOpenPath,
  showKeys = true,
}: Props) {
  const tr = useT();
  const { toolName, input } = parseApprovalPayload(approval.payload);
  const attr = formatApprovalAttribution(approval, tr);
  // A decided approval is no longer a question. The same card stays where it
  // was asked and says what was decided, instead of vanishing and leaving the
  // reader to infer the answer from the conversation moving on.
  const decided = approval.decision !== "pending";
  const approved = approval.decision === "approved";
  // An older row can carry no `decided_via`; "Decided via " with nothing after
  // it reads as a bug, and "decided here" would be a lie on the other device.
  // The channel table lives in `approvalViaLabel` so `ios:<device-id>` and
  // `mcp:<client>` get words instead of audit tokens.
  const viaLabel = approvalViaLabel(approval.decided_via ?? "", tr);
  // The buttons that had focus unmount when the answer arrives; without this
  // the focus falls to <body> and the next Tab starts at the top of the
  // window, which is exactly where the reader was not. Only an answer given
  // from this card moves focus: a decision made on the phone (or by the
  // timeout) can land while the reader is typing here, and stealing the caret
  // mid-sentence would lose what they were writing.
  const rootRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const answeredHere = useRef(false);
  const wasDecided = useRef(decided);
  // The claim can outlive the request: a failed answer leaves the card pending
  // with nothing on its way. `busy` cannot tell the two apart — the shared hook
  // clears it a render before the surface adopts the answer — so the claim is
  // dropped when the reader's attention moves elsewhere, which is the moment a
  // later phone decision would start stealing the caret from them.
  useEffect(() => {
    if (decided || !answeredHere.current) return;
    const dropClaimOutside = (event: FocusEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        answeredHere.current = false;
      }
    };
    document.addEventListener("focus", dropClaimOutside, true);
    return () => document.removeEventListener("focus", dropClaimOutside, true);
  }, [decided, busy]);
  useEffect(() => {
    if (decided && !wasDecided.current && answeredHere.current) {
      statusRef.current?.focus({ preventScroll: true });
    }
    wasDecided.current = decided;
  }, [decided]);
  const filePath =
    typeof input.path === "string"
      ? input.path
      : typeof input.file_path === "string"
        ? input.file_path
        : typeof input.filePath === "string"
          ? input.filePath
          : "";
  const command =
    typeof input.command === "string"
      ? input.command
      : typeof input.cmd === "string"
        ? input.cmd
        : "";
  // What this request would change, when the payload says. An approval that
  // writes or edits a file is the one place a reader is being asked to decide
  // about a change, so it is worth showing the change rather than the JSON that
  // describes it — and where the payload cannot be reconstructed (a shell
  // command, a tool whose body is elsewhere) the JSON below is still the honest
  // answer.
  const diff = toolInputDiff(toolName, input);
  const preview = diff
    ? previewFromTexts(diff.original, diff.modified, { maxLines: 24, context: 2 })
    : null;

  return (
    <div
      ref={rootRef}
      className={[
        "rounded-xl animate-slideIn overflow-hidden",
        decided
          ? "border border-kin-hairline bg-kin-panel"
          : focused
            ? "border-2 border-kin-blue ring ring-kin-blue/20"
            : "border border-kin-orange/55 shadow-e2",
        decided ? "" : "bg-gradient-to-b from-kin-orange/10 to-kin-orange/5",
      ].join(" ")}
    >
      <div className="px-3.5 py-3.5">
        <div className="flex items-center gap-2">
          {decided ? (
            approved ? (
              <IconCheck size={15} className="flex-none text-kin-green-ink" />
            ) : approval.decision === "expired" ? (
              // A request nobody answered is not a denial: the red X reads as
              // "someone said no", which is the opposite of what happened.
              <IconAlert size={15} className="flex-none text-kin-orange-ink" />
            ) : (
              <IconX size={15} className="flex-none text-kin-red-ink" />
            )
          ) : (
            <IconAlert size={15} className="text-kin-orange-ink flex-none" />
          )}
          <span
            className={[
              "text-strong font-semibold",
              decided ? "text-kin-text" : "text-kin-orange-ink",
            ].join(" ")}
          >
            {tr(
              decided
                ? approved
                  ? "approval.approvedTitle"
                  : approval.decision === "expired"
                    ? "approval.expiredTitle"
                    : "approval.deniedTitle"
                : "approval.cardTitle",
            )}
          </span>
          {focused && (
            <span className="text-micro font-semibold uppercase tracking-label text-kin-blue-ink bg-kin-blue/15 rounded px-1.5 py-0.5">
              {tr("inbox.focused")}
            </span>
          )}
          <span className="ml-auto text-caption text-kin-muted truncate max-w-[45%]" title={attr}>
            {attr}
          </span>
        </div>

        <div className="mt-2.5 flex items-center gap-2 text-body min-w-0">
          <span className="inline-flex items-center gap-1.5 font-semibold text-kin-text flex-none">
            <IconFile size={13} />
            {toolName}
          </span>
          {filePath ? (
            <button
              type="button"
              onClick={() => onOpenPath?.(filePath)}
              className="font-mono text-kin-blue-ink truncate hover:underline text-left"
              title={filePath}
            >
              {shortPath(filePath, 48)}
            </button>
          ) : (
            <span className="font-mono text-kin-secondary truncate">
              {command ? shortPath(command, 48) : ""}
            </span>
          )}
        </div>

        {preview && <PreviewLines lines={preview.lines} className="mt-2.5" />}
        {preview && preview.hidden > 0 && (
          <p className="mt-1 text-caption text-kin-muted">
            {/* The caption describes the box above it, so it counts what is drawn:
                hidden is how many lines were cut, which for a 60-line diff capped at
                24 would caption 24 lines as "the first 36". */}
            {tr("chat.diff.truncated", { count: preview.lines.length })}
          </p>
        )}

        {!preview && Object.keys(input).length > 0 && (
          <pre className="mt-2.5 max-h-28 overflow-auto rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-2 text-caption font-mono text-kin-secondary">
            {JSON.stringify(input, null, 2)}
          </pre>
        )}

        {/*
          The key letters are for the keyboard model the session view has on a
          desktop (`j/k/a/d`). On a phone they are a caption for a key that is
          not there, and the button already says what it does — so they are
          hidden below `sm`, the same gate the composer's ⌘↵ hint uses. They are
          dropped entirely where no such binding exists (`showKeys`).
        */}
        {decided ? (
          <div
            ref={statusRef}
            role="status"
            tabIndex={-1}
            className="mt-3 flex items-center gap-2 rounded-lg bg-[var(--kin-fill)] px-3 py-2 text-body text-kin-secondary focus:outline-none"
          >
            <span className="min-w-0 flex-1 truncate">
              {viaLabel}
              {approval.decided_at ? (
                <span className="text-caption text-kin-muted">
                  {" · "}
                  {formatRelativeTime(approval.decided_at, Date.now())}
                </span>
              ) : null}
            </span>
          </div>
        ) : (
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => {
                answeredHere.current = true;
                onApprove();
              }}
              className="kin-btn-approve flex-1 disabled:opacity-60"
            >
              {busy === "approved" ? (
                tr("approval.approving")
              ) : (
                <>
                  {tr("chat.approve")}{" "}
                  {showKeys && <span className="hidden sm:inline opacity-60 font-semibold">A</span>}
                </>
              )}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => {
                answeredHere.current = true;
                onDeny();
              }}
              className="kin-btn-deny flex-1 disabled:opacity-60"
            >
              {busy === "denied" ? (
                tr("approval.denying")
              ) : (
                <>
                  {tr("chat.deny")}{" "}
                  {showKeys && <span className="hidden sm:inline opacity-50">D</span>}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
