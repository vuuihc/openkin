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
import {
  ActivityIndicator,
  AppState,
  StyleSheet,
  View,
} from "react-native";
import {
  createApprovals,
  entriesForTask,
  type ApprovalsModel,
  type ApprovalsState,
  type SubmitResult,
} from "../approvals/approvalsModel";
import { readSession, secureStoreBackend, type Session } from "../auth/tokenStore";
import { t } from "../i18n";
import {
  asAppStateStatus,
  shouldResume,
  type AppStateLike,
  type AppStateStatus,
} from "../native/reconnect";
import {
  createProvidersModel,
  type ProvidersModel,
  type ProvidersView,
  type UsageWindowDays,
} from "../providers/providersModel";
import type { StreamSource } from "../thread/stream";
import {
  createThread,
  type SendOutcome,
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
    title: "",
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
  /**
   * A pending decision settled on the server: the sibling list's badges may be
   * stale. The split route raises its focus epoch from here; a phone route
   * passes nothing because there is no mounted list to re-read.
   */
  onPendingSettled?: () => void;
  /** Tests inject the Keychain read; production reads the paired session. */
  readSessionImpl?: () => Promise<Session | null>;
  /** Tests inject a recording fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Tests inject the event source. Production lets the thread build the
   * fetch reader, exactly as the web console's EventSource would.
   */
  source?: StreamSource;
  /**
   * Tests inject the platform app-state emitter. Production uses React
   * Native's `AppState`; a foreground return reopens a dead stream
   * (KIN-MOBILE-001 R7).
   */
  appState?: AppStateLike;
};

