import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  MAX_TITLE_CHARS,
  bodyBytes,
  publishWordsRefusal,
} from "./publishWords";
import { DEFAULT_LOCALE, setLocale, t } from "../i18n";

describe("publishWordsRefusal", () => {
  it("sends the words the sheet was opened with", () => {
    expect(publishWordsRefusal({ title: "Add the thing", body: "It does it." })).toBe("");
  });

  it("asks for a title, which gh would otherwise open an editor for", () => {
    expect(publishWordsRefusal({ title: "   ", body: "b" })).toBe("publish.needsTitle");
  });

  it("refuses a body the machine could not carry, in the reader's language", () => {
    // The bound is the wire's, and the console's job is to say so *before* the
    // escape below it starts a branch and then meets the refusal.
    const key = publishWordsRefusal({ title: "t", body: "x".repeat(MAX_BODY_BYTES + 1) });
    expect(key).toBe("publish.bodyTooLong");
    for (const locale of ["en", "zh"] as const) {
      setLocale(locale);
      expect(t(key), locale).not.toBe(key);
      expect(t(key), locale).toContain("64");
    }
    setLocale(DEFAULT_LOCALE);
  });
});

describe("bodyBytes", () => {
  it("counts bytes rather than UTF-16 units", () => {
    // 30,000 Chinese characters are 30,000 units and 90,000 bytes: a check on
    // `.length` would let through the one body this is here to stop.
    const body = "标".repeat(30000);
    expect(body.length).toBeLessThan(MAX_BODY_BYTES);
    expect(bodyBytes(body)).toBeGreaterThan(MAX_BODY_BYTES);
    expect(publishWordsRefusal({ title: "t", body })).toBe("publish.bodyTooLong");
  });

  it("leaves room for a title at the character bound", () => {
    // The two bounds are independent, and neither one is reached by the other:
    // a title at its limit is a kilobyte at most, nowhere near the body's.
    expect(publishWordsRefusal({ title: "标".repeat(MAX_TITLE_CHARS), body: "" })).toBe("");
  });
});
