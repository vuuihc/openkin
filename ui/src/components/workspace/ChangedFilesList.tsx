import { useEffect, useMemo, useRef } from "react";
import { shortPath } from "../../lib/paths";
import type { ChangedFile } from "../../lib/changedFiles";
import { useT } from "../../i18n/react";
import { IconFile } from "../icons";

type Props = {
  files: ChangedFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
};

/**
 * Sidebar list of agent-written files for the workspace dual-pane.
 * Left column of the diff panel: only mutations (write/edit/delete).
 */
export default function ChangedFilesList({
  files,
  selectedPath,
  onSelect,
}: Props) {
  const t = useT();

  const ordered = useMemo(() => {
    // Mutations only, newest first.
    const mut = files.filter(
      (f) => f.action !== "read" && f.action !== "other",
    );
    const bySeq = (a: ChangedFile, b: ChangedFile) =>
      b.seq - a.seq || a.path.localeCompare(b.path);
    return [...mut].sort(bySeq);
  }, [files]);

  if (ordered.length === 0) {
    return (
      <div className="h-full flex items-center justify-center px-4 text-center text-[12px] text-kin-muted">
        {t("workspace.changed.empty")}
      </div>
    );
  }

  const selectedKey = selectedPath ? normalizeKey(selectedPath) : "";
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  return (
    <div className="h-full min-h-0 overflow-y-auto kin-scroll">
      <ul className="py-1">
        {ordered.map((f) => {
          const key = normalizeKey(f.path);
          const active =
            selectedKey !== "" &&
            (selectedKey === key ||
              selectedKey.endsWith("/" + key) ||
              key.endsWith("/" + selectedKey));
          return (
            <li key={`${f.action}:${f.path}`}>
              <button
                type="button"
                ref={active ? activeRef : undefined}
                onClick={() => onSelect(f.path)}
                title={f.path}
                className={[
                  "w-full flex items-start gap-2 px-2.5 py-1.5 text-left transition-colors",
                  active
                    ? "bg-kin-blue/15 text-kin-text"
                    : "text-kin-secondary hover:bg-black/[.04] dark:hover:bg-white/[.04] hover:text-kin-text",
                ].join(" ")}
              >
                <span
                  className={[
                    "mt-1 w-1.5 h-1.5 rounded-full flex-none",
                    actionDot(f.action),
                  ].join(" ")}
                  aria-hidden
                />
                <IconFile size={13} className="mt-0.5 flex-none opacity-80" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px] leading-snug">
                    {shortPath(f.path, 36)}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide opacity-70">
                    <span>{actionLabel(f.action, t)}</span>
                    {(f.additions != null || f.deletions != null) && (
                      <span className="normal-case tabular-nums tracking-normal">
                        <DeltaInline
                          additions={f.additions ?? 0}
                          deletions={f.deletions ?? 0}
                        />
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function normalizeKey(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function actionDot(action: ChangedFile["action"]): string {
  switch (action) {
    case "write":
      return "bg-[#8de4a0]";
    case "edit":
      return "bg-[#7cbcff]";
    case "delete":
      return "bg-[#ffb4ad]";
    default:
      return "bg-kin-muted";
  }
}

function actionLabel(
  action: ChangedFile["action"],
  t: (
    path: string,
    params?: Record<string, string | number | null | undefined>,
  ) => string,
): string {
  switch (action) {
    case "write":
      return t("workspace.changed.write");
    case "edit":
      return t("workspace.changed.edit");
    case "delete":
      return t("workspace.changed.delete");
    default:
      return t("workspace.changed.other");
  }
}

function DeltaInline({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions === 0 && deletions === 0) {
    return <span className="text-kin-muted">±0</span>;
  }
  return (
    <span>
      {additions > 0 && <span className="text-[#8de4a0]">+{additions}</span>}
      {additions > 0 && deletions > 0 && (
        <span className="text-kin-muted"> </span>
      )}
      {deletions > 0 && <span className="text-[#ffb4ad]">−{deletions}</span>}
    </span>
  );
}
