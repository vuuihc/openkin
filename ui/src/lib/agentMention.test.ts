import { describe, expect, it } from "vitest";
import { agentAvatarMeta, parseAgentDirective } from "./agentMention";

const AGENTS = ["kin", "claude-code", "codex", "grok"];

describe("parseAgentDirective", () => {
  it("reads a leading mention as a delegation", () => {
    const plan = parseAgentDirective("@codex fix the tests", AGENTS);
    expect(plan.agent).toBe("codex");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].instruction).toBe("fix the tests");
  });

  it("reads an alias as the agent it names", () => {
    expect(parseAgentDirective("@claude review", AGENTS).agent).toBe("claude-code");
  });

  it("leaves a token that names no known agent as text", () => {
    const plan = parseAgentDirective("@someone look at this", AGENTS);
    expect(plan.steps).toEqual([]);
    expect(plan.prompt).toBe("@someone look at this");
  });

  // The composer's @ menu inserts workspace-relative paths, and the first
  // segment of a path can name an agent. A path is not a delegation.
  it("does not read a path whose first segment names an agent as a mention", () => {
    for (const prompt of [
      "@claude-code/notes.md summarise this",
      "@codex/main.go what does this do",
      "@kin/api/handler.go explain",
      "@codex.go check the parser",
      "@grok[1].txt",
    ]) {
      const plan = parseAgentDirective(prompt, AGENTS);
      expect(plan.steps, prompt).toEqual([]);
      expect(plan.multi, prompt).toBe(false);
    }
  });

  // A stop after the name is punctuation, not a path.
  it("still reads a mention followed by sentence punctuation", () => {
    expect(parseAgentDirective("@codex, please fix", AGENTS).agent).toBe("codex");
    expect(parseAgentDirective("ask @codex.", AGENTS).agent).toBe("codex");
    expect(parseAgentDirective("@codex[gpt-5] fix", AGENTS).steps[0].model).toBe("gpt-5");
  });
});

describe("agentAvatarMeta", () => {
  it("keeps Kin on brand blue and external agents on calm monochrome chrome", () => {
    expect(agentAvatarMeta("kin").className).toContain("bg-kin-blue");
    for (const id of ["claude-code", "codex", "droid", "workbuddy", "trae", "doubao", "zcode"]) {
      const meta = agentAvatarMeta(id);
      expect(meta.className).not.toContain("bg-kin-agent-");
      expect(meta.className).toContain("bg-[var(--kin-fill-strong)]");
      expect(meta.className).toContain("text-kin-secondary");
    }
    expect(agentAvatarMeta("custom-agent").className).toContain("bg-[var(--kin-fill-strong)]");
  });
});
