import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import {
  createHubSignIn,
  normalizeHubOrigin,
  parseHubConnectLink,
} from "../auth/hub";
import {
  SESSION_KEY,
  readSession,
  type SecureBackend,
} from "../auth/tokenStore";
import { t } from "../i18n";

/**
 * KIN-MOBILE-002 R2 (D3) — a LAN http Hub asks once, explicitly.
 *
 * The signed acceptance file for the story's R2 row: a plaintext Hub address
 * off loopback shows one inline card naming the `kin_session` credential, and
 * only its 仍然继续 lets the first request leave. Rejecting sends nothing and
 * asks again; the confirmation belongs to the exact origin; https never asks.
 * The stored record keeps the confirmation so a relaunch stays signed in, and
 * a record without it is still refused.
 *
 * The screen talks to the real Hub core over a recording fetch, so "no request"
 * is counted at the network rather than argued from a mock's arguments.
 */

const PLAIN = "http://192.168.1.42:7777";
const EDITED = "http://192.168.1.42:7778";
const HTTPS = "https://h.example";
const EMAIL = "owner@example.com";

let mockParams: { hub?: string; reason?: string } = {};
const mockRouter = { replace: jest.fn(), push: jest.fn() };

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));

jest.mock("../auth/pairing", () => ({
  pairing: { pairWithLink: jest.fn(), clearRetired: jest.fn() },
}));

jest.mock("../auth/hubSignIn", () => {
  const actual =
    jest.requireActual<typeof import("../auth/hub")>("../auth/hub");
  const entries = new Map<string, string>();
  const store = {
    getItemAsync: async (key: string) => entries.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      entries.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      entries.delete(key);
    },
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = jest.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init });
    const body = {
      providers: [{ id: "password", label: "Password", kind: "password" }],
    };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  return {
    hubSignIn: actual.createHubSignIn({
      store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
    __entries: entries,
    __calls: calls,
  };
});

import PairScreen from "../../app/pair";

const harness = jest.requireMock("../auth/hubSignIn") as unknown as {
  __entries: Map<string, string>;
  __calls: Array<{ url: string; init?: RequestInit }>;
};

