export type NewChatControlId =
  "machine" | "permission" | "routine" | "hostModel" | "dispatch" | "cwd" | "branch";

export type NewChatControlGroup = {
  id: "run" | "route" | "workspace";
  labelKey: string;
  controls: NewChatControlId[];
};

export function newChatControlGroups({
  asRoutine,
  remote = false,
}: {
  asRoutine: boolean;
  /** Aimed at another machine: no routine (they run here) and no team dispatch
   *  (that is the Hub's own routing, which does not cross machines). */
  remote?: boolean;
}): NewChatControlGroup[] {
  return [
    {
      id: "run",
      labelKey: "newChat.controlsRun",
      controls: remote ? ["permission"] : ["permission", "routine"],
    },
    ...(asRoutine
      ? []
      : [
          {
            id: "route" as const,
            labelKey: "newChat.controlsRoute",
            controls: (remote
              ? ["machine", "hostModel"]
              : ["machine", "hostModel", "dispatch"]) as NewChatControlId[],
          },
        ]),
    {
      id: "workspace",
      labelKey: "newChat.controlsWorkspace",
      controls: ["cwd", "branch"],
    },
  ];
}
