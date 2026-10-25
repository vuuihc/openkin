import { describe, expect, it } from "vitest";
import {
  authErrorText,
  formatClaimCode,
  formatInviteCode,
  gateFor,
  gateForVisit,
  CODE_FIELDS,
  inviteFromQuery,
  prefilledCode,
} from "./accountGate";
import { NO_ACCOUNT, type AccountState } from "../store/appStore";
import { en } from "../i18n";

function account(over: Partial<AccountState> = {}): AccountState {
  return {
    ...NO_ACCOUNT,
    enabled: true,
    providers: [{ id: "password", label: "password", kind: "password" }],
    ...over,
  };
}

describe("gateFor", () => {
  it("keeps the token gate on a daemon with no accounts", () => {
    expect(gateFor(NO_ACCOUNT)).toBe("token");
  });

  it("asks a hub without an owner to be claimed", () => {
    expect(gateFor(account({ needsBootstrap: true, claimable: true }))).toBe("claim");
  });

  it("still asks for the claim code after it expires", () => {
    // Signing in cannot work yet, so offering it would be a dead end.
    expect(gateFor(account({ needsBootstrap: true, claimable: false }))).toBe("claim");
  });

  it("asks a claimed hub to sign in", () => {
    expect(gateFor(account({ needsBootstrap: false }))).toBe("login");
  });
});

describe("gateForVisit", () => {
  const invite = "?invite=HZ9EW-V3DPK-4MNQB-7RTXS";

  it("sends somebody who followed an invitation to the join screen", () => {
    expect(gateForVisit(account({ needsBootstrap: false }), invite)).toBe("join");
  });

  it("does not send them there on a hub that has no owner", () => {
    // An invitation is issued by an owner, so a hub with no owner has nothing
    // to join: RedeemInvite refuses, and the join screen could only ever fail.
    // It would also hide the claim screen, which is the one route that produces
    // a working hub -- and an operator whose address bar still carries a stale
    // ?invite= would be locked out of claiming their own machine.
    expect(gateForVisit(account({ needsBootstrap: true, claimable: true }), invite)).toBe("claim");
  });

  it("leaves every other visit to the hub's own answer", () => {
    expect(gateForVisit(account({ needsBootstrap: false }), "")).toBe("login");
    expect(gateForVisit(account({ needsBootstrap: true }), "?token=abc&pairing=1")).toBe("claim");
  });

  it("keeps the token gate on a daemon with no accounts", () => {
    // There is no join screen to send anybody to: the daemon cannot make an
    // account at all, and an invitation link cannot change that.
    expect(gateForVisit(NO_ACCOUNT, invite)).toBe("token");
  });
});

describe("authErrorText", () => {
  const tr = (key: string) =>
    (({ "account.errors.weak_password": "密码太弱" }) as Record<string, string>)[key] ?? key;

  it("translates a known code", () => {
    expect(authErrorText({ code: "weak_password", message: "too weak" }, tr)).toBe("密码太弱");
  });

  it("falls back to the server message for an unknown code", () => {
    expect(authErrorText({ code: "from_the_future", message: "nope" }, tr)).toBe("nope");
  });

  it("falls back to a generic message when there is nothing else", () => {
    expect(authErrorText({ code: "from_the_future", message: "" }, tr)).toBe(
      "account.errors.sign_in_failed",
    );
  });
});

describe("formatClaimCode", () => {
  it("groups a typed code the way it is printed", () => {
    expect(formatClaimCode("hz9ewv3dpk")).toBe("HZ9EW-V3DPK");
  });

  it("accepts a pasted code that already has its separator", () => {
    expect(formatClaimCode("HZ9EW-V3DPK")).toBe("HZ9EW-V3DPK");
  });

  it("drops characters the alphabet does not contain", () => {
    expect(formatClaimCode(" hz9ew v3dpk ")).toBe("HZ9EW-V3DPK");
  });

  it("stops accepting input past the code length", () => {
    expect(formatClaimCode("HZ9EWV3DPKEXTRA")).toBe("HZ9EW-V3DPK");
  });
});

