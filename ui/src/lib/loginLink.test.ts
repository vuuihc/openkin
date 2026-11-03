import { describe, expect, it } from "vitest";
import {
  hasLoginHash,
  loginTokenFromHash,
  loginVisit,
  withoutClaimHash,
  withoutLoginHash,
} from "./loginLink";

const token = "0123456789abcdef".repeat(4);

describe("loginTokenFromHash", () => {
  it("reads the token a sign-in link carries", () => {
    expect(loginTokenFromHash(`#login=${token}`)).toBe(token);
  });

  it("reads it whether or not the hash keeps its marker", () => {
    // `window.location.hash` includes the "#"; a caller that already stripped
    // it must not get a different answer.
    expect(loginTokenFromHash(`login=${token}`)).toBe(token);
  });

  it("reads it when the fragment carries something else too", () => {
    expect(loginTokenFromHash(`#from=chat&login=${token}`)).toBe(token);
  });

  it("reports nothing for an ordinary visit", () => {
    expect(loginTokenFromHash("")).toBe("");
    expect(loginTokenFromHash("#settings")).toBe("");
    expect(loginTokenFromHash("#login=")).toBe("");
  });

  it("accepts the upper-case hex a chat client may produce", () => {
    // The Hub lowercases before hashing, so this is the same token.
    expect(loginTokenFromHash(`#login=${token.toUpperCase()}`)).toBe(token.toUpperCase());
  });

  it("rejects anything that is not a full token", () => {
    // Posting a truncated token would spend a rate-limit attempt and come back
    // "expired", which reads as a dead link rather than a mangled one.
    expect(loginTokenFromHash("#login=0123456789abcdef")).toBe("");
    expect(loginTokenFromHash(`#login=${token}extra`)).toBe("");
  });
});

describe("hasLoginHash", () => {
  it("reports a login parameter even when the token is malformed", () => {
    // This is how the entry point distinguishes "no link" from "a link a chat
    // client cut in half"; the latter has to be reported, not ignored.
    expect(hasLoginHash("#login=0123456789abcdef")).toBe(true);
    expect(hasLoginHash("#login=")).toBe(true);
  });

  it("reports nothing for an ordinary visit", () => {
    expect(hasLoginHash("")).toBe(false);
    expect(hasLoginHash("#section")).toBe(false);
  });
});

describe("loginVisit", () => {
  it("reports an ordinary visit as no link at all", () => {
    expect(loginVisit("")).toBeNull();
    expect(loginVisit("#section")).toBeNull();
  });

  it("carries a full token", () => {
    expect(loginVisit(`#login=${token}`)).toEqual({ token, malformed: false });
  });

  it("marks a link whose token was mangled", () => {
    // Present but unusable: the entry point clears the fragment and reports the
    // failure instead of treating the visit as if no link had been followed.
    expect(loginVisit("#login=0123456789abcdef")).toEqual({ token: "", malformed: true });
    expect(loginVisit("#login=")).toEqual({ token: "", malformed: true });
  });
});

describe("withoutLoginHash", () => {
  it("removes the credential but keeps the path and query", () => {
    expect(withoutLoginHash(`https://kin.example.com/?claim=abcde23456#login=${token}`)).toBe(
      "https://kin.example.com/?claim=abcde23456",
    );
  });

  it("keeps the rest of the fragment", () => {
    // Deleting the whole fragment would take a claim code the account screen
    // has not read yet with it.
    expect(withoutLoginHash(`https://kin.example.com/#from=chat&login=${token}`)).toBe(
      "https://kin.example.com/#from=chat",
    );
  });

  it("returns the address unchanged when there is no sign-in token", () => {
    const href = "https://kin.example.com/#section";
    expect(withoutLoginHash(href)).toBe(href);
  });
});

describe("withoutClaimHash", () => {
  it("removes a claim code from the fragment but keeps the rest", () => {
    expect(withoutClaimHash("https://kin.example.com/?room=r1#claim=abcde23456")).toBe(
      "https://kin.example.com/?room=r1",
    );
  });

  it("keeps other fragment parameters", () => {
    expect(withoutClaimHash("https://kin.example.com/#from=chat&claim=abcde23456")).toBe(
      "https://kin.example.com/#from=chat",
    );
  });

  it("returns the address unchanged when there is no claim code", () => {
    // Callers use the equality to decide whether a history rewrite is needed.
    const href = `https://kin.example.com/#login=${token}`;
    expect(withoutClaimHash(href)).toBe(href);
  });

  it("removes an empty claim parameter too", () => {
    expect(withoutClaimHash("https://kin.example.com/#claim=")).toBe("https://kin.example.com/");
  });
});
