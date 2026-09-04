import { describe, expect, it } from "vitest";
import { parseWSMessage } from "./contract";

const task = {
  id: "task-1",
  title: "Task",
  agent: "kin",
  cwd: "/tmp",
  prompt: "work",
  status: "running",
  tokens_in: 0,
  tokens_out: 0,
  created_at: 1,
  event_epoch: 0,
};

describe("parseWSMessage", () => {
  it("accepts each discriminated live-message shape", () => {
    const messages = [
      { kind: "task_update", data: task },
      { kind: "task_deleted", data: { id: task.id } },
      {
        kind: "event",
        data: {
          task_id: task.id,
          event_epoch: 0,
          seq: 1,
          ts: 2,
          type: "message",
          payload: {},
        },
      },
      {
        kind: "approval_update",
        data: {
          id: "approval-1",
          task_id: task.id,
          kind: "tool",
          payload: {},
          decision: "pending",
          created_at: 3,
        },
      },
      {
        kind: "user_question_update",
        data: {
          id: "question-1",
          task_id: task.id,
          payload: {
            question: "Continue?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
          status: "pending",
          created_at: 4,
        },
      },
    ];

    for (const message of messages) {
      expect(parseWSMessage(JSON.stringify(message))).toEqual(message);
    }
  });

  it.each([
    ["invalid JSON", "{"],
    ["non-text frame", new Blob(["{}"])],
    ["unknown kind", JSON.stringify({ kind: "unknown", data: {} })],
    ["missing envelope data", JSON.stringify({ kind: "task_deleted" })],
    [
      "invalid task payload",
      JSON.stringify({ kind: "task_update", data: { id: "task-1" } }),
    ],
    [
      "invalid optional task field",
      JSON.stringify({
        kind: "task_update",
        data: { ...task, routine_unread: "yes" },
      }),
    ],
    [
      "missing task event epoch",
      JSON.stringify({
        kind: "task_update",
        data: Object.fromEntries(
          Object.entries(task).filter(([key]) => key !== "event_epoch"),
        ),
      }),
    ],
    [
      "extra envelope field",
      JSON.stringify({ kind: "task_deleted", data: { id: "task-1" }, extra: true }),
    ],
    [
      "invalid event sequence",
      JSON.stringify({
        kind: "event",
        data: {
          task_id: "task-1",
          event_epoch: 0,
          seq: 0,
          ts: 1,
          type: "message",
          payload: {},
        },
      }),
    ],
    [
      "invalid user question payload",
      JSON.stringify({
        kind: "user_question_update",
        data: {
          id: "question-1",
          task_id: "task-1",
          payload: {},
          status: "pending",
          created_at: 4,
        },
      }),
    ],
    [
      "invalid user question response",
      JSON.stringify({
        kind: "user_question_update",
        data: {
          id: "question-1",
          task_id: "task-1",
          payload: {
            question: "Continue?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
          response: { selected: "Yes" },
          status: "answered",
          created_at: 4,
        },
      }),
    ],
  ])("rejects %s", (_name, frame) => {
    expect(parseWSMessage(frame)).toBeNull();
  });
});
