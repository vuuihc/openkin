import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NotifyDeduper,
  notifyKey,
  notifyHasDecisionActions,
  parseNotifyEvent,
  safeNotifyPath,
  shouldAnnounceNotify,
} from "./native-notifications.ts";
import {
  Notifier,
  type NotificationCallbacks,
  type NotificationHandle,
  type NotificationOptions,
} from "./notifications.ts";

// KIN-NOTIFY-001: the desktop shell's notification policy.

describe("parsing the node's notify event", () => {
  const event = {
    kind: "approval",
    id: "appr-1",
    url: "https://kin.example.com/inbox?focus=appr-1",
    title: "Fix the tests",
    body: "Task 01ABC needs approval",
    task_id: "01ABC",
  };

  it("keeps the fields the shell needs", () => {
    assert.deepEqual(parseNotifyEvent(event), event);
  });

  it("drops an unknown kind instead of displaying it", () => {
    assert.equal(parseNotifyEvent({ ...event, kind: "system_exec" }), null);
    assert.equal(parseNotifyEvent({ ...event, kind: undefined }), null);
  });

  it("drops an event that names nothing", () => {
    assert.equal(parseNotifyEvent({ ...event, id: "" }), null);
    assert.equal(parseNotifyEvent({ ...event, id: 42 }), null);
    assert.equal(parseNotifyEvent(null), null);
    assert.equal(parseNotifyEvent("notify"), null);
  });

  it("clips text so a node cannot fill the screen with one banner", () => {
    const parsed = parseNotifyEvent({
      ...event,
      title: "t".repeat(1000),
      body: "b".repeat(5000),
    });
    assert.equal(parsed?.title.length, 200);
    assert.equal(parsed?.body.length, 600);
  });

  it("keeps the state that makes two events different", () => {
    assert.equal(parseNotifyEvent({ ...event, status: "waiting" })?.status, "waiting");
    assert.equal(parseNotifyEvent({ ...event, status: "" })?.status, undefined);
    assert.equal(parseNotifyEvent({ ...event, status: 42 })?.status, undefined);
  });
});

describe("deciding whether a banner is worth it", () => {
  const approval = {
    kind: "approval" as const,
    id: "appr-1",
    url: "/inbox?focus=appr-1",
    title: "Approval needed",
    body: "",
    task_id: "01ABC",
  };

  it("stays quiet only for the task on screen in the focused window", () => {
    assert.equal(
      shouldAnnounceNotify(approval, { focused: true, viewingTaskId: "01ABC" }),
      false,
    );
    assert.equal(
      shouldAnnounceNotify(approval, { focused: true, viewingTaskId: "01OTHER" }),
      true,
    );
    assert.equal(
      shouldAnnounceNotify(approval, { focused: false, viewingTaskId: "01ABC" }),
      true,
    );
  });

  it("announces a task-less event even while the window is focused", () => {
    assert.equal(
      shouldAnnounceNotify(
        { ...approval, kind: "quota", task_id: undefined },
        { focused: true, viewingTaskId: "01ABC" },
      ),
      true,
    );
  });
});

describe("deduping the same event", () => {
  it("shows one banner per kind and target", () => {
    const dedupe = new NotifyDeduper();
    const event = {
      kind: "approval" as const,
      id: "appr-1",
      url: "/inbox?focus=appr-1",
      title: "Approval needed",
      body: "",
    };
    assert.equal(dedupe.remember(event), true);
    assert.equal(dedupe.remember(event), false);
    assert.equal(dedupe.remember({ ...event, id: "appr-2" }), true);
    assert.equal(notifyKey(event), "approval:appr-1");

    dedupe.forget("approval", "appr-1");
    assert.equal(dedupe.remember(event), true);
  });

  it("treats a new state of the same target as news", () => {
    const waiting = {
      kind: "quota" as const,
      id: "t1",
      url: "/tasks/t1",
      title: "Waiting for provider quota",
      body: "",
      task_id: "t1",
      status: "waiting",
    };
    assert.equal(notifyKey(waiting), "quota:t1:waiting");
    assert.notEqual(notifyKey(waiting), notifyKey({ ...waiting, status: "resumed" }));
    const dedupe = new NotifyDeduper();
    assert.equal(dedupe.remember(waiting), true);
    assert.equal(dedupe.remember({ ...waiting, status: "resumed" }), true);
    assert.equal(dedupe.remember(waiting), false);
  });

  it("stays bounded on a long-lived shell", () => {
    const dedupe = new NotifyDeduper();
    const event = (i: number) => ({
      kind: "task" as const,
      id: `t${i}`,
      url: "",
      title: "",
      body: "",
    });
    for (let i = 0; i < NotifyDeduper.MAX_SEEN; i++) {
      assert.equal(dedupe.remember(event(i)), true);
    }
    // One more insertion evicts the oldest key, so it can be shown again; the
    // newest one is still remembered. An unbounded set would keep every task
    // id forever.
    assert.equal(dedupe.remember(event(NotifyDeduper.MAX_SEEN)), true);
    assert.equal(dedupe.remember(event(0)), true);
    assert.equal(dedupe.remember(event(NotifyDeduper.MAX_SEEN)), false);
  });

  it("forgets every state of one target", () => {
    const dedupe = new NotifyDeduper();
    const waiting = {
      kind: "quota" as const,
      id: "t1",
      url: "",
      title: "",
      body: "",
      status: "waiting",
    };
    dedupe.remember(waiting);
    dedupe.forget("quota", "t1");
    assert.equal(dedupe.remember(waiting), true);
  });
});

