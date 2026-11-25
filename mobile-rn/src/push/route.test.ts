import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { routeForPush, toHref, type PushContext, type PushRoute } from "./route";

/**
 * KIN-MOBILE-001 §8 / R7 — where a tapped push lands.
 *
 * The node sends `{"kin":{"kind","id","url"}}` (`internal/apns/apns.go`,
 * `payloadWith`) and the web console link inside `url` names the conversation
 * and, for a waiting item, the card (`internal/notify/notify.go`,
 * `pendingLink`). These tests pin the routing policy only: no notification
 * module, no native registration, no navigation.
 *
 * AGENTS.md rule 11 (a late answer keeps its origin) and rule 13 (no
 * unbounded wait on the path) each have a test below.
 */

const HUB = "https://kin.example.com";
const OTHER = "https://other.example.com";

function push(kind: string, id: string, url: string): unknown {
  return {
    aps: { alert: { title: "Fixture", body: "Fixture" }, "thread-id": id },
    kin: { kind, id, url },
  };
}

/**
 * `seen` is the caller's durable delivery record (AGENTS.md rule 14): the call
 * claims the key and reports whether an earlier tap already claimed it.
 */
function context(
  pairedOrigin: string | null = HUB,
): PushContext & { claimed: Set<string> } {
  const claimed = new Set<string>();
  return {
    claimed,
    pairedOrigin,
    seen: (key) => {
      if (claimed.has(key)) return true;
      claimed.add(key);
      return false;
    },
  };
}

/** One row per notification kind the node actually emits. */
const KIND_ROUTES: ReadonlyArray<{
  kind: string;
  id: string;
  url: string;
  route: PushRoute;
}> = [
  {
    kind: "approval",
    id: "appr-1",
    url: `${HUB}/tasks/task-1?focus=appr-1`,
    route: { kind: "thread", taskId: "task-1", focus: { approvalId: "appr-1" } },
  },
  {
    kind: "question",
    id: "ques-1",
    url: `${HUB}/tasks/task-1?focus=ques-1`,
    route: { kind: "thread", taskId: "task-1", focus: { questionId: "ques-1" } },
  },
  {
    kind: "quota",
    id: "task-1",
    url: `${HUB}/tasks/task-1`,
    route: { kind: "thread", taskId: "task-1" },
  },
  {
    kind: "worker",
    id: "wrkr-1",
    url: `${HUB}/tasks/task-1`,
    route: { kind: "thread", taskId: "task-1" },
  },
  {
    kind: "task",
    id: "task-1",
    url: `${HUB}/tasks/task-1`,
    route: { kind: "thread", taskId: "task-1" },
  },
  {
    kind: "routine",
    id: "task-1",
    url: `${HUB}/tasks/task-1`,
    route: { kind: "thread", taskId: "task-1" },
  },
  {
    // Routine failure: no task, so the node links /routines and `id` is the
    // routine. RN has no routines surface, so the list is the honest landing.
    kind: "routine",
    id: "routine-1",
    url: `${HUB}/routines`,
    route: { kind: "list" },
  },
];

