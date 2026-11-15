import type { AgentModelOption } from "../../lib/agentModels";
import {
  CUSTOM_MODEL_ID,
  isListedModel,
  modelPickTarget,
  modelPickerOptions,
  modelPickerSelection,
} from "../../lib/agentModels";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/react";
import SearchSelect from "../ui/SearchSelect";

type Props = {
  /** Selected model id, or "" for agent default. */
  value: string;
  models: AgentModelOption[];
  source?: "configured" | "discovered" | "recommended" | "none";
  status?: "available" | "default_only" | "unavailable";
  /** When true, picker is display-only (session locked). */
  locked?: boolean;
  disabled?: boolean;
  /** Single-row footer: hide labels / secondary hints. */
  compact?: boolean;
  /**
   * What the trigger names when no model is set: the model the transcript
   * reports, so the strip says what the session is actually running instead
   * of the generic default. The stored value stays "" — a follow-up with no
   * explicit model still lets the daemon choose — and the list marks the
   * custom row, because the named model is not in this agent's catalog.
   */
  fallbackDisplay?: string;
  onChange: (modelId: string) => void;
};

/**
 * Compact model selector for the composer footer.
 * Empty value = agent / CLI default (no model field on the API request).
 */
export default function ModelPicker({
  value,
  models,
  source,
  status,
  locked,
  disabled,
  compact,
  fallbackDisplay,
  onChange,
}: Props) {
  const tr = useT();
  const readOnly = locked || disabled;
  const current = value.trim();
  const currentIsCustom = Boolean(current) && !isListedModel(models, current);
  const [custom, setCustom] = useState(currentIsCustom);
  useEffect(() => {
    if (currentIsCustom) setCustom(true);
    else if (current) setCustom(false);
  }, [currentIsCustom, current]);

  const sourceLabel =
    source && source !== "none"
      ? tr(`modelPicker.source.${source}`)
      : status === "default_only"
        ? tr("modelPicker.defaultOnly")
        : "";

  const options = modelPickerOptions(models, {
    default: tr("modelPicker.default"),
    custom: tr("modelPicker.custom"),
  });
  // A transcript-reported model with no stored value: name it, mark the
  // custom row (it is not in the catalog), and never force the custom input
  // — nothing was typed.
  const namedByTranscript = !current && Boolean(fallbackDisplay?.trim());
  const display =
    custom || currentIsCustom ? current || tr("modelPicker.custom") : undefined;
  // The sentinel, not the raw id — see `modelPickerSelection`.
  const selection = modelPickerSelection(current, custom || currentIsCustom);
  const effectiveSelection = namedByTranscript ? CUSTOM_MODEL_ID : selection;
  const effectiveDisplay = namedByTranscript ? fallbackDisplay!.trim() : display;
  const effectiveTitle = namedByTranscript
    ? fallbackDisplay!.trim()
    : display || current || tr("modelPicker.defaultHint");
  const pick = (id: string) => {
    const next = modelPickTarget(id);
    // Choosing Custom while the trigger only *names* the transcript model
    // should not blank the control: materialise that name as the explicit
    // value, so the custom field opens prefilled with what actually ran.
    const value =
      id === CUSTOM_MODEL_ID && namedByTranscript
        ? fallbackDisplay!.trim()
        : next.value;
    setCustom(next.custom);
    onChange(value);
  };

  if (compact) {
    return (
      <div className="flex items-center gap-1.5 flex-none">
        <SearchSelect
          label={tr("modelPicker.label")}
          value={effectiveSelection}
          display={effectiveDisplay}
          title={effectiveTitle}
          options={options}
          disabled={readOnly}
          onChange={pick}
          className="max-w-[10rem] text-kin-secondary"
          placement="top"
          searchable
          searchPlaceholder={tr("modelPicker.searchPlaceholder")}
          emptyLabel={tr("modelPicker.searchEmpty")}
        />
        {(custom || currentIsCustom) && !readOnly && (
          <input
            className="w-28 px-1.5 py-0.5 text-caption rounded-lg border border-[var(--kin-hairline-strong)] bg-transparent text-kin-secondary focus:outline-none focus:ring-1 focus:ring-kin-focus-ring"
            value={current}
            placeholder={tr("modelPicker.customPlaceholder")}
            aria-label={tr("modelPicker.customLabel")}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {currentIsCustom && readOnly && (
          <span className="text-caption text-kin-secondary truncate">{current}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-caption text-kin-muted flex-none">{tr("modelPicker.label")}</span>
      <SearchSelect
        label={tr("modelPicker.label")}
        value={effectiveSelection}
        display={effectiveDisplay}
        title={effectiveTitle}
        options={options}
        disabled={readOnly}
        onChange={pick}
        className="max-w-[14rem] text-kin-secondary"
        searchable
        searchPlaceholder={tr("modelPicker.searchPlaceholder")}
        emptyLabel={tr("modelPicker.searchEmpty")}
      />
      {(custom || currentIsCustom) && !readOnly && (
        <input
          className="w-44 px-2 py-1 text-caption rounded-lg border border-[var(--kin-hairline-strong)] bg-transparent text-kin-secondary focus:outline-none focus:ring-1 focus:ring-kin-focus-ring"
          value={current}
          placeholder={tr("modelPicker.customPlaceholder")}
          aria-label={tr("modelPicker.customLabel")}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {currentIsCustom && readOnly && (
        <span className="text-caption text-kin-secondary truncate">{current}</span>
      )}
      {sourceLabel && <span className="text-caption text-kin-muted truncate">{sourceLabel}</span>}
      {locked && (
        <span className="text-caption text-kin-muted truncate">
          {tr("modelPicker.sessionHint")}
        </span>
      )}
    </div>
  );
}
