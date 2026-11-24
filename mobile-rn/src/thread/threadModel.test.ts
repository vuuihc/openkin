import { describe, expect, it, jest } from "@jest/globals";
import type { Task, TaskEvent } from "../../../ui/src/api/contract";
import {
  buildChatItems,
  groupIntoTurns,
} from "../../../ui/src/components/chat/transcriptProjection";
import { createThread, loadThread } from "./threadModel";

/**
 * KIN-MOBILE-001 R4 — the headless conversation read model.
 *
 * The history row compares against the shared projection itself, not a
 * hand-written expectation: R4's contract is that the phone groups the
 * transcript exactly as the web console does. The live round (streamed
 * appends, send queue, stop row) lands in the next slice with its own suite.
 */

const TASK_ID = "task-1";
const ORIGIN = "https://kin.example.com";
const TOKEN = "fixture-token-not-real";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "A conversation",
    agent: "kin",
    cwd: "/work",
    prompt: "hello",
    model: "model-x",
    status: "running",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1,
    event_epoch: 0,
    ...overrides,
  };
}

function event(
  seq: number,
  type = "message",
  payload: TaskEvent["payload"] = {},
): TaskEvent {
  return {
    task_id: TASK_ID,
    event_epoch: 0,
    seq,
    ts: 1_000 + seq,
    type,
    payload,
  };
}

const HISTORY: TaskEvent[] = [
  event(1, "message", {
    speaker: "user",
    role: "user",
    content: "hello",
    visibility: { user: true, task: true },
  }),
  event(2, "task_started"),
  event(3, "message", {
    speaker: "kin",
    content: "hi there",
    visibility: { user: true, task: true },
  }),
  event(4, "result", { is_error: false }),
];

function ok(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

type Reply = { status?: number; body: unknown };
type Router = (url: string, init?: RequestInit) => Reply | Promise<Reply>;

function routedFetch(route: Router): typeof fetch {
  return jest.fn(async (input: string, init?: RequestInit) => {
    const reply = await route(input, init);
    return ok(reply.body, reply.status ?? 200);
  }) as unknown as typeof fetch;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("KIN-MOBILE-001 R4 thread model", () => {
  it("KIN-MOBILE-001 R4: history is grouped by the shared projection", async () => {
    const fetchImpl = routedFetch((url) =>
      url.endsWith("/events") ? { body: HISTORY } : { body: task() },
    );

    const snapshot = await loadThread(ORIGIN, TOKEN, TASK_ID, { fetchImpl });
    const expected = groupIntoTurns(
      buildChatItems(HISTORY, "kin", "model-x", false, "running"),
      "kin",
      "model-x",
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.turns).toEqual(expected);
    expect(snapshot.running).toBe(true);
  });

  it("KIN-MOBILE-001 R4: a late load answer does not repaint a newer one", async () => {
    type Pending = { url: string; resolve: (response: Response) => void };
    const pending: Pending[] = [];
    const fetchImpl = jest.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          pending.push({ url, resolve });
        }),
    ) as unknown as typeof fetch;
    const model = createThread({
      origin: ORIGIN,
      token: TOKEN,
      taskId: TASK_ID,
      fetchImpl,
    });

    const first = model.load();
    const second = model.load();
    await settle();
    expect(pending).toHaveLength(4);

    const secondEvents = [
      event(1, "message", {
        speaker: "user",
        role: "user",
        content: "second answer",
        visibility: { user: true, task: true },
      }),
    ];
    pending[2].resolve(ok(task({ title: "newer" })));
    pending[3].resolve(ok(secondEvents));
    await settle();
    expect(JSON.stringify(model.getState().turns)).toContain("second");

    pending[0].resolve(ok(task({ title: "older" })));
    pending[1].resolve(
      ok([
        event(1, "message", {
          speaker: "user",
          role: "user",
          content: "first answer",
          visibility: { user: true, task: true },
        }),
      ]),
    );
    await settle();

    const rendered = JSON.stringify(model.getState().turns);
    expect(rendered).toContain("second");
    expect(rendered).not.toContain("first answer");
    await Promise.all([first, second]);
    model.close();
  });
});
