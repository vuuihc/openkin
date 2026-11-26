import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  StyleSheet,
  View,
} from "react-native";
import {
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { pairing, type AppState } from "../src/auth/pairing";
import { t } from "../src/i18n";
import SplitListLayout from "../src/layout/SplitListLayout";
import { splitFor } from "../src/layout/split";
import { useListWidth } from "../src/layout/useListWidth";
import { bootHref } from "../src/screens/pairModel";
import ConversationScreen from "../src/screens/ConversationScreen";
import ListScreen from "../src/screens/ListScreen";

/** A URL param, narrowed from expo-router's string | string[] to one id. */
function firstParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  return first === null || first === "" ? null : first;
}

/**
 * KIN-MOBILE-001 R3 — the list route.
 *
 * The boot check decides the first frame (a stored, accepted session lands
 * here; anything else opens the pairing entry), then the wired screen reads
 * the session itself and draws device → project → conversation.
 *
 * KIN-MOBILE-001 R5 — Back is also a data event: the conversation behind the
 * reader may have approved or answered something, and the list's pending
 * badges are the server's answer (story §8). The route is the only place that
 * knows about focus, so it translates a refocus into a bumped `focusEpoch`;
 * the screen re-reads through its controller. The focus at mount is skipped —
 * the screen's initial load already covers it.
 *
 * KIN-MOBILE-001 R3 / KIN-CONTINUE-007 各面差异 — at 768pt and wider the list
 * keeps its 304pt column and the selected conversation opens beside it. The
 * selection is the `thread` URL param, so a deep link into one conversation and
 * a reload both land on the same two panes; below 768 the same selection is
 * handed to the pushed `/thread/<id>` route, which is the phone stack.
 */
export default function ListRoute() {
  const router = useRouter();
  const width = useListWidth();
  const { thread } = useLocalSearchParams<{ thread?: string | string[] }>();
  const selected = firstParam(thread);
  const layout = splitFor(width);
  const [state, setState] = useState<AppState | null>(null);
  const [focusEpoch, setFocusEpoch] = useState(0);
  // KIN-MOBILE-001 §2「返回时焦点回到那一行」. A separate signal from the data
  // epoch: only a real focus regain (Back from a pushed conversation) may move
  // the reader, while a split open/switch/close bumps `focusEpoch` alone and
  // must leave reader focus in the conversation pane.
  const [returnFocusEpoch, setReturnFocusEpoch] = useState(0);
  // A focus event while the list is showing is a return. While the boot read
  // is still deciding the first frame there is nothing to re-read.
  const showing = useRef(false);
  showing.current = state !== null;

  // In a split the list never blurs, so the R5 "returned from a conversation"
  // data event is opening, switching or closing one; each re-reads the
  // server's pending badges through the screen's focus epoch.
  const refreshAfterConversation = useCallback(() => {
    setFocusEpoch((epoch) => epoch + 1);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!showing.current) return;
      setFocusEpoch((epoch) => epoch + 1);
      // The return epoch has no split-path writer: opening, switching or
      // closing the conversation beside the list never calls this callback,
      // so a pane change cannot be mistaken for a return.
      setReturnFocusEpoch((epoch) => epoch + 1);
    }, []),
  );

  useEffect(() => {
    let mounted = true;
    void pairing
      .startRoute()
      .then((next) => {
        if (!mounted) return;
        if (next.route === "pairing") {
          router.replace(bootHref(next));
          return;
        }
        setState(next);
      })
      .catch(() => {
        if (mounted) router.replace("/pair");
      });
    return () => {
      mounted = false;
    };
  }, [router]);

  // A selection carried by the URL while the window is a phone (a deep link,
  // or a resize from the split) belongs to the pushed conversation route. The
  // task id rides along, so rotating back to 768 reopens the same conversation
  // in the split. The list clears its own param before pushing, so Back lands
  // on a list that cannot bounce straight back here; a ref makes the hand-off
  // one-shot even if an effect runs twice in development.
  const handedOff = useRef<string | null>(null);
  useEffect(() => {
    if (layout.mode === "split") {
      handedOff.current = null;
      return;
    }
    if (state === null || selected === null) return;
    if (handedOff.current === selected) return;
    handedOff.current = selected;
    router.setParams({ thread: undefined });
    router.push(`/thread/${encodeURIComponent(selected)}`);
  }, [layout.mode, router, selected, state]);

  // Android's system back is the same Back the phone stack honours: in a split
  // it closes the conversation instead of leaving the app with the pane open.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    if (layout.mode !== "split") return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (selectedRef.current === null) return false;
        selectedRef.current = null;
        router.setParams({ thread: undefined });
        refreshAfterConversation();
        return true;
      },
    );
    return () => subscription.remove();
    // The subscription reads the selection through the ref, so it need not
    // resubscribe on every row.
  }, [layout.mode, refreshAfterConversation, router]);

  const open = useCallback(
    (taskId: string) => {
      if (layout.mode === "split") {
        // The URL is the selection: the right pane follows it, and a reload or
        // a shared link reopens the same conversation.
        router.setParams({ thread: taskId });
        refreshAfterConversation();
        return;
      }
      router.push(`/thread/${encodeURIComponent(taskId)}`);
    },
    [layout.mode, refreshAfterConversation, router],
  );

  const clearSelection = useCallback(() => {
    router.setParams({ thread: undefined });
    refreshAfterConversation();
  }, [refreshAfterConversation, router]);

  if (state === null) {
    return (
      <View style={styles.container}>
        <ActivityIndicator accessibilityLabel={t("common.loading")} />
      </View>
    );
  }

  return (
    <SplitListLayout
      conversation={
        selected === null ? null : (
          <ConversationScreen onBack={clearSelection} taskId={selected} />
        )
      }
      emptyLabel={t("sessions.selectConversation")}
      list={
        <ListScreen
          focusEpoch={focusEpoch}
          returnFocusEpoch={returnFocusEpoch}
          onNeedsPairing={() => router.replace("/pair")}
          onOpen={open}
        />
      }
      selectedTaskId={selected}
      width={width}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
});
