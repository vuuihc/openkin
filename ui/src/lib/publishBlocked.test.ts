import { afterEach, describe, expect, it } from "vitest";
import {
  BLOCKED_CODES,
  blockedHeadline,
  isSessionRunsHere,
} from "./publishBlocked";
import { DEFAULT_LOCALE, setLocale, t } from "../i18n";

afterEach(() => setLocale(DEFAULT_LOCALE));

describe("blockedHeadline", () => {
  it("has a line of its own for every refusal a machine can name", () => {
    // The vocabulary on the wire is closed, so a code without a line here is a
    // refusal a person would read in the machine's English.
    for (const code of BLOCKED_CODES) {
      const line = blockedHeadline(code);
      expect(line, code).not.toBe("");
      expect(line, code).not.toContain("publish.blockedWhy");
    }
  });

  it("says nothing for a code it does not know", () => {
    // A newer machine refusing for a reason this console has never heard of:
    // the machine's own sentence is shown instead, and nothing is invented.
    expect(blockedHeadline("branch_protected")).toBe("");
    expect(blockedHeadline("")).toBe("");
  });

  it("speaks the reader's language, not the machine's", () => {
    setLocale("zh");
    expect(blockedHeadline("default_branch")).toBe(
      t("publish.blockedWhy.default_branch"),
    );
    expect(blockedHeadline("default_branch")).toContain("默认分支");
    setLocale("en");
    expect(blockedHeadline("default_branch")).toContain("default branch");
  });
});

describe("isSessionRunsHere", () => {
  it("is the conflict whose sentence this console has its own line for", () => {
    expect(
      isSessionRunsHere({ status: 409, body: { code: "session_runs_here" } }),
    ).toBe(true);
  });

  it("is not the other conflict the same routes answer with", () => {
    // A workspace on that machine this Hub cannot place is a 409 too, and it is
    // not "your session runs here". Saying so would be the console inventing a
    // fact about where somebody's work is.
    expect(isSessionRunsHere({ status: 409, body: { error: "cannot place it" } })).toBe(
      false,
    );
    expect(isSessionRunsHere({ status: 409 })).toBe(false);
    expect(isSessionRunsHere({ status: 400, body: { code: "session_runs_here" } })).toBe(
      false,
    );
  });
});
