/**
 * KIN-MOBILE-001 R4b/R5c — the conversation route, wired to the phone's session.
 *
 * The pure view owns every word and the back control; the headless models own
 * the transcript and the node's pending approvals (`threadModel`,
 * `approvalsModel`), including their generation rules. This container is the
 * only place that reads the stored session, builds both models, and closes them
 * on unmount so a late answer cannot repaint a screen that is gone
 * (AGENTS.md §11). The pending lists are node-wide; `entriesForTask` scopes
 * them to this conversation at render time.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import {
  createApprovals,
  entriesForTask,
  type ApprovalsModel,
  type ApprovalsState,
} from "../approvals/approvalsModel";
import { readSession, secureStoreBackend, type Session } from "../auth/tokenStore";
import { t } from "../i18n";
import {
  createThread,
  type Thread,
  type ThreadState,
} from "../thread/threadModel";
import ConversationView from "./ConversationView";

/** Read the paired node from the platform Keychain. */
async function readStoredSession(): Promise<Session | null> {
  return readSession(await secureStoreBackend());
}

/**
 * A conversation opened with no stored session has nothing to read: the honest
 * state is the pairing sentence, and there is no read to retry.
 */
function expiredState(taskId: string): ThreadState {
  return {
    taskId,
    status: "error",
    turns: [],
    running: false,
    sendQueue: [],
    banner: null,
    reason: "expired",
  };
}

export type ConversationScreenProps = {
  taskId: string;
  onBack: () => void;
  /** Tests inject the Keychain read; production reads the paired session. */
  readSessionImpl?: () => Promise<Session | null>;
  /** Tests inject a recording fetch. */
  fetchImpl?: typeof fetch;
};

export default function ConversationScreen({
  taskId,
  onBack,
  readSessionImpl,
  fetchImpl,
}: ConversationScreenProps) {
  const [state, setState] = useState<ThreadState | null>(null);
  // The node-wide pending lists, scoped to this conversation at render time
  // by `entriesForTask`: the model keeps the whole list because decisions
  // address cards by id.
  const [approvals, setApprovals] = useState<ApprovalsState | null>(null);
  const threadRef = useRef<Thread | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const approvalsRef = useRef<ApprovalsModel | null>(null);
  const approvalsUnsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let live = true;
    // Whatever this run reads, no card from the previous run may paint in the
    // meantime — and an expired session shows no old approval at all.
    setApprovals(null);
    const read = readSessionImpl ?? readStoredSession;
    void read()
      .then((session) => {
        // The screen unmounted while the Keychain answered: build no thread.
        if (!live) return;
        if (session === null) {
          setState(expiredState(taskId));
          return;
        }
        const thread = createThread({
          origin: session.origin,
          token: session.token,
          taskId,
          fetchImpl,
        });
        threadRef.current = thread;
        unsubscribeRef.current = thread.subscribe((next) => {
          if (live) setState(next);
        });
        setState(thread.getState());
        void thread.load();

        // One approvals model beside the thread, from the same session: the
        // conversation shows the card its next turn is blocked on.
        const approvalsModel = createApprovals({
          origin: session.origin,
          token: session.token,
          fetchImpl,
        });
        approvalsRef.current = approvalsModel;
        approvalsUnsubscribeRef.current = approvalsModel.subscribe((next) => {
          if (live) setApprovals(next);
        });
        setApprovals(approvalsModel.getState());
        void approvalsModel.load();
      })
      .catch(() => {
        if (live) setState(expiredState(taskId));
      });
    return () => {
      live = false;
      // Drop the listeners first, then dispose/close: each model bumps its own
      // generation, so a read still in flight cannot publish to anyone
      // (AGENTS.md §11). The approvals read is abandoned with the screen.
      approvalsUnsubscribeRef.current?.();
      approvalsUnsubscribeRef.current = null;
      approvalsRef.current?.dispose();
      approvalsRef.current = null;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      threadRef.current?.close();
      threadRef.current = null;
    };
  }, [taskId, readSessionImpl, fetchImpl]);

  const retry = useCallback(() => {
    void threadRef.current?.load();
  }, []);

  // One read path for the list and for a failed card's retry: re-reading the
  // pending lists is the only way either recovers, and a second path could
  // disagree with the first about what is pending.
  const refresh = useCallback(() => {
    void approvalsRef.current?.load();
  }, []);
  const approve = useCallback((id: string) => {
    void approvalsRef.current?.approve(id);
  }, []);
  const deny = useCallback((id: string) => {
    void approvalsRef.current?.deny(id);
  }, []);
  const answer = useCallback((id: string, text: string) => {
    void approvalsRef.current?.answer(id, text);
  }, []);

  if (state === null) {
    return (
      <View style={styles.container}>
        <ActivityIndicator accessibilityLabel={t("common.loading")} />
      </View>
    );
  }

  const approvalsProps =
    approvals === null
      ? undefined
      : {
          state: entriesForTask(approvals, taskId),
          t,
          onApprove: approve,
          onDeny: deny,
          onAnswer: answer,
          onRetry: refresh,
          onRefresh: refresh,
        };

  return (
    <ConversationView
      approvals={approvalsProps}
      onBack={onBack}
      // With no thread there is no read to retry, so the control is absent
      // rather than a button that does nothing.
      onRetry={threadRef.current === null ? undefined : retry}
      state={state}
      t={t}
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
