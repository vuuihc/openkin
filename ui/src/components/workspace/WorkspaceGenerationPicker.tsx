import { useMemo, useRef, useState } from "react";
import { type WorkspaceGeneration } from "../../api/client";
import { useT } from "../../i18n/react";
import { IconChevron } from "../icons";
import Button from "../ui/Button";
import Menu from "../ui/Menu";

type Props = {
  generations: readonly WorkspaceGeneration[];
  loading: boolean;
  selectedId: string | null;
  onChange: (id: string | null) => void;
};

/**
 * Dropdown picker for workspace generations.
 * Shows "Workspace N" entries plus a "Current project" (source) option.
 * Displays lifecycle badge (active, integrated, released, blocked).
 *
 * The list is the console's shared `Menu` on the shared `Popover` layer, not a
 * private copy of it: the portal, viewport anchoring, outside-pointer and
 * Escape dismissal, focus moving in and back to the chip, and the layer that
 * owns the keyboard while it is open all belong to that facade. What remains
 * here is the domain mapping — which generation is checked, and what choosing
 * one means. The trigger keeps its own shape: the chip names the workspace the
 * viewer is showing and draws that generation's lifecycle pill.
 */
export default function WorkspaceGenerationPicker({
  generations,
  loading,
  selectedId,
  onChange,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = useMemo(
    () => generations.find((g) => g.id === selectedId) ?? null,
    [generations, selectedId],
  );

  if (generations.length === 0) {
    return (
      <span className={["text-caption text-kin-muted", loading ? "animate-pulse" : ""].join(" ")}>
        {t("workspace.generation.source")}
      </span>
    );
  }

  const label = selected
    ? `${t("workspace.generation.workspace")} ${selected.generation}`
    : t("workspace.generation.source");

  return (
    <>
      {/* The children are elements, so the facade cannot derive a string
          accessible name; the label is stated explicitly. */}
      <Button
        ref={triggerRef}
        variant="secondary"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="h-auto! rounded-md px-2 py-1 text-caption [&>span>span]:flex [&>span>span]:items-center [&>span>span]:gap-1"
      >
        <span className="truncate max-w-[160px]">{label}</span>
        {selected && (
          <span
            className={[
              "flex-none rounded px-1 py-0 text-micro font-semibold uppercase tracking-label",
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
      </Button>
      <Menu
        open={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        label={label}
        items={[
          {
            id: "source",
            label: t("workspace.generation.source"),
            // The consequence stays in the row's text content, so it is part
            // of the name a reader hears as they move through the choices.
            description: t("workspace.generation.readOnly"),
            checked: selectedId === null,
            onSelect: () => onChange(null),
          },
          ...generations.map((gen) => ({
            id: gen.id,
            label: `${t("workspace.generation.workspace")} ${gen.generation}`,
            description: stateLabel(gen.state, t),
            checked: selectedId === gen.id,
            onSelect: () => onChange(gen.id),
          })),
        ]}
        // A radio menu opens on the row that is set: the arrow keys then move
        // from the current choice instead of from the top of the list.
        initialFocusId={selectedId ?? "source"}
        placement="below"
        align="left"
      />
    </>
  );
}

function stateBadgeClass(state: string): string {
  switch (state) {
    case "active":
    case "ready":
      return "bg-kin-blue/15 text-kin-blue-ink";
    case "integrated":
    case "released":
      return "bg-kin-green/15 text-kin-green-ink";
    case "merge_blocked":
    case "finalize_blocked":
      return "bg-kin-orange/15 text-kin-orange-ink";
    case "orphaned":
      return "bg-kin-red/15 text-kin-red-ink";
    default:
      return "bg-kin-muted/15 text-kin-muted";
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
