import { describe, expect, it } from "vitest";
import { sidebarNavSections } from "./sidebarNavigation";

describe("sidebarNavSections", () => {
  it("keeps daily library destinations separate from operations surfaces", () => {
    const sections = sidebarNavSections();

    expect(sections.map((section) => section.id)).toEqual(["library", "operations"]);
    expect(sections[0].items.map((item) => item.id)).toEqual(["artifacts", "routines"]);
    expect(sections[1].items.map((item) => item.id)).toEqual(["agents", "settings"]);
  });

  it("labels the current agents route as an operations entry", () => {
    const operations = sidebarNavSections().find((section) => section.id === "operations");

    expect(operations?.items.find((item) => item.id === "agents")).toEqual({
      id: "agents",
      path: "/agents",
      labelKey: "nav.agentOperations",
    });
  });
});
