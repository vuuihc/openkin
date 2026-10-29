import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isTerminalStatus,
  shouldAnnounceTask,
  taskIdFromURL,
} from "./task-notifications.ts";

describe("what counts as a finish", () => {
  it("is the three terminal statuses", () => {
    for (const status of ["succeeded", "failed", "canceled"]) {
      assert.equal(isTerminalStatus(status), true, status);
    }
    for (const status of ["running", "queued", "waiting_approval", ""]) {
      assert.equal(isTerminalStatus(status), false, status);
    }
  });
});

describe("reading the task out of a console URL", () => {
  const base = "http://127.0.0.1:7777";

  it("finds the task a transcript URL points at", () => {
    assert.equal(taskIdFromURL(`${base}/tasks/01ABC`), "01ABC");
    assert.equal(taskIdFromURL(`${base}/tasks/01ABC/`), "01ABC");
    assert.equal(taskIdFromURL(`${base}/tasks/01ABC?token=redacted`), "01ABC");
    assert.equal(taskIdFromURL(`${base}/tasks/01%20ABC`), "01 ABC");
  });

  it("says nothing for every other surface", () => {
    assert.equal(taskIdFromURL(`${base}/inbox`), null);
    assert.equal(taskIdFromURL(`${base}/tasks/`), null);
    assert.equal(taskIdFromURL(`${base}/tasks/a/b`), null);
    assert.equal(taskIdFromURL(`${base}/`), null);
    assert.equal(taskIdFromURL("not a url"), null);
  });
});

describe("announcing a finished task", () => {
  const done = { id: "01ABC", status: "succeeded" };

  it("stays quiet about the task on screen", () => {
    assert.equal(
      shouldAnnounceTask(done, { focused: true, viewingTaskId: "01ABC" }),
      false,
    );
  });

  it("announces it to a reader who is looking elsewhere", () => {
    assert.equal(
      shouldAnnounceTask(done, { focused: true, viewingTaskId: "01OTHER" }),
      true,
    );
    assert.equal(
      shouldAnnounceTask(done, { focused: false, viewingTaskId: "01ABC" }),
      true,
    );
    assert.equal(
      shouldAnnounceTask(done, { focused: false, viewingTaskId: null }),
      true,
    );
  });

  it("never announces work that has not finished", () => {
    assert.equal(
      shouldAnnounceTask(
        { id: "01ABC", status: "running" },
        { focused: false, viewingTaskId: null },
      ),
      false,
    );
  });
});
