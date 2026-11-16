import { useRef, type RefObject } from "react";
import { type TerminalProfile } from "../../api/client";
import { useT } from "../../i18n/react";
import Menu from "../ui/Menu";

type Props = {
  profiles: TerminalProfile[];
  open: boolean;
  onClose: () => void;
  onSelectProfile: (profileId: string) => void;
  /** The trigger the menu anchors to and returns focus to (the + / chevron control). */
  anchorRef?: RefObject<HTMLElement | null>;
};

/**
 * Profile picker for "New terminal".
 *
 * The picker is the console's shared `Menu`: the same rows, arrows, Home/End,
 * typeahead, one layer per Escape and focus back on the trigger as every other
 * picker. This module stays the seam the terminal knows — it names the profiles
 * in the terminal's own vocabulary (including which one is the default) — while
 * the layer behavior lives in the facade instead of a private copy of it.
 *
 * The trigger is the chevron, not the group around it: the group is a box, and
 * focus returning to a box is focus going nowhere.
 */
export default function TerminalProfileMenu({
  profiles,
  open,
  onClose,
  onSelectProfile,
  anchorRef,
}: Props) {
  const tr = useT();
  // A caller that passes no trigger still gets a valid (never-focused) anchor;
  // the menu only needs one element to measure against.
  const untetheredRef = useRef<HTMLElement | null>(null);

  if (profiles.length === 0) return null;

  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      triggerRef={anchorRef ?? untetheredRef}
      label={tr("terminal.new")}
      placement="below"
      align="right"
      items={profiles.map((profile) => ({
        id: profile.id,
        label: profile.default
          ? `${profile.name} ${tr("terminal.defaultProfile")}`
          : profile.name,
        onSelect: () => onSelectProfile(profile.id),
      }))}
    />
  );
}
