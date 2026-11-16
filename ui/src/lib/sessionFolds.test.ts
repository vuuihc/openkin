// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { readSessionFolds, setSessionFold } from "./sessionFolds";

describe("session folds", () => {
  beforeEach(() => localStorage.clear());

  it("starts with no stored opinion", () => {
    expect(readSessionFolds()).toEqual({});
  });

  it("remembers one place's fold without touching another's", () => {
    setSessionFold("mac-1::/work/alpha", false);
    setSessionFold("mac-1::imported\u0000mac-1", true);
    expect(readSessionFolds()).toEqual({
      "mac-1::/work/alpha": false,
      "mac-1::imported\u0000mac-1": true,
    });
  });

  it("keeps the rest of the map when one fold changes", () => {
    setSessionFold("a", false);
    setSessionFold("b", false);
    setSessionFold("a", true);
    expect(readSessionFolds()).toEqual({ a: true, b: false });
  });

  it("ignores a corrupt or non-boolean store instead of throwing", () => {
    localStorage.setItem("kin_session_folds", "{not json");
    expect(readSessionFolds()).toEqual({});
    localStorage.setItem("kin_session_folds", JSON.stringify({ a: "yes", b: 1, c: false }));
    expect(readSessionFolds()).toEqual({ c: false });
  });
});
