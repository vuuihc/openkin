import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";

/**
 * KIN-MOBILE-001 R5 — the list route's focus epoch.
 *
 * The screen's own re-read is pinned in `src/screens/ListScreen.test.tsx`. This
 * suite is about the route: the one place that knows about navigation must
 * turn "the list is focused again" into a changed `focusEpoch`, or the screen
 * has nothing to react to. `expo-router` is mocked to capture the focus
 * callback, and the screen is a probe that renders the epoch it was handed.
 */

const mockFocusCallbacks: Array<() => void> = [];
// One router for the whole suite: the route's effect depends on `router`, and
// a fresh object per render would re-run the boot read forever.
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  setParams: jest.fn(),
};

/** The epoch the route passed, as text; a missing prop reads `none`. */
function mockProbe({ focusEpoch }: { focusEpoch?: number }) {
  return <Text testID="epoch">{String(focusEpoch ?? "none")}</Text>;
}

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useFocusEffect: (callback: () => void) => {
    mockFocusCallbacks.push(callback);
  },
  // The route reads the split selection from the URL even when this suite only
  // cares about focus; no selection means the stack at any width.
  useLocalSearchParams: () => ({}),
}));

jest.mock("../src/auth/pairing", () => ({
  pairing: {
    startRoute: jest.fn(async () => ({
      route: "list",
      reason: "none",
      origin: "https://kin.example.com",
      tasks: [],
      display: null,
    })),
  },
}));

jest.mock("../src/screens/ListScreen", () => ({
  __esModule: true,
  default: mockProbe,
}));

import ListRoute from "./list";

describe("KIN-MOBILE-001 R5 list route focus", () => {
  beforeEach(() => {
    mockFocusCallbacks.length = 0;
  });

  it("KIN-MOBILE-001 R5: the list route bumps the focus epoch when the screen regains focus", async () => {
    const screen = await render(<ListRoute />);
    await waitFor(() => expect(screen.getByTestId("epoch")).toBeTruthy());
    expect(screen.getByTestId("epoch").props.children).toBe("0");
    expect(mockFocusCallbacks.length).toBeGreaterThan(0);

    // Back from the pushed conversation: the router runs the captured focus
    // callback again, and the epoch the screen receives must advance.
    const focus = mockFocusCallbacks[0]!;
    await act(async () => {
      focus();
    });

    await waitFor(() =>
      expect(screen.getByTestId("epoch").props.children).toBe("1"),
    );
  });
});