describe("opening the event's link", () => {
  const origin = "https://kin.example.com";

  it("keeps a known console path and its focus", () => {
    assert.equal(safeNotifyPath("/inbox?focus=appr-1", origin), "/inbox?focus=appr-1");
    assert.equal(safeNotifyPath("/tasks/01ABC", origin), "/tasks/01ABC");
  });

  it("takes the path out of the node's absolute link, wherever it points", () => {
    // The node writes ui.base_url, which can be the Hub URL while this shell
    // loads the console from localhost. Only the path is ever opened, so the
    // host must not decide whether the tap lands.
    assert.equal(
      safeNotifyPath("https://kin.example.com/tasks/01ABC?from=push", origin),
      "/tasks/01ABC?from=push",
    );
    assert.equal(
      safeNotifyPath("https://kin.example.com/inbox?focus=a1", "http://127.0.0.1:7777"),
      "/inbox?focus=a1",
    );
  });

  it("falls back to the inbox for anything else", () => {
    for (const url of [
      "https://evil.example/admin?focus=a1",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "/admin",
      "",
    ]) {
      assert.equal(safeNotifyPath(url, origin), "/inbox", url);
    }
  });

  it("still opens an absolute known route when the console origin is unknown", () => {
    assert.equal(safeNotifyPath("https://kin.example.com/tasks/01ABC"), "/tasks/01ABC");
    assert.equal(safeNotifyPath("https://evil.example/tasks/01ABC"), "/tasks/01ABC");
    assert.equal(safeNotifyPath("/tasks/01ABC"), "/tasks/01ABC");
  });
});

describe("approval actions", () => {
  it("belong to approvals only", () => {
    assert.equal(notifyHasDecisionActions("approval"), true);
    for (const kind of ["question", "task", "quota", "routine", "worker", "test"] as const) {
      assert.equal(notifyHasDecisionActions(kind), false, kind);
    }
  });
});

// The display policy, exercised without Electron: the shell is only allowed to
// show what parseNotifyEvent accepted, and a click must land on a console path.
class FakeNotification {
  options: NotificationOptions;
  showCount = 0;
  closeCount = 0;
  private clickHandler?: () => void;
  private actionHandler?: (event: unknown, index: number) => void;

  constructor(options: NotificationOptions) {
    this.options = options;
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    if (event === "click") this.clickHandler = listener as () => void;
    if (event === "action") {
      this.actionHandler = listener as (event: unknown, index: number) => void;
    }
  }

  show(): void {
    this.showCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }

  emitClick(): void {
    this.clickHandler?.();
  }

  emitAction(index: number): void {
    this.actionHandler?.(null, index);
  }
}

function fakeNotifier(cb: Partial<NotificationCallbacks> = {}) {
  const created: FakeNotification[] = [];
  const opened: string[] = [];
  const decisions: Array<{ id: string; decision: string }> = [];
  const notifier = new Notifier(
    {
      openPath: (path) => opened.push(path),
      getToken: () => "test-token",
      ...cb,
    },
    {
      createNotification: (options) => {
        const notification = new FakeNotification(options);
        created.push(notification);
        return notification as unknown as NotificationHandle;
      },
      isSupported: () => true,
      decideApproval: async (_token, id, decision) => {
        decisions.push({ id, decision });
        return {};
      },
    },
  );
  return { notifier, created, opened, decisions };
}

