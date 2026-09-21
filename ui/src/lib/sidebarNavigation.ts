export type SidebarNavItemId = "artifacts" | "routines" | "agents" | "settings";

export type SidebarNavItem = {
  id: SidebarNavItemId;
  path: string;
  labelKey: string;
};

export type SidebarNavSection = {
  id: "library" | "operations";
  labelKey: string;
  items: SidebarNavItem[];
};

export function sidebarNavSections(): SidebarNavSection[] {
  return [
    {
      id: "library",
      labelKey: "nav.sectionLibrary",
      items: [
        { id: "artifacts", path: "/artifacts", labelKey: "nav.artifacts" },
        { id: "routines", path: "/routines", labelKey: "nav.routines" },
      ],
    },
    {
      id: "operations",
      labelKey: "nav.sectionOperations",
      items: [
        { id: "agents", path: "/agents", labelKey: "nav.agentOperations" },
        { id: "settings", path: "/settings", labelKey: "nav.settings" },
      ],
    },
  ];
}
