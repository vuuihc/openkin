import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, within } from "@testing-library/react-native";
import {
  StyleSheet,
  useColorScheme,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { Approval } from "@ui/api/contract";
import type { ApprovalEntry, ApprovalsState } from "../approvals/approvalsModel";
import { palette, radius } from "../theme/tokens";
import Approvals from "./Approvals";

/**
 * KIN-MOBILE-002 R5 — the approval card's signed visual.
 *
 * The frame (`KIN-MOBILE-002.figma/frames/04-phone-composer-approval.svg`) and
 * the story's acceptance row (`KIN-MOBILE-002.md:130`) ask for one obvious
 * primary: 批准 is the single filled blue control, 拒绝 its outlined
 * counterpart, the command still readable in mono, and the card on the
 * elevated surface. This suite pins that at element/style level in both
 * schemes; KIN-MOBILE-001 R5b's behaviour (reads, transitions, focus,
 * the four non-ready states) is proven in `Approvals.test.tsx`.
 *
 * `useColorScheme` is mocked at the platform module `useTheme()` imports, the
 * same seam `theme.test.ts` and the R6 suite use, so the two schemes are real
 * renders rather than a second palette guess.
 */

jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const systemScheme = jest.mocked(useColorScheme) as jest.MockedFunction<
  () => ReturnType<typeof useColorScheme> | undefined
>;

const t = (key: string): string => key;

const COMMAND = "ls -la";

function approval(id: string, createdAt = 1): Approval {
  return {
    id,
    task_id: "task-1",
    kind: "tool_use",
    payload: { tool_name: "Bash", input: { command: COMMAND } },
    decision: "pending",
    created_at: createdAt,
  };
}

function approvalEntry(
  id: string,
  overrides: Partial<ApprovalEntry> = {},
): ApprovalEntry {
  const record = approval(id);
  return {
    key: `approval:${id}`,
    kind: "approval",
    id,
    createdAt: record.created_at,
    approval: record,
    phase: "idle",
    pending: true,
    ...overrides,
  };
}

function state(overrides: Partial<ApprovalsState> = {}): ApprovalsState {
  return {
    status: "ready",
    items: [approvalEntry("a1")],
    pendingCount: 1,
    online: true,
    revision: 1,
    ...overrides,
  };
}

type Screen = Awaited<ReturnType<typeof render>>;

/** The rendered style of one testID, flattened the way RN resolves it. */
function style(screen: Screen, id: string): ViewStyle {
  return StyleSheet.flatten(
    screen.getByTestId(id).props.style,
  ) as ViewStyle;
}

/** The flattened style of the label inside one control. */
function labelStyle(screen: Screen, id: string, text: string): TextStyle {
  const control = within(screen.getByTestId(id));
  return StyleSheet.flatten(control.getByText(text).props.style) as TextStyle;
}

/**
 * Every control the reader can press inside one card, as flattened styles.
 * Enumerating by role (rather than by the two known testIDs) is what makes
 * "approve is the only filled button" a real statement: a third control that
 * gained a fill would fail it too.
 */
function cardButtons(
  screen: Screen,
  cardID: string,
): { id: string; style: ViewStyle }[] {
  const found: { id: string; style: ViewStyle }[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const element = node as {
      props?: {
        accessibilityRole?: string;
        style?: StyleProp<ViewStyle>;
        testID?: string;
      };
      children?: unknown[];
    };
    const props = element.props ?? {};
    if (props.accessibilityRole === "button") {
      found.push({
        id: props.testID ?? "",
        style: (StyleSheet.flatten(props.style) ?? {}) as ViewStyle,
      });
    }
    const children = Array.isArray(element.children) ? element.children : [];
    for (const child of children) walk(child);
  };
  walk(screen.getByTestId(cardID));
  return found;
}

function renderScreen(overrides: Partial<ApprovalsState> = {}): Promise<Screen> {
  return render(
    <Approvals
      onAnswer={() => {}}
      onApprove={() => {}}
      onDeny={() => {}}
      state={state(overrides)}
      t={t}
    />,
  );
}

beforeEach(() => {
  systemScheme.mockReturnValue("dark");
});

describe("KIN-MOBILE-002 R5 approval card visual", () => {
  it("KIN-MOBILE-002 R5: approve is the only filled primary and deny is outlined", async () => {
    for (const scheme of ["dark", "light"] as const) {
      systemScheme.mockReturnValue(scheme);
      const screen = await renderScreen();

      // The one filled control: the brand pigment, the frame's 10pt button
      // radius from the token scale, and the assigned on-brand ink — not a
      // contrast guess (theme.css:189-195 records the pair as assigned).
      const approve = style(screen, "approve:a1");
      expect(approve.backgroundColor).toBe(palette[scheme].blue);
      expect(approve.borderRadius).toBe(radius.bubble);
      const approveLabel = labelStyle(screen, "approve:a1", "chat.approve");
      expect(approveLabel.color).toBe(palette[scheme].onBrand);
      expect(approveLabel.fontWeight).toBe("600");

      // The safe alternative: no fill, one strong hairline, red ink.
      const deny = style(screen, "deny:a1");
      expect(deny.backgroundColor).toBe("transparent");
      expect(deny.borderWidth).toBeGreaterThanOrEqual(1);
      expect(deny.borderColor).toBe(palette[scheme].hairlineStrong);
      const denyLabel = labelStyle(screen, "deny:a1", "chat.deny");
      expect(denyLabel.color).toBe(palette[scheme].redInk);
      expect(denyLabel.fontWeight).toBe("600");

      // Both stay the signed 44pt floor (TASTE 11).
      for (const id of ["approve:a1", "deny:a1"]) {
        expect(style(screen, id).minHeight).toBeGreaterThanOrEqual(44);
        expect(style(screen, id).minWidth).toBeGreaterThanOrEqual(44);
      }

      // And nothing else on the card is filled: the primary is unambiguous.
      const filled = cardButtons(screen, "card:approval:a1").filter(
        (button) =>
          button.style.backgroundColor !== undefined &&
          button.style.backgroundColor !== "transparent",
      );
      expect(filled.map((button) => button.id)).toEqual(["approve:a1"]);
    }
  });

  it("KIN-MOBILE-002 R5: a card with no action available dims both buttons and keeps approve the filled one", async () => {
    const screen = await renderScreen({ online: false });

    for (const id of ["approve:a1", "deny:a1"]) {
      expect(style(screen, id).opacity).toBe(0.5);
      expect(screen.getByTestId(id).props.accessibilityState).toEqual({
        disabled: true,
      });
    }
    // Dimmed is still legible as the primary: the fill survives the state.
    expect(style(screen, "approve:a1").backgroundColor).toBe(palette.dark.blue);
    expect(style(screen, "deny:a1").backgroundColor).toBe("transparent");
  });

  it("KIN-MOBILE-002 R5: the approval card sits on the elevated surface and keeps the command monospace", async () => {
    for (const scheme of ["dark", "light"] as const) {
      systemScheme.mockReturnValue(scheme);
      const screen = await renderScreen();

      const card = style(screen, "card:approval:a1");
      expect(card.backgroundColor).toBe(palette[scheme].elevated);
      expect(card.borderRadius).toBe(radius.card);
      expect(card.borderColor).toBe(palette[scheme].hairlineStrong);
      expect(card.borderWidth).toBe(1);

      // The command is what the person is approving: it stays mono.
      const command = StyleSheet.flatten(
        screen.getByText(COMMAND).props.style,
      ) as TextStyle;
      expect(command.fontFamily).toContain("monospace");
    }
  });
});
