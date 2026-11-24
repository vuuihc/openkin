/**
 * KIN-MOBILE-001 R3 — the conversation list, wired to the phone's session.
 *
 * The pure screen (`ConversationList`) owns presentation and the headless model
 * (`listModel`) owns grouping, folds, the request state and its generation
 * rule. This container is the only place that reads the stored session, builds
 * the controller, and mirrors the model's state into React. Every callback
 * leaves the model as the one writer: a refresh asks the controller, a fold is
 * the controller's own toggle, and neither derives list state here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import type { Machine } from "../../../ui/src/lib/devices";
import { readSession, secureStoreBackend, type Session } from "../auth/tokenStore";
import { t } from "../i18n";
import {
  createListController,
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
}: ListScreenProps) {
  const [state, setState] = useState<ListViewState | null>(null);
  const controllerRef = useRef<ListController | null>(null);
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
    let local: ListController | null = null;
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
        local = createListController({
          origin: session.origin,
          token: session.token,
          selfDeviceId: self,
          machines: devices,
          t,
          formatTime: clock,
          store: folds,
          fetchImpl,
        });
        controllerRef.current = local;
        setState(local.state());
        return local.load().then((next) => {
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
      local = null;
    };
  }, [readSessionImpl, fetchImpl]);

  const refresh = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    void controller.load().then((next) => {
      if (controllerRef.current === controller) setState(next);
    });
  }, []);

  const toggleProject = useCallback((deviceId: string, projectKey: string) => {
    const controller = controllerRef.current;
    if (!controller) return;
    setState(controller.toggleProject(deviceId, projectKey));
  }, []);

  const open = useCallback((taskId: string) => {
    callbacks.current.onOpen(taskId);
  }, []);

  if (state === null) {
    return (
      <View style={styles.container}>
        <ActivityIndicator accessibilityLabel={t("common.loading")} />
      </View>
    );
  }

  return (
    <ConversationList
      onOpen={open}
      onRefresh={refresh}
      onToggleProject={toggleProject}
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
