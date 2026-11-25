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
 *
 * The card also answers the platform sheet gesture: a 44pt grabber strip above
 * the embedded scroller follows a downward drag and closes past
 * `SHEET_DISMISS_DISTANCE`, while an upward drag clamps at rest. The strip, not
 * the card, owns the responder, so `ProviderUsage`'s ScrollView keeps its
 * vertical scroll.
 */

import { useEffect, useRef } from "react";
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import type {
  ProvidersView,
  UsageWindowDays,
} from "../providers/providersModel";
import ProviderUsage from "./ProviderUsage";
import { dragOffset, shouldDismiss } from "./sheetDrag";

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
  // The card's downward travel. An Animated.Value, not React state, so a move
  // updates the transform without re-rendering the embedded ScrollView.
  const translateY = useRef(new Animated.Value(0)).current;
  // Where the finger started, in page coordinates; null when no drag owns the
  // strip (a fresh tap, or a touch the system cancelled).
  const startPageY = useRef<number | null>(null);

  // A spring that is still settling when the sheet goes away must not keep
  // animating a card that no longer exists (AGENTS.md §11).
  useEffect(() => () => translateY.stopAnimation(), [translateY]);

  // The sheet stays mounted while hidden, so a drag that ended in a close (or
  // that was interrupted by another close path) can leave the card displaced.
  // Reset at open, not at close: resetting inside `onClose()` would snap the
  // card back up while the modal is still sliding out.
  useEffect(() => {
    if (visible) translateY.setValue(0);
  }, [visible, translateY]);

  function handleGrant(event: GestureResponderEvent) {
    startPageY.current = event.nativeEvent.pageY;
  }

  function handleMove(event: GestureResponderEvent) {
    const start = startPageY.current;
    if (start === null) return;
    translateY.setValue(dragOffset(start, event.nativeEvent.pageY));
  }

  function handleRelease(event: GestureResponderEvent) {
    const start = startPageY.current;
    // The gesture is over whether it closes or springs back.
    startPageY.current = null;
    const offset =
      start === null ? 0 : dragOffset(start, event.nativeEvent.pageY);
    if (shouldDismiss(offset)) {
      // The same close callback as the button and the scrim: one close path,
      // one place for the container to abandon its in-flight read.
      onClose();
      return;
    }
    // A tap or a short drag: spring back and leave the sheet open.
    Animated.spring(translateY, {
      bounciness: 0,
      toValue: 0,
      useNativeDriver: true,
    }).start();
  }

  function handleTerminate() {
    // The system took the touch (e.g. an incoming call). A cancelled gesture
    // is not a dismissal, and it must not leave the card displaced either.
    startPageY.current = null;
    translateY.setValue(0);
  }

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
        <Animated.View
          accessibilityViewIsModal
          style={[styles.card, { transform: [{ translateY }] }]}
          testID="usage-card"
        >
          {/*
            The pull-down lives on a 44pt grabber strip above the content, not
            on the card: a responder on the card would fight the embedded
            `ProviderUsage` ScrollView. The strip is decorative to the reader
            (the header's 关闭 stays the only announced dismiss), so it adds no
            label and no new sentence.
          */}
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onResponderGrant={handleGrant}
            onResponderMove={handleMove}
            onResponderRelease={handleRelease}
            onResponderTerminate={handleTerminate}
            onStartShouldSetResponder={() => true}
            style={styles.handle}
            testID="usage-drag-handle"
          >
            <View style={styles.handleBar} testID="usage-drag-bar" />
          </View>
          <ProviderUsage
            onClose={onClose}
            onRefresh={onRefresh}
            onSelectWindow={onSelectWindow}
            state={state}
            t={t}
          />
        </Animated.View>
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
  /** The 44pt finger target; the visible affordance is the bar inside it. */
  handle: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
  },
  handleBar: {
    backgroundColor: "#d0d0d0",
    borderRadius: 2.5,
    height: 5,
    width: 36,
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
