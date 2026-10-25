import { useEffect, useMemo, useRef } from "react";
import { shortPath } from "../../lib/paths";
import type { ChangedFile } from "../../lib/changedFiles";
import { useT } from "../../i18n/react";
import { FileSize, actionDotClass, actionLabelKey } from "../changedFileFace";
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
export default function ChangedFilesList({ files, selectedPath, onSelect }: Props) {
  const t = useT();

  const ordered = useMemo(() => {
    // Mutations only, newest first.
    const mut = files.filter((f) => f.action !== "read" && f.action !== "other");
    const bySeq = (a: ChangedFile, b: ChangedFile) => b.seq - a.seq || a.path.localeCompare(b.path);
    return [...mut].sort(bySeq);
  }, [files]);

  // Hooks must run unconditionally. Returning above these when the list is
  // empty caused React minified error #300 ("Rendered fewer hooks than
  // expected") as the list flipped between empty and non-empty.
  const selectedKey = selectedPath ? normalizeKey(selectedPath) : "";
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  if (ordered.length === 0) {
    return (
      <div className="h-full flex items-center justify-center px-4 text-center text-body text-kin-muted">
        {t("workspace.changed.empty")}
      </div>
    );
  }

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
                    : "text-kin-secondary  hover:bg-kin-fill hover:text-kin-text",
                ].join(" ")}
              >
                <span
                  className={[
                    "mt-1 w-1.5 h-1.5 rounded-full flex-none",
                    actionDotClass(f.action),
                  ].join(" ")}
                  aria-hidden
                />
                <IconFile size={13} className="mt-0.5 flex-none opacity-80" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-body leading-ui">
                    {shortPath(f.path, 36)}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-micro uppercase tracking-label opacity-70">
                    <span>{t(actionLabelKey(f.action))}</span>
                    {/* The same face as the bar and the round card, from the same
                        component: a file whose payload carried no counts says "size
                        unknown" here too, instead of going quiet while the bar beside
                        it says it. Both-absent is the common case — a bodyless delete,
                        a binary file, an untracked path. */}
                    <span className="normal-case tabular-nums tracking-normal">
                      <FileSize
                        additions={f.additions}
                        deletions={f.deletions}
                        label={t("workspace.changed.noLineDelta")}
                      />
                    </span>
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
