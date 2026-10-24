import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, MAX_TITLE_CHARS, bodyBytes, publishWordsRefusal } from "./publishWords";
import { en, zh } from "../i18n";

/** The sentence one catalog holds for a dotted key, or undefined. */
function at(catalog: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((cur, part) => (cur as Record<string, unknown> | undefined)?.[part], catalog);
}

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
    // Read out of each catalog rather than through `t()`: `t` falls back to the
    // other language before it gives up, so it answers with a sentence even when
    // the key is missing from one of them — which is the bug this is about.
    for (const [name, catalog] of [
      ["en", en],
      ["zh", zh],
    ] as const) {
      const sentence = at(catalog, key);
      expect(typeof sentence, name).toBe("string");
      expect(sentence, name).not.toBe(key);
      expect(String(sentence), name).toContain("32");
    }
  });
});

describe("bodyBytes", () => {
  it("counts bytes rather than UTF-16 units", () => {
    // 20,000 Chinese characters are 20,000 units and 60,000 bytes: a check on
    // `.length` would let through the one body this is here to stop.
    const body = "标".repeat(20000);
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