describe("showing a notification", () => {
  const approval = {
    kind: "approval" as const,
    id: "appr-1",
    url: "https://kin.example.com/inbox?focus=appr-1",
    title: "Fix the login bug",
    body: "Task 01ABC needs approval",
    task_id: "01ABC",
  };

  it("shows the node's text once and opens a console path on click", () => {
    const { notifier, created, opened } = fakeNotifier({
      origin: () => "http://127.0.0.1:7777",
    });
    notifier.onNotify(approval);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.options.title, "Fix the login bug");
    assert.equal(created[0]?.options.body, "Task 01ABC needs approval");
    assert.equal(created[0]?.options.urgency, "critical");
    assert.equal(created[0]?.showCount, 1);

    created[0]?.emitClick();
    // The node wrote the Hub origin; this shell is on localhost. Only the path
    // is opened, so the tap still names the approval.
    assert.deepEqual(opened, ["/inbox?focus=appr-1"]);
  });

  it("stays quiet only for the task already on screen", () => {
    const { notifier, created } = fakeNotifier({
      isFocused: () => true,
      viewingTaskId: () => "01ABC",
    });
    notifier.onNotify(approval);
    assert.equal(created.length, 0, "the task is on screen in the focused window");
    notifier.onNotify({ ...approval, id: "appr-2", task_id: "01OTHER" });
    assert.equal(created.length, 1, "another task needs a banner");
  });

  it("does not turn an event seen on screen into a later banner", () => {
    let focused = true;
    const { notifier, created } = fakeNotifier({
      isFocused: () => focused,
      viewingTaskId: () => "01ABC",
    });
    notifier.onNotify(approval);
    assert.equal(created.length, 0);

    // The reader looked away; the node rebroadcasts the same event. It was
    // already presented in the window, so it is not news now.
    focused = false;
    notifier.onNotify(approval);
    assert.equal(created.length, 0);
  });

  it("does not rebroadcast one state but does show the next", () => {
    const { notifier, created } = fakeNotifier();
    const quota = {
      kind: "quota" as const,
      id: "t1",
      url: "/tasks/t1",
      title: "Waiting for provider quota",
      body: "",
      task_id: "t1",
      status: "waiting",
    };
    notifier.onNotify(quota);
    notifier.onNotify(quota);
    assert.equal(created.length, 1);
    notifier.onNotify({ ...quota, status: "resumed", title: "Provider quota available" });
    assert.equal(created.length, 2);
    // The waiting banner is the slot the resumed state takes over; leaving it
    // behind stacks two macOS notifications for one task.
    assert.equal(created[0]?.closeCount, 1);
    assert.equal(created[1]?.closeCount, 0);

    // A different target is a different slot and stays.
    notifier.onNotify({ ...quota, id: "t2", task_id: "t2" });
    assert.equal(created[2]?.showCount, 1);
    assert.equal(created[2]?.options.title, "Waiting for provider quota");
    assert.equal(created[1]?.closeCount, 0);
    assert.equal(created[2]?.closeCount, 0);
  });

  it("closes the banner it forgets when the slot map is full", () => {
    // A long-lived shell sees more events than the map holds. Dropping a key
    // without closing its banner leaves a window nothing can dismiss.
    const { notifier, created } = fakeNotifier();
    for (let i = 0; i <= Notifier.MAX_SHOWN; i++) {
      notifier.onNotify({ ...approval, id: `appr-${i}`, task_id: `task-${i}` });
    }
    assert.equal(created.length, Notifier.MAX_SHOWN + 1);
    assert.equal(created[0]?.closeCount, 1);
    assert.equal(created[1]?.closeCount, 0);
  });

  it("takes the old state away even when the new one is on screen", () => {
    let viewing: string | null = null;
    const { notifier, created } = fakeNotifier({
      isFocused: () => true,
      viewingTaskId: () => viewing,
    });
    const quota = {
      kind: "quota" as const,
      id: "t1",
      url: "/tasks/t1",
      title: "Waiting for provider quota",
      body: "",
      task_id: "t1",
      status: "waiting",
    };
    notifier.onNotify(quota);
    assert.equal(created.length, 1);

    // The reader opened the task; the wait ended while they were reading it.
    // No second banner, but the stale "waiting" one must not survive.
    viewing = "t1";
    notifier.onNotify({ ...quota, status: "resumed", title: "Provider quota available" });
    assert.equal(created.length, 1);
    assert.equal(created[0]?.closeCount, 1);
  });

  it("releases the banner when the reader handles it", async () => {
    const { notifier, created } = fakeNotifier();
    notifier.onNotify(approval);
    created[0]?.emitClick();
    assert.equal(created[0]?.closeCount, 1);
  });

  it(
    "sends an action button to the approval decision",
    { skip: process.platform !== "darwin" && process.platform !== "win32" },
    async () => {
      const { notifier, created, decisions } = fakeNotifier();
      notifier.onNotify(approval);
      created[0]?.emitAction(0);
      notifier.onNotify({ ...approval, id: "appr-2" });
      created[1]?.emitAction(1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(decisions, [
        { id: "appr-1", decision: "approved" },
        { id: "appr-2", decision: "denied" },
      ]);
    },
  );
});
