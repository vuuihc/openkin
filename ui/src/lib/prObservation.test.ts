import { describe, expect, it } from "vitest";
import {
  absentRepoLabel,
  ciLabel,
  headerLabel,
  leadObservation,
  observedBranch,
  otherPullRequests,
  parseCISummary,
  shortRepo,
  shouldAskForRead,
  stateLabel,
  unobservedLabel,
  type CISummary,
} from "./prObservation";
import type { PullRequestObservation } from "../api/client";

/** The real catalog is not loaded here; the key sent is the thing under test. */
const tr = (key: string, params?: Record<string, string | number | undefined | null>) =>
  params ? `${key}(${Object.values(params).join("|")})` : key;

/** A parsed summary with only the fields a case cares about. */
function ci(over: Partial<CISummary> = {}): CISummary {
  return { total: 0, passed: 0, failed: 0, pending: 0, failing: [], ...over };
}

function obs(
  over: Partial<PullRequestObservation> & { head_branch: string },
): PullRequestObservation {
  return { repo: "github.com/owner/repo", task_id: "t1", attempted_at: 0, ...over };
}

describe("parseCISummary", () => {
  it("reads the daemon's summary", () => {
    const s = parseCISummary(
      JSON.stringify({
        state: "failure",
        total: 5,
        passed: 3,
        failed: 2,
        pending: 0,
        failing: ["lint", "test"],
      }),
    );
    expect(s).toEqual({
      total: 5,
      passed: 3,
      failed: 2,
      pending: 0,
      failing: ["lint", "test"],
    });
  });

  it("survives a value that is not JSON at all", () => {
    // A cache of somebody else's API. Throwing here would lose the pull-request
    // number too, which is the part the user actually needs.
    expect(parseCISummary("not json")).toBeNull();
    expect(parseCISummary("")).toBeNull();
    expect(parseCISummary(undefined)).toBeNull();
  });

  it("survives JSON of the wrong shape", () => {
    expect(parseCISummary("[1,2,3]")).toBeNull();
    expect(parseCISummary("null")).toBeNull();
    expect(parseCISummary('"a string"')).toBeNull();
  });

  it("defaults missing counts to zero rather than NaN", () => {
    expect(parseCISummary("{}")).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      failing: [],
    });
    expect(parseCISummary('{"total":"five"}')?.total).toBe(0);
  });

  it("drops non-string entries from the failing list", () => {
    expect(parseCISummary('{"failing":["ok",3,null]}')?.failing).toEqual(["ok"]);
  });
});

describe("leadObservation", () => {
  it("picks the row for the current branch", () => {
    const rows = [
      obs({ head_branch: "kin/task/1/g1", observed_at: 500 }),
      obs({ head_branch: "kin/task/1/g2", observed_at: 100 }),
    ];
    expect(leadObservation(rows, "kin/task/1/g2")?.head_branch).toBe("kin/task/1/g2");
  });

  it("falls back to the most recent observation when the branch is gone", () => {
    // The checkout can be removed while the observation survives; going blank
    // there would hide a pull request that still exists.
    const rows = [
      obs({ head_branch: "kin/task/1/g1", observed_at: 100 }),
      obs({ head_branch: "kin/task/1/g2", observed_at: 900 }),
    ];
    expect(leadObservation(rows, "kin/task/1/g9")?.head_branch).toBe("kin/task/1/g2");
    expect(leadObservation(rows, undefined)?.head_branch).toBe("kin/task/1/g2");
  });

  it("keeps the current branch's row even when it was never observed", () => {
    // The failed attempt is the answer for *this* branch. Substituting an older
    // generation's pull request would show a number that is not this branch's.
    const rows = [
      obs({ head_branch: "kin/task/1/g9", last_error: "404" }),
      obs({ head_branch: "kin/task/1/g1", observed_at: 100, number: 7 }),
    ];
    const lead = leadObservation(rows, "kin/task/1/g9");
    expect(lead?.head_branch).toBe("kin/task/1/g9");
    expect(lead?.observed_at).toBeUndefined();
  });

  it("prefers an observed row when falling back", () => {
    const rows = [
      obs({ head_branch: "kin/task/1/g9", last_error: "404" }),
      obs({ head_branch: "kin/task/1/g1", observed_at: 100 }),
    ];
    expect(leadObservation(rows, "kin/task/1/gone")?.head_branch).toBe("kin/task/1/g1");
  });

  it("returns null when there is nothing to show", () => {
    expect(leadObservation([], "b")).toBeNull();
    expect(leadObservation(undefined, "b")).toBeNull();
  });
});

