import { describe, expect, it } from "vitest";
import { isListedModel, normalizeModelSelection } from "./agentModels";

describe("agent model choices", () => {
  it("keeps arbitrary custom model IDs usable", () => {
    const models = [{ id: "sonnet" }];
    expect(isListedModel(models, "sonnet")).toBe(true);
    expect(isListedModel(models, "proxy/preview-model")).toBe(false);
    expect(normalizeModelSelection(" proxy/preview-model ")).toBe("proxy/preview-model");
  });

  it("preserves empty default semantics", () => {
    expect(normalizeModelSelection("  ")).toBe("");
  });
});