describe("KIN-MOBILE-001 R7 push routing", () => {
  it("KIN-MOBILE-001 R7: an approval tap opens its conversation with the card in focus", () => {
    const route = routeForPush(
      push("approval", "appr-1", `${HUB}/tasks/task-1?focus=appr-1`),
      context(),
    );

    expect(route).toEqual({
      kind: "thread",
      taskId: "task-1",
      focus: { approvalId: "appr-1" },
    });
  });

  it("KIN-MOBILE-001 R7: a question tap opens its conversation with the question in focus", () => {
    const route = routeForPush(
      push("question", "ques-1", `${HUB}/tasks/task-1?focus=ques-1`),
      context(),
    );

    expect(route).toEqual({
      kind: "thread",
      taskId: "task-1",
      focus: { questionId: "ques-1" },
    });
  });

  it("KIN-MOBILE-001 R7: a worker tap uses the link for the task, never the worker id", () => {
    const route = routeForPush(
      push("worker", "wrkr-1", `${HUB}/tasks/task-9`),
      context(),
    );

    expect(route).toEqual({ kind: "thread", taskId: "task-9" });
  });

  it("KIN-MOBILE-001 R7: a routine report with a task opens its conversation; a routine-only alert lists", () => {
    expect(
      routeForPush(push("routine", "task-2", `${HUB}/tasks/task-2`), context()),
    ).toEqual({ kind: "thread", taskId: "task-2" });

    expect(
      routeForPush(push("routine", "routine-2", `${HUB}/routines`), context()),
    ).toEqual({ kind: "list" });
  });

  it.each(KIND_ROUTES)(
    "KIN-MOBILE-001 R7: $kind routes where the node intends",
    (row) => {
      expect(routeForPush(push(row.kind, row.id, row.url), context())).toEqual(
        row.route,
      );
    },
  );

  it("KIN-MOBILE-001 R7: the table covers every kind notify.go sends", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../internal/notify/notify.go"),
      "utf8",
    );
    const emitted = new Set<string>();
    const pattern = /Kind:\s*"([a-z]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) emitted.add(match[1]);

    expect([...emitted].sort()).toEqual(
      [...new Set(KIND_ROUTES.map((row) => row.kind))].sort(),
    );
  });

  it("KIN-MOBILE-001 R7: a link on another origin is never followed", () => {
    // `task` still routes: its id is the conversation, the off-origin link
    // must not override it.
    expect(
      routeForPush(
        push("task", "task-1", `${OTHER}/tasks/task-9`),
        context(),
      ),
    ).toEqual({ kind: "thread", taskId: "task-1" });

    // An approval's id names the card, not the conversation, so without a
    // trusted link there is nowhere to land but the list.
    expect(
      routeForPush(
        push("approval", "appr-1", `${OTHER}/tasks/task-9?focus=appr-1`),
        context(),
      ),
    ).toEqual({ kind: "list" });

    // A scheme-relative link is another origin too, not a path on ours.
    expect(
      routeForPush(
        push("worker", "wrkr-1", `//${OTHER.slice("https://".length)}/tasks/task-9`),
        context(),
      ),
    ).toEqual({ kind: "list" });
  });

  it("KIN-MOBILE-001 R7: a malformed paired origin never makes a link trusted", () => {
    expect(
      routeForPush(
        push("worker", "wrkr-1", `${HUB}/tasks/task-1`),
        context("not a url"),
      ),
    ).toEqual({ kind: "list" });
  });

  it("KIN-MOBILE-001 R7: only a web link to the Hub is followed", () => {
    // `file:` URLs have the origin "null" in both positions; matching them
    // would turn a local path into a conversation id.
    expect(
      routeForPush(
        push("worker", "wrkr-1", "file:///tasks/task-1"),
        context("file:///tmp"),
      ),
    ).toEqual({ kind: "list" });
  });

  it("KIN-MOBILE-001 R7: a relative link resolves against the paired Hub", () => {
    expect(
      routeForPush(push("worker", "wrkr-1", "/tasks/task-1"), context()),
    ).toEqual({ kind: "thread", taskId: "task-1" });
  });

  it("KIN-MOBILE-001 R7: an unpaired phone ignores the tap", () => {
    expect(
      routeForPush(push("task", "task-1", `${HUB}/tasks/task-1`), context(null)),
    ).toEqual({ kind: "ignore", reason: "unpaired" });

    // Even a payload that cannot be read: there is no node to route on yet.
    expect(routeForPush(null, context(null))).toEqual({
      kind: "ignore",
      reason: "unpaired",
    });
  });

  it("KIN-MOBILE-001 R7: a malformed payload lands on the list and never throws", () => {
    const malformed: unknown[] = [
      undefined,
      null,
      "approval",
      42,
      [],
      {},
      { aps: {} },
      { kin: null },
      { kin: [] },
      { kin: {} },
      { kin: { kind: 42, id: "task-1", url: `${HUB}/tasks/task-1` } },
      { kin: { kind: "task", id: 7, url: `${HUB}/tasks/task-1` } },
      { kin: { kind: "task", id: "task-1", url: 7 } },
    ];

    for (const value of malformed) {
      expect(() => routeForPush(value, context())).not.toThrow();
      expect(routeForPush(value, context())).toEqual({ kind: "list" });
    }
  });

  it("KIN-MOBILE-001 R7: an unknown kind lands on the list", () => {
    expect(
      routeForPush(push("build", "build-1", `${HUB}/tasks/task-1`), context()),
    ).toEqual({ kind: "list" });
  });

  it("KIN-MOBILE-001 R7: an approval without a conversation id lands on the list", () => {
    // A taskless approval links /sessions; nothing in the payload names a
    // conversation to open.
    expect(
      routeForPush(push("approval", "appr-1", `${HUB}/sessions`), context()),
    ).toEqual({ kind: "list" });
  });

  it("KIN-MOBILE-001 R7: the same notification tapped twice is claimed once", () => {
    const ctx = context();
    const tap = push("approval", "appr-1", `${HUB}/tasks/task-1?focus=appr-1`);

    expect(routeForPush(tap, ctx)).toEqual({
      kind: "thread",
      taskId: "task-1",
      focus: { approvalId: "appr-1" },
    });
    expect(routeForPush(tap, ctx)).toEqual({
      kind: "ignore",
      reason: "duplicate",
    });
    expect(ctx.claimed.has("approval:appr-1")).toBe(true);

    // The key is kind + id: a question that happens to share the id is a
    // different delivery.
    expect(
      routeForPush(
        push("question", "appr-1", `${HUB}/tasks/task-1?focus=appr-1`),
        ctx,
      ).kind,
    ).toBe("thread");
  });

  it("KIN-MOBILE-001 R7: a late tap from the previous Hub never crosses into the newly paired Hub (AGENTS.md 11)", () => {
    // The phone re-paired to OTHER while a notification from HUB was in the
    // notification centre. The stale tap carries HUB's link; routing reads the
    // pairing that is current at tap time, so the old origin is never followed.
    const nowPairedElsewhere = context(OTHER);
    const staleTap = push(
      "approval",
      "appr-1",
      `${HUB}/tasks/task-1?focus=appr-1`,
    );

    expect(routeForPush(staleTap, nowPairedElsewhere)).toEqual({
      kind: "list",
    });

    // A tap that belongs to the current pairing still lands on its thread.
    expect(
      routeForPush(
        push("approval", "appr-2", `${OTHER}/tasks/task-2?focus=appr-2`),
        nowPairedElsewhere,
      ),
    ).toEqual({
      kind: "thread",
      taskId: "task-2",
      focus: { approvalId: "appr-2" },
    });
  });

  it("KIN-MOBILE-001 R7: routing a tap is synchronous and performs no network wait (AGENTS.md 13)", () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("the tap path must not fetch");
    }) as typeof fetch;

    try {
      const route = routeForPush(
        push("approval", "appr-1", `${HUB}/tasks/task-1?focus=appr-1`),
        context(),
      );
      expect(route).not.toBeInstanceOf(Promise);
      expect(route).toEqual({
        kind: "thread",
        taskId: "task-1",
        focus: { approvalId: "appr-1" },
      });
      expect(toHref(route)).toBe("/thread/task-1?focus=appr-1");
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("KIN-MOBILE-001 R7 hrefs", () => {
  it("KIN-MOBILE-001 R7: a thread href carries the focused card", () => {
    expect(
      toHref({ kind: "thread", taskId: "task-1", focus: { approvalId: "appr-1" } }),
    ).toBe("/thread/task-1?focus=appr-1");
    expect(
      toHref({ kind: "thread", taskId: "task-1", focus: { questionId: "ques-1" } }),
    ).toBe("/thread/task-1?focus=ques-1");
  });

  it("KIN-MOBILE-001 R7: a plain thread href names no card and encodes an opaque id", () => {
    expect(toHref({ kind: "thread", taskId: "task-1" })).toBe("/thread/task-1");
    expect(toHref({ kind: "thread", taskId: "a/b c" })).toBe(
      "/thread/a%2Fb%20c",
    );
  });

  it("KIN-MOBILE-001 R7: a list route is the list, and an ignored tap does not navigate", () => {
    expect(toHref({ kind: "list" })).toBe("/list");
    expect(toHref({ kind: "ignore", reason: "duplicate" })).toBeNull();
    expect(toHref({ kind: "ignore", reason: "unpaired" })).toBeNull();
  });
});