describe("observedBranch", () => {
  it("finds this branch's row", () => {
    const rows = [
      obs({ head_branch: "kin/task/1/g1", observed_at: 500 }),
      obs({ head_branch: "kin/task/1/g2", observed_at: 100 }),
    ];
    expect(observedBranch(rows, "kin/task/1/g2")?.head_branch).toBe("kin/task/1/g2");
  });

  it("does not count another generation's row as this branch's", () => {
    // The panel still renders the g1 pull request — that fallback is for
    // showing. Asking GitHub is decided here, and g2 has never been asked
    // about, so it must not be mistaken for already answered.
    const rows = [obs({ head_branch: "kin/task/1/g1", observed_at: 500 })];
    expect(observedBranch(rows, "kin/task/1/g2")).toBeUndefined();
    expect(leadObservation(rows, "kin/task/1/g2")).not.toBeNull();
  });

  it("counts a row that was attempted and failed", () => {
    // This branch has been asked about; the answer was an error, and the card
    // says so. Asking again on every open is what the only-once rule prevents.
    const rows = [obs({ head_branch: "kin/task/1/g2", last_error: "404" })];
    expect(observedBranch(rows, "kin/task/1/g2")?.last_error).toBe("404");
  });

  it("has nothing to match without rows or a branch", () => {
    expect(observedBranch(undefined, "b")).toBeUndefined();
    expect(observedBranch([obs({ head_branch: "b" })], undefined)).toBeUndefined();
    expect(observedBranch([], "b")).toBeUndefined();
  });
});

describe("otherPullRequests", () => {
  it("lists earlier generations that have a pull request", () => {
    const lead = obs({ head_branch: "kin/task/1/g2", number: 42 });
    const rows = [
      lead,
      obs({ head_branch: "kin/task/1/g1", number: 7 }),
      obs({ head_branch: "kin/task/1/g0" }),
    ];
    expect(otherPullRequests(rows, lead).map((o) => o.number)).toEqual([7]);
  });

  it("does not repeat the lead row", () => {
    const lead = obs({ head_branch: "kin/task/1/g2", number: 42 });
    expect(otherPullRequests([lead], lead)).toEqual([]);
    expect(otherPullRequests(undefined, lead)).toEqual([]);
  });

  it("keeps a namesake branch from another repository", () => {
    // Identity is (repo, branch). Two repositories can name a branch the same
    // way, and hiding one of them would hide a pull request that exists.
    const lead = obs({ head_branch: "kin/task/1/g1", number: 42 });
    const other = obs({
      repo: "github.com/other/repo",
      head_branch: "kin/task/1/g1",
      number: 43,
    });
    expect(otherPullRequests([lead, other], lead).map((o) => o.number)).toEqual([43]);
  });
});

describe("stateLabel", () => {
  it("reads draft before state", () => {
    expect(stateLabel(tr, { is_draft: true, state: "open" })).toBe("pr.stateDraft");
  });

  it("maps the three states, defaulting to open", () => {
    expect(stateLabel(tr, { state: "merged" })).toBe("pr.stateMerged");
    expect(stateLabel(tr, { state: "closed" })).toBe("pr.stateClosed");
    expect(stateLabel(tr, { state: "open" })).toBe("pr.stateOpen");
    expect(stateLabel(tr, { state: undefined })).toBe("pr.stateOpen");
  });
});

