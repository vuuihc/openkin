export type NewChatControlId =
  | "permission"
  | "routine"
  | "hostModel"
  | "dispatch"
  | "cwd"
  | "branch";

export type NewChatControlGroup = {
  id: "run" | "route" | "workspace";
  labelKey: string;
  controls: NewChatControlId[];
};

export function newChatControlGroups({
  asRoutine,
}: {
  asRoutine: boolean;
}): NewChatControlGroup[] {
  return [
    {
      id: "run",
      labelKey: "newChat.controlsRun",
      controls: ["permission", "routine"],
    },
    ...(asRoutine
      ? []
      : [
          {
            id: "route" as const,
            labelKey: "newChat.controlsRoute",
            controls: ["hostModel", "dispatch"] as NewChatControlId[],
          },
        ]),
    {
      id: "workspace",
      labelKey: "newChat.controlsWorkspace",
      controls: ["cwd", "branch"],
    },
  ];
}
