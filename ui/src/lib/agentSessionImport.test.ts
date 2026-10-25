import { describe, expect, it } from "vitest";

import {
  firstFailedReason,
  firstFailedSource,
  importTargets,
  importTargetsFor,
  importToast,
  mergeAgentSessionImports,
} from "./agentSessionImport";
import type { Machine } from "./devices";

// The translator, stubbed as "the key and its parameters": what these tests
// assert is which sentence was chosen, and a stub that rendered one would only
// be asserting the locale file back at itself.
const tr = (path: string, params?: Record<string, string | number>): string =>
  params ? `${path} ${JSON.stringify(params)}` : path;

// Importing from more than one machine is one errand for the person and several
// answers underneath, and this is where the several become the one. What it gets
// wrong is invisible in the UI: a count that was overwritten rather than added
// reads as "your other machine had nothing", and an error keyed by provider
// alone sends the reader to look at the machine they are already on.

describe("mergeAgentSessionImports", () => {
  it("adds the machines' counts together", () => {
    const merged = mergeAgentSessionImports([
      { label: "This machine", result: { imported: 2, providers: { "claude-code": 2 } } },
      { label: "studio", result: { imported: 3, providers: { "claude-code": 1, codex: 2 } } },
    ]);
    expect(merged.imported).toBe(5);
    // One provider's sessions are one set of sessions however many machines they
    // were found on: a per-machine breakdown is not what the toast reports.
    expect(merged.providers).toEqual({ "claude-code": 3, codex: 2 });
    expect(merged.errors).toBeUndefined();
  });

  it("files an error under the machine that said it", () => {
    const merged = mergeAgentSessionImports([
      { label: "This machine", result: { imported: 1, providers: { "claude-code": 1 } } },
      {
        label: "studio",
        result: { imported: 0, providers: {}, errors: { codex: "no catalog" } },
      },
    ]);
    expect(merged.errors).toEqual({ "studio: codex": "no catalog" });
    // The machine that answered is still in the result: a phone whose laptop is
    // asleep still gets the sessions that are reachable.
    expect(merged.imported).toBe(1);
  });

  it("reports a machine that could not be reached without losing the others", () => {
    const merged = mergeAgentSessionImports([
      { label: "This machine", result: { imported: 4, providers: { "claude-code": 4 } } },
      { label: "studio", error: new Error("machine is offline") },
    ]);
    expect(merged.imported).toBe(4);
    expect(merged.errors).toEqual({ studio: "machine is offline" });
  });

  it("keeps the same provider's errors from two machines apart", () => {
    const merged = mergeAgentSessionImports([
      { label: "This machine", result: { imported: 0, providers: {}, errors: { codex: "here" } } },
      { label: "studio", result: { imported: 0, providers: {}, errors: { codex: "there" } } },
    ]);
    expect(merged.errors).toEqual({ "This machine: codex": "here", "studio: codex": "there" });
  });

  it("omits the errors map entirely when nothing failed", () => {
    // The callers count keys to decide whether to show a warning, so an empty
    // map that is present is a warning with nothing in it.
    expect(mergeAgentSessionImports([]).errors).toBeUndefined();
    expect(
      mergeAgentSessionImports([{ label: "studio", result: { imported: 0, providers: {} } }])
        .errors,
    ).toBeUndefined();
  });

  it("carries a machine's cap through as its own fact", () => {
    // One machine having more than it could send is the errand's answer, not
    // that machine's: the person asked for their sessions and the list they are
    // about to read is not all of them.
    const merged = mergeAgentSessionImports([
      { label: "This machine", result: { imported: 2, providers: {} } },
      { label: "studio", result: { imported: 500, providers: {}, truncated: true } },
    ]);
    expect(merged.truncated).toBe(true);
    expect(merged.imported).toBe(502);
    // And it is not a failure: nothing here is a provider anybody can fix.
    expect(merged.errors).toBeUndefined();
  });

  it("says nothing about truncation when there was none", () => {
    expect(
      mergeAgentSessionImports([{ label: "studio", result: { imported: 1, providers: {} } }])
        .truncated,
    ).toBe(false);
  });
});

// The toast says one thing and counts the rest, because "1 provider
// unavailable" is a lie when the one thing that failed was a machine that never
// answered: the reader goes and looks at providers. So the single named thing
// has to be the one the error map actually keys.
describe("firstFailedSource", () => {
  it("names the machine that could not be reached", () => {
    const merged = mergeAgentSessionImports([
      { label: "This machine", result: { imported: 2, providers: { "claude-code": 2 } } },
      { label: "studio", error: new Error("machine is offline") },
    ]);
    expect(firstFailedSource(merged)).toBe("studio");
  });

  it("names a provider with the machine it refused on", () => {
    const merged = mergeAgentSessionImports([
      {
        label: "studio",
        result: { imported: 0, providers: {}, errors: { codex: "no catalog" } },
      },
    ]);
    expect(firstFailedSource(merged)).toBe("studio: codex");
  });

  it("is empty when nothing failed", () => {
    const merged = mergeAgentSessionImports([
      { label: "This machine", result: { imported: 1, providers: { codex: 1 } } },
    ]);
    expect(firstFailedSource(merged)).toBe("");
    // And there is no reason to show for a failure that did not happen: an
    // empty string, not the word "undefined" in a toast.
    expect(firstFailedReason(merged)).toBe("");
  });

  it("carries the reason the machine gave", () => {
    const merged = mergeAgentSessionImports([
      { label: "This machine", error: new Error("agent session discovery is unavailable") },
    ]);
    expect(firstFailedReason(merged)).toBe("agent session discovery is unavailable");
  });
});

