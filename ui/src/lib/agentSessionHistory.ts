import type { AgentSessionHistoryItem } from "../api/client";

export type AgentSessionTurn = {
  id: string;
  userItems: AgentSessionHistoryItem[];
  finalAssistant: AgentSessionHistoryItem | null;
  processItems: AgentSessionHistoryItem[];
};

export function mergeAgentSessionMessageChunks(
  items: AgentSessionHistoryItem[],
): AgentSessionHistoryItem[] {
  const merged: AgentSessionHistoryItem[] = [];
  for (const item of items) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      (item.kind ?? "message") === "message" &&
      (previous.kind ?? "message") === "message" &&
      item.role === previous.role &&
      sameProviderMessage(previous.message_id, item.message_id)
    ) {
      previous.text = `${previous.text}\n\n${item.text}`;
      previous.message_id = `${previous.message_id}:${item.message_id}`;
      continue;
    }
    merged.push({ ...item });
  }
  return merged;
}

/**
 * Provider transcripts do not expose one shared turn identifier. A user
 * message is therefore the stable boundary, and the last assistant message
 * in that boundary is treated as the turn's conclusion.
 */
export function groupAgentSessionHistory(
  items: AgentSessionHistoryItem[],
): AgentSessionTurn[] {
  const turns: AgentSessionTurn[] = [];
  let current: AgentSessionHistoryItem[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const finalIndex = findFinalAssistantIndex(current);
    const first = current[0];
    turns.push({
      id: `${first.source_rev}:${first.message_id.split(":")[0]}`,
      userItems: current.filter((item) => item.role === "user"),
      finalAssistant: finalIndex >= 0 ? current[finalIndex] : null,
      processItems: current.filter(
        (item, index) => item.role !== "user" && index !== finalIndex,
      ),
    });
    current = [];
  };

  for (const item of items) {
    if (item.role === "user" && current.length > 0) flush();
    current.push(item);
  }
  flush();
  return turns;
}

function findFinalAssistantIndex(items: AgentSessionHistoryItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.role === "assistant" && (item.kind ?? "message") === "message") {
      return index;
    }
  }
  return -1;
}

function sameProviderMessage(previousID: string, currentID: string): boolean {
  if (previousID === currentID) return true;
  const previousRoot = previousID.split(":")[0];
  const currentRoot = currentID.split(":")[0];
  return (
    previousRoot !== "" &&
    previousRoot === currentRoot &&
    (previousID.includes(":") || currentID.includes(":"))
  );
}
