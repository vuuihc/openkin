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
