import { Link, useParams } from "react-router-dom";
import { ApiError, isTerminal } from "../api/client";
import ChatStream from "../components/chat/ChatStream";
import { useMachines } from "../hooks/useMachines";
import { useRemoteTaskRun } from "../hooks/useRemoteTaskRun";
import { useT } from "../i18n/react";
import { displayUserPrompt } from "../lib/attachments";
import { routineStatusLabel } from "../lib/routineStatus";

function formatWhen(ms?: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

/**
 * One routine run, opened where it lives.
 *
 * A run is a task in the store of the machine that ran it. The Routines page
 * lists those rows by relaying that machine's console, so the id in the list
 * does not exist in this Hub's task table: the ordinary conversation page would
 * open, ask this Hub for the task, and show "not found" for a row the reader
 * just tapped. This page asks the machine that owns the run instead.
 *
 * It is read-only by design. Approvals, replies, files, and stopping a run are
 * actions on the machine's own console; the Hub relays none of them, and a
 * control that could only ever be refused is worse than no control.
 */
export default function MachineTaskPage() {
  const { device = "", id = "" } = useParams();
  const tr = useT();
  const { machines } = useMachines();
  const machine = machines.find((m) => m.id === device);
  const name = machine?.label || tr("machine.gone", { name: device });
  const run = useRemoteTaskRun(device, id);
  const task = run.task;
  const terminal = task ? isTerminal(task.status) : false;
  const title = task?.title || displayUserPrompt(task?.prompt || "") || id.slice(0, 8);
  const error =
    run.error instanceof ApiError && run.error.status === 404
      ? tr("runDetail.notFound", { name })
      : run.error
        ? tr("runDetail.loadFailed", { name })
        : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="flex-none border-b border-[var(--kin-hairline)] px-4 py-3 sm:px-7">
        <div className="mx-auto max-w-conversation">
          <Link
            to="/routines"
            className="inline-flex min-h-9 items-center gap-1 rounded text-body text-kin-secondary hover:text-kin-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kin-focus-ring"
          >
            <span aria-hidden>←</span>
            {tr("runDetail.back")}
          </Link>
          <h1 className="mt-1 text-title font-semibold leading-6 text-kin-text [overflow-wrap:anywhere]">
            {task ? title : id.slice(0, 8)}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-kin-muted">
            {task ? (
              <span>{routineStatusLabel(task.status, tr)}</span>
            ) : (
              !error && <span>{tr("runDetail.loading")}</span>
            )}
            {task && (
              <>
                <span aria-hidden>·</span>
                <span>{formatWhen(task.finished_at ?? task.created_at)}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span>{tr("runDetail.readOnly", { name })}</span>
          </div>
        </div>
      </header>

      {error && (
        <div className="flex-none border-b border-kin-red/30 bg-kin-red/10 px-4 py-2 sm:px-7">
          <div
            className="mx-auto flex max-w-conversation flex-wrap items-center gap-2 text-body text-kin-red-ink"
            role="alert"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={run.retry}
              className="min-h-9 rounded-md border border-kin-red/40 px-2 text-body font-medium hover:bg-kin-red/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kin-focus-ring"
            >
              {tr("runDetail.retry")}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto kin-scroll py-5">
        {run.loaded && run.events.length === 0 ? (
          <div className="mx-auto max-w-conversation px-4 sm:px-7">
            <div className="rounded-2xl border border-dashed border-[var(--kin-hairline-strong)] px-6 py-12 text-center">
              <p className="text-subtitle font-medium text-kin-text">{tr("runDetail.empty")}</p>
              <p className="mt-1 text-strong text-kin-secondary">{tr("runDetail.emptyHint")}</p>
            </div>
          </div>
        ) : (
          task && (
            <ChatStream
              events={run.events}
              fallbackUserPrompt={displayUserPrompt(task.prompt || "")}
              messageScope={task.id}
              loading={!run.loaded || !terminal}
              loadingSpeaker={task.agent || "kin"}
              hostSpeaker={task.agent || "kin"}
              hostModel={task.model}
              showMessageActions={false}
            />
          )
        )}
      </div>
    </div>
  );
}
