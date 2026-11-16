import { describe, expect, it } from "vitest";
import type { Task } from "../api/client";
import { settleArchiveBatch } from "./archiveBatch";

function task(id: string): Task {
  return {
    id,
    title: id,
    agent: "kin",
    cwd: "/work/alpha",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1,
    event_epoch: 0,
  };
}

function ok(id: string): PromiseSettledResult<Task> {
  return { status: "fulfilled", value: task(id) };
}

function no(reason: string): PromiseSettledResult<Task> {
  return { status: "rejected", reason: new Error(reason) };
}

describe("settleArchiveBatch", () => {
  it("answers the moved rows and leaves every refused id", () => {
    // Swapping these two lists is the bug this function exists to prevent:
    // the failures are the ones that must stay selected, and the successes
    // are the ones that go to the live store.
    const outcome = settleArchiveBatch(["a", "b", "c"], [ok("a"), no("offline"), ok("c")]);
    expect(outcome.moved.map((row) => row.id)).toEqual(["a", "c"]);
    expect(outcome.failed).toEqual(["b"]);
  });

  it("keeps the ids aligned with their own answers", () => {
    // `allSettled` preserves input order; a batch that paired a rejection
    // with the wrong id would keep a row that moved and drop one that did not.
    const outcome = settleArchiveBatch(["a", "b"], [no("gone"), ok("b")]);
    expect(outcome.failed).toEqual(["a"]);
    expect(outcome.moved.map((row) => row.id)).toEqual(["b"]);
  });

  it("treats a missing answer as a failure, not a success", () => {
    // A shorter results array is a bug, and the safe reading is "nothing
    // moved": a row wrongly called successful would lose its selection and
    // never be retried.
    const outcome = settleArchiveBatch(["a", "b"], [ok("a")]);
    expect(outcome.moved.map((row) => row.id)).toEqual(["a"]);
    expect(outcome.failed).toEqual(["b"]);
  });

  it("reports a fully failed batch as all failed", () => {
    const outcome = settleArchiveBatch(["a", "b"], [no("x"), no("y")]);
    expect(outcome.moved).toEqual([]);
    expect(outcome.failed).toEqual(["a", "b"]);
  });
});
