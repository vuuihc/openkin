import type { AgentSessionImportResult } from "../api/client";
import type { Machine } from "./devices";

/** One machine to ask, and what to call it when it does not answer. */
export type AgentSessionImportTarget = {
  /** The API's name for the machine. Empty means the daemon serving this console. */
  deviceId: string;
  label: string;
};

/**
 * The machines one import asks, in the order it asks them.
 *
 * This machine first, because it is the one a console without a machine list
 * still has, and its failure is the one a person can act on directly. Every
 * paired machine after it, in the order the machine list shows them.
 *
 * The local machine is named by the empty device id rather than by its own id:
 * a console reading this list has already been told which machine it is talking
 * to, and "self" is a name the API keeps working even when the id is not known
 * yet.
 */
export function importTargets(
  machines: readonly Machine[],
  thisMachineLabel: string,
): AgentSessionImportTarget[] {
  const targets: AgentSessionImportTarget[] = [{ deviceId: "", label: thisMachineLabel }];
  for (const machine of machines) {
    if (machine.isSelf) continue;
    targets.push({ deviceId: machine.id, label: machine.label });
  }
  return targets;
}

/**
 * The machines one import asks, given the provider names it was asked for.
 *
 * No names is the errand "index my sessions", and that is every machine. Names
 * are a different errand: every surface that offers a provider by name — the
 * sidebar's menu, the settings rows — read those ids out of *this* daemon's
 * registry, so a named provider means this machine's provider. Asking the other
 * machines by name would ask each of them for something it may not have, and
 * "I have no codex" is an error the reader cannot act on: it is not news about
 * their sessions.
 */
export function importTargetsFor(
  agents: readonly string[] | undefined,
  machines: readonly Machine[],
  thisMachineLabel: string,
): AgentSessionImportTarget[] {
  const named = (agents ?? []).filter((id) => id.trim() !== "");
  return named.length > 0
    ? [{ deviceId: "", label: thisMachineLabel }]
    : importTargets(machines, thisMachineLabel);
}

/** The translator, as the console hands it out. */
export type ImportToastTranslator = (
  path: string,
  params?: Record<string, string | number>,
) => string;

/**
 * What to tell the person after an import, and how loudly.
 *
 * A count alone would be answered with the wrong noun: an import that asks every
 * machine can fail because a machine is asleep, and "2 providers unavailable"
 * sends the reader to a provider list that is fine while their laptop is the
 * thing that is not.
 */
export function importToast(
  result: AgentSessionImportResult,
  tr: ImportToastTranslator,
): { message: string; kind: "info" | "error" } {
  const failures = Object.keys(result.errors ?? {}).length;
  // A capped import is said out loud rather than left in the count. The rows
  // that arrived are real, so it is not an error — but "indexed 500 sessions"
  // on its own reads as the whole of them, and a person who is not told will
  // never ask for the rest.
  const truncated = result.truncated ? ` ${tr("settings.localAgents.importTruncated")}` : "";
  if (failures === 0) {
    return {
      message: tr("settings.localAgents.imported", { imported: result.imported }) + truncated,
      kind: "info",
    };
  }
  const source = firstFailedSource(result);
  const reason = firstFailedReason(result);
  // One failure with nothing to say about it falls back to the counted form,
  // which still reads as a sentence: the reason is the half that earns the
  // name-then-reason phrasing, and without it the phrasing is a dangling colon.
  const message =
    failures === 1 && reason
      ? tr("settings.localAgents.importPartialSource", {
          imported: result.imported,
          source,
          reason,
        })
      : tr("settings.localAgents.importPartialSources", {
          imported: result.imported,
          errors: failures,
          source,
        });
  return { message: message + truncated, kind: "error" };
}

/**
 * One machine's answer, or the reason there is none.
 *
 * The label is the machine's name as a person reads it: it is what an error is
 * filed under, because "session catalog unavailable" is actionable only next to
 * the name of the machine that said it.
 */
export type AgentSessionImportAttempt = {
  label: string;
  result?: AgentSessionImportResult;
  error?: unknown;
};

/**
 * Fold per-machine imports into the one result the console reports.
 *
 * Importing sessions is one action per machine — a Mac's sessions are on the Mac
 * — but it is one *errand* for the person, who asked for their sessions and
 * should not have to hold which machine each one is on in their head. So the
 * counts add up and the errors stay separate.
 *
 * A machine that could not be reached is an error like any other rather than a
 * failed import: a laptop being asleep must not cost the phone the sessions that
 * are reachable, and the machines that did answer are already in this result.
 * This never throws, for that reason.
 */
export function mergeAgentSessionImports(
  attempts: readonly AgentSessionImportAttempt[],
): AgentSessionImportResult {
  const merged: AgentSessionImportResult = { imported: 0, providers: {}, errors: {} };
  for (const attempt of attempts) {
    if (attempt.result) {
      merged.imported += attempt.result.imported;
      // Any machine's cap is the errand's cap: the person asked for their
      // sessions, so one machine having more than it could send means the list
      // they are about to read is not all of them, whichever machine it was.
      merged.truncated = Boolean(merged.truncated || attempt.result.truncated);
      for (const [provider, count] of Object.entries(attempt.result.providers ?? {})) {
        merged.providers[provider] = (merged.providers[provider] ?? 0) + count;
      }
      for (const [key, reason] of Object.entries(attempt.result.errors ?? {})) {
        merged.errors![`${attempt.label}: ${key}`] = reason;
      }
      continue;
    }
    if (attempt.error !== undefined) {
      merged.errors![attempt.label] = describeImportFailure(attempt.error);
    }
  }
  // An empty map and no map are the same answer, and the callers count keys to
  // decide whether to show a warning. An empty object that is present is a
  // warning with nothing in it.
  if (Object.keys(merged.errors!).length === 0) delete merged.errors;
  return merged;
}

function describeImportFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The first thing that failed, named the way the error map names it.
 *
 * The keys are the machine's name for a machine that could not be reached, and
 * "machine: provider" for a provider that refused — so the key *is* the answer
 * to "what do I go look at". A count alone ("1 provider unavailable") sends the
 * reader to the provider list when the truth is that their other machine is
 * asleep, which is the failure this whole fan-out introduced.
 *
 * Deterministic: the map is built in import order, so this is the local
 * machine's first refusal if it had one, and otherwise the first machine that
 * could not be reached.
 */
export function firstFailedSource(result: AgentSessionImportResult): string {
  const keys = Object.keys(result.errors ?? {});
  return keys.length > 0 ? keys[0] : "";
}

/**
 * Why the first thing that failed failed, in the words of whoever said it.
 *
 * The name alone ("this machine did not sync") leaves the reader with nowhere to
 * go: the reason is the machine's own sentence, or the status the Hub answered
 * with, and it is the only part that says whether to try again, start a CLI, or
 * look at the other machine.
 */
export function firstFailedReason(result: AgentSessionImportResult): string {
  const source = firstFailedSource(result);
  return source ? (result.errors?.[source] ?? "") : "";
}
