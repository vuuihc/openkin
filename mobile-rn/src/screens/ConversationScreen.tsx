/**
 * KIN-MOBILE-001 R4b — the conversation route, wired to the phone's session.
 *
 * The pure view owns every word and the back control; the headless model
 * (`threadModel`) owns the transcript, the projection and its generation rule.
 * This container is the only place that reads the stored session, builds the
 * thread, and closes it on unmount so a late answer cannot repaint a screen
 * that is gone (AGENTS.md §11).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
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
  const threadRef = useRef<Thread | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let live = true;
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
      })
      .catch(() => {
        if (live) setState(expiredState(taskId));
      });
    return () => {
      live = false;
      // Drop the listener first, then close: the model's close bumps its
      // generation, so a read still in flight cannot publish to anyone.
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      threadRef.current?.close();
      threadRef.current = null;
    };
  }, [taskId, readSessionImpl, fetchImpl]);

  const retry = useCallback(() => {
    void threadRef.current?.load();
  }, []);

  if (state === null) {
    return (
      <View style={styles.container}>
        <ActivityIndicator accessibilityLabel={t("common.loading")} />
      </View>
    );
  }

  return (
    <ConversationView
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
