import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { t } from "../../src/i18n";
import SplitListLayout from "../../src/layout/SplitListLayout";
import { splitFor } from "../../src/layout/split";
import { useListWidth } from "../../src/layout/useListWidth";
import ConversationScreen from "../../src/screens/ConversationScreen";
import ListScreen from "../../src/screens/ListScreen";

/**
 * KIN-MOBILE-001 R4b — the conversation route.
 *
 * One dynamic segment carries the task id. It is narrowed to one string here
 * so the screen never receives an array, and on a phone Back pops the stack to
 * the list, which stayed mounted with its folds and scroll position.
 *
 * KIN-CONTINUE-007 各面差异 — at 768pt and wider this route draws the same
 * 304pt list beside the conversation, so rotating a phone conversation onto an
 * iPad keeps both panes instead of dropping to the list. Picking another row
 * rewrites the `id` segment, which is also what a deep link names.
 */
export default function ThreadRoute() {
  const router = useRouter();
  const width = useListWidth();
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const taskId = Array.isArray(id) ? (id[0] ?? "") : (id ?? "");
  const split = splitFor(width).mode === "split";
  // The list stays mounted beside the conversation, so the R5 "Back is a data
  // event" signal is a changed conversation: switching rows re-reads the
  // server's pending badges. The id observed at mount is the baseline.
  const [focusEpoch, setFocusEpoch] = useState(0);
  const seenTask = useRef(taskId);
  useEffect(() => {
    if (seenTask.current === taskId) return;
    seenTask.current = taskId;
    setFocusEpoch((epoch) => epoch + 1);
  }, [taskId]);

  // The conversation closes to the list, whether it arrived by a phone push
  // (rotate onto the iPad) or by a deep link with nothing beneath it.
  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/list");
  }, [router]);

  // Android's system back in a split means the same thing as the pane's Back:
  // it must not finish the activity with the conversation still open.
  useEffect(() => {
    if (!split) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        leave();
        return true;
      },
    );
    return () => subscription.remove();
  }, [leave, split]);

  if (!split) {
    return <ConversationScreen onBack={leave} taskId={taskId} />;
  }

  return (
    <SplitListLayout
      conversation={<ConversationScreen onBack={leave} taskId={taskId} />}
      emptyLabel={t("sessions.selectConversation")}
      list={
        <ListScreen
          focusEpoch={focusEpoch}
          onNeedsPairing={() => router.replace("/pair")}
          onOpen={(next) => router.setParams({ id: next })}
        />
      }
      selectedTaskId={taskId === "" ? null : taskId}
      width={width}
    />
  );
}
