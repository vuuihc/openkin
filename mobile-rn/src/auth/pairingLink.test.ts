import { describe, expect, it } from "@jest/globals";
import { parsePairingLink, redactToken } from "./pairingLink";

/**
 * KIN-MOBILE-001 R2 — the pairing link's focused proofs.
 *
 * These were folded into `pairing.test.ts` to fit R2a's merge cap and are
 * restored here without changing the parser. Each case pins one shape the
 * owner can paste: a web link, an app link that names its node, and the four
 * ways a link is refused before anything is stored or sent.
 */

const ORIGIN = "https://kin.example.com";
const TOKEN = "fixture-token-not-real";

describe("KIN-MOBILE-001 R2 pairing link", () => {
  it("KIN-MOBILE-001 R2: a kin:// link names its node in the origin query parameter", () => {
    const parsed = parsePairingLink(
      `kin://pair?token=${TOKEN}&origin=${encodeURIComponent(ORIGIN)}`,
    );

    expect(parsed).toEqual({
      ok: true,
      link: {
        origin: ORIGIN,
        token: TOKEN,
        pairing: false,
        display: ORIGIN,
      },
    });
  });

  it("KIN-MOBILE-001 R2: a full https link parses to its origin, token and display form", () => {
    expect(parsePairingLink(`${ORIGIN}/pair?token=${TOKEN}`)).toEqual({
      ok: true,
      link: {
        origin: ORIGIN,
        token: TOKEN,
        pairing: false,
        display: ORIGIN,
      },
    });
  });

  it("KIN-MOBILE-001 R2: redactToken keeps the kin:// origin and drops the token", () => {
    const raw = `kin://pair?token=${TOKEN}&origin=${encodeURIComponent(ORIGIN)}`;

    expect(redactToken(raw)).toBe(ORIGIN);
    expect(redactToken(raw)).not.toContain(TOKEN);
    expect(redactToken(raw)).not.toContain("token=");
  });

  it.each([
    ["no token parameter", `${ORIGIN}/pair`, "no-token"],
    ["an empty token", `${ORIGIN}/?token=`, "empty-token"],
    ["a foreign scheme", `ftp://kin.example.com/?token=${TOKEN}`, "bad-link"],
    ["plain text", "not a link at all", "bad-link"],
  ] as const)(
    "KIN-MOBILE-001 R2: refuses %s with its own reason",
    (_label, raw, reason) => {
      expect(parsePairingLink(raw)).toEqual({ ok: false, reason });
    },
  );
});
