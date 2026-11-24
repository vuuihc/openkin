import { describe, expect, it } from "@jest/globals";
import { parsePairingLink, redactToken } from "./pairingLink";

/**
 * KIN-MOBILE-001 R2 — the pairing link parser.
 *
 * The node hands out a `?token=` link. Parsing it is pure: it must accept the
 * web form and the app's own `kin://` form, reject everything else, and never
 * hand back a string that still carries the token for display.
 */

const TOKEN = "fixture-token-not-real";

describe("KIN-MOBILE-001 R2 pairing link", () => {
  it("KIN-MOBILE-001 R2: parses ?token= from a full URL", () => {
    const parsed = parsePairingLink(`https://kin.example.com/?token=${TOKEN}`);

    expect(parsed).toEqual({
      ok: true,
      link: {
        origin: "https://kin.example.com",
        token: TOKEN,
        display: "https://kin.example.com",
      },
    });
  });

  it("KIN-MOBILE-001 R2: parses ?token= from a bare kin:// link", () => {
    const parsed = parsePairingLink(`kin://pair?token=${TOKEN}`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.link.token).toBe(TOKEN);
    expect(parsed.link.origin).toBeNull();
    expect(parsed.link.display).toBe("kin://pair");
  });

  it("KIN-MOBILE-001 R2: a kin:// link may carry the node origin beside the token", () => {
    const parsed = parsePairingLink(
      `kin://pair?origin=${encodeURIComponent("https://kin.example.com")}&token=${TOKEN}`,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.link.origin).toBe("https://kin.example.com");
    expect(parsed.link.display).toBe("https://kin.example.com");
  });

  it.each([
    ["a link with no token", "https://kin.example.com/", "no-token"],
    ["an empty token", "https://kin.example.com/?token=", "empty-token"],
    ["a blank token", "https://kin.example.com/?token=%20%20", "empty-token"],
    ["an ftp link", `ftp://kin.example.com/?token=${TOKEN}`, "bad-link"],
    ["a file link", `file:///tmp/x?token=${TOKEN}`, "bad-link"],
    ["plain text", "not a link at all", "bad-link"],
    ["an empty string", "", "bad-link"],
  ] as const)("KIN-MOBILE-001 R2: rejects %s", (_label, raw, reason) => {
    expect(parsePairingLink(raw)).toEqual({ ok: false, reason });
  });

  it("KIN-MOBILE-001 R2: redactToken shows the origin only", () => {
    expect(redactToken(`https://kin.example.com/?token=${TOKEN}`)).toBe(
      "https://kin.example.com",
    );
    expect(redactToken(`kin://pair?token=${TOKEN}`)).toBe("kin://pair");

    for (const display of [
      redactToken(`https://kin.example.com/?token=${TOKEN}`),
      redactToken(`kin://pair?token=${TOKEN}`),
    ]) {
      expect(display).not.toContain(TOKEN);
      expect(display).not.toContain("token=");
    }
  });
});
