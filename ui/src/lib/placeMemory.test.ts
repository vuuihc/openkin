// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { rememberedProject, rememberProject } from "./placeMemory";

/**
 * KIN-START-001: the project each machine was last used in.
 *
 * The draft keeps one place; this keeps one per machine so switching away and
 * back does not forget where each machine was working. Best-effort client
 * storage: an unreadable value is simply no memory.
 */
describe("the place memory (KIN-START-001)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("remembers a project per machine", () => {
    rememberProject("device-studio", "/srv/gamma");
    rememberProject("", "/work/alpha");
    expect(rememberedProject("device-studio")).toBe("/srv/gamma");
    expect(rememberedProject("")).toBe("/work/alpha");
    expect(rememberedProject("device-nas")).toBe("");
  });

  it("keeps the two machines' entries apart", () => {
    rememberProject("device-studio", "/srv/gamma");
    rememberProject("device-studio", "/srv/delta");
    rememberProject("", "/work/alpha");
    expect(rememberedProject("device-studio")).toBe("/srv/delta");
    expect(rememberedProject("")).toBe("/work/alpha");
  });

  it("forgets a machine when the place is cleared", () => {
    rememberProject("device-studio", "/srv/gamma");
    rememberProject("device-studio", "  ");
    expect(rememberedProject("device-studio")).toBe("");
  });

  it("reads a corrupt value as no memory", () => {
    localStorage.setItem("kin_place_projects", "{not json");
    expect(rememberedProject("device-studio")).toBe("");
    localStorage.setItem("kin_place_projects", "[1,2]");
    expect(rememberedProject("device-studio")).toBe("");
  });

  it("does not mistake a prototype key for a remembered project", () => {
    // The machine id comes from storage; "constructor" must not return a
    // function that the page would then call .trim() on.
    expect(rememberedProject("constructor")).toBe("");
    expect(rememberedProject("toString")).toBe("");
  });
});
