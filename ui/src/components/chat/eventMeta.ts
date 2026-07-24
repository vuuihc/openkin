/**
 * Canonical event metadata for Kin task transcripts.
 *
 * Transport type (message, tool_use, result, …) lives on TaskEvent.type.
 * Semantic origin, audience, phase, and execution attribution live here.
 * Provider-specific content remains in the raw payload and is interpreted by
 * adapters / projection separately.
 */

export type EventOrigin =
  | "user"
  | "host"
  | "worker"
  | "orchestrator"
  | "delegate"
  | "create"
  | "follow_up"
  | string;

export type EventPhase = "plan" | "progress" | "summary" | string;

export type EventVisibility = {
  user: boolean;
  task: boolean;
};

export type ExecutionAttribution = {
  id?: string;
  agent?: string;
  step?: number;
  model?: string;
};

/** Discriminated view of canonical envelope fields on a payload. */
export type CanonicalEventMeta = {
  speaker: string;
  agent?: string;
  origin?: EventOrigin;
  phase?: EventPhase;
  model?: string;
  role?: string;
  visibility?: EventVisibility;
  execution?: ExecutionAttribution;
  /** True when visibility was inferred by the legacy compatibility path. */
  legacyVisibility: boolean;
};

/** Transport/control labels that must not become chat speakers. */
const CONTROL_SOURCE_LABELS = new Set([
  "follow_up",
  "create",
  "orchestrator",
  "delegate",
  "host",
  "user",
  "system",
  "assistant",
]);

/**
 * Isolate historical decoding in one compatibility function.
 * Explicit speaker/agent and visibility are authoritative for new rows.
 * Wording heuristics are not applied here — callers may still need a
 * narrow phase-less orchestrator fallback for stored history.
 */
export function decodeCanonicalEventMeta(
  payload: Record<string, unknown>,
  hostSpeaker = "",
): CanonicalEventMeta {
  const speaker = resolveSpeaker(payload, hostSpeaker);
  const agent =
    typeof payload.agent === "string" && payload.agent.trim()
      ? payload.agent.trim()
      : undefined;
  const origin =
    typeof payload.source === "string" && payload.source.trim()
      ? (payload.source.trim() as EventOrigin)
      : undefined;
  const phase =
    typeof payload.phase === "string" && payload.phase.trim()
      ? (payload.phase.trim() as EventPhase)
      : undefined;
  const model =
    typeof payload.model === "string" && payload.model.trim()
      ? payload.model.trim()
      : undefined;
  const role =
    typeof payload.role === "string" && payload.role.trim()
      ? payload.role.trim()
      : undefined;

  const explicit = readVisibility(payload);
  let visibility = explicit;
  let legacyVisibility = false;
  if (!visibility) {
    visibility = legacyVisibilityFor(speaker, hostSpeaker, origin);
    legacyVisibility = true;
  }

  const execution = readExecution(payload);

  return {
    speaker,
    agent,
    origin,
    phase,
    model,
    role,
    visibility,
    execution,
    legacyVisibility,
  };
}

/**
 * Resolve the speaking agent for an event.
 * Explicit `speaker` / `agent` are authoritative for any plugin ID.
 * Control-plane labels that appear only as `source` are never speakers.
 * Legacy rows may encode a built-in agent id in `source`.
 */
export function resolveSpeaker(
  p: Record<string, unknown>,
  hostSpeaker = "",
): string {
  for (const raw of [p.speaker, p.agent]) {
    if (typeof raw === "string") {
      const s = raw.trim();
      if (s) return s;
    }
  }
  // Legacy fallback only: reached when no explicit speaker/agent is stamped.
  // Real user turns and stamped workers/host echoes both carry a speaker and
  // return above, so this never reclaims a role:"user" tool_result / echo.
  if (p.role === "user") return "user";
  // Narrow legacy path: older rows sometimes used source as agent identity.
  if (typeof p.source === "string") {
    const s = p.source.trim();
    if (s && !CONTROL_SOURCE_LABELS.has(s)) return s;
  }
  return hostSpeaker || "assistant";
}

function readVisibility(
  p: Record<string, unknown>,
): EventVisibility | undefined {
  const v = p.visibility as { task?: boolean; user?: boolean } | undefined;
  if (!v || typeof v !== "object") return undefined;
  if (typeof v.user !== "boolean" && typeof v.task !== "boolean") {
    return undefined;
  }
  return {
    user: Boolean(v.user),
    task: typeof v.task === "boolean" ? v.task : true,
  };
}

function legacyVisibilityFor(
  speaker: string,
  hostSpeaker: string,
  origin?: EventOrigin,
): EventVisibility {
  if (
    speaker === "user" ||
    speaker === "kin" ||
    speaker === hostSpeaker ||
    speaker === "orchestrator" ||
    origin === "orchestrator" ||
    origin === "delegate"
  ) {
    return { user: true, task: true };
  }
  // Historical workers without visibility → task-only.
  if (speaker && speaker !== "assistant") {
    return { user: false, task: true };
  }
  return { user: true, task: true };
}

function readExecution(
  p: Record<string, unknown>,
): ExecutionAttribution | undefined {
  const id =
    typeof p.execution_id === "string" ? p.execution_id.trim() : undefined;
  const agent =
    typeof p.execution_agent === "string"
      ? p.execution_agent.trim()
      : undefined;
  const model =
    typeof p.execution_model === "string"
      ? p.execution_model.trim()
      : undefined;
  let step: number | undefined;
  if (typeof p.execution_step === "number" && Number.isFinite(p.execution_step)) {
    step = p.execution_step;
  }
  if (!id && !agent && step === undefined && !model) return undefined;
  return { id: id || undefined, agent, step, model };
}

/**
 * Whether the event is task-log only (progress box / hidden from main chat).
 * Explicit visibility.user is authoritative.
 */
export function isTaskOnlyMeta(meta: CanonicalEventMeta): boolean {
  if (meta.speaker === "user") return false;
  if (meta.visibility) {
    if (meta.visibility.user) return false;
    if (meta.visibility.task) return true;
  }
  if (meta.origin === "orchestrator" || meta.origin === "delegate") {
    return false;
  }
  return false;
}

/**
 * Intermediate multi-agent chatter goes into the progress box.
 * Explicit phase is preferred; wording heuristics apply only to legacy
 * orchestrator rows that predate the phase field (preserved for stored history).
 */
export function isProgressMessageMeta(
  meta: CanonicalEventMeta,
  text: string,
): boolean {
  if (meta.speaker === "user") return false;
  if (meta.origin === "delegate") return true;
  if (meta.origin === "orchestrator") {
    if (meta.phase === "summary") return false;
    if (meta.phase === "plan" || meta.phase === "progress") return true;
    // Legacy rows without phase: keep wording heuristic only for history.
    if (meta.legacyVisibility || !meta.phase) {
      if (isLegacyOrchestratorSummaryWording(text)) return false;
    }
    return true;
  }
  return isTaskOnlyMeta(meta);
}

/**
 * Historical orchestrator summaries used fixed Chinese/English prefixes
 * before phase=summary was stamped. Kept only for stored history decoding.
 */
export function isLegacyOrchestratorSummaryWording(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^完成(（有失败）)?[：:]/u.test(trimmed) ||
    /^(done|completed)([:：]|\s*\()/i.test(trimmed)
  );
}
