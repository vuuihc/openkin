import { describe, expect, it } from "vitest";
import { authErrorText, formatClaimCode, gateFor } from "./accountGate";
import { NO_ACCOUNT, type AccountState } from "../store/appStore";

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
