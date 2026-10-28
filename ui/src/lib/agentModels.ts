/** Known models from GET /api/agents for the composer model picker. */

export type AgentModelOption = {
  id: string;
  label?: string;
  tier?: string;
};

/** Short label for UI: prefer catalog label, else last path segment of id. */
export function modelPickerLabel(m: AgentModelOption): string {
  const label = (m.label || "").trim();
  if (label) return label;
  const id = m.id.trim();
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/** Models for one agent id from the agents list. */
export function modelsForAgent(
  agents: { id: string; models?: AgentModelOption[] }[],
  agentId: string,
): AgentModelOption[] {
  const a = agents.find((x) => x.id === agentId);
  return a?.models ?? [];
}

export function isListedModel(models: AgentModelOption[], modelId: string): boolean {
  return models.some((model) => model.id === modelId.trim());
}

/** Resolve display value: empty string means "agent default". */
export function normalizeModelSelection(value: string | null | undefined): string {
  return (value || "").trim();
}

/**
 * Row id for the free-text "Custom" choice.
 *
 * It must not be `""`: that is the Default row's id, and a typed model id
 * matches no row at all, so the two states need three distinct values. Both
 * pickers share the sentinel so the two cannot drift.
 */
export const CUSTOM_MODEL_ID = "__custom__";

/** Rows every model picker shows: Default, the agent's catalog, Custom. */
export function modelPickerOptions(
  models: AgentModelOption[],
  copy: { default: string; custom: string },
): { id: string; label: string; detail?: string }[] {
  return [
    { id: "", label: copy.default },
    ...models.map((m) => ({
      id: m.id,
      label: modelPickerLabel(m),
      ...(m.tier ? { detail: m.tier } : {}),
    })),
    { id: CUSTOM_MODEL_ID, label: copy.custom },
  ];
}

/**
 * The row a picker should mark as current.
 *
 * A typed id matches no row, and choosing Custom stores `""` — the Default
 * row's id. Passing the raw value through would therefore mark Default while
 * the chip says Custom; the sentinel keeps them apart.
 */
export function modelPickerSelection(current: string, custom: boolean): string {
  return custom ? CUSTOM_MODEL_ID : current;
}

/** What choosing a row means: Custom opens the free-text field and clears the
 *  stored id; any other row stores the id itself (Default stores ""). */
export function modelPickTarget(id: string): { custom: boolean; value: string } {
  return id === CUSTOM_MODEL_ID ? { custom: true, value: "" } : { custom: false, value: id };
}
