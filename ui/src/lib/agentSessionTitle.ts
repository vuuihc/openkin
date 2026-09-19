import type { AgentSession } from "../api/client";
import { agentDisplayName } from "./agentMention";

const opaqueTitlePattern =
  /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|[a-z0-9][a-z0-9_-]{23,})$/i;

function shortExternalRef(externalRef: string): string {
  const value = externalRef.trim();
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function isOpaqueAgentSessionTitle(title: string, externalRef: string): boolean {
  const value = title.trim();
  return (
    value.length === 0 ||
    value === externalRef.trim() ||
    opaqueTitlePattern.test(value)
  );
}

/**
 * Keep provider IDs available as metadata without using them as the primary
 * label when an older index row has no human-readable title.
 */
export function displayAgentSessionTitle(
  session: Pick<AgentSession, "agent_id" | "external_ref" | "project_label" | "title">,
  fallback: string,
): string {
  const title = session.title.trim();
  if (!isOpaqueAgentSessionTitle(title, session.external_ref)) {
    return title;
  }
  const project = session.project_label?.trim();
  const suffix = shortExternalRef(session.external_ref);
  if (project) {
    return `${agentDisplayName(session.agent_id)} · ${project} · ${suffix}`;
  }
  return suffix ? `${fallback} · ${suffix}` : fallback;
}
