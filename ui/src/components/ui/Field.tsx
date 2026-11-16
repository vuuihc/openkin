import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { Field as AstryxField } from "@astryxdesign/core";

export type FieldProps = {
  /** The control's id; the label points at it. */
  id: string;
  label: string;
  /** Always-visible guidance; part of the control's description. */
  hint?: string;
  /** When set, marks the control invalid and becomes part of the description. */
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
};

type ControlAria = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
};

/**
 * Give the control the id the label points at and the description this field
 * renders. The child stays the single source of its visible content — the
 * field only adds the label and the description around it.
 */
function withDescription(
  children: ReactNode,
  id: string,
  describedBy: string | undefined,
  invalid: boolean,
): ReactNode {
  if (!isValidElement(children)) return children;
  const control = children as ReactElement<ControlAria>;
  const existing = control.props["aria-describedby"];
  return cloneElement(control, {
    id,
    "aria-describedby": [existing, describedBy].filter(Boolean).join(" ") || undefined,
    ...(invalid ? { "aria-invalid": true as const } : {}),
  });
}

/**
 * The console's field chrome for controls that are not the two text facades —
 * a picker, a composed row.
 *
 * Astryx's `Field` draws the label and owns its `htmlFor`/`id` relationship.
 * Kin renders the hint and the error beside it so their ids are stable and the
 * control's `aria-describedby` points at real elements; an error also sets
 * `aria-invalid`, which a red border alone does not do. There is exactly one
 * label and one description: the Astryx field is not also given a
 * `description`/`status`, which would render a second copy.
 */
export default function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
  className,
}: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <>
      <AstryxField inputID={id} label={label} isRequired={required} className={className}>
        {withDescription(children, id, describedBy, Boolean(error))}
      </AstryxField>
      {hint ? (
        <p id={hintId} className="text-caption text-kin-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-caption text-kin-red-ink">
          {error}
        </p>
      ) : null}
    </>
  );
}
