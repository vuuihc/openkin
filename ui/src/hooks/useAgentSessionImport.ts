import { useCallback, useSyncExternalStore } from "react";
import { importAgentSessions, type AgentSessionImportResult } from "../api/client";
import { useT } from "../i18n/react";
import {
  importTargetsFor,
  mergeAgentSessionImports,
  type AgentSessionImportAttempt,
} from "../lib/agentSessionImport";
import { refreshMachines } from "./useMachines";

/**
 * Import provider sessions from the machines that hold them.
 *
 * The scan is per machine — a Mac's sessions are on the Mac — so an import that
 * only asked the daemon serving this console would leave a phone showing a
 * session list that silently means "here". What the person asked for is their
 * sessions, and which machine each one happens to be on is not a distinction
 * they should have to hold in their head.
 *
 * It is a hook rather than a function because there are several surfaces that
 * offer the same errand — the sidebar's menu, the settings section, its
 * per-provider rows and the automatic sync — and a person touching one of them
 * is asking for the same thing. Separate implementations of it is how they came
 * to differ: one asked every machine and the other only the machine the console
 * was being served from, under identical labels.
 *
 * The answers are folded by mergeAgentSessionImports, which is where the rule
 * about a machine that is away lives: the machines that did answer are the
 * result, and the one that did not is an error beside them. This never rejects;
 * a machine that cannot be reached is a result, not an exception.
 */
export function useAgentSessionImport(): {
  /** True while an import is in flight, for disabling the control that started it. */
  importing: boolean;
  importEveryMachine: (agents?: string[]) => Promise<AgentSessionImportResult>;
} {
  const tr = useT();
  const busy = useSyncExternalStore(subscribeToImports, importsInFlight, importsInFlight);

  const importEveryMachine = useCallback(
    async (agents?: string[]): Promise<AgentSessionImportResult> => {
      // The flag goes up before the machine list is read, not after: the errand
      // starts with that read, and a control that stays live through it is a
      // control that starts a second errand.
      beginImport();
      try {
        // The machine list is read here rather than taken from the hook's state:
        // this is the one place that has to name a machine it has not seen yet,
        // and a list from page load would quietly leave out a laptop paired
        // since.
        const machines = await refreshMachines();
        const attempts: AgentSessionImportAttempt[] = [];
        for (const target of importTargetsFor(agents, machines, tr("machine.thisMachine"))) {
          try {
            attempts.push({
              label: target.label,
              result: await importAgentSessions(agents, target.deviceId),
            });
          } catch (error) {
            attempts.push({ label: target.label, error });
          }
        }
        return mergeAgentSessionImports(attempts);
      } finally {
        endImport();
      }
    },
    [tr],
  );

  return { importing: busy, importEveryMachine };
}

// How many imports are running anywhere in this console. It is module state
// rather than a hook's, because the surfaces that offer the errand are on
// different pages: a fan-out started from settings leaves the sidebar's own
// button enabled, and two taps a second apart would then run two overlapping
// fan-outs whose counts are each other's duplicates.
let imports = 0;
const importListeners = new Set<() => void>();

function emitImports(): void {
  for (const listener of importListeners) listener();
}

function beginImport(): void {
  imports += 1;
  emitImports();
}

function endImport(): void {
  imports -= 1;
  emitImports();
}

function subscribeToImports(listener: () => void): () => void {
  importListeners.add(listener);
  return () => {
    importListeners.delete(listener);
  };
}

/**
 * Whether an import is running anywhere in this console.
 *
 * Exported because a caller outside React has to ask the same question and
 * cannot wait for a render to answer it: the auto-sync's 30 second tick runs on
 * a timer, and an import that started a moment ago has not rendered yet — so a
 * check against the rendered value would let the tick start a second fan-out
 * over the first, and the two would count each other's rows. Both this and the
 * hook's `importing` read the one counter, so they cannot disagree.
 */
export function importsInFlight(): boolean {
  return imports > 0;
}