export default function ConversationScreen({
  taskId,
  onBack,
  onPendingSettled,
  readSessionImpl,
  fetchImpl,
  source,
  appState,
}: ConversationScreenProps) {
  const [state, setState] = useState<ThreadState | null>(null);
  // The node-wide pending lists, scoped to this conversation at render time
  // by `entriesForTask`: the model keeps the whole list because decisions
  // address cards by id.
  const [approvals, setApprovals] = useState<ApprovalsState | null>(null);
  // This conversation's provider/usage view. The model keeps the chosen window
  // for the whole screen, so it survives the sheet closing and reopening; the
  // sheet itself owns no data (AGENTS.md §11).
  const [providers, setProviders] = useState<ProvidersView | null>(null);
  const threadRef = useRef<Thread | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const approvalsRef = useRef<ApprovalsModel | null>(null);
  const approvalsUnsubscribeRef = useRef<(() => void) | null>(null);
  const providersRef = useRef<ProvidersModel | null>(null);
  // The model publishes by promise, not by subscription, so the effect hands
  // its still-live publish here and clears it on the way out.
  const publishProvidersRef = useRef<
    ((next: ProvidersView) => void) | null
  >(null);

  useEffect(() => {
    let live = true;
    // The platform's app-state emitter, or the test's. The subscription is
    // created below, after the session answers, and removed by this run's
    // cleanup (a return after the screen is gone must resume nothing).
    let appStateSubscription: { remove(): void } | null = null;
    // Whatever this run reads, no card from the previous run may paint in the
    // meantime — and an expired session shows no old approval at all.
    setApprovals(null);
    setProviders(null);
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
          source,
        });
        threadRef.current = thread;
        unsubscribeRef.current = thread.subscribe((next) => {
          if (live) setState(next);
        });
        setState(thread.getState());
        // R7: a return from the background reopens a stream that gave up,
        // silently and from the last applied seq. The listener is in place
        // before `start()` so no transition can be missed while the first
        // read is in flight; `resume()` itself no-ops until the thread is
        // ready and while the stream is healthy.
        const appStatePort: AppStateLike = appState ?? {
          // RN's generated type is `string | null` until the platform sets it;
          // anything outside the status union reads as `unknown`.
          get currentState() {
            return asAppStateStatus(AppState.currentState);
          },
          addEventListener(_type, listener) {
            const subscription = AppState.addEventListener("change", listener);
            return { remove: () => subscription.remove() };
          },
        };
        let previousAppState: AppStateStatus = appStatePort.currentState;
        appStateSubscription = appStatePort.addEventListener(
          "change",
          (next) => {
            if (shouldResume(previousAppState, next)) void thread.resume();
            previousAppState = next;
          },
        );
        // `start()` is the read *and* the subscription: `load()` alone leaves
        // the screen with a snapshot that never learns a sent message, its
        // reply, or the round's end (2026-11-25, the simulator walk).
        void thread.start();

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

        // One providers model beside the thread, from the same session. It is
        // built here but never read here: the sheet's open handler is the one
        // trigger, so a conversation opened for reading calls no usage
        // endpoint (external-integration UX gate).
        const providersModel = createProvidersModel({
          origin: session.origin,
          token: session.token,
          fetchImpl,
        });
        providersRef.current = providersModel;
        publishProvidersRef.current = (next) => {
          if (live) setProviders(next);
        };
        // The model's opening view (loading, no rows), never a read: this is
        // what makes the header entry exist before the sheet is first opened.
        setProviders(providersModel.getState());
      })
      .catch(() => {
        if (live) setState(expiredState(taskId));
      });
    return () => {
      live = false;
      appStateSubscription?.remove();
      appStateSubscription = null;
      // Drop the listeners first, then dispose/close: each model bumps its own
      // generation, so a read still in flight cannot publish to anyone
      // (AGENTS.md §11). The approvals read is abandoned with the screen.
      publishProvidersRef.current = null;
      providersRef.current?.cancel();
      providersRef.current = null;
      approvalsUnsubscribeRef.current?.();
      approvalsUnsubscribeRef.current = null;
      approvalsRef.current?.dispose();
      approvalsRef.current = null;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      threadRef.current?.close();
      threadRef.current = null;
    };
  }, [taskId, readSessionImpl, fetchImpl, source, appState]);

  const retry = useCallback(() => {
    // A retry after a failed read must also (re)open the subscription: a
    // load-only retry would leave the recovered screen unable to update.
    void threadRef.current?.start();
  }, []);
  // The offline banner's one manual retry: reopen the stream without the
  // visible re-read `start()` does, keeping the transcript and the draft.
  const reconnect = useCallback(() => {
    void threadRef.current?.resume();
  }, []);

  // One read path for the list and for a failed card's retry: re-reading the
  // pending lists is the only way either recovers, and a second path could
  // disagree with the first about what is pending.
  const refresh = useCallback(() => {
    void approvalsRef.current?.load();
  }, []);
  // The one outward signal a settled decision sends: the list beside this
  // conversation is showing a count the server just changed. Only an `ok`
  // answer moved anything — a failure restored the card, and a `stale` answer
  // belongs to a list this screen no longer owns (AGENTS.md §11).
  const settled = useCallback(
    (result: SubmitResult) => {
      if (result.ok) onPendingSettled?.();
    },
    [onPendingSettled],
  );
  const approve = useCallback(
    (id: string) => {
      void approvalsRef.current?.approve(id).then(settled);
    },
    [settled],
  );
  const deny = useCallback(
    (id: string) => {
      void approvalsRef.current?.deny(id).then(settled);
    },
    [settled],
  );
  const answer = useCallback(
    (id: string, text: string) => {
      void approvalsRef.current?.answer(id, text).then(settled);
    },
    [settled],
  );

  // The composer's three writes go to the thread model, which owns the queue,
  // the stop and the offline refusal; this container only forwards. `send`
  // carries the model's answer back, because a refused send is the composer's
  // business: it is the only place that can put the words back and say why
  // (KIN-MOBILE-001 §5 失败). A press after unmount reaches a null ref and
  // posts nothing — and reports a refusal, so the words are not silently lost.
  const send = useCallback((text: string): Promise<SendOutcome> => {
    const thread = threadRef.current;
    if (thread === null) return Promise.resolve({ ok: false, reason: "stale" });
    return thread.send(text);
  }, []);
  const stop = useCallback(() => {
    void threadRef.current?.stop();
  }, []);
  const withdraw = useCallback((id: string) => {
    threadRef.current?.cancelQueued(id);
  }, []);

  // Both the sheet's first read and its retry are the same read. The model
  // sets its "loading" state synchronously, so the sheet never opens on the
  // previous answer pretending to be this one; a late answer is dropped by the
  // model's own generation rule before it reaches `setProviders`, and the
  // publisher is the one this run installed — a read that outlives its effect
  // run lands on a dead `live` and paints nothing (AGENTS.md §11).
  const readUsage = useCallback(() => {
    const model = providersRef.current;
    if (!model) return;
    const publish = publishProvidersRef.current;
    const read = model.load();
    setProviders(model.getState());
    void read.then((next) => publish?.(next));
  }, []);
  // Cancel is the container telling the model the sheet is gone: it bumps the
  // generation and aborts the request, so a held answer paints nothing.
  const closeUsage = useCallback(() => {
    providersRef.current?.cancel();
  }, []);
  const selectUsageWindow = useCallback((days: UsageWindowDays) => {
    const model = providersRef.current;
    if (!model) return;
    const publish = publishProvidersRef.current;
    const read = model.setWindow(days);
    setProviders(model.getState());
    void read.then((next) => publish?.(next));
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

  // With no model there is no session to read providers with, and the header
  // draws no entry: the same rule that removes the composer removes this.
  const usageProps =
    providers === null
      ? undefined
      : {
          state: providers,
          onSelectWindow: selectUsageWindow,
          onRefresh: readUsage,
          onOpen: readUsage,
          onClose: closeUsage,
        };

  return (
    <ConversationView
      approvals={approvalsProps}
      onBack={onBack}
      // With no thread there is no read to retry, so the control is absent
      // rather than a button that does nothing. The same rule draws no
      // composer: a box that cannot post is not a composer.
      onRetry={threadRef.current === null ? undefined : retry}
      onReconnect={threadRef.current === null ? undefined : reconnect}
      onSend={threadRef.current === null ? undefined : send}
      onStop={threadRef.current === null ? undefined : stop}
      onWithdraw={threadRef.current === null ? undefined : withdraw}
      state={state}
      t={t}
      usage={usageProps}
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
