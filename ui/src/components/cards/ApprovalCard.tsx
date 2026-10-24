import { type Approval, parseApprovalPayload } from "../../api/client";
import { shortPath } from "../../lib/paths";
import { formatApprovalAttribution } from "../../lib/approvalAttribution";
import { useT } from "../../i18n/react";
import { IconAlert, IconFile } from "../icons";

type Props = {
  approval: Approval;
  focused?: boolean;
  busy?: "approved" | "denied" | null;
  onApprove: () => void;
  onDeny: () => void;
  onOpenPath?: (path: string) => void;
  /** Optional path/diff snippet lines. */
  previewLines?: { type: "add" | "del" | "ctx"; text: string }[];
};

export default function ApprovalCard({
  approval,
  focused,
  busy,
  onApprove,
  onDeny,
  onOpenPath,
  previewLines,
}: Props) {
  const tr = useT();
  const { toolName, input } = parseApprovalPayload(approval.payload);
  const attr = formatApprovalAttribution(approval, tr);
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

  return (
    <div
      className={[
        "rounded-xl animate-slideIn overflow-hidden",
        focused
          ? "border-2 border-kin-blue ring ring-kin-blue/20"
          : "border border-kin-orange/55 shadow-e2",
        "bg-gradient-to-b from-kin-orange/10 to-kin-orange/5",
      ].join(" ")}
    >
      <div className="px-3.5 py-3.5">
        <div className="flex items-center gap-2">
          <IconAlert size={15} className="text-kin-orange-ink flex-none" />
          <span className="text-strong font-semibold text-kin-orange-ink">
            {tr("approval.cardTitle")}
          </span>
          {focused && (
            <span className="text-micro font-semibold uppercase tracking-label text-kin-blue-ink bg-kin-blue/15 rounded px-1.5 py-0.5">
              {tr("approval.focused")}
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

        {previewLines && previewLines.length > 0 && (
          <div className="mt-2.5 rounded-lg overflow-hidden border border-[var(--kin-hairline)] font-mono text-caption leading-prose">
            {previewLines.map((line, i) => (
              <div
                key={i}
                className={
                  line.type === "add"
                    ? "px-2.5 py-0.5 bg-kin-green/10 text-kin-green-ink"
                    : line.type === "del"
                      ? "px-2.5 py-0.5 bg-kin-red/10 text-kin-red-ink"
                      : "px-2.5 py-0.5 text-kin-secondary"
                }
              >
                {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
                {line.text}
              </div>
            ))}
          </div>
        )}

        {!previewLines && Object.keys(input).length > 0 && (
          <pre className="mt-2.5 max-h-28 overflow-auto rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-2 text-caption font-mono text-kin-secondary">
            {JSON.stringify(input, null, 2)}
          </pre>
        )}

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={!!busy}
            onClick={onApprove}
            className="kin-btn-approve flex-1 disabled:opacity-60"
          >
            {busy === "approved" ? (
              tr("approval.approving")
            ) : (
              <>
                {tr("chat.approve")} <span className="opacity-60 font-semibold">A</span>
              </>
            )}
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={onDeny}
            className="kin-btn-deny flex-1 disabled:opacity-60"
          >
            {busy === "denied" ? (
              tr("approval.denying")
            ) : (
              <>
                {tr("chat.deny")} <span className="opacity-50">D</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
