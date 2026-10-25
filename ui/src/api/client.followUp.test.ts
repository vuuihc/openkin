import { afterEach, describe, expect, it, vi } from "vitest";
import { followUpPrompt } from "./client";

/**
 * The default follow-up is a queued message: a running task answers it when the
 * round it is in ends. `interrupt` is the explicit second action, and it means
 * more than "send now" — that path also denies the round's pending approvals and
 * answers its pending questions, because the process it was talking to is about
 * to be killed.
 *
 * So the flag is the whole difference between the two buttons, and both ways of
 * getting it wrong are the bug this feature exists to fix: a UI that set it by
 * accident is back to interrupting, and one that never set it has an interrupt
 * button that does nothing.
 */

function stubSend(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return Promise.resolve(
      new Response(JSON.stringify({ id: "task-1", status: "running" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return { bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("followUpPrompt", () => {
  it("does not send interrupt unless the caller asked for it", async () => {
    const { bodies } = stubSend();

    await followUpPrompt("task-1", "and then?");

    expect(bodies).toEqual([{ prompt: "and then?" }]);
    expect("interrupt" in bodies[0]).toBe(false);
  });

  it("sends interrupt only when the explicit action asked for it", async () => {
    const { bodies } = stubSend();

    await followUpPrompt("task-1", "stop and do this instead", { interrupt: true });

    expect(bodies).toEqual([{ prompt: "stop and do this instead", interrupt: true }]);
  });

  it("keeps the model and permission fields it already sent", async () => {
    const { bodies } = stubSend();

    await followUpPrompt("task-1", "carry on", {
      model: "gpt-5.5-codex",
      permission_mode: "acceptEdits",
      interrupt: true,
    });

    expect(bodies[0]).toEqual({
      prompt: "carry on",
      model: "gpt-5.5-codex",
      permission_mode: "acceptEdits",
      interrupt: true,
    });
  });
});
