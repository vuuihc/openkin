import type { AgentSessionHistoryItem, TaskEvent } from "../api/client";

type AgentSessionHistoryKind = NonNullable<AgentSessionHistoryItem["kind"]>;

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
      // One part cut means the message is incomplete: the chunks are one message
      // the provider wrote, split by its own record keeping, so a reader who
      // learns it was cut has learned it about the whole of it.
      previous.truncated = Boolean(previous.truncated || item.truncated);
      continue;
    }
    merged.push({ ...item });
  }
  return merged;
}

/**
 * Project provider-owned history into the same event shape used by Kin task
 * transcripts so imported sessions share the normal chat renderer.
 *
 * `options.truncatedNotice` is the sentence shown after a message the machine
 * could not send whole. It is passed in rather than written here because it is
 * user-visible text and belongs to the locale files; a caller that leaves it out
 * gets the transcript without the markers, which is what a caller with nowhere
 * to show them should get.
 */
export function agentSessionHistoryToTaskEvents(
  items: AgentSessionHistoryItem[],
  taskID: string,
  hostSpeaker: string,
  options: { truncatedNotice?: string } = {},
): TaskEvent[] {
  const events: TaskEvent[] = [];
  const normalized = mergeAgentSessionMessageChunks(items);
  let current: AgentSessionHistoryItem[] = [];
  let seq = 1;

  const flush = () => {
    if (current.length === 0) return;
    const finalIndex = findFinalAssistantIndex(current);
    for (let index = 0; index < current.length; index += 1) {
      const item = current[index];
      const event = historyItemToTaskEvent(item, taskID, hostSpeaker, seq, index === finalIndex);
      if (event) {
        events.push(event);
        seq += 1;
      }
      // After the message, because that is where the reader finds out: the text
      // they just read stopped, and this is why. It is a notice rather than an
      // error — the session was read successfully, and what is missing is the
      // rest of one message.
      if (item.truncated && options.truncatedNotice) {
        events.push({
          task_id: taskID,
          event_epoch: 0,
          seq,
          ts: item.occurred_at || 0,
          type: "notice",
          payload: { message: options.truncatedNotice, severity: "info" },
        });
        seq += 1;
      }
    }
    const last = current[current.length - 1];
    events.push({
      task_id: taskID,
      event_epoch: 0,
      seq,
      ts: last?.occurred_at ?? 0,
      type: "result",
      payload: { is_error: false, source: "host", speaker: hostSpeaker },
    });
    seq += 1;
    current = [];
  };

  for (const item of normalized) {
    if (item.role === "user" && current.length > 0) flush();
    current.push(item);
  }
  flush();
  return events;
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

function historyItemToTaskEvent(
  item: AgentSessionHistoryItem,
  taskID: string,
  hostSpeaker: string,
  seq: number,
  finalAssistant: boolean,
): TaskEvent | null {
  const kind: AgentSessionHistoryKind = item.kind ?? "message";
  const ts = item.occurred_at || 0;
  const messageID = item.message_id || `${item.source_rev}:${seq}`;
  const common = {
    message_id: messageID,
    source_rev: item.source_rev,
    visibility: { user: true, task: true },
  };

  if (kind === "tool_call") {
    const name = item.tool_name?.trim() || "tool";
    return {
      task_id: taskID,
      event_epoch: 0,
      seq,
      ts,
      type: "tool_use",
      payload: {
        ...common,
        source: "host",
        speaker: hostSpeaker,
        role: "assistant",
        phase: "progress",
        tool_use_id: messageID,
        name,
        tool_name: name,
        summary: firstLine(item.text) || name,
        input: item.text,
      },
    };
  }

  if (kind === "tool_result") {
    const name = item.tool_name?.trim();
    return {
      task_id: taskID,
      event_epoch: 0,
      seq,
      ts,
      type: "tool_result",
      payload: {
        ...common,
        source: "host",
        speaker: hostSpeaker,
        role: "assistant",
        phase: "progress",
        tool_use_id: messageID,
        ...(name ? { name, tool_name: name } : {}),
        ok: true,
        output: item.text,
      },
    };
  }

  if (!item.text.trim()) return null;

  const speaker = item.role === "user" ? "user" : hostSpeaker;
  const phase = item.role === "user" ? undefined : finalAssistant ? "summary" : "progress";
  const role = kind === "reasoning" ? "reasoning" : item.role;
  return {
    task_id: taskID,
    event_epoch: 0,
    seq,
    ts,
    type: "message",
    payload: {
      ...common,
      source: item.role === "user" ? "user" : "host",
      speaker,
      role,
      phase,
      content: item.text,
      text: item.text,
    },
  };
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
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
