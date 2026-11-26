import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";

/**
 * R-rn-hub-signin — a `kin://connect?hub=…` link lands on the pair screen with
 * the Hub address already in the field. It is the console's G8 link; the
 * person still taps Continue, exactly as for a typed address.
 */

const mockRouter = { replace: jest.fn(), push: jest.fn() };

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ hub: "https://h.example" }),
}));

jest.mock("../src/auth/hubSignIn", () => ({
  hubSignIn: {
    probe: jest.fn(),
    signInWithPassword: jest.fn(),
    startProvider: jest.fn(),
    completeCallback: jest.fn(),
    cancel: jest.fn(),
  },
}));

jest.mock("../src/auth/pairing", () => ({
  pairing: { pairWithLink: jest.fn() },
}));

import PairScreen from "./pair";

describe("R-rn-hub-signin connect link", () => {
  it("R-rn-hub-signin: kin://connect?hub= pre-fills the pair screen", () => {
    const screen = render(<PairScreen />);

    expect(screen.getByDisplayValue("https://h.example")).toBeTruthy();
  });
});
