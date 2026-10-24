import { useT } from "../../i18n/react";
import type { Machine } from "../../lib/devices";

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

  return (
    <select
      className={[
        "max-w-[10.5rem] truncate rounded-lg border bg-transparent px-1.5 py-0.5 text-caption font-medium",
        "focus:outline-none focus:ring-1 focus:ring-kin-focus-ring",
        offline
          ? "border-[rgba(255,159,10,.4)] text-[#ffb340]"
          : "border-[var(--kin-hairline-strong)] text-kin-secondary",
        disabled ? "opacity-70 cursor-default" : "cursor-pointer hover:text-kin-text",
      ].join(" ")}
      value={missing ? MISSING : (value ?? "")}
      disabled={disabled || loading}
      aria-label={tr("machine.title")}
      title={
        missing
          ? tr("machine.gone", { name: missing })
          : offline
            ? tr("machine.offlineHint", { name: selected?.label ?? "" })
            : tr("machine.pickerHint")
      }
      onChange={(e) => onChange(e.target.value || null)}
    >
      {loading && machines.length === 0 ? (
        <option value="">{tr("machine.detecting")}</option>
      ) : null}
      {missing ? <option value={MISSING}>{tr("machine.gone", { name: missing })}</option> : null}
      {machines.map((m) => (
        <option key={m.id || "self"} value={m.isSelf ? "" : m.id}>
          {m.isSelf ? tr("machine.thisMachine") : m.label}
          {m.online ? "" : ` · ${tr("machine.offline")}`}
        </option>
      ))}
    </select>
  );
}

/** Not a device id: a device id could in principle be this string. */
const MISSING = "\u0000missing";
