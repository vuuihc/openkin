import { describe, expect, it } from "vitest";
import type { Task } from "../api/client";
import { sessionFeedTasks } from "./sessionFeed";

function task(partial: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: partial.id,
    agent: "kin",
    cwd: "/work/alpha",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1,
    event_epoch: 0,
    ...partial,
  };
}

function ids(rows: readonly Task[]): string[] {
  return rows.map((row) => row.id);
}

describe("sessionFeedTasks", () => {
  it("drops an archived row from the live list even though the page still holds it", () => {
    // Archiving from this screen updates the row in place; the loaded page
    // keeps it until the next fetch, so the list has to apply the rule itself.
    const live = [task({ id: "kept" }), task({ id: "put-away", archived_at: 99 })];
    expect(ids(sessionFeedTasks(live, [], "active"))).toEqual(["kept"]);
  });

  it("shows archived conversations and project rows side by side in the archive view", () => {
    // Archiving a project never touched its tasks, so its chats only arrive
    // through the live page; a chat put away one by one only arrives through
    // the archive feed.
    const live = [task({ id: "project-chat" })];
    const feed = [task({ id: "put-away", archived_at: 99 })];
    expect(ids(sessionFeedTasks(live, feed, "archived"))).toEqual([
      "project-chat",
      "put-away",
    ]);
  });

  it("shows a row once when both feeds carry it", () => {
    // A conversation archived from this screen is in the loaded live page and
    // in the archive feed; a flat merge would show it twice under one heading.
    const putAway = task({ id: "put-away", archived_at: 99 });
    expect(ids(sessionFeedTasks([putAway], [putAway, task({ id: "older", archived_at: 1 })], "archived"))).toEqual([
      "put-away",
      "older",
    ]);
  });

  it("narrows by status on both feeds while the server catches up", () => {
    // A filter change is a new list key; the hook answers with an unloaded
    // resource until the server replies, and the previous rows must not sit
    // under the new chip in the meantime.
    const live = [task({ id: "running", status: "running" }), task({ id: "done" })];
    const feed = [
      task({ id: "archived-running", status: "running", archived_at: 9 }),
      task({ id: "archived-done", archived_at: 9 }),
    ];
    expect(ids(sessionFeedTasks(live, feed, "active", "running"))).toEqual(["running"]);
    expect(ids(sessionFeedTasks(live, feed, "archived", "running"))).toEqual([
      "running",
      "archived-running",
    ]);
  });

  it("drops a restored row from the archive's own feed", () => {
    // A restored conversation leaves the registered list through its params,
    // but the "load older" tail is only pruned by id, never by flag. Without
    // this rule the row a person just restored keeps sitting in the archive
    // until the view is rebuilt.
    const feed = [task({ id: "restored" }), task({ id: "still-away", archived_at: 9 })];
    expect(ids(sessionFeedTasks([], feed, "archived"))).toEqual(["still-away"]);
  });

  it("does not read the archive feed in the live scope", () => {
    // The feed is only fetched while the archive view is open; an unmounted
    // view must not leak yesterday's archived rows into the list.
    const live = [task({ id: "live" })];
    const feed = [task({ id: "stale", archived_at: 5 })];
    expect(ids(sessionFeedTasks(live, feed, "active"))).toEqual(["live"]);
  });
});
