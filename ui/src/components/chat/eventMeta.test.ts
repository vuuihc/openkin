import { describe, expect, it } from "vitest";
import {
  decodeCanonicalEventMeta,
  isLegacyOrchestratorSummaryWording,
  isProgressMessageMeta,
  isTaskOnlyMeta,
  resolveSpeaker,
} from "./eventMeta";

describe("decodeCanonicalEventMeta", () => {
  it("accepts explicit speaker for arbitrary plugin ids", () => {
    const meta = decodeCanonicalEventMeta(
      {
        speaker: "future-agent",
        visibility: { user: true, task: true },
        phase: "summary",
        source: "host",
      },
      "future-agent",
    );
    expect(meta.speaker).toBe("future-agent");
    expect(meta.visibility).toEqual({ user: true, task: true });
    expect(meta.legacyVisibility).toBe(false);
    expect(meta.phase).toBe("summary");
  });

  it("isolates legacy visibility decoding for stored history", () => {
    const worker = decodeCanonicalEventMeta(
      { speaker: "codex", text: "legacy worker note" },
      "kin",
    );
    expect(worker.legacyVisibility).toBe(true);
    expect(isTaskOnlyMeta(worker)).toBe(true);

    const host = decodeCanonicalEventMeta(
      { speaker: "kin", text: "legacy host reply" },
      "kin",
    );
    expect(isTaskOnlyMeta(host)).toBe(false);
  });

  it("does not treat control source labels as speakers", () => {
    expect(
      resolveSpeaker({ source: "follow_up", text: "x" }, "future-agent"),
    ).toBe("future-agent");
  });

  it("keeps legacy role-only user messages attributed to the user", () => {
    expect(resolveSpeaker({ role: "user", text: "hello" }, "future-agent"))
      .toBe("user");
  });

  it("keeps explicit visibility authoritative over origin fallbacks", () => {
    const meta = decodeCanonicalEventMeta(
      {
        speaker: "future-agent",
        source: "orchestrator",
        visibility: { user: false, task: true },
      },
      "future-agent",
    );
    expect(isTaskOnlyMeta(meta)).toBe(true);
  });

  it("uses phase for progress vs summary without wording heuristics", () => {
    const summary = decodeCanonicalEventMeta(
      {
        speaker: "kin",
        source: "orchestrator",
        phase: "summary",
        visibility: { user: true, task: true },
      },
      "kin",
    );
    expect(
      isProgressMessageMeta(summary, "The workers found and fixed the root cause."),
    ).toBe(false);

    const plan = decodeCanonicalEventMeta(
      {
        speaker: "kin",
        source: "orchestrator",
        phase: "plan",
        visibility: { user: true, task: true },
      },
      "kin",
    );
    expect(isProgressMessageMeta(plan, "plan text")).toBe(true);
  });

  it("keeps wording heuristic only for phase-less legacy orchestrator rows", () => {
    expect(isLegacyOrchestratorSummaryWording("完成：done")).toBe(true);
    const legacy = decodeCanonicalEventMeta(
      { speaker: "kin", source: "orchestrator", text: "完成：all good" },
      "kin",
    );
    expect(isProgressMessageMeta(legacy, "完成：all good")).toBe(false);
  });
});
