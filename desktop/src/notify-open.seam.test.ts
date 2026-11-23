import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBootWindow, type BootWindowHost } from "./boot-window.ts";
import {
  Notifier,
  type NotificationHandle,
  type NotificationOptions,
} from "./notifications.ts";
import type { NotifyEvent } from "./native-notifications.ts";

/**
 * The join between a banner click and the window.
 *
 * Each layer has its own suite — `notifications.test.ts` pins click →
 * `openPath`, `boot-window.test.ts` pins the coordinator → host edge, and
 * `window.wiring.test.ts` pins the host adapter. None walked the real chain
 * through every launch phase, so a tap that named a task could land on the
 * conversation list with every layer green. The adapter below is exactly
 * `main.ts:77-83` and the click callback is exactly `main.ts:518`.
 */

class FakeNotification {
  options: NotificationOptions;
  showCount = 0;
  private clickHandler?: () => void;

  constructor(options: NotificationOptions) {
    this.options = options;
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    if (event === "click") this.clickHandler = listener as () => void;
  }

  show(): void {
    this.showCount += 1;
  }

  close(): void {}

  emitClick(): void {
    this.clickHandler?.();
  }
}

/** The window controller: records every page it is asked for. */
function recordingWindow() {
  const calls: string[] = [];
  let open = false;
  return {
    calls,
    close: () => {
      open = false;
    },
    window: {
      isOpen: () => open,
      showBoot: (path: string) => {
        calls.push(`boot:${path}`);
        open = true;
      },
      enterConsole: (path: string) => {
        calls.push(`console:${path}`);
        open = true;
      },
      showBootFailure: (reason: string) => {
        calls.push(`failure:${reason}`);
        open = true;
      },
      revealWindow: () => {
        calls.push("reveal");
      },
    },
  };
}

function shell() {
  const win = recordingWindow();
  const host: BootWindowHost = {
    hasWindow: () => win.window.isOpen(),
    showBoot: (path) => win.window.showBoot(path),
    showConsole: (path) => win.window.enterConsole(path),
    showBootFailure: (reason) => win.window.showBootFailure(reason),
    reveal: () => win.window.revealWindow(),
  };
  const boot = createBootWindow(host);
  const created: FakeNotification[] = [];
  const notifier = new Notifier(
    {
      openPath: (path) => boot.show(path),
      getToken: () => "test-token",
      origin: () => "http://127.0.0.1:7777",
    },
    {
      createNotification: (options) => {
        const notification = new FakeNotification(options);
        created.push(notification);
        return notification as unknown as NotificationHandle;
      },
      isSupported: () => true,
      decideApproval: async () => ({}),
    },
  );
  return { boot, win, created, notifier };
}

const completedTask: NotifyEvent = {
  kind: "task",
  id: "01ABC",
  url: "https://kin.example.com/tasks/01ABC",
  title: "Write the report — Completed",
  body: "Completed",
  task_id: "01ABC",
};

function tap(created: FakeNotification[]): void {
  assert.equal(created.length, 1, "the banner was not shown");
  created[0]?.emitClick();
}

function consoles(calls: string[]): string[] {
  return calls.filter((call) => call.startsWith("console:"));
}

describe("a notification click reaches the window", () => {
  it("ready with a window: the tap navigates the window that is open", () => {
    const { boot, win, created, notifier } = shell();
    boot.start();
    boot.settle("ready");
    win.calls.length = 0;

    notifier.onNotify(completedTask);
    tap(created);

    assert.deepEqual(consoles(win.calls), ["console:/tasks/01ABC"]);
    assert.ok(
      !win.calls.includes("console:/sessions"),
      "the tap landed on the conversation list instead of the task",
    );
  });

  it("ready with no window: a tap after close-to-tray reopens at the task", () => {
    const { boot, win, created, notifier } = shell();
    boot.start();
    boot.settle("ready");
    // Closed to the tray: the coordinator is ready, the window is gone.
    win.close();
    win.calls.length = 0;

    notifier.onNotify(completedTask);
    tap(created);

    assert.deepEqual(win.calls, ["console:/tasks/01ABC"]);
  });

  it("booting: the tap waits for the daemon and lands on the task", () => {
    const { boot, win, created, notifier } = shell();
    boot.start();
    win.calls.length = 0;

    notifier.onNotify(completedTask);
    tap(created);
    assert.deepEqual(
      consoles(win.calls),
      [],
      "the console must not load before the daemon answers",
    );

    boot.settle("ready");
    assert.deepEqual(consoles(win.calls), ["console:/tasks/01ABC"]);
  });

  it("failed then recovered: the tap survives the failure page", () => {
    const { boot, win, created, notifier } = shell();
    boot.start();
    boot.settle("unavailable");
    boot.fail("crash");
    win.calls.length = 0;

    notifier.onNotify(completedTask);
    tap(created);
    assert.deepEqual(
      consoles(win.calls),
      [],
      "a terminal failure must not load a console that is not there",
    );

    // The recovery retry finds a daemon: the console replaces the failure page
    // at the path the tap named, not at `/`.
    boot.settle("ready");
    assert.deepEqual(consoles(win.calls), ["console:/tasks/01ABC"]);
  });

  it("a banner with no link still opens the task it names", () => {
    // The whole chain for a latent empty-link event: no shipped producer
    // writes `url: ""`, so this pins the fallback rather than the reported
    // tap, which stays unexplained (leading candidate: a banner created
    // before a relaunch and clicked after it).
    const { boot, win, created, notifier } = shell();
    boot.start();
    boot.settle("ready");
    win.calls.length = 0;

    notifier.onNotify({ ...completedTask, id: "01DEF", task_id: "01DEF", url: "" });
    tap(created);

    assert.deepEqual(win.calls, ["console:/tasks/01DEF"]);
  });
});
