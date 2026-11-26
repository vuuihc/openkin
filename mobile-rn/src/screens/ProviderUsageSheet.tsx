/**
 * KIN-MOBILE-001 R6 (part 2) — the provider/usage bottom sheet.
 *
 * A thin shell, no state of its own: it lifts R6's screen over the conversation
 * transcript in a react-native `Modal` and owns only the scrim, the card, the
 * glass background and the close gesture. Every number, chip, row and state
 * sentence is `ProviderUsage`'s; the reload, the session-kept window and the
 * late-answer drop are `providersModel`'s (AGENTS.md §11).
 *
 * R7's §7 立刻看到 asks for the sheet over a 「玻璃背景」, so the card carries a
 * `GlassSurface` behind its content instead of painting white: the conversation
 * blurs through. The branch (blur, or today's opaque white under reduced
 * transparency and on Android) is `glassFor`'s (`native/glass.ts`); this file
 * only applies it to the card's own background, which must stay transparent
 * while the blur is showing or it would cover it.
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
  Platform,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import GlassSurface, { useReduceTransparency } from "../native/GlassSurface";
import { GLASS_FALLBACK_COLOR, glassFor } from "../native/glass";
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

  // The card's surface, from the same preference the glass layer reads. The
  // card must not paint over the blur, and under reduced transparency it keeps
  // today's white (`native/glass.ts`).
  const glass = glassFor({
    reduceTransparency: useReduceTransparency(),
    platform: Platform.OS,
  });

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
          style={[
            styles.card,
            glass.kind === "blur" ? styles.cardGlass : styles.cardOpaque,
            { transform: [{ translateY }] },
          ]}
          testID="usage-card"
        >
          {/*
            The surface, not the content: an absolute fill behind both the
            grabber strip and `ProviderUsage`, so the blur is what shows
            through the card and the strip's pull-down still owns its touches.
            The card clips it (`overflow: hidden`) to the signed top radius.
          */}
          <GlassSurface style={StyleSheet.absoluteFill} />
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
            autoFocus={visible}
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
  /**
   * The card's geometry only: its colour belongs to the glass branch below, so
   * the blur is never covered by a panel paint. `overflow: "hidden"` clips the
   * absolute-fill surface to the signed top radius.
   */
  card: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    height: "85%",
    overflow: "hidden",
  },
  /** The blur branch: the surface behind the card is what the reader sees. */
  cardGlass: {
    backgroundColor: "transparent",
  },
  /** Reduced transparency / Android: today's card, unchanged. */
  cardOpaque: {
    backgroundColor: GLASS_FALLBACK_COLOR,
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
