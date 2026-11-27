import { createElement } from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet, useColorScheme, type StyleProp, type ViewStyle } from "react-native";
import type { Task } from "../../../ui/src/api/contract";
import type { Machine } from "../../../ui/src/lib/devices";
import type { Turn } from "../../../ui/src/components/chat/transcriptProjection";
import type { Session } from "../auth/tokenStore";
import { t } from "../i18n";
import { createListMemory } from "../list/listModel";
import { createReadingMemory } from "../thread/readingMemory";
import { palette, scrim, wash, type Palette } from "./tokens";
import ListScreen from "../screens/ListScreen";
import ConversationView from "../screens/ConversationView";
import PairScreen from "../../app/pair";

/**
 * KIN-MOBILE-002 R1b — the two schemes, painted by real screens.
 *
 * The palette itself is pinned by `tokens.parity.test.ts` against the desktop
 * theme; this suite is about the screens actually using it. A renderer answer
 * of "dark" must put the dark palette on the list's title, separator and row,
 * and on the conversation's answer and composer line — the bug R1b fixes was
 * every screen painting the light literals while iOS was in dark mode.
 *
 * `useColorScheme` is mocked at the platform module the hook imports, exactly
 * as `useTheme.test.ts` does, so the renderer and the hook cannot disagree.
 */

jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({
  __esModule: true,
  default: jest.fn(),
}));

// The pair route reads its own navigation and auth seams; the render below is
// about the ink and placeholder colours it paints, not either seam.
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ hub: "https://kin.example.com" }),
}));

jest.mock("../auth/hubSignIn", () => ({
  hubSignIn: {
    probe: jest.fn(async () => ({
      ok: true,
      origin: "https://kin.example.com",
      status: {
        origin: "https://kin.example.com",
        needsBootstrap: false,
        claimable: false,
        authenticated: false,
        providers: [{ id: "password", label: "Password", kind: "password" }],
      },
    })),
    signInWithPassword: jest.fn(),
    startProvider: jest.fn(),
    completeCallback: jest.fn(),
    cancel: jest.fn(),
  },
}));

jest.mock("../auth/pairing", () => ({
  pairing: { pairWithLink: jest.fn(), clearRetired: jest.fn() },
}));

const systemScheme = jest.mocked(useColorScheme) as jest.MockedFunction<
  () => ReturnType<typeof useColorScheme> | undefined
>;

type RGB = [number, number, number];

/** A palette value as three channels: the two spellings tokens.ts writes. */
function channels(value: string): RGB {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`${value} is not a colour this check can measure`);
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: RGB): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast, 1–21. */
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** An `rgba(...)` tint composited over an opaque palette surface. */
function over(tint: string, base: string): RGB {
  const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(tint);
  if (!rgba) throw new Error(`${tint} is not a tint this check can compose`);
  const alpha = Number(rgba[4]);
  const under = channels(base);
  return [0, 1, 2].map(
    (i) => Number(rgba[i + 1]) * alpha + under[i]! * (1 - alpha),
  ) as RGB;
}

// ---- The list route's harness (copied from `ListScreen.test.tsx`) ----------

const ORIGIN = "https://kin.example.com";
const TOKEN = "test-token";

const MACHINES: Machine[] = [
  { id: "dev-a", label: "Laptop", isSelf: true, online: true, roots: [], agents: [] },
];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "First conversation",
    agent: "kin",
    cwd: "/work/alpha",
    prompt: "hello",
    model: "model-x",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1000,
    started_at: 1000,
    finished_at: 1000,
    executing_device_id: "dev-a",
    event_epoch: 0,
    ...overrides,
  };
}

