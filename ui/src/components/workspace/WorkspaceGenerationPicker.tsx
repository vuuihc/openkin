import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listTaskWorkspaces,
  type WorkspaceGeneration,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { IconChevron } from "../icons";

type Props = {
  taskId: string;
  /** Currently selected workspace ID (null = source / current project). */
  selectedId: string | null;
  onChange: (id: string | null) => void;
};

/**
 * Dropdown picker for workspace generations.
 * Shows "Workspace N" entries plus a "Current project" (source) option.
 * Displays lifecycle badge (active, integrated, released, blocked).
 */
export default function WorkspaceGenerationPicker({
  taskId,
  selectedId,
  onChange,
}: Props) {
  const t = useT();
  const [generations, setGenerations] = useState<WorkspaceGeneration[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(false);
    listTaskWorkspaces(taskId)
      .then((list) => {
        if (cancelled) return;
        setGenerations(list);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFetchError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const selected = useMemo(
    () => generations.find((g) => g.id === selectedId) ?? null,
    [generations, selectedId],
  );

  const close = useCallback(() => setOpen(false), []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && !target.closest("[data-gen-picker]")) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (loading) {
    return (
      <span className="text-[11px] text-kin-muted animate-pulse">
        {t("workspace.generation.source")}
      </span>
    );
  }

  if (fetchError || generations.length === 0) {
    return (
      <span className="text-[11px] text-kin-muted">
        {t("workspace.generation.source")}
      </span>
    );
  }

  const label = selected
    ? `${t("workspace.generation.workspace")} ${selected.generation}`
    : t("workspace.generation.source");

  return (
    <div className="relative" data-gen-picker>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1 text-[11.5px] font-medium text-kin-text hover:bg-[var(--kin-fill-strong)] transition-colors"
      >
        <span className="truncate max-w-[160px]">{label}</span>
        {selected && (
          <span
            className={[
              "flex-none rounded px-1 py-0 text-[9px] font-semibold uppercase tracking-wide",
              stateBadgeClass(selected.state),
            ].join(" ")}
          >
            {stateLabel(selected.state, t)}
          </span>
        )}
        <IconChevron
          size={11}
          className={[
            "flex-none text-kin-muted transition-transform",
            open ? "rotate-180" : "",
          ].join(" ")}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 min-w-[200px] rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-elevated)] shadow-lg py-1">
          {/* Source / current project */}
          <button
            type="button"
            onClick={() => {
              onChange(null);
              close();
            }}
            className={[
              "w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors",
              !selectedId
                ? "bg-kin-blue/15 text-kin-text"
                : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
            ].join(" ")}
          >
            <span className="flex-1 truncate">
              {t("workspace.generation.source")}
            </span>
            <span className="flex-none rounded px-1 py-0 text-[9px] font-semibold uppercase tracking-wide bg-kin-muted/20 text-kin-muted">
              {t("workspace.generation.readOnly")}
            </span>
          </button>

          {generations.map((gen) => (
            <button
              key={gen.id}
              type="button"
              onClick={() => {
                onChange(gen.id);
                close();
              }}
              className={[
                "w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors",
                selectedId === gen.id
                  ? "bg-kin-blue/15 text-kin-text"
                  : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
              ].join(" ")}
            >
              <span className="flex-1 truncate">
                {t("workspace.generation.workspace")} {gen.generation}
              </span>
              <span
                className={[
                  "flex-none rounded px-1 py-0 text-[9px] font-semibold uppercase tracking-wide",
                  stateBadgeClass(gen.state),
                ].join(" ")}
              >
                {stateLabel(gen.state, t)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function stateBadgeClass(state: string): string {
  switch (state) {
    case "active":
    case "ready":
      return "bg-kin-blue/20 text-kin-blue";
    case "integrated":
    case "released":
      return "bg-kin-green/20 text-kin-green";
    case "merge_blocked":
    case "finalize_blocked":
      return "bg-kin-orange/20 text-kin-orange";
    case "orphaned":
      return "bg-kin-red/20 text-kin-red";
    default:
      return "bg-kin-muted/20 text-kin-muted";
  }
}

function stateLabel(
  state: string,
  t: (key: string, params?: Record<string, string | number | null | undefined>) => string,
): string {
  switch (state) {
    case "active":
      return t("workspace.generation.stateActive");
    case "ready":
      return t("workspace.generation.stateReady");
    case "integrated":
      return t("workspace.generation.stateIntegrated");
    case "released":
      return t("workspace.generation.stateReleased");
    case "merge_blocked":
      return t("workspace.generation.stateBlocked");
    case "finalize_blocked":
      return t("workspace.generation.stateBlocked");
    case "orphaned":
      return t("workspace.generation.stateOrphaned");
    case "legacy_pending":
      return t("workspace.generation.stateLegacy");
    default:
      return state;
  }
}
