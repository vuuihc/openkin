import {
  type Approval,
  parseApprovalPayload,
} from "../../api/client";
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
        "rounded-[12px] animate-slideIn overflow-hidden",
        focused
          ? "border-2 border-kin-blue shadow-[0_0_0_3px_rgba(10,132,255,.2)]"
          : "border border-[rgba(255,159,10,.55)] shadow-card-amber",
        "bg-gradient-to-b from-[rgba(255,159,10,.1)] to-[rgba(255,159,10,.03)]",
      ].join(" ")}
    >
      <div className="px-3.5 py-3.5">
        <div className="flex items-center gap-2">
          <IconAlert size={15} className="text-kin-orange flex-none" />
          <span className="text-[13.5px] font-semibold text-[#ffb340]">
            Permission needed
          </span>
          {focused && (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-kin-blue bg-kin-blue-soft rounded px-1.5 py-0.5">
              focused
            </span>
          )}
          <span className="ml-auto text-[11px] text-kin-tertiary truncate max-w-[45%]" title={attr}>
            {attr}
          </span>
        </div>

        <div className="mt-2.5 flex items-center gap-2 text-[12.5px] min-w-0">
          <span className="inline-flex items-center gap-1.5 font-semibold text-kin-text flex-none">
            <IconFile size={13} />
            {toolName}
          </span>
          {filePath ? (
            <button
              type="button"
              onClick={() => onOpenPath?.(filePath)}
              className="font-mono text-kin-blue truncate hover:underline text-left"
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
          <div className="mt-2.5 rounded-lg overflow-hidden border border-[var(--kin-hairline)] font-mono text-[11.5px] leading-relaxed">
            {previewLines.map((line, i) => (
              <div
                key={i}
                className={
                  line.type === "add"
                    ? "px-2.5 py-0.5 bg-[rgba(48,209,88,.1)] text-[#5be584]"
                    : line.type === "del"
                      ? "px-2.5 py-0.5 bg-[rgba(255,69,58,.1)] text-[#ff8a80]"
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
          <pre className="mt-2.5 max-h-28 overflow-auto rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-2 text-[11px] font-mono text-kin-secondary">
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
            {busy === "approved" ? "Approving…" : (
              <>
                Approve <span className="opacity-60 font-semibold">A</span>
              </>
            )}
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={onDeny}
            className="kin-btn-deny flex-1 disabled:opacity-60"
          >
            {busy === "denied" ? "Denying…" : (
              <>
                Deny <span className="opacity-50">D</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
