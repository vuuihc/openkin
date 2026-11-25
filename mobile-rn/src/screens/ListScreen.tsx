/**
 * KIN-MOBILE-001 R3 — the conversation list, wired to the phone's session.
 *
 * The pure screen (`ConversationList`) owns presentation and the headless model
 * (`listModel`) owns grouping, folds, the request state and its generation
 * rule. This container is the only place that reads the stored session, builds
 * the controller, and mirrors the model's state into React. Every callback
 * leaves the model as the one writer: a refresh asks the controller, a fold is
 * the controller's own toggle, and neither derives list state here.
 *
 * KIN-MOBILE-001 R7 adds one more async owner: the resume controller
 * (`lifecycle/resume`) re-reads the list after a real absence and reports the
 * reconnect band's state. It is created with the list controller and disposed
 * with it, so no answer outlives the screen.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, View } from "react-native";
import type { Machine } from "../../../ui/src/lib/devices";
import { readSession, secureStoreBackend, type Session } from "../auth/tokenStore";
import { t } from "../i18n";
import {
  createResumeController,
  type AppStateLike,
  type ResumeController,
  type ResumeStatus,
} from "../lifecycle/resume";
import {
  createListController,
  filterGroups,
  sharedListMemory,
  type FoldStore,
  type ListController,
  type ListMemory,
  type ListViewState,
} from "../list/listModel";
import ConversationList from "./ConversationList";

/** Read the paired node from the platform Keychain. */
async function readStoredSession(): Promise<Session | null> {
  return readSession(await secureStoreBackend());
}

export type ListScreenProps = {
  onOpen: (taskId: string) => void;
  onNeedsPairing: () => void;
  /** Tests inject the Keychain read; production reads the paired session. */
  readSessionImpl?: () => Promise<Session | null>;
  /** Tests inject a recording fetch. */
  fetchImpl?: typeof fetch;
  /**
   * The device this phone is. Nothing in this slice confirms it (the session
   * holds only origin and token), so production leaves it empty and every task
   * keeps the device id it names.
   */
  selfDeviceId?: string;
  /** The device list, when the caller has one; headings fall back to the id. */
  machines?: readonly Machine[];
  /** The shared relative-time formatter, injected like the web list's. */
  formatTime?: (at: number) => string;
  /** The fold store; production keeps the reader's folds in memory for now. */
  store?: FoldStore;
  /**
   * What the route must not forget when it unmounts: the query, the scroll
   * offset and the last page. Production uses the app's one shared memory;
   * tests inject a fresh one per case.
   */
  memory?: ListMemory;
  /** The AppState emitter; production uses react-native's. Tests inject one. */
  appState?: AppStateLike;
  /** Test seam; production uses the platform clock. */
  now?: () => number;
  /**
   * Bumped by the route when the list is focused again (Back from a pushed
   * conversation). The screen owns no navigation knowledge: it only re-reads
   * when this value changes after the one it mounted with.
   */
  focusEpoch?: number;
};

