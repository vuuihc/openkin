import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react-native";
import { Children, type ReactElement, type ReactNode } from "react";
import { AccessibilityInfo, FlatList, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { Turn } from "../../../ui/src/components/chat/transcriptProjection";
import { t } from "../i18n";
import { GLASS_FALLBACK_COLOR } from "../native/glass";
import {
  HEADER_ROW_HEIGHT,
  headerTopInset,
  headerTotalHeight,
} from "../native/insets";
import type { ProvidersView } from "../providers/providersModel";
import type { ThreadState } from "../thread/threadModel";
import ConversationView from "./ConversationView";

/**
 * KIN-MOBILE-001 R7 — the conversation's top bar as real chrome.
 *
 * The signed row (`KIN-MOBILE-001.md:143`) sends the 玻璃头部/导航条 through a
 * native surface and the 证据 row asks every R7 PR to carry this suite's
 * output. The bar is a frosted layer the transcript scrolls under, the first
 * turn still opens below it, and a reader who asked iOS for reduced
 * transparency (or any Android device) keeps today's opaque bar.
 *
 * The platform read is mocked the way `ProviderUsageSheet.glass.test.tsx`
 * mocks it: the view is rendered directly, so the assertions are about the
 * drawn surface and the list's content, not about iOS.
 */

const TASK_ID = "task-glass";

const EMPTY_USAGE: ProvidersView = {
  status: "empty",
  days: 30,
  providers: [],
  usage: [],
};

type ViewProps = Partial<Parameters<typeof ConversationView>[0]>;
type View = Awaited<ReturnType<typeof render>>;

function state(
  turns: Turn[],
  overrides: Partial<ThreadState> = {},
): ThreadState {
  return {
    taskId: TASK_ID,
    title: "Glass header",
    status: "ready",
    turns,
    running: false,
    sendQueue: [],
    banner: null,
    reason: null,
    ...overrides,
  };
}

function userTurn(text: string): Turn {
  return {
    kind: "user",
    item: { kind: "message", key: `user-${text}`, speaker: "you", text },
  };
}

/**
 * The platform's reduced-transparency preference. `AccessibilityInfo` is a
 * real module object, so its members are spied on rather than replacing the
 * whole of `react-native`: this suite renders the conversation.
 */
const isReduceTransparencyEnabled = jest.spyOn(
  AccessibilityInfo,
  "isReduceTransparencyEnabled",
);
const addEventListener = jest.spyOn(AccessibilityInfo, "addEventListener");

beforeEach(() => {
  // The platform default is an unobstructed surface; the reduced-transparency
  // case overrides it.
  isReduceTransparencyEnabled.mockResolvedValue(false);
  addEventListener.mockImplementation(() => ({ remove: jest.fn() }) as never);
});

afterEach(() => {
  jest.clearAllMocks();
});

function element(turns: Turn[], extra: ViewProps = {}) {
  return (
    <ConversationView
      onBack={jest.fn()}
      state={state(turns)}
      t={t}
      {...extra}
    />
  );
}

async function renderView(
  turns: Turn[] = [],
  extra: ViewProps = {},
): Promise<View> {
  return render(element(turns, extra));
}

/** The conversation under a provider carrying a notched iPhone's top inset. */
async function renderWithInsets(top: number, turns: Turn[] = []): Promise<View> {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top, left: 0, right: 0, bottom: 0 },
      }}
    >
      {element(turns)}
    </SafeAreaProvider>,
  );
}

/** The list's declared header element, which holds the spacer and notices. */
type ListHeaderElement = ReactElement<{ children?: ReactNode }>;

type FiberNode = {
  elementType?: unknown;
  memoizedProps?: Record<string, unknown>;
  return?: FiberNode | null;
};

/**
 * The FlatList's `ListHeaderComponent`, read from the fiber above the rendered
 * spacer: this renderer exposes no `findByType`, and the declared element is
 * what says which content comes first, before any notice or turn.
 */
function listHeaderOf(view: View): ListHeaderElement {
  const spacer = view.getByTestId("conversation:header-spacer", {
    includeHiddenElements: true,
  });
  let node = spacer.unstable_fiber as FiberNode | null;
  while (node && node.elementType !== FlatList) node = node.return ?? null;

  expect(node).not.toBeNull();
  const header = node?.memoizedProps?.ListHeaderComponent;
  expect(header).toBeDefined();
  return header as ListHeaderElement;
}