/** An in-memory Keychain, for the cases that exercise the real module. */
function memoryStore(): SecureBackend & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItemAsync: async (key) => entries.get(key) ?? null,
    setItemAsync: async (key, value) => {
      entries.set(key, value);
    },
    deleteItemAsync: async (key) => {
      entries.delete(key);
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function addressField(
  screen: Awaited<ReturnType<typeof render>>,
): ReturnType<typeof screen.getByLabelText> {
  return screen.getByLabelText(t("pairing.hubPlaceholder") as string);
}

async function pressContinue(
  screen: Awaited<ReturnType<typeof render>>,
): Promise<void> {
  await fireEvent.press(screen.getByText(t("pairing.hubContinue") as string));
}

beforeEach(() => {
  mockParams = {};
  jest.clearAllMocks();
  harness.__entries.clear();
  harness.__calls.length = 0;
});

afterEach(() => {
  jest.clearAllMocks();
});

describe("KIN-MOBILE-002 R2 plaintext Hub confirmation", () => {
  it("KIN-MOBILE-002 R2: an http Hub off loopback asks before any request, and rejecting sends none", async () => {
    const screen = await render(<PairScreen />);
    await fireEvent.changeText(addressField(screen), PLAIN);
    await pressContinue(screen);

    // The card is the first thing the address produces — no status probe, no
    // cookie leaving the phone.
    expect(screen.getByText(t("pairing.hubPlaintextTitle"))).toBeTruthy();
    expect(screen.getByText(t("pairing.hubPlaintextBody"))).toBeTruthy();
    expect(harness.__calls).toHaveLength(0);

    await fireEvent.press(
      screen.getByText(t("pairing.hubPlaintextCancel") as string),
    );
    expect(screen.queryByText(t("pairing.hubPlaintextTitle"))).toBeNull();
    expect(harness.__calls).toHaveLength(0);

    // Rejecting stores nothing: the next attempt asks again.
    await pressContinue(screen);
    expect(screen.getByText(t("pairing.hubPlaintextTitle"))).toBeTruthy();
    expect(harness.__calls).toHaveLength(0);
  });

  it("KIN-MOBILE-002 R2: confirming the plaintext origin lets the first request through with the opt-in", async () => {
    const screen = await render(<PairScreen />);
    await fireEvent.changeText(addressField(screen), PLAIN);
    await pressContinue(screen);
    expect(harness.__calls).toHaveLength(0);

    await fireEvent.press(
      screen.getByText(t("pairing.hubPlaintextConfirm") as string),
    );

    // The core refuses an http origin that did not opt in, so this request
    // existing at all is the opt-in reaching the normalizer.
    await waitFor(() => expect(harness.__calls).toHaveLength(1));
    expect(harness.__calls[0]!.url).toBe(`${PLAIN}/api/auth/status`);
    await waitFor(() =>
      expect(screen.getByText(t("pairing.hubPasswordHint"))).toBeTruthy(),
    );
  });

  it("KIN-MOBILE-002 R2: the confirmation is bound to the exact origin and editing the address clears it", async () => {
    const screen = await render(<PairScreen />);
    await fireEvent.changeText(addressField(screen), PLAIN);
    await pressContinue(screen);
    await fireEvent.press(
      screen.getByText(t("pairing.hubPlaintextConfirm") as string),
    );
    await waitFor(() => expect(harness.__calls).toHaveLength(1));

    await fireEvent.changeText(addressField(screen), EDITED);
    await pressContinue(screen);

    // The edited address has no confirmation of its own: the card returns and
    // nothing was requested for it.
    expect(screen.getByText(t("pairing.hubPlaintextTitle"))).toBeTruthy();
    expect(harness.__calls).toHaveLength(1);
    expect(harness.__calls.some((call) => call.url.includes(":7778"))).toBe(
      false,
    );
  });

  it("KIN-MOBILE-002 R2: an https Hub never asks", async () => {
    const screen = await render(<PairScreen />);
    await fireEvent.changeText(addressField(screen), HTTPS);
    await pressContinue(screen);

    await waitFor(() => expect(harness.__calls).toHaveLength(1));
    expect(harness.__calls[0]!.url).toBe(`${HTTPS}/api/auth/status`);
    expect(screen.queryByText(t("pairing.hubPlaintextTitle"))).toBeNull();
  });
});

describe("KIN-MOBILE-002 R2 stored plaintext session", () => {
  it("KIN-MOBILE-002 R2: a confirmed plaintext session is stored with the flag and survives a read", async () => {
    const store = memoryStore();
    const calls: string[] = [];
    const signIn = createHubSignIn({
      store,
      fetchImpl: (async (input: string) => {
        calls.push(input);
        return input.endsWith("/api/auth/me")
          ? jsonResponse(200, { user: { email: EMAIL } })
          : jsonResponse(200, {});
      }) as unknown as typeof fetch,
    });

    const result = await signIn.signInWithPassword(PLAIN, EMAIL, "not-a-real-password", {
      allowInsecure: true,
    });

    expect(result).toEqual({ ok: true, origin: PLAIN });
    expect(calls).toEqual([`${PLAIN}/api/auth/login`, `${PLAIN}/api/auth/me`]);
    expect(JSON.parse(store.entries.get(SESSION_KEY) ?? "")).toEqual({
      kind: "hub",
      origin: PLAIN,
      insecure: true,
    });
    // A launch must not silently sign the phone out: the read keeps the flag.
    await expect(readSession(store)).resolves.toEqual({
      kind: "hub",
      origin: PLAIN,
      insecure: true,
    });
  });

  it("KIN-MOBILE-002 R2: a plaintext record without the flag is refused (fail closed)", async () => {
    const store = memoryStore();
    store.entries.set(SESSION_KEY, JSON.stringify({ kind: "hub", origin: PLAIN }));
    const calls: string[] = [];
    createHubSignIn({
      store,
      fetchImpl: (async (input: string) => {
        calls.push(input);
        return jsonResponse(200, {});
      }) as unknown as typeof fetch,
    });

    await expect(readSession(store)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("KIN-MOBILE-002 R2 normalizer allowance", () => {
  it("KIN-MOBILE-002 R2: the normalizer stays default-deny; the opt-in is the only allowance", () => {
    expect(normalizeHubOrigin(PLAIN)).toBeNull();
    expect(normalizeHubOrigin(PLAIN, { allowInsecure: false })).toBeNull();
    expect(normalizeHubOrigin(PLAIN, { allowInsecure: true })).toBe(PLAIN);

    // https and loopback http need no opt-in, and the opt-in changes neither.
    expect(normalizeHubOrigin(HTTPS)).toBe(HTTPS);
    expect(normalizeHubOrigin(HTTPS, { allowInsecure: true })).toBe(HTTPS);
    expect(normalizeHubOrigin("http://127.0.0.1:7777")).toBe(
      "http://127.0.0.1:7777",
    );
    expect(normalizeHubOrigin("http://127.0.0.1:7777", { allowInsecure: true })).toBe(
      "http://127.0.0.1:7777",
    );

    // A link only pre-fills the screen: it can never carry the opt-in.
    expect(parseHubConnectLink(`kin://connect?hub=${PLAIN}`)).toBeNull();
  });
});