// Which machines one import asks. This is the other half of the same bug: two
// surfaces offer "import agent sessions", and the one that asked only the
// daemon serving the console looked identical to the one that asked every
// machine.
describe("importTargets", () => {
  const machine = (over: Partial<Machine>): Machine => ({
    id: "d-1",
    label: "machine",
    isSelf: false,
    online: true,
    roots: [],
    agents: [],
    ...over,
  });

  it("asks this machine first, then every paired one", () => {
    const targets = importTargets(
      [
        machine({ id: "desktop-1", label: "studio", isSelf: true }),
        machine({ id: "d-2", label: "laptop" }),
      ],
      "This machine",
    );
    expect(targets).toEqual([
      { deviceId: "", label: "This machine" },
      { deviceId: "d-2", label: "laptop" },
    ]);
  });

  it("asks this machine even when the machine list has not loaded", () => {
    expect(importTargets([], "This machine")).toEqual([{ deviceId: "", label: "This machine" }]);
  });

  it("asks a machine that reads as offline", () => {
    // The flag is a snapshot from the last poll and the answer is what is
    // authoritative, so a laptop that has just woken up is asked rather than
    // skipped until the console notices.
    const targets = importTargets(
      [machine({ id: "d-2", label: "laptop", online: false })],
      "This machine",
    );
    expect(targets.map((target) => target.deviceId)).toEqual(["", "d-2"]);
  });
});

// Names are a different errand from "all of mine": every surface that offers a
// provider by name read that id out of this daemon's registry, so a named
// provider is this machine's provider. Asking the others by name asks each of
// them for something it may not have, and "I have no codex" lands in the error
// map as a failure the reader cannot act on.
describe("importTargetsFor", () => {
  const machine = (over: Partial<Machine>): Machine => ({
    id: "d-1",
    label: "machine",
    isSelf: false,
    online: true,
    roots: [],
    agents: [],
    ...over,
  });
  const paired = [machine({ id: "d-2", label: "laptop" })];

  it("asks only this machine when the provider was named", () => {
    expect(importTargetsFor(["codex"], paired, "This machine")).toEqual([
      { deviceId: "", label: "This machine" },
    ]);
  });

  it("asks every machine when no provider was named", () => {
    expect(importTargetsFor(undefined, paired, "This machine")).toEqual([
      { deviceId: "", label: "This machine" },
      { deviceId: "d-2", label: "laptop" },
    ]);
    expect(importTargetsFor([], paired, "This machine")).toHaveLength(2);
  });

  it("treats a list of blank names as no names at all", () => {
    // An empty string is not a provider anybody chose: it is what a caller that
    // meant "all of them" would send if it built its list carelessly, and the
    // wire reads a blank name as "every provider you have".
    expect(importTargetsFor(["  "], paired, "This machine")).toHaveLength(2);
  });
});

// What the person is told afterwards. Every import asks every machine now, so
// the failure can be a machine rather than a provider, and the message has to
// be able to say so.
describe("importToast", () => {
  it("reports the count when nothing failed", () => {
    const toast = importToast({ imported: 7, providers: {} }, tr);
    expect(toast).toEqual({
      message: 'settings.localAgents.imported {"imported":7}',
      kind: "info",
    });
  });

  it("names the machine that did not answer, and why", () => {
    const toast = importToast(
      { imported: 3, providers: {}, errors: { studio: "machine is offline" } },
      tr,
    );
    expect(toast).toEqual({
      message:
        'settings.localAgents.importPartialSource {"imported":3,"source":"studio","reason":"machine is offline"}',
      kind: "error",
    });
  });

  it("names one failure and counts the rest", () => {
    const toast = importToast(
      {
        imported: 3,
        providers: {},
        errors: { studio: "machine is offline", "This machine: codex": "no catalog" },
      },
      tr,
    );
    expect(toast).toEqual({
      message:
        'settings.localAgents.importPartialSources {"imported":3,"errors":2,"source":"studio"}',
      kind: "error",
    });
  });

  it("calls a partial import an error even though sessions arrived", () => {
    // The sessions that did arrive are in the count and the toast is still a
    // warning: a person who is not told will believe the list is the whole of
    // their sessions.
    expect(
      importToast({ imported: 12, providers: {}, errors: { codex: "no catalog" } }, tr).kind,
    ).toBe("error");
  });

  it("still reads as a sentence when the failure came with no reason", () => {
    // An error object with an empty message is possible, and "codex did not
    // sync: " is a colon with nothing after it. The counted form says the same
    // thing without the trailing half.
    const toast = importToast({ imported: 2, providers: {}, errors: { codex: "" } }, tr);
    expect(toast.message).toBe(
      'settings.localAgents.importPartialSources {"imported":2,"errors":1,"source":"codex"}',
    );
  });

  it("says out loud that a capped import was capped", () => {
    // A count on its own reads as the whole of them, and the machine's cap is
    // invisible from here: the rows that arrived look exactly like all the rows
    // there were.
    const toast = importToast({ imported: 500, providers: {}, truncated: true }, tr);
    expect(toast.kind).toBe("info");
    expect(toast.message).toBe(
      'settings.localAgents.imported {"imported":500} settings.localAgents.importTruncated',
    );
  });

  it("says both things when an import was capped and something failed", () => {
    // Neither half replaces the other: one names a machine to look at, the
    // other says the list is short, and a reader told only one of them will act
    // on the wrong one.
    const toast = importToast(
      { imported: 500, providers: {}, truncated: true, errors: { studio: "machine is offline" } },
      tr,
    );
    expect(toast.kind).toBe("error");
    expect(toast.message).toBe(
      'settings.localAgents.importPartialSource {"imported":500,"source":"studio","reason":"machine is offline"}' +
        " settings.localAgents.importTruncated",
    );
  });
});