function ok(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function routedFetch(route: (url: string) => { body: unknown }): typeof fetch {
  return jest.fn(async (input: string) => {
    const reply = route(input);
    return ok(reply.body);
  }) as unknown as typeof fetch;
}

function storedSession(): Promise<Session | null> {
  return Promise.resolve({ kind: "node", origin: ORIGIN, token: TOKEN });
}

async function renderList() {
  return render(
    createElement(ListScreen, {
      fetchImpl: routedFetch(() => ({ body: [task()] })),
      formatTime: (at: number) => `t${at}`,
      machines: MACHINES,
      memory: createListMemory(),
      onNeedsPairing: jest.fn(),
      onOpen: jest.fn(),
      readSessionImpl: storedSession,
      selfDeviceId: "dev-a",
    }),
  );
}

// ---- The conversation harness (copied from the reading suite) -------------

function userTurn(text: string): Turn {
  return {
    kind: "user",
    item: { kind: "message", key: `user-${text}`, speaker: "you", text },
  };
}

function agentTurn(text: string): Turn {
  return {
    kind: "agent",
    speaker: "kin",
    items: [{ kind: "message", key: `agent-${text}`, speaker: "kin", text }],
  };
}

async function renderConversation() {
  return render(
    createElement(ConversationView, {
      onBack: jest.fn(),
      onSend: async () => ({ ok: true, queued: false }),
      readingMemory: createReadingMemory(),
      state: {
        taskId: "task-reading",
        title: "Morning planning",
        status: "ready",
        turns: [userTurn("what changed?"), agentTurn("the suite is green")],
        running: false,
        sendQueue: [],
        banner: null,
        reason: null,
      },
      t,
    }),
  );
}

/** The flattened style a host node paints with. */
function styleOf(node: { props: { style?: unknown } }): Record<string, unknown> {
  const flat = StyleSheet.flatten(node.props.style as StyleProp<ViewStyle>);
  return (flat ?? {}) as Record<string, unknown>;
}

describe("KIN-MOBILE-002 R1b screens", () => {
  beforeEach(() => {
    systemScheme.mockReset();
  });

  it("KIN-MOBILE-002 R1b: the list paints dark from the palette", async () => {
    systemScheme.mockReturnValue("dark");
    const view = await renderList();

    const row = await view.findByTestId("row:task-1");
    const title = view.getByText("First conversation");
    expect(styleOf(title).color).toBe(palette.dark.text);
    expect(styleOf(row).borderBottomColor).toBe(palette.dark.hairlineStrong);
    expect(styleOf(row).backgroundColor).toBe(palette.dark.bg);
  });

  it("KIN-MOBILE-002 R1b: the list paints light from the palette", async () => {
    systemScheme.mockReturnValue("light");
    const view = await renderList();

    const row = await view.findByTestId("row:task-1");
    const title = view.getByText("First conversation");
    expect(styleOf(title).color).toBe(palette.light.text);
    expect(styleOf(row).borderBottomColor).toBe(palette.light.hairlineStrong);
    expect(styleOf(row).backgroundColor).toBe(palette.light.bg);
  });

  it("KIN-MOBILE-002 R1b: the conversation paints dark from the palette", async () => {
    systemScheme.mockReturnValue("dark");
    const view = await renderConversation();

    expect(styleOf(view.getByText("the suite is green")).color).toBe(
      palette.dark.text,
    );
    expect(styleOf(view.getByTestId("conversation:composerBar")).borderColor).toBe(
      palette.dark.hairlineStrong,
    );
  });

  it("KIN-MOBILE-002 R1b: the conversation paints light from the palette", async () => {
    systemScheme.mockReturnValue("light");
    const view = await renderConversation();

    expect(styleOf(view.getByText("the suite is green")).color).toBe(
      palette.light.text,
    );
    expect(styleOf(view.getByTestId("conversation:composerBar")).borderColor).toBe(
      palette.light.hairlineStrong,
    );
  });

  it("KIN-MOBILE-002 R1b: the pair screen paints its text and placeholders from the palette", async () => {
    systemScheme.mockReturnValue("dark");
    const view = await render(createElement(PairScreen));

    // The heading is plain text on the screen's own surface.
    expect(styleOf(view.getByText(t("pairing.hubTitle"))).color).toBe(
      palette.dark.text,
    );

    // The Hub address field: typed text and its placeholder.
    const hub = view.getByLabelText(t("pairing.hubPlaceholder"));
    expect(styleOf(hub).color).toBe(palette.dark.text);
    expect(hub.props.placeholderTextColor).toBe(palette.dark.muted);

    // Probe the listed password Hub so the email and password fields exist.
    await fireEvent.press(view.getByText(t("pairing.hubContinue")));
    const email = await view.findByLabelText(t("account.emailLabel"));
    const password = view.getByLabelText(t("account.passwordLabel"));
    expect(email.props.placeholderTextColor).toBe(palette.dark.muted);
    expect(password.props.placeholderTextColor).toBe(palette.dark.muted);
    expect(styleOf(view.getByText("https://kin.example.com")).color).toBe(
      palette.dark.text,
    );

    // The node section's heading and address field take the same ink.
    await fireEvent.press(view.getByText(t("pairing.hubNodeInstead")));
    expect(styleOf(view.getByText(t("pairing.hubNodeTitle"))).color).toBe(
      palette.dark.text,
    );
    const node = view.getByLabelText(t("pairing.hint"));
    expect(styleOf(node).color).toBe(palette.dark.text);
    expect(node.props.placeholderTextColor).toBe(palette.dark.muted);
  });

  it("KIN-MOBILE-002 R1b: every sampled ink clears 4.5:1 on the surface it is drawn on", () => {
    for (const scheme of ["dark", "light"] as const) {
      const colors: Palette = palette[scheme];
      const pairs: { name: string; fg: string; bg: RGB }[] = [
        { name: "text/bg", fg: colors.text, bg: channels(colors.bg) },
        { name: "secondary/bg", fg: colors.secondary, bg: channels(colors.bg) },
        { name: "muted/bg", fg: colors.muted, bg: channels(colors.bg) },
        {
          name: "orangeInk over a 15% orange tint",
          fg: colors.orangeInk,
          bg: over(wash(colors.orange, 0.15), colors.bg),
        },
        {
          name: "onStatus on the red pill",
          fg: colors.onStatus,
          bg: channels(colors.red),
        },
      ];
      for (const pair of pairs) {
        const ratio = contrast(channels(pair.fg), pair.bg);
        expect({
          scheme,
          pair: pair.name,
          passes: ratio >= 4.5,
        }).toEqual({ scheme, pair: pair.name, passes: true });
      }
    }
  });

  it("KIN-MOBILE-002 R1b: wash() spells a 15% tint and refuses a value it cannot parse", () => {
    expect(wash("#0b57d0", 0.15)).toBe("rgba(11, 87, 208, 0.15)");
    expect(wash("rgb(10, 132, 255)", 0.12)).toBe("rgba(10, 132, 255, 0.12)");
    // A caller must never silently paint a fallback.
    expect(() => wash("transparent", 0.15)).toThrow();
    expect(() => wash("#fff", 0.15)).toThrow();
    // The scrim is one value in both schemes: it darkens whatever is behind.
    for (const _scheme of ["light", "dark"] as const) {
      expect(scrim).toBe("rgba(0, 0, 0, 0.35)");
    }
  });
});