describe("KIN-MOBILE-001 R7 the conversation's glass header", () => {
  it("KIN-MOBILE-001 R7: the conversation header draws glass behind its row", async () => {
    const view = await renderView([userTurn("hello")]);
    const header = view.getByTestId("conversation:header");

    // The blur is the bar's background: it fills the header, so the transcript
    // passing beneath is what tints the chrome.
    expect(within(header).getByTestId("glass-blur")).toBeTruthy();
    expect(within(header).queryByTestId("glass-opaque")).toBeNull();

    // A header that paints its own background sits on top of the blur and
    // hides it, which is the flat strip this row replaces.
    const headerStyle = StyleSheet.flatten(header.props.style) as {
      backgroundColor?: string;
    };
    expect(headerStyle.backgroundColor).toBe("transparent");
  });

  it("KIN-MOBILE-001 R7: reduce transparency swaps the header's blur for an opaque bar", async () => {
    isReduceTransparencyEnabled.mockResolvedValue(true);
    const view = await renderView([userTurn("hello")]);
    const header = view.getByTestId("conversation:header");

    // The asynchronous platform answer lands after the first paint.
    await waitFor(() =>
      expect(within(header).getByTestId("glass-opaque")).toBeTruthy(),
    );
    expect(within(header).queryByTestId("glass-blur")).toBeNull();

    // The bar reaches today's surface through the opaque branch, so a reader
    // who asked for reduced transparency keeps the contrast they have now.
    const headerStyle = StyleSheet.flatten(header.props.style) as {
      backgroundColor?: string;
    };
    expect(headerStyle.backgroundColor).toBe(GLASS_FALLBACK_COLOR);
  });

  it("KIN-MOBILE-001 R7: the transcript's first line rests below the header, never under it", async () => {
    const view = await renderWithInsets(59, [userTurn("hello")]);

    // The spacer is the list header's first content: whatever the read's
    // notices do, the transcript starts with the bar's full height reserved.
    const first = Children.toArray(listHeaderOf(view).props.children)[0] as
      | ReactElement<{ testID?: string }>
      | undefined;
    expect(first?.props.testID).toBe("conversation:header-spacer");

    const spacer = view.getByTestId("conversation:header-spacer", {
    includeHiddenElements: true,
  });
    const spacerStyle = StyleSheet.flatten(spacer.props.style) as {
      height?: number;
    };
    expect(spacerStyle.height).toBe(headerTotalHeight(59));
    expect(headerTotalHeight(59)).toBe(HEADER_ROW_HEIGHT + headerTopInset(59));

    // Decoration, not a reader stop: the back control stays the first thing
    // VoiceOver says on this screen.
    expect(spacer.props.accessibilityElementsHidden).toBe(true);
    expect(spacer.props.importantForAccessibility).toBe(
      "no-hide-descendants",
    );
  });

  it("KIN-MOBILE-001 R7: the header stays chrome above the transcript while the composer keeps the bottom", async () => {
    const onUsageClose = jest.fn();
    const view = await renderView([userTurn("hello")], {
      onSend: jest.fn(),
      usage: {
        state: EMPTY_USAGE,
        onSelectWindow: jest.fn(),
        onClose: onUsageClose,
      },
    });

    // The bar is lifted out of the flow so the transcript scrolls under it,
    // and it draws the same hairline the composer uses.
    const headerStyle = StyleSheet.flatten(
      view.getByTestId("conversation:header").props.style,
    ) as {
      borderBottomWidth?: number;
      position?: string;
      top?: number;
      zIndex?: number;
    };
    expect(headerStyle.position).toBe("absolute");
    expect(headerStyle.top).toBe(0);
    expect(headerStyle.zIndex).toBeGreaterThan(0);
    expect(headerStyle.borderBottomWidth).toBe(StyleSheet.hairlineWidth);

    // The transcript still renders its turns...
    expect(view.getByText("hello")).toBeTruthy();
    // ...and the composer is still the surface's bottom sibling.
    expect(view.getByTestId("conversation:composerBar")).toBeTruthy();
    expect(view.getByTestId("conversation:composer")).toBeTruthy();

    // The usage sheet is a native `Modal`, above the whole screen: the
    // header's stacking index cannot cover it, so its close control still
    // takes the press.
    await fireEvent.press(view.getByTestId("conversation:usage"));
    expect(view.getByTestId("usage-sheet", { includeHiddenElements: true })).toBeTruthy();
    const close = view.getByTestId("usage-close", { includeHiddenElements: true });
    await fireEvent.press(close);
    expect(onUsageClose).toHaveBeenCalledTimes(1);
  });

  it("KIN-MOBILE-001 R7: the header's back control is still the first stop and its title still speaks as the heading", async () => {
    const view = await renderView([], {
      usage: { state: EMPTY_USAGE, onSelectWindow: jest.fn() },
    });
    const header = view.getByTestId("conversation:header");

    // Same three cells, same order, same words: the glass layer precedes the
    // row but is decoration, so the back control remains the first stop.
    const cells = within(header)
      .getAllByTestId(/^conversation:(?:back|title|usage)$/)
      .map((cell) => cell.props.testID);
    expect(cells).toEqual([
      "conversation:back",
      "conversation:title",
      "conversation:usage",
    ]);

    expect(view.getByTestId("conversation:back").props.accessibilityLabel).toBe(
      t("app.back"),
    );
    expect(
      view.getByTestId("conversation:usage").props.accessibilityLabel,
    ).toBe(t("usage.openPhone"));

    const title = view.getByTestId("conversation:title");
    expect(title.props.accessibilityRole).toBe("header");
    expect(within(header).getByText("Glass header")).toBeTruthy();
  });
});
