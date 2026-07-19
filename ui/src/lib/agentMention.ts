/**
 * Parse @agent directives from a user prompt.
 *
 * Single:
 *   "@codex fix the tests" → { agents: ["codex"], steps: [...], prompt cleaned }
 * Multi (host orchestrates workers):
 *   "调研 X，@claude 做实验 @codex 验收" → multiple steps, keep raw for backend
 */

const ALIASES: Record<string, string> = {
  kin: "kin",
  "claude-code": "claude-code",
  claude: "claude-code",
  cc: "claude-code",
  codex: "codex",
  gpt: "codex",
  openai: "codex",
  grok: "grok",
  xai: "grok",
};

/** Ordered mention patterns (longer first). */
const MENTION_RE =
  /@([a-zA-Z][a-zA-Z0-9_-]*)(?:\[([a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127})\])?/g;

export type DelegateStep = {
  agent: string;
  model?: string;
  instruction: string;
  mention: string;
};

export type AgentDirective = {
  /** First mentioned available agent (legacy single-route). */
  agent?: string;
  /** All resolved worker steps in order. */
  steps: DelegateStep[];
  /** Prompt with @mentions stripped (legacy). */
  prompt: string;
  /** Original text (backend orchestrator prefers this). */
  raw: string;
  /** Raw first mention token if any. */
  mention?: string;
  /** True when ≥1 worker step is assigned. */
  multi: boolean;
};

export function parseAgentDirective(
  raw: string,
  availableIds: string[],
): AgentDirective {
  const avail = new Set(availableIds);
  const text = raw;
  const hits: {
    start: number;
    end: number;
    agent: string;
    model?: string;
    mention: string;
  }[] = [];

  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const tok = m[1];
    const key = tok.toLowerCase();
    const id = ALIASES[key] ?? key;
    if (!avail.has(id)) continue;
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      agent: id,
      model: m[2] || undefined,
      mention: tok,
    });
  }

  if (hits.length === 0) {
    return {
      steps: [],
      prompt: text.trim(),
      raw: text,
      multi: false,
    };
  }

  const overview = text.slice(0, hits[0].start).trim();
  const steps: DelegateStep[] = hits.map((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : text.length;
    let instruction = text.slice(h.end, end).trim().replace(/[ \t]{2,}/g, " ");
    if (!instruction) {
      instruction =
        overview || "Complete the assigned work for this session.";
    }
    return {
      agent: h.agent,
      model: h.model,
      instruction,
      mention: h.mention,
    };
  });

  const workers = steps.filter((s) => !!s.agent);
  // Strip mentions for a cleaned single-agent prompt (first worker or kin).
  const cleaned = text
    .replace(MENTION_RE, (full, tok: string) => {
      const key = String(tok).toLowerCase();
      const id = ALIASES[key] ?? key;
      if (avail.has(id) || ALIASES[key]) return " ";
      return full;
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    agent: workers[0]?.agent ?? steps[0]?.agent,
    steps,
    prompt: cleaned || overview || text.trim(),
    raw: text,
    mention: hits[0]?.mention,
    multi: workers.length >= 1,
  };
}

/** Short labels for composer hint. */
export function mentionHints(availableIds: string[], hostId?: string): string[] {
  const hints: string[] = [];
  for (const id of availableIds) {
    if (hostId && id === hostId) continue;
    hints.push("@" + id);
  }
  return hints;
}

export function agentDisplayName(id: string): string {
  switch (id) {
    case "kin":
      return "Kin";
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "grok":
      return "Grok";
    case "user":
      return "You";
    default:
      return id;
  }
}

/** Avatar initials / color tokens for chat. */
export function agentAvatarMeta(id: string): {
  label: string;
  initials: string;
  className: string;
} {
  switch (id) {
    case "user":
      return {
        label: "You",
        initials: "Y",
        className: "bg-[var(--kin-fill-strong)] text-kin-text",
      };
    case "kin":
      return {
        label: "Kin",
        initials: "K",
        className: "bg-gradient-to-br from-[#5e5ce6] to-[#3a3a8c] text-white",
      };
    case "claude-code":
      return {
        label: "Claude Code",
        initials: "C",
        className: "bg-[#d97757] text-white",
      };
    case "codex":
      return {
        label: "Codex",
        initials: "X",
        className: "bg-[#10a37f] text-white",
      };
    case "grok":
      return {
        label: "Grok",
        initials: "G",
        className: "bg-zinc-800 text-white border border-zinc-600",
      };
    default: {
      const label = agentDisplayName(id) || id || "agent";
      const cleaned = label.replace(/[^a-zA-Z0-9]+/g, " ").trim();
      const initials = (
        cleaned
          .split(/\s+/)
          .map((w) => w[0] || "")
          .join("") ||
        label.slice(0, 2) ||
        "?"
      )
        .slice(0, 2)
        .toUpperCase();
      return {
        label,
        initials,
        className: "bg-kin-blue-soft text-kin-blue",
      };
    }
  }
}
