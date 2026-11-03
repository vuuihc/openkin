import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  routeNotifyMessage,
  type NotifyEvent,
} from "./native-notifications.ts";

// KIN-NOTIFY-001: the desktop channel is the node's own event bus.

function recorder() {
  const events: NotifyEvent[] = [];
  return {
    events,
    sink: {
      onNotify(ev: NotifyEvent) {
        events.push(ev);
      },
    },
  };
}

describe("routing a notify message into the shell", () => {
  it("hands the notifier the kind, id and link the node sent", () => {
    const { events, sink } = recorder();
    const handled = routeNotifyMessage(
      {
        kind: "notify",
        data: {
          kind: "approval",
          id: "appr-1",
          url: "https://kin.example.com/inbox?focus=appr-1",
          title: "Fix the tests",
          body: "Task 01ABC needs approval",
          task_id: "01ABC",
        },
      },
      sink,
    );

    assert.equal(handled, true);
    assert.deepEqual(events, [
      {
        kind: "approval",
        id: "appr-1",
        url: "https://kin.example.com/inbox?focus=appr-1",
        title: "Fix the tests",
        body: "Task 01ABC needs approval",
        task_id: "01ABC",
      },
    ]);
  });

  it("works with no APNs credential, device row, or provider involved", () => {
    // The desktop channel is a bus message. Nothing about Apple is on this
    // path, so a node that has never configured APNs still reaches the Mac.
    const { events, sink } = recorder();
    assert.equal(
      routeNotifyMessage(
        { kind: "notify", data: { kind: "task", id: "01ABC", url: "/tasks/01ABC", title: "Done", body: "Succeeded" } },
        sink,
      ),
      true,
    );
    assert.equal(events.length, 1);
  });

  it("leaves every other bus message alone", () => {
    const { events, sink } = recorder();
    assert.equal(routeNotifyMessage({ kind: "task_update", data: {} }, sink), false);
    assert.equal(routeNotifyMessage({ kind: "approval_update", data: {} }, sink), false);
    assert.equal(events.length, 0);
  });

  it("does not forward a malformed notify payload", () => {
    const { events, sink } = recorder();
    assert.equal(routeNotifyMessage({ kind: "notify", data: { kind: "nope", id: "x" } }, sink), false);
    assert.equal(routeNotifyMessage({ kind: "notify", data: null }, sink), false);
    assert.equal(events.length, 0);
  });
});
