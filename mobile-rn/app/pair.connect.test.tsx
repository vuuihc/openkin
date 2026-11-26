import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { pairing } from "../src/auth/pairing";
import { t } from "../src/i18n";

/**
 * R-rn-hub-signin — a `kin://connect?hub=…` link lands on the pair screen with
 * the Hub address already in the field. It is the console's G8 link; the
 * person still taps Continue, exactly as for a typed address.
 *
 * The same screen carries the Hub sign-in, so the cases below also pin what a
 * refusal says, what a boot expiry shows, and that a signed-in Hub clears an
 * earlier node retirement before the list route reads it.
 */

const HUB = "https://h.example";

let mockParams: { hub?: string; reason?: string } = { hub: HUB };
let mockProbeResult: unknown = null;
let mockSignInResult: unknown = null;

const mockRouter = { replace: jest.fn(), push: jest.fn() };

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));

jest.mock("../src/auth/hubSignIn", () => ({
  hubSignIn: {
    probe: jest.fn(async () => mockProbeResult),
    signInWithPassword: jest.fn(async () => mockSignInResult),
    startProvider: jest.fn(),
    completeCallback: jest.fn(),
    cancel: jest.fn(),
  },
}));

jest.mock("../src/auth/pairing", () => ({
  pairing: { pairWithLink: jest.fn(), clearRetired: jest.fn() },
}));

import PairScreen from "./pair";

const STATUS = {
  origin: HUB,
  needsBootstrap: false,
  claimable: false,
  authenticated: false,
  providers: [{ id: "password", label: "Password", kind: "password" }],
};

/** Fill the listed password form and press Sign in. */
async function signIn(
  screen: Awaited<ReturnType<typeof render>>,
): Promise<void> {
  await fireEvent.press(screen.getByText(t("pairing.hubContinue")));
  await fireEvent.changeText(
    screen.getByLabelText(t("account.emailLabel")),
    "owner@example.com",
  );
  await fireEvent.changeText(
    screen.getByLabelText(t("account.passwordLabel")),
    "not-a-real-password",
  );
  await fireEvent.press(screen.getByText(t("pairing.hubSignIn")));
}

beforeEach(() => {
  mockParams = { hub: HUB };
  mockProbeResult = { ok: true, origin: HUB, status: STATUS };
  mockSignInResult = null;
  jest.clearAllMocks();
});

describe("R-rn-hub-signin connect link", () => {
  it("R-rn-hub-signin: kin://connect?hub= pre-fills the pair screen", async () => {
    const screen = await render(<PairScreen />);

    expect(screen.getByDisplayValue(HUB)).toBeTruthy();
  });
});

describe("R-rn-hub-signin pair screen", () => {
  it("R-rn-hub-signin: a signed-in Hub clears an earlier retirement before landing on the list", async () => {
    mockSignInResult = { ok: true, origin: HUB };

    const screen = await render(<PairScreen />);
    await signIn(screen);

    const clearRetired = pairing.clearRetired as jest.Mock;
    expect(clearRetired).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/list");
    expect(clearRetired.mock.invocationCallOrder[0]).toBeLessThan(
      (mockRouter.replace as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it("R-rn-hub-signin: a refused sign-in names the Hub, not the pairing link", async () => {
    mockSignInResult = { ok: false, reason: "rejected", origin: HUB };

    const screen = await render(<PairScreen />);
    await signIn(screen);

    expect(screen.getByText(t("pairing.hubRejected"))).toBeTruthy();
    expect(screen.queryByText(t("pairing.rejected"))).toBeNull();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("R-rn-hub-signin: the server's refusal code becomes its own sentence", async () => {
    mockSignInResult = {
      ok: false,
      reason: "rejected",
      origin: HUB,
      errorCode: "invalid_credentials",
    };

    const screen = await render(<PairScreen />);
    await signIn(screen);

    expect(
      screen.getByText(t("account.errors.invalid_credentials")),
    ).toBeTruthy();
    expect(screen.queryByText(t("pairing.hubRejected"))).toBeNull();
  });

  it("R-rn-hub-signin: /pair?reason=expired shows the expiry without opening the node section", async () => {
    mockParams = { reason: "expired" };

    const screen = await render(<PairScreen />);

    // `showNode` is still collapsed; the sentence is the Hub area's.
    expect(screen.getByText(t("pairing.expired"))).toBeTruthy();
    expect(screen.queryByText(t("pairing.hubNodeTitle"))).toBeNull();
  });
});