describe("formatInviteCode", () => {
  const code = "HZ9EW-V3DPK-4MNQB-7RTXS";

  it("groups a typed code the way it is printed", () => {
    expect(formatInviteCode("hz9ewv3dpk4mnqb7rtxs")).toBe(code);
  });

  it("keeps all twenty characters", () => {
    // The bug this exists for: an invitation formatted with the claim code's
    // ten-character limit is accepted by the field and rejected by the Hub, so
    // the person who was invited is told their code is wrong.
    expect(formatInviteCode(code)).toHaveLength(23);
    expect(formatInviteCode(code).replace(/-/g, "")).toHaveLength(20);
  });

  it("stops accepting input past the code length", () => {
    expect(formatInviteCode(code + "ZZZZZ")).toBe(code);
  });
});

describe("inviteFromQuery", () => {
  it("reads the invitation out of a link", () => {
    expect(inviteFromQuery("?invite=hz9ewv3dpk4mnqb7rtxs")).toBe("HZ9EW-V3DPK-4MNQB-7RTXS");
  });

  it("reads it when it is not the only parameter", () => {
    expect(inviteFromQuery("?room=r1&invite=HZ9EW-V3DPK-4MNQB-7RTXS&key=k")).toBe(
      "HZ9EW-V3DPK-4MNQB-7RTXS",
    );
  });

  it("reports no invitation on an ordinary visit", () => {
    // Every other way into the console arrives with no invite parameter, and
    // the gate must not read an empty one as somebody who was invited.
    expect(inviteFromQuery("")).toBe("");
    expect(inviteFromQuery("?token=abc&pairing=1")).toBe("");
    expect(inviteFromQuery("?invite=")).toBe("");
  });
});

describe("prefilledCode", () => {
  const invite = "?invite=HZ9EW-V3DPK-4MNQB-7RTXS";

  it("opens the join screen with the invitation already in it", () => {
    expect(prefilledCode("join", invite)).toBe("HZ9EW-V3DPK-4MNQB-7RTXS");
  });

  it("does not put an invitation in the claim screen's field", () => {
    // The claim field holds ten characters, and its formatter runs on the next
    // keystroke rather than on this value -- so a prefilled invitation would sit
    // in it looking accepted until the claim failed.
    expect(prefilledCode("claim", invite)).toBe("");
  });

  it("leaves the sign-in screen empty", () => {
    expect(prefilledCode("login", invite)).toBe("");
  });

  it("leaves the join screen empty when the visit carried no invitation", () => {
    expect(prefilledCode("join", "")).toBe("");
  });
});

describe("CODE_FIELDS", () => {
  /** Resolve an i18n key path against the English catalog. */
  function text(path: string): string {
    return path
      .split(".")
      .reduce<unknown>((cur, part) => (cur as Record<string, unknown>)[part], en) as string;
  }

  // The formatters are each correct in isolation, so this can only be checked as
  // a pairing. What it catches is the two rows being swapped: an invitation cut
  // to ten characters, which the field accepts and the Hub never will.
  //
  // The expected length comes from the placeholder the person actually reads,
  // not from a number written here, so a placeholder that promises four groups
  // over a formatter that keeps two is a failure rather than a coincidence.
  it("formats each mode's code at the length its own placeholder shows", () => {
    for (const mode of ["claim", "join"] as const) {
      const field = CODE_FIELDS[mode];
      // The placeholder is the shape: "XXXXX-XXXXX" for a claim code, four
      // groups for an invitation. Filling it in is what the formatter must do.
      const shape = text(field.placeholder);
      const formatted = field.format("A".repeat(shape.replace(/-/g, "").length + 3));
      expect({ mode, formatted }).toEqual({ mode, formatted: shape.replace(/X/g, "A") });
    }
  });

  it("gives the two modes different lengths", () => {
    // If a claim code and an invitation were the same length, the test above
    // would pass on a swapped table too.
    const claim = text(CODE_FIELDS.claim.placeholder);
    const join = text(CODE_FIELDS.join.placeholder);
    expect(claim).not.toBe(join);
    expect(CODE_FIELDS.claim.format("A".repeat(20))).toBe("AAAAA-AAAAA");
    expect(CODE_FIELDS.join.format("A".repeat(20))).toBe("AAAAA-AAAAA-AAAAA-AAAAA");
  });

  it("names a distinct label and placeholder per mode", () => {
    expect(CODE_FIELDS.claim.label).not.toBe(CODE_FIELDS.join.label);
    expect(CODE_FIELDS.claim.placeholder).not.toBe(CODE_FIELDS.join.placeholder);
  });
});
