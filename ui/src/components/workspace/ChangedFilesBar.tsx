import { shortPath } from "../../lib/paths";
import type { ChangedFile } from "../../lib/changedFiles";
import { useT } from "../../i18n/react";
import { IconFile, IconPanel } from "../icons";

type Props = {
  files: ChangedFile[];
  onOpenPath: (path: string) => void;
  onOpenPanel?: () => void;
  /** Compact single-row chips under the task header. */
  className?: string;
};

export default function ChangedFilesBar({
  files,
  onOpenPath,
  onOpenPanel,
  className,
}: Props) {
  const t = useT();
  if (files.length === 0) return null;

  const mutated = files.filter((f) => f.action !== "read");
  const labelCount = mutated.length > 0 ? mutated.length : files.length;
  const titleKey =
    mutated.length > 0 ? "workspace.changed.title" : "workspace.changed.viewedTitle";

  return (
    <div
      className={[
        "flex-none border-b border-[var(--kin-hairline)] bg-[var(--kin-fill)]/80",
        className ?? "",
      ].join(" ")}
    >
      <div className="px-4 sm:px-5 py-2 flex items-start gap-2 min-w-0">
        <div className="flex-none pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
          {t(titleKey, { count: labelCount })}
        </div>
        <div className="flex-1 min-w-0 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <button
              key={`${f.action}:${f.path}`}
              type="button"
              onClick={() => onOpenPath(f.path)}
              title={f.path}
              className={[
                "inline-flex items-center gap-1 max-w-full rounded-md border px-2 py-0.5",
                "text-[11.5px] font-mono transition-colors",
                chipClass(f.action),
              ].join(" ")}
            >
              <IconFile size={11} className="flex-none opacity-80" />
              <span className="truncate">{shortPath(f.path, 42)}</span>
              <span className="flex-none text-[10px] uppercase opacity-70">
                {actionLabel(f.action, t)}
              </span>
            </button>
          ))}
        </div>
        {onOpenPanel && (
          <button
            type="button"
            onClick={onOpenPanel}
            className="flex-none inline-flex items-center gap-1 text-[11.5px] text-kin-blue hover:underline pt-0.5"
            title={t("workspace.toggle")}
          >
            <IconPanel size={12} />
            <span className="hidden sm:inline">{t("workspace.title")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function chipClass(action: ChangedFile["action"]): string {
  switch (action) {
    case "write":
      return "border-[rgba(50,215,75,.35)] bg-[rgba(50,215,75,.08)] text-[#8de4a0] hover:bg-[rgba(50,215,75,.14)]";
    case "edit":
      return "border-[rgba(10,132,255,.35)] bg-[rgba(10,132,255,.08)] text-[#7cbcff] hover:bg-[rgba(10,132,255,.14)]";
    case "delete":
      return "border-[rgba(255,69,58,.35)] bg-[rgba(255,69,58,.08)] text-[#ffb4ad] hover:bg-[rgba(255,69,58,.14)]";
    case "read":
      return "border-[var(--kin-hairline-strong)] bg-black/[.03] dark:bg-white/[.04] text-kin-secondary hover:bg-black/[.05] dark:hover:bg-white/[.06]";
    default:
      return "border-[var(--kin-hairline-strong)] bg-black/[.03] dark:bg-white/[.04] text-kin-secondary";
  }
}

function actionLabel(
  action: ChangedFile["action"],
  t: (path: string, params?: Record<string, string | number | null | undefined>) => string,
): string {
  switch (action) {
    case "write":
      return t("workspace.changed.write");
    case "edit":
      return t("workspace.changed.edit");
    case "delete":
      return t("workspace.changed.delete");
    case "read":
      return t("workspace.changed.read");
    default:
      return t("workspace.changed.other");
  }
}
