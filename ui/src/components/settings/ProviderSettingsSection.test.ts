import { describe, expect, it } from "vitest";
import type { ProviderEntry } from "../../api/client";
import { providerDisplayName, providerSummary } from "./ProviderSettingsSection";

describe("providerDisplayName", () => {
  it("prefers the display name over model and id", () => {
    const provider = {
      id: "openai",
      name: "OpenAI",
      kind: "openai-compatible",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      active: false,
    } satisfies ProviderEntry;

    expect(providerDisplayName(provider)).toBe("OpenAI");
  });

  it("falls back to model and then id", () => {
    expect(
      providerDisplayName({
        id: "fallback",
        name: "",
        kind: "openai-compatible",
        base_url: "",
        model: "gpt-4.1-mini",
        active: false,
      }),
    ).toBe("gpt-4.1-mini");

    expect(
      providerDisplayName({
        id: "fallback",
        name: "",
        kind: "openai-compatible",
        base_url: "",
        model: "",
        active: false,
      }),
    ).toBe("fallback");
  });
});

describe("providerSummary", () => {
  it("preserves the existing model and base URL summary format", () => {
    expect(
      providerSummary({
        id: "openai",
        name: "OpenAI",
        kind: "openai-compatible",
        base_url: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        active: true,
      }),
    ).toBe("gpt-4.1-mini · https://api.openai.com/v1");

    expect(
      providerSummary({
        id: "proxy",
        name: "Proxy",
        kind: "openai-compatible",
        base_url: "https://proxy.example.com/v1",
        model: "",
        active: false,
      }),
    ).toBe(" · https://proxy.example.com/v1");
  });
});