export default function ListScreen({
  onOpen,
  onNeedsPairing,
  readSessionImpl,
  fetchImpl,
  selfDeviceId = "",
  machines,
  formatTime,
  store,
  memory = sharedListMemory,
  appState = AppState,
  now,
  focusEpoch = 0,
}: ListScreenProps) {
  const [state, setState] = useState<ListViewState | null>(null);
  // What the reader was looking for, and where they were. Both outlive the
  // list route because they live in `memory`, not in this component.
  const [query, setQuery] = useState(() => memory.read().query);
  const [initialOffset, setInitialOffset] = useState(0);
  // The reconnect band is a network state, not a steady one: null whenever the
  // list is current.
  const [band, setBand] = useState<"resuming" | "offline" | null>(null);
  const controllerRef = useRef<ListController | null>(null);
  const resumeRef = useRef<ResumeController | null>(null);
  // The mount that owns the memory right now, and the session its answers
  // belong to. A load from a replaced mount must not write either.
  const sessionRef = useRef<Session | null>(null);
  const claimRef = useRef(0);
  const memoryRef = useRef(memory);
  memoryRef.current = memory;
  // The route callbacks are fresh closures on most renders; a ref keeps the
  // mount effect from tearing the controller down just because the parent
  // repainted.
  const callbacks = useRef({ onOpen, onNeedsPairing });
  callbacks.current = { onOpen, onNeedsPairing };
  // Creation options are read once per mounted controller. A fold store is the
  // identity of the reader's folds, and swapping it mid-life would resurrect
  // folds the reader has already changed.
  const options = useRef({ selfDeviceId, machines, formatTime, store });
  options.current = { selfDeviceId, machines, formatTime, store };

  /**
   * The one place a model state reaches both React and the route's memory.
   * The page is written only while this mount still owns the memory, so a
   * late answer from an older generation cannot become the page a later
   * remount restores (AGENTS.md rule 11).
   */
  const publish = useCallback((next: ListViewState) => {
    const origin = sessionRef.current?.origin;
    // Only a page is worth remembering. A failure or an offline state is a
    // network fact about the moment, not rows: storing it would make a later
    // remount restore a failure it never retries.
    const page = next.status === "ready" || next.status === "empty";
    if (
      page &&
      origin !== undefined &&
      memoryRef.current.isCurrent(claimRef.current)
    ) {
      memoryRef.current.writeSnapshot(origin, next);
    }
    setState(next);
  }, []);

  useEffect(() => {
    let live = true;
    let list: ListController | null = null;
    let resume: ResumeController | null = null;
    // A rebuilt controller starts with no band: the previous one described a
    // list (and a retry target) this effect is about to replace.
    setBand(null);
    // This mount owns the route's memory from here on. A load that lands for
    // an earlier mount may not write its page over this one (rule 11).
    const mine = memory.claim();
    claimRef.current = mine;
    const read = readSessionImpl ?? readStoredSession;
    void read()
      .then((session) => {
        // A screen that unmounted while the Keychain answered owns no
        // controller and must not navigate (AGENTS.md §11).
        if (!live) return;
        if (session === null) {
          callbacks.current.onNeedsPairing();
          return;
        }
        sessionRef.current = session;
        const {
          selfDeviceId: self,
          machines: devices,
          formatTime: clock,
          store: folds,
        } = options.current;
        // Back on a route that unmounted: the stored page answers the first
        // frame and the stored offset puts the reader back, so neither the
        // list nor the reader pays for the same read again. A stored failure
        // is not a page — restoring it would trap every remount on an error it
        // never retries.
        const cached = memory.readSnapshot(session.origin);
        const restored =
          cached !== null &&
          (cached.status === "ready" || cached.status === "empty");
        list = createListController({
          origin: session.origin,
          token: session.token,
          selfDeviceId: self,
          machines: devices,
          t,
          formatTime: clock,
          store: folds,
          fetchImpl,
          initialState: cached ?? undefined,
        });
        controllerRef.current = list;
        if (restored) {
          setState(cached);
          setInitialOffset(memory.read().offset);
        } else {
          setState(list.state());
        }

        // One resume controller for the mounted screen. Its refresh is the
        // list's own load, so the rows the reader already has are never
        // cleared; the answer is mirrored only while this controller is the
        // one the screen shows.
        const mounted = list;
        resume = createResumeController({
          appState,
          refreshList: async () => {
            const next = await mounted.load();
            if (live && controllerRef.current === mounted) publish(next);
            return {
              ok: next.status !== "offline" && next.status !== "failed",
              reason: next.error ?? undefined,
            };
          },
          // The list route has no open conversation, so `resumeStream` stays
          // absent and a good refresh settles `online` on its own.
          getLastSeq: () => 0,
          onStatus: (status: ResumeStatus) => {
            if (!live) return;
            if (status === "expired") {
              // A dead token is a pairing trip, not a network blip: no band,
              // and no retry behind the reader's back.
              setBand(null);
              callbacks.current.onNeedsPairing();
              return;
            }
            setBand(status === "resuming" || status === "offline" ? status : null);
          },
          now,
        });
        resumeRef.current = resume;

        // A restored page is the read for this mount; anything else starts
        // with one.
        if (restored) return;
        return mounted.load().then((next) => {
          // The controller drops an answer from an older generation; this guard
          // drops the one that lands after the screen is gone, and the memory
          // claim drops the one that belongs to a replaced mount.
          if (!live || !memory.isCurrent(mine)) return;
          publish(next);
        });
      })
      .catch(() => {
        if (live) callbacks.current.onNeedsPairing();
      });
    return () => {
      live = false;
      controllerRef.current = null;
      resumeRef.current = null;
      // Final: removes the AppState listener, clears a pending retry, and
      // drops every answer that lands after the screen is gone.
      resume?.dispose();
      list = null;
    };
  }, [readSessionImpl, fetchImpl, appState, now, memory, publish]);

  const refresh = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    void controller.load().then((next) => {
      if (controllerRef.current !== controller) return;
      publish(next);
      if (next.status === "offline" || next.status === "failed") return;
      // A manual read that worked makes the band's claim false; drop the
      // series that produced it so its retry cannot start a stale one.
      resumeRef.current?.invalidate();
    });
  }, [publish]);

  const toggleProject = useCallback(
    (deviceId: string, projectKey: string) => {
      const controller = controllerRef.current;
      if (!controller) return;
      publish(controller.toggleProject(deviceId, projectKey));
    },
    [publish],
  );

  /** The query is route state, not component state: it must outlive unmount. */
  const changeQuery = useCallback((next: string) => {
    setQuery(next);
    memoryRef.current.write({ query: next });
  }, []);

  /** Every scroll updates the place Back will restore. */
  const rememberOffset = useCallback((offset: number) => {
    memoryRef.current.write({ offset });
  }, []);

  const open = useCallback((taskId: string) => {
    callbacks.current.onOpen(taskId);
  }, []);

  // The band's one control. The controller ignores a retry it cannot honour,
  // so the screen does not have to second-guess the status.
  const retryResume = useCallback(() => {
    resumeRef.current?.retry();
  }, []);

  // A changed `focusEpoch` means the route is on screen again after a pushed
  // conversation, so the server may have moved on (an approval decided inside
  // that conversation). The value observed at mount is the baseline: the
  // initial load already covers it, and only a later change re-reads.
  const seenFocus = useRef(focusEpoch);
  useEffect(() => {
    if (seenFocus.current === focusEpoch) return;
    seenFocus.current = focusEpoch;
    refresh();
  }, [focusEpoch, refresh]);

  if (state === null) {
    return (
      <View style={styles.container}>
        <ActivityIndicator accessibilityLabel={t("common.loading")} />
      </View>
    );
  }

  // The page is the model's; the query only narrows what the reader sees.
  // `filterGroups` returns the page object unchanged for a blank query.
  const visibleGroups = filterGroups(state.groups, query);

  return (
    <ConversationList
      initialOffset={initialOffset}
      onOpen={open}
      onQueryChange={changeQuery}
      onRefresh={refresh}
      onScrollOffset={rememberOffset}
      onToggleProject={toggleProject}
      query={query}
      resume={band ? { status: band, onRetry: retryResume } : undefined}
      state={{ ...state, groups: visibleGroups }}
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
