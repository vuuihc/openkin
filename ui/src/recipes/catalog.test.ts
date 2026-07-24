import { describe, expect, it } from "vitest";
import { getRecipe, listRecipes, renderRecipe } from "./catalog";

describe("renderRecipe", () => {
  it("replaces known placeholders", () => {
    const out = renderRecipe("A={{project_name}} B={{cwd}} C={{user_note}}", {
      project_name: "Kin",
      cwd: "/tmp/x",
      user_note: "go",
    });
    expect(out).toContain("A=Kin");
    expect(out).toContain("B=/tmp/x");
    expect(out).toContain("C=go");
  });

  it("uses default for empty user_note", () => {
    const out = renderRecipe("N={{user_note}}", {});
    expect(out).toContain("（无）");
  });

  it("focus.continue template is non-empty", () => {
    const r = getRecipe("focus.continue");
    const prompt = renderRecipe(r.promptTemplate, {
      project_name: "Demo",
      cwd: "/repo",
    });
    expect(prompt.length).toBeGreaterThan(20);
    expect(prompt).toContain("Demo");
  });
});

  it("lists built-in recipes", () => {
    const ids = listRecipes().map((r) => r.id);
    expect(ids).toContain("focus.continue");
    expect(ids).toContain("cover.update");
    expect(ids).toContain("project.memory.tidy");
  });

