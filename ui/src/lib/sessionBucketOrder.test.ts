import { describe, expect, it } from "vitest";
import type { PhoneProjectBucket } from "./phoneSessionBuckets";
import { sortSessionBuckets } from "./sessionBucketOrder";

function bucket(key: string, options: Partial<PhoneProjectBucket> = {}): PhoneProjectBucket {
  return {
    key,
    label: key,
    cwd: key.startsWith("/") ? key : "",
    rows: [],
    lastActivityAt: 0,
    createdAt: 0,
    hasActiveTask: false,
    ...options,
  };
}

const order = (buckets: PhoneProjectBucket[]) =>
  sortSessionBuckets(buckets, {
    sortMode: "active",
    pinned: [],
    lastInteracted: {},
  }).map((b) => b.key);

describe("sortSessionBuckets", () => {
  it("puts imports and the no-project shelf last, whatever their clock", () => {
    const out = order([
      bucket("imported\u0000mac", { lastActivityAt: 999 }),
      bucket("__unassigned__", { lastActivityAt: 500 }),
      bucket("/work/alpha", { lastActivityAt: 1 }),
    ]);
    expect(out).toEqual(["/work/alpha", "__unassigned__", "imported\u0000mac"]);
  });

  it("puts pinned projects above unpinned ones, in pin rank order", () => {
    const out = sortSessionBuckets(
      [
        bucket("/work/alpha", { lastActivityAt: 100 }),
        bucket("/work/beta", { lastActivityAt: 200 }),
        bucket("/work/gamma", { lastActivityAt: 300 }),
      ],
      { sortMode: "active", pinned: ["/work/gamma", "/work/beta"], lastInteracted: {} },
    ).map((b) => b.key);
    expect(out).toEqual(["/work/gamma", "/work/beta", "/work/alpha"]);
  });

  it("puts projects with active work above idle ones in active mode", () => {
    const out = order([
      bucket("/work/idle", { lastActivityAt: 300 }),
      bucket("/work/running", { lastActivityAt: 100, hasActiveTask: true }),
    ]);
    expect(out).toEqual(["/work/running", "/work/idle"]);
  });

  it("orders by created date when the preference says so", () => {
    const out = sortSessionBuckets(
      [
        bucket("/work/old", { createdAt: 100, lastActivityAt: 999 }),
        bucket("/work/new", { createdAt: 300, lastActivityAt: 1 }),
      ],
      { sortMode: "created", pinned: [], lastInteracted: {} },
    ).map((b) => b.key);
    expect(out).toEqual(["/work/new", "/work/old"]);
  });

  it("counts opening a project as activity without changing its rows", () => {
    const out = order([
      bucket("/work/used-long-ago", { lastActivityAt: 100 }),
      bucket("/work/just-opened", { lastActivityAt: 50 }),
    ]);
    // No local touch: recency wins.
    expect(out).toEqual(["/work/used-long-ago", "/work/just-opened"]);
    const touched = sortSessionBuckets(
      [
        bucket("/work/used-long-ago", { lastActivityAt: 100 }),
        bucket("/work/just-opened", { lastActivityAt: 50 }),
      ],
      { sortMode: "active", pinned: [], lastInteracted: { "/work/just-opened": 1000 } },
    ).map((b) => b.key);
    expect(touched).toEqual(["/work/just-opened", "/work/used-long-ago"]);
  });

  it("ignores pins in the archive view, which shows projects as filed", () => {
    const out = sortSessionBuckets(
      [
        bucket("/work/alpha", { lastActivityAt: 100 }),
        bucket("/work/beta", { lastActivityAt: 200 }),
      ],
      { sortMode: "active", pinned: ["/work/alpha"], lastInteracted: {}, archived: true },
    ).map((b) => b.key);
    expect(out).toEqual(["/work/beta", "/work/alpha"]);
  });
});
