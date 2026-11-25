/**
 * KIN-MOBILE-001 R6 (part 2) — the provider/usage bottom sheet.
 *
 * A thin shell, no state of its own: it lifts R6's screen over the conversation
 * transcript in a react-native `Modal` (core, no new dependency) and owns only
 * the scrim, the card and the close gesture. Every number, chip, row and state
 * sentence is `ProviderUsage`'s; the reload, the session-kept window and the
 * late-answer drop are `providersModel`'s (AGENTS.md §11).
 *
 * One title and one close control: the embedded screen already draws
 * `usage.title` and `usage-close` (`ProviderUsage.tsx:171-190`), so this shell
 * draws neither a second header nor a second ×. The scrim is a close target
 * because a modal must always be dismissable (TASTE 10).
 */

import { Modal, Pressable, StyleSheet, View } from "react-native";
import type {
  ProvidersView,
  UsageWindowDays,
} from "../providers/providersModel";
import ProviderUsage from "./ProviderUsage";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export type ProviderUsageSheetProps = {
  visible: boolean;
  state: ProvidersView;
  t: Translate;
  onSelectWindow: (days: UsageWindowDays) => void;
  onRefresh?: () => void;
  onClose: () => void;
};

export default function ProviderUsageSheet({
  visible,
  state,
  t,
  onSelectWindow,
  onRefresh,
  onClose,
}: ProviderUsageSheetProps) {
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      testID="usage-sheet"
      transparent
      visible={visible}
    >
      <View style={styles.root}>
        {/*
          The scrim covers the transcript and is itself a close target, so the
          sheet is dismissable without hunting for the header's ×.
        */}
        <Pressable
          accessibilityLabel={t("app.close")}
          accessibilityRole="button"
          onPress={onClose}
          style={styles.scrim}
          testID="usage-sheet-scrim"
        />
        {/*
          The fixed height gives the embedded ScrollView a bounded box to fill;
          a flex:1 scroller inside an auto-height card would collapse. Keep the
          card inside the safe area by proportion, without adding a provider
          this app does not otherwise use (`react-native-safe-area-context` is
          installed but no sibling screen reads insets yet).
        */}
        <View accessibilityViewIsModal style={styles.card} testID="usage-card">
          <ProviderUsage
            onClose={onClose}
            onRefresh={onRefresh}
            onSelectWindow={onSelectWindow}
            state={state}
            t={t}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    height: "85%",
  },
  root: {
    flex: 1,
    justifyContent: "flex-end",
  },
  scrim: {
    backgroundColor: "rgba(0, 0, 0, 0.35)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
});