describe("ciLabel", () => {
  it("reports a success the daemon reported even with no counts", () => {
    // A legacy or corrupt row can carry `success` with no summary. "Checks
    // running" is the worst of the three wrong answers here: it reverses the
    // one fact that was actually reported.
    expect(ciLabel(tr, "success", null)).toBe("pr.ciSuccessPlain");
    expect(ciLabel(tr, "success", ci({}))).toBe("pr.ciSuccessPlain");
  });

  it("counts a success that has counts", () => {
    expect(ciLabel(tr, "success", ci({ total: 4 }))).toBe("pr.ciSuccess(4)");
  });

  it("names the failing checks when it knows them", () => {
    expect(
      ciLabel(tr, "failure", ci({ total: 5, failed: 2, failing: ["lint", "unit", "e2e", "docs"] })),
    ).toBe("pr.ciFailureNamed(5|2|lint, unit, e2e)");
  });

  it("falls back to counts, then to a bare verdict", () => {
    expect(ciLabel(tr, "failure", ci({ total: 5, failed: 2 }))).toBe("pr.ciFailureCount(5|2)");
    expect(ciLabel(tr, "failure", null)).toBe("pr.ciFailure");
    expect(ciLabel(tr, "pending", null)).toBe("pr.ciPending");
  });

  it("counts a run still in progress", () => {
    expect(ciLabel(tr, "pending", ci({ total: 5, passed: 3 }))).toBe("pr.ciPendingCount(5|3)");
  });
});

describe("headerLabel", () => {
  it("prefers the live snapshot's repo and branch", () => {
    expect(
      headerLabel(
        { repo: "github.com/cli/cli", branch: "kin/task/1/g1" },
        obs({ head_branch: "kin/task/1/g0", repo: "github.com/other/repo" }),
      ),
    ).toBe("cli/cli · kin/task/1/g1");
  });

  it("falls back to the row when the checkout is gone", () => {
    // No workspace means no snapshot repo. Saying "not in a GitHub repository"
    // while showing a pull request from one would be a lie.
    expect(headerLabel({}, obs({ head_branch: "kin/task/1/g1" }))).toBe(
      "owner/repo · kin/task/1/g1",
    );
  });

  it("is empty when there is neither", () => {
    expect(headerLabel(null, null)).toBe("");
    expect(headerLabel({}, null)).toBe("");
  });

  it("does not repeat the host", () => {
    expect(shortRepo("github.com/owner/repo")).toBe("owner/repo");
    expect(shortRepo("garbage")).toBe("garbage");
  });
});

describe("absentRepoLabel", () => {
  it("claims the task is in no repository only for a checkout read here", () => {
    // The claim is about a checkout this daemon can read. With none to read it
    // is the machine holding the task that would have to make it.
    expect(absentRepoLabel(tr, null)).toBe("pr.noRepo");
  });

  it("names the machine holding the checkout instead", () => {
    expect(absentRepoLabel(tr, { text: "studio", known: true })).toBe("pr.repoElsewhere(studio)");
  });

  it("names a machine this console cannot place, by its id", () => {
    // A revoked machine, a device list that failed to load, or one that is
    // still loading. The id is what the person has to go on, and it beats
    // naming this machine by omission — so the label says where the name came
    // from rather than that the machine is gone.
    expect(absentRepoLabel(tr, { text: "node-7", known: false })).toBe(
      "pr.repoElsewhereUnknown(node-7)",
    );
  });
});

describe("unobservedLabel", () => {
  // One sentence whichever machine holds the checkout: the read is made by that
  // machine, so a task on another one is waiting for an answer, not for news
  // that none is coming.
  it("says the branch has not been checked yet", () => {
    expect(unobservedLabel(tr)).toBe("pr.notChecked");
  });
});

describe("shouldAskForRead", () => {
  const elsewhere = { text: "Work Mac", known: true };

  it("asks about a branch that has no row of its own", () => {
    expect(shouldAskForRead({ branch: "feature/x", observations: [] }, null)).toBe(true);
  });

  it("does not ask again about a branch that has one", () => {
    // Even a row that only records a failure: that is this branch's answer, and
    // the age line is what says how old it is.
    expect(
      shouldAskForRead(
        {
          branch: "feature/x",
          observations: [obs({ head_branch: "feature/x", last_error: "rate limited" })],
        },
        null,
      ),
    ).toBe(false);
  });

  it("asks a task on another machine even with no branch recorded", () => {
    // A session that started while its machine was away, or a fork: the branch
    // is that machine's to report, and this ask is how it arrives.
    expect(shouldAskForRead({ branch: "", observations: [] }, elsewhere)).toBe(true);
  });

  it("does not ask when no branch is recorded and no machine is known", () => {
    // Nothing has a checkout to look in: the daemon answers this one without
    // querying anything.
    expect(shouldAskForRead({ branch: "", observations: [] }, null)).toBe(false);
    expect(shouldAskForRead(null, elsewhere)).toBe(false);
  });
});
