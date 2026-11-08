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

/**
 * The provider path of a catalog id: everything before the model name.
 *
 * A gateway nests its providers (`gateway/dashscope/glm-5.3`), so the first
 * segment alone puts every one of its models under one heading and leaves
 * same-named rows (six "GLM 5.3"s from six upstreams) indistinguishable. The
 * full prefix, minus the model name, is what actually names the source. An id
 * with no slash has no provider to name.
 */
export function modelPickerProvider(id: string): string {
  const trimmed = id.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash > 0 ? trimmed.slice(0, slash) : "";
}

/** Rows every model picker shows: Default, the agent's catalog, Custom. */
export function modelPickerOptions(
  models: AgentModelOption[],
  copy: { default: string; custom: string },
): { id: string; label: string; detail?: string; group?: string }[] {
  const rows: { id: string; label: string; detail?: string; group?: string }[] = [];
  // A choice is one row no matter how many settings name it; the catalog
  // adapters already dedupe, but the pickers are also fed by remote agents and
  // older daemons. Keep the first row so the keyboard order stays stable.
  const seen = new Set<string>();
  for (const m of models) {
    const key = m.id.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const provider = modelPickerProvider(m.id);
    rows.push({
      id: m.id,
      label: modelPickerLabel(m),
      // Secondary text is either the model's tier or its provider — the two
      // things `SearchSelect` documents there. Without a provider a row names
      // no source at all, and the phone's flat sheet has no heading to fall
      // back to.
      ...(m.tier ? { detail: m.tier } : provider ? { detail: provider } : {}),
      ...(provider ? { group: provider } : {}),
    });
  }
  return [{ id: "", label: copy.default }, ...rows, { id: CUSTOM_MODEL_ID, label: copy.custom }];
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
