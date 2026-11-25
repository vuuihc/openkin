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
  type FoldStore,
  type ListController,
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
  appState = AppState,
  now,
  focusEpoch = 0,
}: ListScreenProps) {
  const [state, setState] = useState<ListViewState | null>(null);
  // What the reader is looking for: view state over the page the model owns.
  const [query, setQuery] = useState("");
  // The reconnect band is a network state, not a steady one: null whenever the
  // list is current.
  const [band, setBand] = useState<"resuming" | "offline" | null>(null);
  const controllerRef = useRef<ListController | null>(null);
  const resumeRef = useRef<ResumeController | null>(null);
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

  useEffect(() => {
    let live = true;
    let list: ListController | null = null;
    let resume: ResumeController | null = null;
    // A rebuilt controller starts with no band: the previous one described a
    // list (and a retry target) this effect is about to replace.
    setBand(null);
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
        const {
          selfDeviceId: self,
          machines: devices,
          formatTime: clock,
          store: folds,
        } = options.current;
        list = createListController({
          origin: session.origin,
          token: session.token,
          selfDeviceId: self,
          machines: devices,
          t,
          formatTime: clock,
          store: folds,
          fetchImpl,
        });
        controllerRef.current = list;
        setState(list.state());

        // One resume controller for the mounted screen. Its refresh is the
        // list's own load, so the rows the reader already has are never
        // cleared; the answer is mirrored only while this controller is the
        // one the screen shows.
        const mounted = list;
        resume = createResumeController({
          appState,
          refreshList: async () => {
            const next = await mounted.load();
            if (live && controllerRef.current === mounted) setState(next);
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

        return mounted.load().then((next) => {
          // The controller drops an answer from an older generation; this guard
          // drops the one that lands after the screen is gone.
          if (live) setState(next);
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
  }, [readSessionImpl, fetchImpl, appState, now]);

  const refresh = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    void controller.load().then((next) => {
      if (controllerRef.current !== controller) return;
      setState(next);
      if (next.status === "offline" || next.status === "failed") return;
      // A manual read that worked makes the band's claim false; drop the
      // series that produced it so its retry cannot start a stale one.
      resumeRef.current?.invalidate();
    });
  }, []);

  const toggleProject = useCallback((deviceId: string, projectKey: string) => {
    const controller = controllerRef.current;
    if (!controller) return;
    setState(controller.toggleProject(deviceId, projectKey));
  }, []);

  /** The query narrows the page; it never changes it. */
  const changeQuery = useCallback((next: string) => {
    setQuery(next);
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
      onOpen={open}
      onQueryChange={changeQuery}
      onRefresh={refresh}
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
