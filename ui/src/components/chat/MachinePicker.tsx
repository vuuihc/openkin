import { useT } from "../../i18n/react";
import type { Machine } from "../../lib/devices";
import SheetSelect from "../ui/SheetSelect";

type Props = {
  machines: Machine[];
  /** null = this machine. */
  value: string | null;
  /** Set when a machine was chosen and is no longer in the list. */
  missing?: string | null;
  loading?: boolean;
  disabled?: boolean;
  onChange: (id: string | null) => void;
};

/**
 * Which machine runs the work. Sits with the other route controls because it
 * decides two things at once: whose agents can run it, and which filesystem the
 * cwd refers to.
 *
 * The console's own picker, not a native `<select>`: on iOS the native one
 * opens a system wheel that belongs to the platform rather than to the console,
 * and its closed state ignores the design tokens. This is the same control the
 * role and routines-device rows use, so the route row has one shape on both
 * widths — an anchored menu on a Mac, the action sheet on a phone.
 */
export default function MachinePicker({
  machines,
  value,
  missing,
  loading,
  disabled,
  onChange,
}: Props) {
  const tr = useT();
  const selected = machines.find((m) => m.id === value);
  const offline = selected ? !selected.online : false;
  const detecting = Boolean(loading) && machines.length === 0;

  // The value a machine row reports is its id; this console is the empty id, so
  // the picker and the rest of the console keep naming "here" the same way.
  const options = detecting
    ? [{ id: "", label: tr("machine.detecting") }]
    : machines.map((m) => ({
        id: m.isSelf ? "" : m.id,
        label: m.isSelf
          ? tr("machine.thisMachine")
          : `${m.label}${m.online ? "" : ` · ${tr("machine.offline")}`}`,
      }));

  return (
    <SheetSelect
      label={tr("machine.title")}
      // A gone machine is a state, not a choice: the chip says which one is
      // missing, and the list still offers the machines that can run work.
      value={missing ? MISSING : (value ?? "")}
      display={missing ? tr("machine.gone", { name: missing }) : undefined}
      options={options}
      disabled={disabled || loading}
      className={["max-w-[10.5rem]", offline ? "text-kin-orange-ink" : "text-kin-secondary"].join(
        " ",
      )}
      onChange={(id) => onChange(id === MISSING ? null : id || null)}
    />
  );
}

/** Not a device id: a device id could in principle be this string. */
const MISSING = "\u0000missing";
