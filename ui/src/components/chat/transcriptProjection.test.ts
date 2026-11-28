import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../api/client";
import { extractChangedFiles } from "../../lib/changedFiles";
import { getLocale, setLocale, t } from "../../i18n";
import {
  buildChatItems,
  chatItemSeqRange,
  groupIntoTurns,
  noteLabelKey,
  noteNeedsAttribution,
  noteSourceOf,
  isProgressCardRunning,
  mergeProcessRuns,
  pendingRefSeqs,
  progressRows,
  roundEvidenceByTurn,
  roundsOf,
  shouldShowGenericThinking,
  summarizeProgressDetails,
  summarizeProgressStatus,
  type ChatItem,
  type NoteStep,
  type ProgressItem,
  type ToolStep,
  type Turn,
} from "./transcriptProjection";

function ev(seq: number, type: string, payload: TaskEvent["payload"]): TaskEvent {
  return {
    task_id: "task-1",
    event_epoch: 0,
    seq,
    ts: seq,
    type,
    payload,
  };
}

describe("transcriptProjection", () => {
  it("replaces Droid assistant and reasoning previews with authoritative messages", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "hel" }],
          partial: true,
          message_id: "m1",
          index: 0,
        }),
        ev(3, "message", {
          role: "reasoning",
          speaker: "kin",
          content: [{ type: "text", text: "rea" }],
          partial: true,
          message_id: "m1",
          index: 1,
        }),
        ev(4, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "hello back" }],
          partial: false,
          message_id: "m1",
          index: 0,
        }),
        ev(5, "message", {
          role: "reasoning",
          speaker: "kin",
          content: [{ type: "text", text: "reasoning complete" }],
          partial: false,
          message_id: "m1",
          index: 1,
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      { kind: "message", speaker: "user", text: "hello" },
      {
        kind: "progress",
        steps: [
          {
            kind: "note",
            // Not narration: the event says `role: "reasoning"`, which is the
            // whole reason this row can be labelled as thinking at all.
            source: "reasoning" as const,
            speaker: "kin",
            text: "reasoning complete",
            status: "done",
          },
        ],
      },
      {
        kind: "message",
        speaker: "kin",
        text: "hello back",
      },
    ]);
    expect(
      items.filter(
        (item) => item.kind === "message" && (item.text === "hel" || item.text === "hello back"),
      ),
    ).toHaveLength(1);
  });

  // Only droid stamps both halves of the identity the scan matches on: claude-code
  // sends `index` alone, ACP `message_id` alone, kinagent neither. Every one of
  // them has to end up with the same transcript.
  it.each([
    ["droid (message_id + index)", { message_id: "m1", index: 0 }],
    ["claude-code (index only)", { index: 0 }],
    ["ACP (message_id only)", { message_id: "m1" }],
    ["kinagent (neither)", {}],
  ])(
    "does not leave half an answer behind when a withdrawal lands mid-stream — %s",
    (_shape, ids) => {
      // A withdrawal can only happen while a turn is running, so its note lands
      // between two deltas of the answer being written. The note flushes the
      // streamed preview, and the scan that removes previews when the
      // authoritative message arrives used to stop at the note — leaving the
      // first half of the answer on screen next to the whole of it.
      const items = buildChatItems(
        [
          ev(1, "message", { role: "user", content: [{ type: "text", text: "ship it" }] }),
          ev(2, "message", {
            role: "assistant",
            speaker: "kin",
            content: [{ type: "text", text: "the parser is" }],
            partial: true,
            ...ids,
          }),
          ev(3, "notice", { code: "prompt_withdrawn", severity: "info", message: "withdrawn" }),
          ev(4, "message", {
            role: "assistant",
            speaker: "kin",
            content: [{ type: "text", text: "the parser is fixed" }],
            partial: true,
            ...ids,
          }),
          ev(5, "message", {
            role: "assistant",
            speaker: "kin",
            content: [{ type: "text", text: "the parser is fixed" }],
            partial: false,
            ...ids,
          }),
        ],
        "kin",
      );

      const texts = items.flatMap((item) => (item.kind === "message" ? [item.text] : []));
      expect(texts).toEqual(["ship it", "the parser is fixed"]);
      expect(items.filter((item) => item.kind === "meta")).toHaveLength(1);
    },
  );

  it("renders an adapter notice as a status line, in the order it arrived", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "acp",
          text: "working",
          partial: true,
        }),
        ev(2, "notice", {
          severity: "warning",
          title: "session loaded without replay",
          message: "the agent did not replay the conversation it loaded",
        }),
        ev(3, "message", {
          role: "assistant",
          speaker: "acp",
          text: "finished",
          partial: false,
        }),
      ],
      "acp",
    );

    expect(items).toMatchObject([
      // Split like an approval does: the text before the notice is a message of
      // its own, still open because the turn is (the turn's result settles it).
      { kind: "message", text: "working", partial: true },
      {
        kind: "meta",
        label:
          "! session loaded without replay: the agent did not replay the conversation it loaded",
      },
      { kind: "message", text: "finished" },
    ]);
  });

  it("shows the agent's plan as one coalesced line inside the process box", () => {
    const items = buildChatItems(
      [
        ev(1, "plan", {
          speaker: "acp",
          replaces: true,
          entries: [
            { content: "read the config", status: "completed", priority: "high" },
            { content: "fix the parser", status: "in_progress" },
            { content: "run the tests", status: "pending" },
          ],
        }),
        // The normal shape: a tool runs, then the plan is revised. The revision
        // rewrites the line rather than adding a second one (two notes keyed the
        // same would also collide in React).
        ev(2, "tool_use", {
          speaker: "acp",
          tool_use_id: "call-1",
          name: "read_file",
          input: { path: "/tmp/x" },
        }),
        ev(3, "plan", {
          speaker: "acp",
          replaces: true,
          entries: [
            { content: "read the config", status: "completed" },
            { content: "fix the parser", status: "completed" },
            { content: "run the tests", status: "in_progress" },
          ],
        }),
      ],
      "acp",
    );

    const progress = items.filter((item) => item.kind === "progress");
    expect(progress).toHaveLength(1);
    const notes = progress[0].steps.filter((step) => step.kind === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      key: "plan-1",
      text: "✓ read the config · ✓ fix the parser · ▸ run the tests",
      status: "running",
    });
    // The tool step it was revised around is still there, in order.
    expect(progress[0].steps.map((step) => step.kind)).toEqual(["note", "tool"]);
  });

  it("says so when the agent withdraws its plan", () => {
    const items = buildChatItems(
      [
        ev(1, "plan", {
          speaker: "acp",
          replaces: true,
          entries: [{ content: "step one", status: "pending" }],
        }),
        ev(2, "plan", { speaker: "acp", replaces: true, entries: [] }),
      ],
      "acp",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        // The literal, not t(...): t() falls back to the key path, so an
        // assertion through it passes even when the key is gone.
        steps: [{ kind: "note", text: "计划已被 agent 撤回" }],
      },
    ]);
  });

  it("marks a notice the agent reported as an error or a warning", () => {
    const items = buildChatItems(
      [
        ev(1, "notice", { speaker: "acp", severity: "info", message: "context used: 1 of 10" }),
        ev(2, "notice", {
          speaker: "acp",
          severity: "error",
          title: "disk",
          message: "the disk is full",
        }),
        ev(3, "notice", { speaker: "acp", severity: "warning", message: "slow" }),
      ],
      "acp",
    );

    expect(items).toMatchObject([
      { kind: "meta", label: "context used: 1 of 10" },
      { kind: "meta", label: "⚠ disk: the disk is full" },
      { kind: "meta", label: "! slow" },
    ]);
  });

  it("words a withdrawal note in the reader's language, not the daemon's", () => {
    // The daemon writes its note in one language and cannot know the reader's;
    // the code it carries is what lets the console say it properly. Without the
    // code the label would fall through to the payload and a Chinese console
    // would show an English sentence.
    const notes = () =>
      buildChatItems([
        ev(1, "notice", {
          code: "prompt_withdrawn",
          severity: "info",
          message: "A queued message was withdrawn before it was sent",
        }),
      ]);

    expect(notes()).toMatchObject([{ kind: "meta", label: t("chat.withdrawnNote") }]);

    const before = getLocale();
    setLocale("zh");
    try {
      expect(notes()).toMatchObject([{ kind: "meta", label: "一条排队中的消息已在发送前撤回" }]);
      // A notice without the code is still the agent's own words, untranslated.
      expect(
        buildChatItems([ev(2, "notice", { severity: "info", message: "context used: 1 of 10" })]),
      ).toMatchObject([{ kind: "meta", label: "context used: 1 of 10" }]);
    } finally {
      setLocale(before);
    }
  });

  // An interrupt cuts the running round short: the answer just stops. The toast
  // says so once, but a reader who reloads only sees a bubble with no reply and
  // concludes the agent never answered. The mark has to live in the transcript
  // itself, at the end of the round it cut.
  const interruptEvents = (): TaskEvent[] => [
    ev(1, "message", {
      role: "user",
      speaker: "user",
      content: [{ type: "text", text: "write the plan" }],
    }),
    ev(2, "message", {
      role: "assistant",
      speaker: "kin",
      partial: true,
      message_id: "m1",
      index: 0,
      content: [{ type: "text", text: "here is the first half" }],
    }),
    ev(3, "message", {
      role: "user",
      speaker: "user",
      content: [{ type: "text", text: "stop, go another way" }],
      source: "interrupt",
      interrupted: true,
    }),
  ];

  it("marks the round an interrupt cut", () => {
    const items = buildChatItems(interruptEvents(), "kin");
    const marks = items.filter((item) => item.kind === "meta");

    expect(marks).toMatchObject([{ kind: "meta", label: t("chat.interruptedNote") }]);
    // The cut half of the answer stays; the mark closes that round rather than
    // replacing anything.
    expect(
      items.some((item) => item.kind === "message" && item.text === "here is the first half"),
    ).toBe(true);
    // It sits at the end of the cut round, directly above the message that cut it.
    const markIndex = items.findIndex((item) => item.kind === "meta");
    const interruptIndex = items.findIndex(
      (item) => item.kind === "message" && item.text === "stop, go another way",
    );
    expect(interruptIndex).toBe(markIndex + 1);

    const before = getLocale();
    setLocale("zh");
    try {
      const zhMark = buildChatItems(interruptEvents(), "kin").find((item) => item.kind === "meta");
      expect(zhMark?.label).toContain("已打断");
    } finally {
      setLocale(before);
    }
  });

  it("keeps the interrupt mark when the same events are projected again", () => {
    // Reloading re-reads the same events into a fresh projection; the mark is
    // derived from them, not from the one-off toast, so it must come back — once.
    const first = buildChatItems(interruptEvents(), "kin");
    const again = buildChatItems(interruptEvents(), "kin");

    for (const items of [first, again]) {
      expect(items.filter((item) => item.kind === "meta")).toHaveLength(1);
    }
  });

  it("marks only the message that interrupted", () => {
    const followUp = buildChatItems(
      [
        ev(1, "message", { role: "user", content: [{ type: "text", text: "go" }] }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "ok" }],
        }),
        ev(3, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "and then" }],
          source: "follow_up",
        }),
      ],
      "kin",
    );
    expect(followUp.filter((item) => item.kind === "meta")).toHaveLength(0);

    const twice = buildChatItems(
      [
        ev(1, "message", { role: "user", content: [{ type: "text", text: "one" }] }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "a" }],
        }),
        ev(3, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "two" }],
          source: "interrupt",
          interrupted: true,
        }),
        ev(4, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "b" }],
        }),
        ev(5, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "three" }],
          source: "interrupt",
          interrupted: true,
        }),
      ],
      "kin",
    );
    expect(twice.filter((item) => item.kind === "meta")).toHaveLength(2);
  });

  it("does not double-mark when the canceled error follows the interrupt", () => {
    // The adapter reports the cancel it caused as an error; it is noise, not a
    // second interruption, and it must not add a second line.
    const items = buildChatItems(
      [...interruptEvents(), ev(4, "error", { message: "canceled" })],
      "kin",
    );
    expect(items.filter((item) => item.kind === "meta")).toHaveLength(1);
    expect(items.some((item) => item.kind === "error")).toBe(false);
  });

  // A bare Stop (no message behind it) ends the round as a cancel error and a
  // result. The only thing that said so was a toast, and it is gone after a
  // reload: the transcript itself has to close the round.
  const stoppedEvents = (): TaskEvent[] => [
    ev(1, "message", {
      role: "user",
      speaker: "user",
      content: [{ type: "text", text: "write the plan" }],
    }),
    ev(2, "task_started", {}),
    ev(3, "message", {
      role: "assistant",
      speaker: "kin",
      partial: true,
      message_id: "m1",
      index: 0,
      content: [{ type: "text", text: "here is the first half" }],
    }),
    ev(4, "tool_use", {
      speaker: "kin",
      tool_use_id: "call-1",
      name: "bash",
      visibility: { user: true, task: true },
    }),
    ev(5, "error", { message: "canceled" }),
    ev(6, "result", { is_error: true }),
  ];

  it("marks a round a bare Stop canceled", () => {
    const items = buildChatItems(stoppedEvents(), "kin");

    const marks = items.filter((item) => item.kind === "meta");
    expect(marks).toMatchObject([{ kind: "meta", label: t("chat.stoppedNote") }]);
    // The cut half of the answer stays; the line closes the round below it,
    // after the process box the running step left behind.
    expect(
      items.map((item) =>
        item.kind === "meta" ? item.label : item.kind === "message" ? item.text : item.kind,
      ),
    ).toEqual(["write the plan", "here is the first half", "progress", t("chat.stoppedNote")]);
    // A Stop is not a failure: no error line and the step settles done.
    expect(items.some((item) => item.kind === "error")).toBe(false);
    expect(items).toMatchObject([
      { kind: "message" },
      { kind: "message" },
      { kind: "progress", steps: [{ kind: "tool", status: "done" }] },
      { kind: "meta", label: t("chat.stoppedNote") },
    ]);

    // Reloading re-reads the same events into a fresh projection; the line is
    // derived from them, not from the toast, so it comes back exactly once.
    expect(
      buildChatItems(stoppedEvents(), "kin").filter((item) => item.kind === "meta"),
    ).toHaveLength(1);

    const before = getLocale();
    setLocale("en");
    try {
      const enMark = buildChatItems(stoppedEvents(), "kin").find((item) => item.kind === "meta");
      expect(enMark).toMatchObject({ label: "Stopped this round" });
    } finally {
      setLocale(before);
    }
    setLocale("zh");
    try {
      const zhMark = buildChatItems(stoppedEvents(), "kin").find((item) => item.kind === "meta");
      expect(zhMark?.label).toContain("已停止本轮");
    } finally {
      setLocale(before);
    }
  });

  it("does not add a stop mark when the interrupt path already marked the round", () => {
    // The composer's interrupt sent a message that already closed the round.
    // The cancel error that follows is the same stop, not a second one. The
    // round really started, so the roundStarted guard is not what suppresses
    // the second line here.
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "write the plan" }],
        }),
        ev(2, "task_started", {}),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          partial: true,
          message_id: "m1",
          index: 0,
          content: [{ type: "text", text: "here is the first half" }],
        }),
        ev(4, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "stop, go another way" }],
          source: "interrupt",
          interrupted: true,
        }),
        ev(5, "error", { message: "canceled" }),
        ev(6, "result", { is_error: true }),
      ],
      "kin",
    );
    const labels = items.flatMap((item) => (item.kind === "meta" ? [item.label] : []));
    expect(labels.filter((label) => label === t("chat.stoppedNote"))).toHaveLength(0);
    expect(labels.filter((label) => label === t("chat.interruptedNote"))).toHaveLength(1);
  });

  it("does not mark a worker's cancel as the round stopping", () => {
    // Delegated workers persist their events on the parent log, stamped
    // task-only. A step canceled from the plan table is not the conversation
    // stopping, and its result must not close the host round.
    const worker = { speaker: "worker-1", visibility: { user: false, task: true } };
    const items = buildChatItems(
      [
        ev(1, "task_started", worker),
        ev(2, "error", { ...worker, message: "canceled" }),
        ev(3, "result", { ...worker, is_error: true }),
      ],
      "kin",
    );
    expect(items.filter((item) => item.kind === "meta")).toHaveLength(0);
  });

  it("does not let a worker's cancel label the host round stopped", () => {
    // The worker's cancel is task-only chatter, but the host's own failed
    // result is user-facing. Without attributing the cancel to its emitter,
    // the host failure would borrow the worker's stop and read as a Stop.
    const items = buildChatItems(
      [
        ev(1, "message", { role: "user", content: [{ type: "text", text: "go" }] }),
        ev(2, "task_started", {}),
        ev(3, "error", {
          message: "canceled",
          speaker: "worker-1",
          visibility: { user: false, task: true },
        }),
        ev(4, "result", { is_error: true }),
      ],
      "kin",
    );
    expect(items.filter((item) => item.kind === "meta")).toHaveLength(0);
  });

  it("does not mark a round stopped when the agent recovered from the cancel", () => {
    // Steering aborts emit the same cancel noise, but the round carries on and
    // ends successfully. That is not a Stop, so it gets no closing line.
    const items = buildChatItems(
      [
        ev(1, "message", { role: "user", content: [{ type: "text", text: "go" }] }),
        ev(2, "task_started", {}),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "ok" }],
        }),
        ev(4, "error", { message: "canceled" }),
        ev(5, "result", { is_error: false }),
      ],
      "kin",
    );
    expect(items.filter((item) => item.kind === "meta")).toHaveLength(0);
  });

  it("does not add a stop mark with no round above it", () => {
    // A window that starts at the cancel, or a prompt the executor never picked
    // up, has no cut round in view; claiming one stopped would point at a round
    // the reader cannot see.
    const windowStart = buildChatItems(
      [ev(1, "error", { message: "canceled" }), ev(2, "result", { is_error: true })],
      "kin",
    );
    expect(windowStart.filter((item) => item.kind === "meta")).toHaveLength(0);

    const noRoundStarted = buildChatItems(
      [
        ev(1, "message", { role: "user", content: [{ type: "text", text: "go" }] }),
        ev(2, "error", { message: "canceled" }),
        ev(3, "result", { is_error: true }),
      ],
      "kin",
    );
    expect(noRoundStarted.filter((item) => item.kind === "meta")).toHaveLength(0);
  });

  // The default claude-code agent and the fake CLI dogfood/J3 use record no
  // cancel error and no result at all: the engine drops events once the cancel
  // deletes the run. The task's terminal status is then the only durable fact
  // that the round was stopped, and the line has to come from it.
  const silentlyStoppedEvents = (): TaskEvent[] => [
    ev(1, "message", {
      role: "user",
      speaker: "user",
      content: [{ type: "text", text: "write the plan" }],
    }),
    ev(2, "task_started", {}),
    ev(3, "message", {
      role: "assistant",
      speaker: "kin",
      partial: true,
      message_id: "m1",
      index: 0,
      content: [{ type: "text", text: "here is the first half" }],
    }),
    ev(4, "tool_use", {
      speaker: "kin",
      tool_use_id: "call-1",
      name: "bash",
      visibility: { user: true, task: true },
    }),
  ];

  it("closes a round a stopped task never recorded in its events", () => {
    const items = buildChatItems(silentlyStoppedEvents(), "kin", undefined, true, "canceled");

    expect(
      items.map((item) =>
        item.kind === "meta" ? item.label : item.kind === "message" ? item.text : item.kind,
      ),
    ).toEqual(["write the plan", "here is the first half", "progress", t("chat.stoppedNote")]);
    // No adapter error to blame and no step left running: the cut is a stop,
    // not a failure.
    expect(items.some((item) => item.kind === "error")).toBe(false);
    expect(items).toMatchObject([
      { kind: "message" },
      { kind: "message" },
      { kind: "progress", steps: [{ kind: "tool", status: "done" }] },
      { kind: "meta", label: t("chat.stoppedNote") },
    ]);

    // Reloading re-projects the same events; the keyed line appears once.
    expect(
      buildChatItems(silentlyStoppedEvents(), "kin", undefined, true, "canceled").filter(
        (item) => item.kind === "meta",
      ),
    ).toHaveLength(1);
  });

  it("does not close a round while the task is live or ended another way", () => {
    // The toast is the live cue; the transcript line is the durable one and
    // only a terminal canceled task earns it.
    expect(
      buildChatItems(silentlyStoppedEvents(), "kin", undefined, false, "canceled").filter(
        (item) => item.kind === "meta",
      ),
    ).toHaveLength(0);
    expect(
      buildChatItems(silentlyStoppedEvents(), "kin", undefined, true, "succeeded").filter(
        (item) => item.kind === "meta",
      ),
    ).toHaveLength(0);
    expect(
      buildChatItems(silentlyStoppedEvents(), "kin", undefined, true, undefined).filter(
        (item) => item.kind === "meta",
      ),
    ).toHaveLength(0);
  });

  it("does not add a second line when the events already recorded the stop", () => {
    expect(
      buildChatItems(stoppedEvents(), "kin", undefined, true, "canceled").filter(
        (item) => item.kind === "meta",
      ),
    ).toHaveLength(1);
  });

  it("does not claim the task status for a round an interrupt already closed", () => {
    // An interrupt ends the round above the message that cut it and already
    // put its own line there; the canceled status describes that same stop.
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "write the plan" }],
        }),
        ev(2, "task_started", {}),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          partial: true,
          message_id: "m1",
          index: 0,
          content: [{ type: "text", text: "here is the first half" }],
        }),
        ev(4, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "stop, go another way" }],
          source: "interrupt",
          interrupted: true,
        }),
      ],
      "kin",
      undefined,
      true,
      "canceled",
    );
    const labels = items.flatMap((item) => (item.kind === "meta" ? [item.label] : []));
    expect(labels.filter((label) => label === t("chat.stoppedNote"))).toHaveLength(0);
    expect(labels.filter((label) => label === t("chat.interruptedNote"))).toHaveLength(1);
  });

  it("keeps the running round when a queued follow-up sits above the interrupt", () => {
    // The follow-up was queued while the round above it was still running and
    // never started a round of its own, so the interrupt still cuts the round
    // `task_started` opened. Its own bubble must not become the boundary that
    // makes the mark disappear.
    const items = buildChatItems(
      [
        ev(1, "message", { role: "user", content: [{ type: "text", text: "write the plan" }] }),
        ev(2, "task_started", {}),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          partial: true,
          message_id: "m1",
          index: 0,
          content: [{ type: "text", text: "here is the first half" }],
        }),
        ev(4, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "add a section" }],
          source: "follow_up",
        }),
        ev(5, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "stop, go another way" }],
          source: "interrupt",
          interrupted: true,
        }),
      ],
      "kin",
    );

    expect(
      items.map((item) =>
        item.kind === "meta" ? item.label : item.kind === "message" ? item.text : item.kind,
      ),
    ).toEqual([
      "write the plan",
      "here is the first half",
      "add a section",
      t("chat.interruptedNote"),
      "stop, go another way",
    ]);
  });

  it("does not mark an interrupt with no round above it", () => {
    // A window that starts at the interrupt message (or a user message followed
    // straight by the interrupt) has no cut round in view. Claiming "the previous
    // round was interrupted" there would point at a round the reader cannot see.
    const windowStart = buildChatItems(
      [
        ev(7, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "stop, go another way" }],
          source: "interrupt",
          interrupted: true,
        }),
      ],
      "kin",
    );
    expect(windowStart.filter((item) => item.kind === "meta")).toHaveLength(0);
    expect(windowStart).toMatchObject([
      { kind: "message", speaker: "user", text: "stop, go another way" },
    ]);

    const noAnswerYet = buildChatItems(
      [
        ev(1, "message", { role: "user", content: [{ type: "text", text: "go" }] }),
        ev(2, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "actually stop" }],
          source: "interrupt",
          interrupted: true,
        }),
      ],
      "kin",
    );
    expect(noAnswerYet.filter((item) => item.kind === "meta")).toHaveLength(0);
  });

  it("marks a round that started before it was cut, even with no answer yet", () => {
    // The interrupt can land before the first token. The executor has started,
    // so there is a round to close even though no agent item is in the window —
    // without the line the reader sees a prompt, an interrupt, and no reason
    // the first one never answered.
    const items = buildChatItems(
      [
        ev(1, "message", { role: "user", content: [{ type: "text", text: "go" }] }),
        ev(2, "task_started", { speaker: "kin" }),
        ev(3, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "actually stop" }],
          source: "interrupt",
          interrupted: true,
        }),
      ],
      "kin",
    );
    expect(items).toMatchObject([
      { kind: "message", speaker: "user", text: "go" },
      { kind: "meta", label: t("chat.interruptedNote") },
      { kind: "message", speaker: "user", text: "actually stop" },
    ]);
  });

  it("keeps the plan line when streamed progress text is interleaved with it", () => {
    // A prompt echo is streamed as partial progress text, and a plan update can
    // land in the middle of it. Both are notes in the same box, so a plan line
    // that merges with the stream (or the stream with it) is destroyed: the text
    // becomes a sentence and the plan key is gone.
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "user",
          speaker: "acp",
          content: [{ type: "text", text: "fix the " }],
          partial: true,
          phase: "progress",
        }),
        ev(2, "plan", {
          speaker: "acp",
          replaces: true,
          entries: [{ content: "read the config", status: "pending" }],
        }),
        ev(3, "message", {
          role: "user",
          speaker: "acp",
          content: [{ type: "text", text: "parser" }],
          partial: true,
          phase: "progress",
        }),
      ],
      "acp",
    );

    const notes = items.flatMap((item) =>
      item.kind === "progress" ? item.steps.filter((step) => step.kind === "note") : [],
    );
    // Three lines, in the order they arrived: the echo, the plan, and the rest of
    // the echo. The stream is settled before the plan is written, so the second
    // chunk opens a line of its own rather than being appended to a line the plan
    // has taken the place of.
    expect(notes.map((note) => (note.kind === "note" ? note.key : ""))).toEqual([
      "note-s-1",
      "plan-2",
      "note-s-3",
    ]);
    expect(notes[0]).toMatchObject({ text: "fix the " });
    expect(notes[1]).toMatchObject({ text: "· read the config" });
    expect(notes[2]).toMatchObject({ text: "parser" });
  });

  it("rewrites the plan line a message has since pushed out of the box", () => {
    // An answer closes the process box, so a later plan update has no box of its
    // own to write into. The line it updates is the one already on screen: a
    // second plan line would describe the same plan twice.
    const items = buildChatItems(
      [
        ev(1, "plan", {
          speaker: "acp",
          replaces: true,
          entries: [{ content: "first", status: "in_progress" }],
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "acp",
          content: [{ type: "text", text: "one moment" }],
          partial: false,
        }),
        ev(3, "plan", {
          speaker: "acp",
          replaces: true,
          entries: [
            { content: "first", status: "completed" },
            { content: "second", status: "in_progress" },
          ],
        }),
        ev(4, "plan", { speaker: "acp", replaces: true, entries: [] }),
      ],
      "acp",
    );

    const notes = items.flatMap((item) =>
      item.kind === "progress" ? item.steps.filter((step) => step.kind === "note") : [],
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      key: "plan-1",
      text: "计划已被 agent 撤回", // zh is the default locale in tests
      status: "done",
    });
  });

  it("gives a new round its own plan line", () => {
    const items = buildChatItems(
      [
        ev(1, "plan", {
          speaker: "acp",
          replaces: true,
          entries: [{ content: "old plan", status: "pending" }],
        }),
        ev(2, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "now do something else" }],
        }),
        ev(3, "plan", {
          speaker: "acp",
          replaces: true,
          entries: [{ content: "new plan", status: "pending" }],
        }),
      ],
      "acp",
    );

    const plans = items.flatMap((item) =>
      item.kind === "progress"
        ? item.steps.filter(
            (step): step is Extract<typeof step, { kind: "note" }> =>
              step.kind === "note" && step.key.startsWith("plan-"),
          )
        : [],
    );
    expect(plans.map((plan) => plan.text)).toEqual(["· old plan", "· new plan"]);
  });

  it("a user message carries its inline images", () => {
    const raw = "look\n\nAttached image:\n- shot.png: /Users/me/.kin/uploads/abc.png";
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: raw }],
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "message",
        speaker: "user",
        text: "look\n\nAttached image: shot.png",
        images: [{ name: "shot.png", src: "/api/uploads/abc.png" }],
      },
    ]);
    // The absolute path stays with the agent; nothing drawn carries it.
    expect(JSON.stringify(items)).not.toContain("/Users/");
  });

  it("starts a new round for prompts that do not reach the transcript as words", () => {
    // A prompt starts a round whatever it looks like once it is in the event
    // stream. Two shapes leave the message case early: a text that reads as a
    // legacy tool dump (diverted to a tool step), and a partial message (a live
    // preview). Neither is a reason for the next plan to rewrite the previous
    // round's line in place.
    const roundOf = (prompt: Record<string, unknown>) =>
      buildChatItems(
        [
          ev(1, "plan", {
            speaker: "acp",
            replaces: true,
            entries: [{ content: "old plan", status: "pending" }],
          }),
          ev(2, "message", { role: "user", speaker: "user", ...prompt }),
          ev(3, "plan", {
            speaker: "acp",
            replaces: true,
            entries: [{ content: "new plan", status: "pending" }],
          }),
        ],
        "acp",
      )
        .flatMap((item) =>
          item.kind === "progress"
            ? item.steps.filter(
                (step): step is Extract<typeof step, { kind: "note" }> =>
                  step.kind === "note" && step.key.startsWith("plan-"),
              )
            : [],
        )
        .map((plan) => plan.text);

    expect(roundOf({ text: "**bash**\n```text\nls\n```" })).toEqual(["· old plan", "· new plan"]);
    expect(roundOf({ content: [{ type: "text", text: "keep going" }], partial: true })).toEqual([
      "· old plan",
      "· new plan",
    ]);
    // The guard the round boundary keeps: a user event with no words in it
    // renders nothing and starts nothing.
    expect(roundOf({ content: [{ type: "text", text: "   " }] })).toEqual(["· new plan"]);
  });

  it("keeps the agent's reasoning out of the answer", () => {
    // What an adapter sends for a thought: role "reasoning", phase "progress".
    // This is the console half of that contract — a reasoning message belongs in
    // the process box, and a turn that ends on one must not show the agent's
    // private reasoning as its reply.
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "reasoning",
          speaker: "acp",
          content: [{ type: "text", text: "weighing the options" }],
          partial: true,
          phase: "progress",
        }),
        ev(2, "tool_use", {
          speaker: "acp",
          tool_use_id: "call-1",
          name: "read_file",
          input: { path: "/tmp/x" },
        }),
      ],
      "acp",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        steps: [
          { kind: "note", text: "weighing the options" },
          { kind: "tool", name: "read_file" },
        ],
      },
    ]);
  });

  it("keeps a delegated worker's plan off the host's line", () => {
    // A host and the worker it delegated to are two agents with two plans. The
    // worker's events carry its own speaker, so a rewritten-in-place plan line
    // that ignored the speaker would replace the host's plan with the worker's.
    const items = buildChatItems(
      [
        ev(1, "plan", {
          speaker: "acp",
          replaces: true,
          entries: [{ content: "host plan", status: "in_progress" }],
        }),
        ev(2, "plan", {
          speaker: "worker-1",
          visibility: { user: false, task: true },
          replaces: true,
          entries: [{ content: "worker plan", status: "in_progress" }],
        }),
        ev(3, "plan", { speaker: "worker-1", replaces: true, entries: [] }),
      ],
      "acp",
    );

    const plans = items.flatMap((item) =>
      item.kind === "progress"
        ? item.steps.filter((step) => step.kind === "note" && step.key.startsWith("plan-"))
        : [],
    );
    expect(plans.map((plan) => (plan.kind === "note" ? plan.text : ""))).toEqual([
      "▸ host plan",
      "计划已被 agent 撤回",
    ]);
    // The withdrawal was the worker's, so it is the worker's line that says so.
    expect(plans[1]).toMatchObject({ speaker: "worker-1" });
    expect(plans[0]).toMatchObject({ speaker: "acp" });
  });

  it("does not let a user event with no words start a new round", () => {
    // An empty user message renders nothing (it breaks before pushing an item),
    // so treating it as a round boundary would split one plan in two.
    const items = buildChatItems(
      [
        ev(1, "plan", {
          speaker: "acp",
          replaces: true,
          entries: [{ content: "one plan", status: "in_progress" }],
        }),
        ev(2, "message", {
          role: "user",
          speaker: "user",
          content: [{ type: "text", text: "   " }],
        }),
        ev(3, "plan", {
          speaker: "acp",
          replaces: true,
          entries: [{ content: "one plan", status: "completed" }],
        }),
      ],
      "acp",
    );

    const plans = items.flatMap((item) =>
      item.kind === "progress"
        ? item.steps.filter((step) => step.kind === "note" && step.key.startsWith("plan-"))
        : [],
    );
    expect(plans.map((plan) => (plan.kind === "note" ? plan.text : ""))).toEqual(["✓ one plan"]);
  });

  it("finalizes a trailing partial when the task is terminal", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "kin",
          text: "done",
          partial: true,
        }),
      ],
      "kin",
      undefined,
      true,
    );

    expect(items).toMatchObject([
      {
        kind: "message",
        speaker: "kin",
        text: "done",
        partial: false,
      },
    ]);
  });

  it("merges tool_use and tool_result into one progress tool step", () => {
    const items = buildChatItems(
      [
        ev(1, "tool_use", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "bash",
          input: { command: "npm test" },
          visibility: { user: true, task: true },
        }),
        ev(2, "tool_result", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "bash",
          output: "ok",
          ok: true,
          visibility: { user: true, task: true },
        }),
      ],
      "kin",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "progress",
      speaker: "kin",
      steps: [
        {
          kind: "tool",
          name: "bash",
          status: "done",
          output: "ok",
        },
      ],
    });
  });

  it("upserts incremental tool snapshots by tool_use_id", () => {
    const items = buildChatItems(
      [
        ev(1, "tool_use", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "bash",
          input: {},
        }),
        ev(2, "tool_use", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "bash",
          input: { command: "npm" },
        }),
        ev(3, "tool_use", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "bash",
          input: { command: "npm test" },
        }),
        ev(4, "tool_result", {
          speaker: "kin",
          tool_use_id: "call-1",
          output: "ok",
          status: "completed",
          ok: true,
        }),
      ],
      "kin",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "progress",
      steps: [
        {
          kind: "tool",
          name: "bash",
          status: "done",
          input: { command: "npm test" },
          output: "ok",
        },
      ],
    });
    expect(items[0]?.kind === "progress" ? items[0].steps : []).toHaveLength(1);
  });

  it("puts delegate chatter in progress and final orchestrator summary in chat", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          source: "delegate",
          speaker: "claude-code",
          text: "→ worker",
        }),
        ev(2, "message", {
          role: "assistant",
          source: "orchestrator",
          speaker: "kin",
          text: "完成：all good",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        steps: [{ kind: "note", speaker: "claude-code", text: "→ worker" }],
      },
      {
        kind: "message",
        speaker: "kin",
        text: "完成：all good",
      },
    ]);
  });

  it("shows a synthesized orchestrator summary regardless of its wording", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          source: "orchestrator",
          phase: "summary",
          speaker: "kin",
          text: "The workers found and fixed the root cause.",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "message",
        speaker: "kin",
        text: "The workers found and fixed the root cause.",
      },
    ]);
  });

  it("projects an explicitly task-only worker summary into process", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "worker",
          phase: "summary",
          text: "Worker completed its subtask.",
          visibility: { user: false, task: true },
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        steps: [
          {
            kind: "note",
            source: "note" as const,
            speaker: "worker",
            text: "Worker completed its subtask.",
          },
        ],
      },
    ]);
    expect(items.some((item) => item.kind === "message")).toBe(false);
  });

  it("keeps reasoning, tools, and progress narration in one process card", () => {
    const items = mergeProcessRuns(
      buildChatItems(
        [
          ev(1, "message", {
            role: "reasoning",
            phase: "progress",
            speaker: "kin",
            text: "Inspecting the repository.",
            partial: false,
            visibility: { user: true, task: true },
          }),
          ev(2, "tool_use", {
            speaker: "kin",
            tool_use_id: "call-1",
            name: "glob",
            input: { pattern: "**/*.tsx" },
            visibility: { user: true, task: true },
          }),
          ev(3, "tool_result", {
            speaker: "kin",
            tool_use_id: "call-1",
            name: "glob",
            output: "ChatStream.tsx",
            ok: true,
            visibility: { user: true, task: true },
          }),
          ev(4, "message", {
            role: "assistant",
            phase: "progress",
            speaker: "kin",
            text: "Located the rendering path.",
            partial: false,
            visibility: { user: true, task: true },
          }),
          ev(5, "message", {
            role: "assistant",
            phase: "summary",
            speaker: "kin",
            text: "Fixed the rendering path.",
            partial: false,
            visibility: { user: true, task: true },
          }),
        ],
        "kin",
      ),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "progress",
      steps: [
        { kind: "note", text: "Inspecting the repository." },
        { kind: "tool", name: "glob", status: "done" },
        { kind: "note", text: "Located the rendering path." },
      ],
    });
    expect(items[1]).toMatchObject({
      kind: "message",
      text: "Fixed the rendering path.",
    });
  });

  it("keeps reasoning and narration in the body while the turn is live, and tools in a card", () => {
    const events = [
      ev(1, "message", {
        role: "reasoning",
        phase: "progress",
        speaker: "kin",
        text: "Inspecting the repository.",
        partial: false,
        visibility: { user: true, task: true },
      }),
      ev(2, "tool_use", {
        speaker: "kin",
        tool_use_id: "call-1",
        name: "glob",
        input: { pattern: "**/*.tsx" },
        visibility: { user: true, task: true },
      }),
      ev(3, "tool_result", {
        speaker: "kin",
        tool_use_id: "call-1",
        name: "glob",
        output: "ChatStream.tsx",
        ok: true,
        visibility: { user: true, task: true },
      }),
      ev(4, "message", {
        role: "assistant",
        phase: "progress",
        speaker: "kin",
        text: "Located the rendering path.",
        partial: false,
        visibility: { user: true, task: true },
      }),
      ev(5, "tool_use", {
        speaker: "kin",
        tool_use_id: "call-2",
        name: "read",
        input: { path: "ChatStream.tsx" },
        visibility: { user: true, task: true },
      }),
      ev(6, "tool_result", {
        speaker: "kin",
        tool_use_id: "call-2",
        name: "read",
        output: "export default function ChatStream() {}",
        ok: true,
        visibility: { user: true, task: true },
      }),
      ev(7, "message", {
        role: "assistant",
        phase: "summary",
        speaker: "kin",
        text: "Fixed the rendering path.",
        partial: false,
        visibility: { user: true, task: true },
      }),
    ];

    // Live: every note is its own body item, in the order it happened; the
    // tools between them keep a card. The projection's own items are folded by
    // `mergeProcessRuns` in the stream, which is what the reader sees.
    const live = mergeProcessRuns(buildChatItems(events, "kin", undefined, false), true);

    expect(live.map((item) => item.kind)).toEqual([
      "progress",
      "progress",
      "progress",
      "progress",
      "message",
    ]);
    expect(live[0]).toMatchObject({
      kind: "progress",
      steps: [{ kind: "note", source: "reasoning", text: "Inspecting the repository." }],
    });
    expect(live[1]).toMatchObject({
      kind: "progress",
      steps: [{ kind: "tool", name: "glob", status: "done" }],
    });
    expect(live[2]).toMatchObject({
      kind: "progress",
      steps: [{ kind: "note", source: "note", text: "Located the rendering path." }],
    });
    expect(live[3]).toMatchObject({
      kind: "progress",
      steps: [{ kind: "tool", name: "read", status: "done" }],
    });
    expect(live[4]).toMatchObject({
      kind: "message",
      text: "Fixed the rendering path.",
    });

    // A note item is keyed by the note itself: the key survives stream updates
    // and is what the find bar points at.
    for (const item of live.slice(0, 4)) {
      const progress = item as ProgressItem;
      expect(progress.steps).toHaveLength(1);
      expect(progress.key).toBe(progress.steps[0].key);
    }

    // Settled: the same turn is one process card plus the final answer, exactly
    // as it was before the live split.
    const settled = mergeProcessRuns(buildChatItems(events, "kin", undefined, true));
    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({
      kind: "progress",
      steps: [
        { kind: "note", text: "Inspecting the repository." },
        { kind: "tool", name: "glob", status: "done" },
        { kind: "note", text: "Located the rendering path." },
        { kind: "tool", name: "read", status: "done" },
      ],
    });
    expect(settled[1]).toMatchObject({
      kind: "message",
      text: "Fixed the rendering path.",
    });
  });

  it("converts legacy tool dump messages into progress tool steps", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "kin",
          text: "**bash**\n```text\nERROR: nope\n```",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        steps: [
          {
            kind: "tool",
            name: "bash",
            status: "error",
            output: "ERROR: nope",
          },
        ],
      },
    ]);
  });

  it("coalesces multiple partial deltas into one streaming message", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "Hel" }],
          partial: true,
        }),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "lo" }],
          partial: true,
        }),
        ev(4, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "Hello world" }],
          partial: false,
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      { kind: "message", speaker: "user", text: "hi" },
      { kind: "message", speaker: "kin", text: "Hello world" },
    ]);
    // No leftover partial item.
    expect(items.filter((i) => i.kind === "message" && i.partial)).toHaveLength(0);
  });

  it("reclassifies a content preview when its final message is progress", () => {
    const items = mergeProcessRuns(
      buildChatItems(
        [
          ev(1, "message", {
            role: "assistant",
            speaker: "kin",
            text: "I will inspect",
            partial: true,
          }),
          ev(2, "message", {
            role: "assistant",
            phase: "progress",
            speaker: "kin",
            text: "I will inspect the files.",
            partial: false,
          }),
          ev(3, "tool_use", {
            speaker: "kin",
            tool_use_id: "call-1",
            name: "read_file",
            input: { path: "README.md" },
            visibility: { user: true, task: true },
          }),
        ],
        "kin",
      ),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "progress",
      steps: [
        { kind: "note", text: "I will inspect the files." },
        { kind: "tool", name: "read_file" },
      ],
    });
  });

  it("keeps a live partial while the task is still running", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "Hel" }],
          partial: true,
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          content: [{ type: "text", text: "lo" }],
          partial: true,
        }),
      ],
      "kin",
      undefined,
      false,
    );
    expect(items).toMatchObject([
      { kind: "message", speaker: "kin", text: "Hello", partial: true },
    ]);
  });

  it("drops whitespace-only partials before a tool and terminal event", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "kin",
          text: "\n \t",
          partial: true,
        }),
        ev(2, "tool_use", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "read_file",
          input: { path: "README.md" },
          visibility: { user: true, task: true },
        }),
        ev(3, "tool_result", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "read_file",
          output: "contents",
          ok: true,
          visibility: { user: true, task: true },
        }),
        ev(4, "result", { is_error: false }),
      ],
      "kin",
      undefined,
      true,
    );

    expect(items.filter((item) => item.kind === "message")).toEqual([]);
    expect(items).toMatchObject([
      {
        kind: "progress",
        steps: [{ kind: "tool", name: "read_file", status: "done" }],
      },
    ]);
  });

  it("drops an empty process created by whitespace-only reasoning", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "reasoning",
          phase: "progress",
          speaker: "kin",
          text: "\n \t",
          partial: true,
        }),
        ev(2, "result", { is_error: false }),
      ],
      "kin",
      undefined,
      true,
    );

    expect(items).toEqual([]);
  });

  it("finalizes a visible partial before an error", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "kin",
          text: "Partial answer",
          partial: true,
        }),
        ev(2, "error", { message: "provider failed" }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "message",
        text: "Partial answer",
        partial: false,
      },
      { kind: "error", message: "provider failed" },
    ]);
  });

  it("marks a reasoning-only process failed when the turn errors", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "reasoning",
          phase: "progress",
          speaker: "kin",
          text: "Inspecting the provider.",
          partial: true,
        }),
        ev(2, "error", { message: "provider failed" }),
      ],
      "kin",
    );
    const process = items.find((item): item is ProgressItem => item.kind === "progress");

    expect(process?.steps).toMatchObject([{ kind: "note", status: "error" }]);
    expect(summarizeProgressStatus(process?.steps ?? [], false).state).toBe("failed");
  });

  it("finalizes interleaved content and reasoning previews on error", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "kin",
          text: "Partial answer",
          partial: true,
        }),
        ev(2, "message", {
          role: "reasoning",
          phase: "progress",
          speaker: "kin",
          text: "Checking the provider",
          partial: true,
        }),
        ev(3, "error", { message: "provider failed" }),
      ],
      "kin",
    );

    expect(items.some((item) => item.kind === "message" && item.partial)).toBe(false);
    expect(items).toMatchObject([
      { kind: "message", text: "Partial answer", partial: false },
      {
        kind: "progress",
        steps: [{ kind: "note", status: "error" }],
      },
      { kind: "error", message: "provider failed" },
    ]);
  });

  it("settles running tool steps even when a summary closed the process", () => {
    const items = buildChatItems(
      [
        ev(1, "tool_use", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "command_execution",
          visibility: { user: true, task: true },
        }),
        ev(2, "message", {
          role: "assistant",
          phase: "summary",
          speaker: "kin",
          text: "Finished.",
          partial: false,
          visibility: { user: true, task: true },
        }),
        ev(3, "result", { is_error: false }),
      ],
      "kin",
      undefined,
      true,
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        steps: [{ kind: "tool", status: "done" }],
      },
      { kind: "message", text: "Finished.", phase: "summary" },
    ]);
  });

  it("does not mark canceled process steps failed", () => {
    const items = buildChatItems(
      [
        ev(1, "tool_use", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "bash",
          visibility: { user: true, task: true },
        }),
        ev(2, "error", { message: "canceled" }),
        ev(3, "result", { is_error: true }),
      ],
      "kin",
      undefined,
      true,
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        steps: [{ kind: "tool", status: "done" }],
      },
    ]);
    expect(items.some((item) => item.kind === "error")).toBe(false);
  });

  it("does not mark interrupted process steps failed when cancel noise was filtered", () => {
    const items = buildChatItems(
      [
        ev(1, "tool_use", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "bash",
          visibility: { user: true, task: true },
        }),
        ev(2, "message", {
          role: "user",
          speaker: "user",
          source: "interrupt",
          interrupted: true,
          text: "Use a different approach",
          partial: false,
        }),
        ev(3, "result", { is_error: true }),
      ],
      "kin",
      undefined,
      true,
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        steps: [{ kind: "tool", status: "done" }],
      },
      // The interrupt also closes the round it cut, above the message that cut it.
      { kind: "meta", label: t("chat.interruptedNote") },
      { kind: "message", speaker: "user", text: "Use a different approach" },
    ]);
  });

  it("removes an earlier content preview when reasoning interleaves the stream", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "kin",
          text: "A",
          partial: true,
        }),
        ev(2, "message", {
          role: "reasoning",
          phase: "progress",
          speaker: "kin",
          text: "R",
          partial: true,
        }),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          text: "B",
          partial: true,
        }),
        ev(4, "message", {
          role: "assistant",
          phase: "summary",
          speaker: "kin",
          text: "AB",
          partial: false,
        }),
        ev(5, "result", { is_error: false }),
      ],
      "kin",
      undefined,
      true,
    );

    expect(items.filter((item) => item.kind === "message")).toMatchObject([
      { kind: "message", text: "AB" },
    ]);
    expect(items.some((item) => item.kind === "message" && item.partial)).toBe(false);
  });

  it("projects an arbitrary plugin host without a speaker whitelist", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "user",
          content: [{ type: "text", text: "ship it" }],
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "future-agent",
          text: "host reply from a new plugin",
          visibility: { user: true, task: true },
        }),
      ],
      "future-agent",
    );

    expect(items).toMatchObject([
      { kind: "message", speaker: "user", text: "ship it" },
      {
        kind: "message",
        speaker: "future-agent",
        text: "host reply from a new plugin",
      },
    ]);
  });

  it("accepts explicit agent field for arbitrary plugin speakers", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          agent: "future-agent",
          text: "identity via agent field",
          visibility: { user: true, task: true },
        }),
      ],
      "future-agent",
    );

    expect(items).toMatchObject([
      {
        kind: "message",
        speaker: "future-agent",
        text: "identity via agent field",
      },
    ]);
  });

  it("keeps future-agent worker chatter in progress via visibility metadata", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "future-agent",
          text: "worker scratch notes",
          visibility: { user: false, task: true },
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          text: "host summary after workers",
          visibility: { user: true, task: true },
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        speaker: "kin",
        steps: [
          {
            kind: "note",
            source: "note" as const,
            speaker: "future-agent",
            text: "worker scratch notes",
          },
        ],
      },
      {
        kind: "message",
        speaker: "kin",
        text: "host summary after workers",
      },
    ]);
  });

  // The subagent's tools are not the host's tools. They are on the stream, and the
  // surface that shows them is fed from the same stream (see the plan's S1b
  // decision); the host's chat column is not that surface. Rendering them here
  // would credit the host with commands it never ran -- which is why the engine
  // keeps worker events task-only instead of flipping them user-facing.
  it("keeps a worker's tool calls out of the host's chat column", () => {
    const items = buildChatItems(
      [
        ev(1, "tool_use", {
          name: "Bash",
          tool_name: "Bash",
          input: { command: "pnpm build" },
          summary: "Bash(pnpm build)",
          status: "running",
          speaker: "future-agent",
          agent: "future-agent",
          source: "future-agent",
          execution_id: "exec-1",
          execution_step: 1,
          visibility: { user: false, task: true },
        }),
        ev(2, "tool_result", {
          name: "Bash",
          tool_name: "Bash",
          output: "built",
          ok: true,
          status: "done",
          speaker: "future-agent",
          agent: "future-agent",
          source: "future-agent",
          execution_id: "exec-1",
          execution_step: 1,
          visibility: { user: false, task: true },
        }),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          text: "host answer",
          visibility: { user: true, task: true },
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([{ kind: "message", speaker: "kin", text: "host answer" }]);
    expect(JSON.stringify(items)).not.toContain("pnpm build");
  });

  it("uses future-agent as host while a built-in worker stays in progress", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          source: "delegate",
          speaker: "claude-code",
          text: "→ delegated worker",
          visibility: { user: false, task: true },
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "future-agent",
          text: "host closes the turn",
          visibility: { user: true, task: true },
        }),
      ],
      "future-agent",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        speaker: "future-agent",
        steps: [
          {
            kind: "note",
            source: "note" as const,
            speaker: "claude-code",
            text: "→ delegated worker",
          },
        ],
      },
      {
        kind: "message",
        speaker: "future-agent",
        text: "host closes the turn",
      },
    ]);
  });

  it("preserves legacy kin host and built-in worker events without visibility", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          source: "delegate",
          speaker: "codex",
          text: "legacy worker note",
        }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          text: "legacy host reply",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "progress",
        steps: [{ kind: "note", speaker: "codex", text: "legacy worker note" }],
      },
      {
        kind: "message",
        speaker: "kin",
        text: "legacy host reply",
      },
    ]);
  });

  it("does not treat control source labels as speakers", () => {
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          source: "follow_up",
          text: "follow-up reply",
          visibility: { user: true, task: true },
        }),
      ],
      "future-agent",
    );

    expect(items).toMatchObject([
      {
        kind: "message",
        speaker: "future-agent",
        text: "follow-up reply",
      },
    ]);
  });

  it("groups projected items into user and agent turns", () => {
    const items = buildChatItems(
      [
        ev(1, "message", { role: "user", text: "do it" }),
        ev(2, "message", {
          role: "assistant",
          speaker: "kin",
          text: "working",
        }),
        ev(3, "approval_requested", {}),
      ],
      "kin",
    );

    const turns = groupIntoTurns(items, "kin");
    expect(turns).toMatchObject([
      { kind: "user" },
      { kind: "agent", speaker: "kin", items: [{ text: "working" }, { kind: "meta" }] },
    ]);
  });

  it("groups turns under an arbitrary plugin host speaker", () => {
    const items = buildChatItems(
      [
        ev(1, "message", { role: "user", text: "go" }),
        ev(2, "message", {
          role: "assistant",
          speaker: "future-agent",
          text: "on it",
          visibility: { user: true, task: true },
        }),
      ],
      "future-agent",
    );

    const turns = groupIntoTurns(items, "future-agent");
    expect(turns).toMatchObject([
      { kind: "user" },
      {
        kind: "agent",
        speaker: "future-agent",
        items: [{ kind: "message", speaker: "future-agent", text: "on it" }],
      },
    ]);
  });
});

it("suppresses cancel error events from steer interrupts", () => {
  const items = buildChatItems(
    [
      ev(1, "message", {
        role: "user",
        content: [{ type: "text", text: "do X" }],
      }),
      ev(2, "tool_use", {
        speaker: "kin",
        tool_use_id: "call-1",
        name: "bash",
        input: { command: "echo hi" },
      }),
      ev(3, "error", { message: "canceled" }),
      ev(4, "message", {
        role: "user",
        content: [{ type: "text", text: "do Y instead" }],
        source: "interrupt",
      }),
    ],
    "kin",
  );
  expect(items.some((i) => i.kind === "error")).toBe(false);
  expect(
    items.filter((i) => i.kind === "message").map((i) => (i as any).text || (i as any).role),
  ).toBeTruthy();
});

describe("mergeProcessRuns", () => {
  function progress(key: string, status: "running" | "done" | "error" = "done"): ProgressItem {
    return {
      kind: "progress",
      key,
      speaker: "kin",
      steps: [
        { kind: "tool", key: `${key}-t`, speaker: "kin", name: "bash", summary: "bash", status },
      ],
    };
  }

  function message(key: string, text: string, partial = false): ChatItem {
    return { kind: "message", key, speaker: "kin", text, partial };
  }

  function progressWithNotes(key: string, notes: string[]): ProgressItem {
    return {
      kind: "progress",
      key,
      speaker: "kin",
      steps: [
        {
          kind: "tool",
          key: `${key}-t1`,
          speaker: "kin",
          name: "bash",
          summary: "bash",
          status: "done" as const,
        },
        ...notes.map((text, i) => ({
          kind: "note" as const,
          source: "note" as const,
          key: `${key}-n${i}`,
          speaker: "kin",
          text,
          status: "done" as const,
        })),
        {
          kind: "tool",
          key: `${key}-t2`,
          speaker: "kin",
          name: "read",
          summary: "read",
          status: "done" as const,
        },
      ],
    };
  }

  it("keeps narration notes and tool blocks in one process card", () => {
    const items: ChatItem[] = [
      progressWithNotes("p1", ["Plan loaded.", "Implementing changes."]),
      message("final", "Here is the summary."),
    ];

    const merged = mergeProcessRuns(items);

    expect(merged.map((x) => x.kind)).toEqual(["progress", "message"]);
    expect(merged[0]).toMatchObject({
      kind: "progress",
      steps: [
        { kind: "tool", name: "bash" },
        { kind: "note", text: "Plan loaded." },
        { kind: "note", text: "Implementing changes." },
        { kind: "tool", name: "read" },
      ],
    });
    expect(merged[1]).toMatchObject({
      kind: "message",
      text: "Here is the summary.",
    });
  });

  it("preserves a single tool-only progress card key and shape", () => {
    const items: ChatItem[] = [progress("p1"), message("final", "done")];
    const merged = mergeProcessRuns(items);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      kind: "progress",
      key: "p1",
      speaker: "kin",
    });
    expect((merged[0] as ProgressItem).steps).toEqual((items[0] as ProgressItem).steps);
    expect(merged[1]).toEqual(items[1]);
  });

  it("keeps the anchor key stable when later progress is merged", () => {
    const summary = {
      ...message("final", "done"),
      phase: "summary",
    };
    const initial = mergeProcessRuns([progress("p1"), summary]);
    const updated = mergeProcessRuns([progress("p1"), progress("p2"), summary]);

    expect(initial[0]).toMatchObject({ kind: "progress", key: "p1" });
    expect(updated[0]).toMatchObject({ kind: "progress", key: "p1" });
  });

  it("keeps the last legacy assistant message final and folds earlier narration", () => {
    const items: ChatItem[] = [
      { kind: "message", key: "u1", speaker: "user", text: "hi" },
      progress("p1"),
      message("m1", "working"),
      progress("p2"),
      message("final", "done"),
    ];

    const merged = mergeProcessRuns(items);
    expect(merged[0]).toMatchObject({ kind: "message", speaker: "user" });
    expect(merged).toHaveLength(3);
    expect(merged[1]).toMatchObject({
      kind: "progress",
      steps: [
        { kind: "tool", name: "bash" },
        { kind: "note", text: "working" },
        { kind: "tool", name: "bash" },
      ],
    });
    expect(merged[2]).toMatchObject({ kind: "message", text: "done" });
  });

  it("keeps a still-streaming trailing message live instead of folding it", () => {
    const items: ChatItem[] = [
      progress("p1"),
      message("m1", "working"),
      message("live", "typing...", true),
    ];

    const merged = mergeProcessRuns(items);
    expect(merged).toHaveLength(3);
    expect(merged[0].kind).toBe("progress");
    expect(merged[1]).toMatchObject({ key: "m1", text: "working", partial: false });
    expect(merged[2]).toMatchObject({ key: "live", partial: true });
  });

  it("does not move later progress ahead of a live partial", () => {
    const summary = {
      ...message("final", "done"),
      phase: "summary",
    };
    const merged = mergeProcessRuns([
      progress("before"),
      message("live", "still streaming", true),
      progress("after"),
      summary,
    ]);

    expect(merged.map((item) => item.kind)).toEqual(["progress", "message", "progress", "message"]);
    expect(merged[0]).toMatchObject({
      key: "before",
      steps: [{ kind: "tool", key: "before-t" }],
    });
    expect(merged[1]).toMatchObject({ key: "live", partial: true });
    expect(merged[2]).toMatchObject({
      key: "after",
      steps: [{ kind: "tool", key: "after-t" }],
    });
    expect(merged[3]).toMatchObject({
      key: "final",
      phase: "summary",
    });
  });

  it("splits only the trailing run, so a finished round keeps its card", () => {
    // A follow-up posts into the same task: it is still non-terminal, but the
    // first round already ended at the user message and must not re-open.
    const items: ChatItem[] = [
      progressWithNotes("p1", ["First round note."]),
      message("final", "First round answer."),
      { kind: "message", key: "u2", speaker: "user", text: "follow up" },
      progressWithNotes("p2", ["Second round note."]),
      message("live", "still working", true),
    ];

    const merged = mergeProcessRuns(items, true);

    // Round one keeps the exact card it had while it was the live round.
    expect(merged[0]).toMatchObject({
      kind: "progress",
      key: "p1",
      steps: [
        { kind: "tool", name: "bash" },
        { kind: "note", text: "First round note." },
        { kind: "tool", name: "read" },
      ],
    });
    expect((merged[0] as ProgressItem).prose).toBeUndefined();
    expect((merged[0] as ProgressItem).live).toBeUndefined();

    // Round two is the live one: its note is body prose, its tools a card.
    const liveNote = merged.find(
      (item): item is ProgressItem =>
        item.kind === "progress" &&
        item.steps.some((step) => step.kind === "note" && step.text === "Second round note."),
    );
    expect(liveNote?.prose).toBe(true);
    const liveTool = merged.find(
      (item): item is ProgressItem =>
        item.kind === "progress" &&
        item.steps.some((step) => step.kind === "tool" && step.key === "p2-t1"),
    );
    expect(liveTool?.live).toBe(true);
  });

  it("merges consecutive progress cards without splitting notes", () => {
    const a: ProgressItem = {
      kind: "progress",
      key: "a",
      speaker: "kin",
      steps: [
        { kind: "tool", key: "a-t", speaker: "kin", name: "bash", summary: "bash", status: "done" },
        {
          kind: "note",
          key: "a-n",
          speaker: "kin",
          text: "mid note",
          status: "done",
          source: "note",
        },
      ],
    };
    const b: ProgressItem = {
      kind: "progress",
      key: "b",
      speaker: "kin",
      steps: [
        { kind: "tool", key: "b-t", speaker: "kin", name: "read", summary: "read", status: "done" },
      ],
    };
    const merged = mergeProcessRuns([a, b, message("final", "done")]);
    expect(merged.map((x) => x.kind)).toEqual(["progress", "message"]);
    expect(merged[0]).toMatchObject({
      kind: "progress",
      steps: [
        { kind: "tool", name: "bash" },
        { kind: "note", text: "mid note" },
        { kind: "tool", name: "read" },
      ],
    });
    expect(merged[1]).toMatchObject({ text: "done" });
  });

  // -- Route event rendering (US2, US6, US7: route_decision / route_fallback) --

  it("renders route_decision as a meta item with phase, provider, model, and team", () => {
    const items = buildChatItems(
      [
        ev(1, "route_decision", {
          phase: "execute",
          provider: "prov-a",
          model: "a-smart-1",
          team: "t1",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "meta",
        key: "rd-1",
        label: "Routing: execute → prov-a/a-smart-1 (team: t1)",
      },
    ]);
  });

  it("renders route_decision without team when team is missing", () => {
    const items = buildChatItems(
      [
        ev(1, "route_decision", {
          phase: "plan",
          provider: "prov-b",
          model: "b-fast",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "meta",
        key: "rd-1",
        label: "Routing: plan → prov-b/b-fast",
      },
    ]);
  });

  it("renders route_fallback as a meta item with source and destination", () => {
    const items = buildChatItems(
      [
        ev(1, "route_fallback", {
          provider: "prov-b",
          model: "b-smart",
          fallback_from: { provider: "prov-a", model: "a-smart-1" },
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "meta",
        key: "rf-1",
        label: "Fallback: prov-a/a-smart-1 → prov-b/b-smart",
      },
    ]);
  });

  it("renders route_fallback with unknown source when fallback_from is missing", () => {
    const items = buildChatItems(
      [
        ev(1, "route_fallback", {
          provider: "prov-c",
          model: "c-free",
        }),
      ],
      "kin",
    );

    expect(items).toMatchObject([
      {
        kind: "meta",
        key: "rf-1",
        label: "Fallback: unknown → prov-c/c-free",
      },
    ]);
  });

  it("route events flush the stream and do not leave a dangling progress", () => {
    // A route_decision between two assistant messages should flush the
    // streaming partial and appear as a standalone meta item.
    const items = buildChatItems(
      [
        ev(1, "message", {
          role: "assistant",
          speaker: "kin",
          text: "partial",
          partial: true,
        }),
        ev(2, "route_decision", {
          phase: "review",
          provider: "prov-a",
          model: "a-smart-1",
        }),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          text: "final answer",
          partial: false,
        }),
      ],
      "kin",
    );

    // Note: route_decision's flushStream only clears streaming progress buffers,
    // not standalone message partials. The partial remains partial.
    expect(items).toMatchObject([
      { kind: "message", text: "partial" },
      { kind: "meta", key: "rd-2", label: "Routing: review → prov-a/a-smart-1" },
      { kind: "message", text: "final answer" },
    ]);
  });
});

describe("shouldShowGenericThinking", () => {
  it("only shows before the current round has displayable agent content", () => {
    const completed: ProgressItem = {
      kind: "progress",
      key: "completed",
      speaker: "kin",
      steps: [
        {
          kind: "tool",
          key: "tool",
          speaker: "kin",
          name: "read_file",
          summary: "done",
          status: "done",
        },
      ],
    };
    expect(shouldShowGenericThinking([completed], true)).toBe(false);
    expect(
      shouldShowGenericThinking(
        [
          {
            kind: "message",
            key: "previous",
            speaker: "kin",
            text: "previous answer",
          },
          { kind: "message", key: "user", speaker: "user", text: "next" },
        ],
        true,
      ),
    ).toBe(true);
    expect(shouldShowGenericThinking([], true)).toBe(true);
    expect(shouldShowGenericThinking([], false)).toBe(false);
  });
});

describe("isProgressCardRunning", () => {
  it("keeps only the latest process card live without showing generic dots", () => {
    const earlier: ProgressItem = {
      kind: "progress",
      key: "earlier",
      speaker: "kin",
      steps: [
        {
          kind: "tool",
          key: "earlier-tool",
          speaker: "kin",
          name: "read_file",
          summary: "done",
          status: "done",
        },
      ],
    };
    const latest: ProgressItem = {
      kind: "progress",
      key: "latest",
      speaker: "kin",
      steps: [
        {
          kind: "tool",
          key: "latest-tool",
          speaker: "kin",
          name: "bash",
          summary: "done",
          status: "done",
        },
      ],
    };
    const items: ChatItem[] = [earlier, latest];

    expect(shouldShowGenericThinking(items, true)).toBe(false);
    expect(isProgressCardRunning(items, earlier, true)).toBe(false);
    expect(isProgressCardRunning(items, latest, true)).toBe(true);
    expect(isProgressCardRunning(items, latest, false)).toBe(false);
  });

  it("stops a process card once a final summary is displayed", () => {
    const progress: ProgressItem = {
      kind: "progress",
      key: "process",
      speaker: "kin",
      steps: [
        {
          kind: "tool",
          key: "tool",
          speaker: "kin",
          name: "bash",
          summary: "running",
          status: "running",
        },
      ],
    };
    const items: ChatItem[] = [
      progress,
      {
        kind: "message",
        key: "summary",
        speaker: "kin",
        text: "Finished.",
        phase: "summary",
      },
    ];

    expect(isProgressCardRunning(items, progress, true)).toBe(false);
  });
});

describe("summarizeProgressDetails", () => {
  it("counts tool types and uses the latest non-empty note", () => {
    const item: ProgressItem = {
      kind: "progress",
      key: "process",
      speaker: "kin",
      steps: [
        {
          kind: "tool",
          key: "r1",
          speaker: "kin",
          name: "read_file",
          summary: "read",
          status: "done",
        },
        {
          kind: "note",
          key: "n1",
          speaker: "kin",
          text: "Inspecting files",
          status: "done",
          source: "note",
        },
        { kind: "tool", key: "g1", speaker: "kin", name: "glob", summary: "glob", status: "done" },
        {
          kind: "tool",
          key: "r2",
          speaker: "kin",
          name: "read_file",
          summary: "read",
          status: "done",
        },
        {
          kind: "note",
          source: "note" as const,
          key: "n2",
          speaker: "kin",
          text: "  Located\nrendering path.  ",
          status: "done",
        },
        { kind: "note", key: "n3", speaker: "kin", text: " \n ", status: "done", source: "note" },
        { kind: "tool", key: "b1", speaker: "kin", name: "bash", summary: "bash", status: "done" },
      ],
    };

    expect(summarizeProgressDetails(item.steps)).toEqual({
      toolCounts: "read × 2 · glob × 1 · shell × 1",
      latestNote: "Located rendering path.",
      noteCount: 2,
    });
  });
});

describe("summarizeProgressStatus", () => {
  it("ignores notes when classifying failed tool execution", () => {
    const item: ProgressItem = {
      kind: "progress",
      key: "failed",
      speaker: "kin",
      steps: [
        {
          kind: "note",
          source: "note" as const,
          key: "note",
          speaker: "kin",
          text: "Attempt finished.",
          status: "done",
        },
        {
          kind: "tool",
          key: "tool",
          speaker: "kin",
          name: "bash",
          summary: "failed",
          status: "error",
        },
      ],
    };

    expect(summarizeProgressStatus(item.steps, false)).toEqual({
      state: "failed",
      doneTools: 0,
      failedTools: 1,
      failedNotes: 0,
      totalTools: 1,
    });
  });

  it("classifies mixed tool results as partially failed", () => {
    const item: ProgressItem = {
      kind: "progress",
      key: "mixed",
      speaker: "kin",
      steps: [
        {
          kind: "tool",
          key: "done",
          speaker: "kin",
          name: "read_file",
          summary: "done",
          status: "done",
        },
        {
          kind: "tool",
          key: "failed",
          speaker: "kin",
          name: "bash",
          summary: "failed",
          status: "error",
        },
      ],
    };

    expect(summarizeProgressStatus(item.steps, false)).toEqual({
      state: "partial_failed",
      doneTools: 1,
      failedTools: 1,
      failedNotes: 0,
      totalTools: 2,
    });
  });

  it("classifies a reasoning-only failed process as failed", () => {
    const steps: ProgressItem["steps"] = [
      {
        kind: "note",
        source: "note" as const,
        key: "reasoning",
        speaker: "kin",
        text: "Provider reasoning before failure.",
        status: "error",
      },
    ];

    expect(summarizeProgressStatus(steps, false).state).toBe("failed");
  });

  it("counts a failed note when the card holds no tools", () => {
    // A settled card can hold only notes. Its state comes from their statuses,
    // so the failure sentence has to count them too — otherwise a red card
    // reads "0 failed".
    const steps: ProgressItem["steps"] = [
      {
        kind: "note",
        source: "note" as const,
        key: "ok",
        speaker: "kin",
        text: "Parsing.",
        status: "done",
      },
      {
        kind: "note",
        source: "note" as const,
        key: "bad",
        speaker: "kin",
        text: "The provider dropped.",
        status: "error",
      },
    ];

    expect(summarizeProgressStatus(steps, false)).toMatchObject({
      state: "partial_failed",
      failedTools: 0,
      failedNotes: 1,
    });
  });
});

describe("turn seq ranges", () => {
  const hostToolUse = (seq: number, id: string, name: string, path: string) =>
    ev(seq, "tool_use", {
      name,
      tool_name: name,
      tool_use_id: id,
      input: { path },
      summary: `${name} ${path}`,
      status: "running",
      speaker: "kin",
      visibility: { user: true, task: true },
    });
  const hostToolResult = (seq: number, id: string, name: string) =>
    ev(seq, "tool_result", {
      name,
      tool_name: name,
      tool_use_id: id,
      ok: true,
      output: "ok",
      summary: `${name} done`,
      status: "done",
      speaker: "kin",
      visibility: { user: true, task: true },
    });
  const userTurn = (seq: number, text: string) =>
    ev(seq, "message", {
      role: "user",
      speaker: "user",
      text,
      visibility: { user: true, task: true },
    });

  /**
   * Three rounds. The middle one ends with a tool call whose result arrives after
   * it, and the last one is the newest in the stream, so the two shapes the range
   * has to get right -- a turn closed by the next turn, and a turn with nothing
   * after it to close it -- are both in here.
   */
  const threeRounds = (): TaskEvent[] => [
    userTurn(1, "fix the parser"),
    hostToolUse(2, "t1", "edit", "internal/parse.go"),
    hostToolResult(3, "t1", "edit"),
    // Nothing in the projection comes from this one, and it is still the first
    // turn's: the range has to cover it, or an event that matters later would be
    // missing from the turn's evidence.
    ev(4, "raw_output", { text: "cli noise", speaker: "kin" }),
    ev(5, "message", {
      role: "assistant",
      speaker: "kin",
      text: "parser fixed",
      visibility: { user: true, task: true },
    }),
    userTurn(6, "now the docs"),
    hostToolUse(7, "t2", "write", "docs/readme.md"),
    hostToolResult(8, "t2", "write"),
    userTurn(9, "and the changelog"),
    hostToolUse(10, "t3", "edit", "CHANGELOG.md"),
    hostToolResult(11, "t3", "edit"),
  ];

  const turnsOf = (events: TaskEvent[]) => groupIntoTurns(buildChatItems(events, "kin"), "kin");

  it("gives each turn the events behind it, closed before the next turn starts", () => {
    const turns = turnsOf(threeRounds());

    expect(turns.map((turn) => [turn.kind, turn.fromSeq, turn.toSeq])).toEqual([
      ["user", 1, 1],
      ["agent", 2, 5],
      ["user", 6, 6],
      // The call is at 7 and its result at 8; the step is anchored at 7, so 8 is
      // only in this turn because the next turn closes it there. That is the
      // whole reason the closing pass exists.
      ["agent", 7, 8],
      ["user", 9, 9],
      // Nothing follows this one, so it ends at its own newest event: the result
      // at 11 is outside. See the note on TurnSeqRange -- the call that carried
      // the path is inside, which is what the evidence card reads.
      ["agent", 10, 10],
    ]);
  });

  it("slices the stream into exactly the turn's own file changes", () => {
    const events = threeRounds();
    const turns = turnsOf(events);
    const sliceOf = (turn: Turn) =>
      events.filter((event) => event.seq >= turn.fromSeq! && event.seq <= turn.toSeq!);

    expect(extractChangedFiles(sliceOf(turns[1])).map((file) => file.path)).toEqual([
      "internal/parse.go",
    ]);
    expect(extractChangedFiles(sliceOf(turns[3])).map((file) => file.path)).toEqual([
      "docs/readme.md",
    ]);
    // Truncated at 10, and still complete: the path travels on the tool call.
    expect(extractChangedFiles(sliceOf(turns[5])).map((file) => file.path)).toEqual([
      "CHANGELOG.md",
    ]);
    // And the whole stream is all three, so no turn lost a file the others do not
    // account for -- which is what makes a turn's card a slice rather than a guess.
    expect(
      extractChangedFiles(events)
        .map((file) => file.path)
        .sort(),
    ).toEqual(["CHANGELOG.md", "docs/readme.md", "internal/parse.go"]);
  });

  it("cannot see a file a shell command wrote, which is why the card says so", () => {
    // The extractor reads file-tool payloads, so a turn that edits through the
    // shell produces an empty list. This is the documented limit of the card --
    // the workspace/PR panel stays the authority -- and it is asserted here so a
    // later change cannot quietly start claiming otherwise.
    const events: TaskEvent[] = [
      userTurn(1, "bump the version"),
      ev(2, "tool_use", {
        name: "Bash",
        tool_name: "Bash",
        tool_use_id: "b1",
        input: { command: "sed -i '' 's/1.2.3/1.2.4/' internal/version.go" },
        summary: "Bash(sed -i)",
        status: "running",
        speaker: "kin",
        visibility: { user: true, task: true },
      }),
      hostToolResult(3, "b1", "Bash"),
    ];
    const turns = turnsOf(events);
    const slice = events.filter(
      (event) => event.seq >= turns[1].fromSeq! && event.seq <= turns[1].toSeq!,
    );

    expect(extractChangedFiles(slice)).toEqual([]);
  });

  it("reaches work the chat column never showed, which is why a round is the unit", () => {
    // A subagent's file tools are task-only: the projection drops them, so they
    // leave no item and no step. They are still in the stream, and a round's
    // range has to reach them -- otherwise the card for a round the host spent
    // delegating reads as "changed nothing".
    const events: TaskEvent[] = [
      userTurn(1, "delegate the docs"),
      ev(2, "tool_use", {
        name: "write",
        tool_name: "write",
        tool_use_id: "w1",
        input: { path: "docs/api.md" },
        summary: "write docs/api.md",
        status: "running",
        speaker: "codex",
        agent: "codex",
        source: "codex",
        execution_id: "exec-1",
        execution_step: 1,
        visibility: { user: false, task: true },
      }),
      ev(3, "tool_result", {
        name: "write",
        tool_name: "write",
        tool_use_id: "w1",
        ok: true,
        output: "ok",
        summary: "write done",
        status: "done",
        speaker: "codex",
        agent: "codex",
        source: "codex",
        execution_id: "exec-1",
        execution_step: 1,
        visibility: { user: false, task: true },
      }),
      ev(4, "message", {
        role: "assistant",
        speaker: "kin",
        text: "docs delegated",
        visibility: { user: true, task: true },
      }),
    ];
    const turns = turnsOf(events);
    // The chat column shows the host's answer and nothing of the worker's write.
    expect(JSON.stringify(buildChatItems(events, "kin"))).not.toContain("docs/api.md");
    expect(turns.map((turn) => turn.kind)).toEqual(["user", "agent"]);
    expect(extractChangedFiles(events).map((file) => file.path)).toEqual(["docs/api.md"]);

    // The round is both turns: the gap events fall on the user turn because that
    // is the turn the gap was closed onto, so reading either turn alone gets this
    // wrong in one direction or the other.
    const from = turns[0].fromSeq!;
    const to = Math.max(...turns.map((turn) => turn.toSeq ?? 0));
    expect(extractChangedFiles(events.filter((e) => e.seq >= from && e.seq <= to))).toHaveLength(1);
  });

  it("leaves a turn with no range when nothing behind it carried a seq", () => {
    // A streamed preview is one item built from many chunks: the projection
    // deliberately gives a partial message no seq, so there is nothing to anchor
    // the turn to. A range invented here would slice the stream at the wrong
    // place, and "no range" is what tells the card to stay out of the way.
    const turns = turnsOf([
      ev(1, "message", {
        role: "assistant",
        speaker: "kin",
        text: "thinking out loud",
        partial: true,
        visibility: { user: true, task: true },
      }),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].fromSeq).toBeUndefined();
    expect(turns[0].toSeq).toBeUndefined();
  });

  /**
   * The ACP shape: the agent echoes the prompt it was given, and the echo lands
   * late enough that the work it prompted has already started.
   */
  const echoedPrompt = (): TaskEvent[] => [
    // The echo, streamed. A streamed message is one item built from many chunks
    // and gets no seq; the tool call below flushes the buffer into an item.
    ev(1, "message", {
      role: "user",
      speaker: "user",
      text: "rename the field",
      partial: true,
      visibility: { user: true, task: true },
    }),
    ev(2, "message", {
      role: "user",
      speaker: "user",
      text: ", and the docs",
      partial: true,
      visibility: { user: true, task: true },
    }),
    hostToolUse(3, "t1", "edit", "a.go"),
    // The copy that carries the seq, arriving after the work started.
    userTurn(4, "rename the field, and the docs"),
    hostToolResult(5, "t1", "edit"),
    ev(6, "message", {
      role: "assistant",
      speaker: "kin",
      text: "renamed",
      visibility: { user: true, task: true },
    }),
  ];

  it("gives a round with two user turns to the ask that was still open", () => {
    // Two user turns and an agent turn between them: the ask reached the
    // transcript twice, and the projection cannot tell a second copy from a
    // second question. The round is the ask that was open, not the copy.
    const turns = turnsOf(echoedPrompt());

    expect(turns.map((turn) => [turn.kind, turn.fromSeq, turn.toSeq])).toEqual([
      ["user", undefined, undefined],
      ["agent", 3, 3],
      ["user", 4, 5],
      ["agent", 6, 6],
    ]);
    const rounds = roundsOf(turns);

    expect(rounds).toHaveLength(1);
    expect(rounds[0].user).toBe(turns[0]);
    expect([rounds[0].fromSeq, rounds[0].toSeq]).toEqual([3, 6]);
  });

  it("reads the work between the two copies as the round's own", () => {
    // This is the whole point of naming the owning ask: read the round as the
    // copy that carries the seq and its range starts at 4, which is after the
    // only event that says which file changed.
    const events = echoedPrompt();
    const rounds = roundsOf(turnsOf(events));
    // No fallbacks: a round whose range went missing has to fail here rather than
    // quietly widen to the whole stream and find the file anyway.
    const slice = (from: number, to: number) =>
      extractChangedFiles(events.filter((event) => event.seq >= from && event.seq <= to)).map(
        (file) => file.path,
      );

    expect(slice(rounds[0].fromSeq!, rounds[0].toSeq!)).toEqual(["a.go"]);
    expect(slice(4, 6)).toEqual([]);
  });

  it("keeps an ask that arrives before the agent answered in the same round", () => {
    // A message sent while the task was working is queued, and its event is
    // written when it is accepted — before the agent has said anything about the
    // first one. One agent column follows, so the round is both asks together.
    const events = [
      userTurn(1, "fix the parser"),
      userTurn(2, "and the changelog"),
      hostToolUse(3, "t1", "edit", "internal/parse.go"),
      hostToolResult(4, "t1", "edit"),
      ev(5, "message", {
        role: "assistant",
        speaker: "kin",
        text: "both done",
        visibility: { user: true, task: true },
      }),
    ];
    const turns = turnsOf(events);
    const rounds = roundsOf(turns);

    expect(rounds).toHaveLength(1);
    expect(rounds[0].user).toBe(turns[0]);
    expect([rounds[0].fromSeq, rounds[0].toSeq]).toEqual([1, 5]);
  });

  it("closes the round at the answer, so the next ask opens its own", () => {
    const rounds = roundsOf(
      turnsOf([
        userTurn(1, "fix the parser"),
        hostToolUse(2, "t1", "edit", "internal/parse.go"),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          text: "parser fixed",
          visibility: { user: true, task: true },
        }),
        userTurn(4, "now the docs"),
        hostToolUse(5, "t2", "write", "docs/readme.md"),
        ev(6, "message", {
          role: "assistant",
          speaker: "kin",
          text: "docs written",
          visibility: { user: true, task: true },
        }),
      ]),
    );

    expect(rounds.map((round) => [round.user.fromSeq, round.fromSeq, round.toSeq])).toEqual([
      [1, 1, 3],
      [4, 4, 6],
    ]);
  });

  it("ends the round at a failure nothing picked back up", () => {
    // The ask was answered with an error: the run died there, and the file the
    // next ask changes is not this round's work.
    const rounds = roundsOf(
      turnsOf([
        userTurn(1, "deploy it"),
        hostToolUse(2, "t1", "bash", "scripts/deploy.sh"),
        ev(3, "error", { message: "deploy.sh exited 1" }),
        userTurn(4, "then fix the parser"),
        hostToolUse(5, "t2", "edit", "internal/parse.go"),
        ev(6, "message", {
          role: "assistant",
          speaker: "kin",
          text: "parser fixed",
          visibility: { user: true, task: true },
        }),
      ]),
    );

    expect(rounds.map((round) => [round.user.fromSeq, round.fromSeq, round.toSeq])).toEqual([
      [1, 1, 3],
      [4, 4, 6],
    ]);
  });

  it("keeps a round whole when the column that failed was not the last word", () => {
    // The error came first, before the column had said anything, and the answer
    // came anyway. The ask was answered, so the answer is inside this round.
    const rounds = roundsOf(
      turnsOf([
        userTurn(1, "fix the parser"),
        ev(2, "error", { message: "provider failed to start" }),
        ev(3, "message", {
          role: "assistant",
          speaker: "kin",
          text: "parser fixed on the second try",
          visibility: { user: true, task: true },
        }),
      ]),
    );

    expect(rounds).toHaveLength(1);
    expect([rounds[0].fromSeq, rounds[0].toSeq]).toEqual([1, 3]);
  });

  it("reads an error the column kept working through as part of the work", () => {
    // The retry shape: the tool failed and the agent carried on in the same
    // column. A round is judged by what the column ended on, not by the error it
    // passed through, so the ask that arrives while it is still working is the
    // same round.
    const rounds = roundsOf(
      turnsOf([
        userTurn(1, "fix the parser"),
        hostToolUse(2, "t1", "edit", "internal/parse.go"),
        ev(3, "error", { message: "tool failed" }),
        hostToolUse(4, "t2", "edit", "internal/parse.go"),
        userTurn(5, "and the changelog"),
        ev(6, "message", {
          role: "assistant",
          speaker: "kin",
          text: "both done",
          visibility: { user: true, task: true },
        }),
      ]),
    );

    expect(rounds).toHaveLength(1);
    expect(rounds[0].turns.map((turn) => turn.kind)).toEqual(["user", "agent", "user", "agent"]);
    expect([rounds[0].fromSeq, rounds[0].toSeq]).toEqual([1, 6]);
  });

  it("leaves the turns before the first ask out of every round", () => {
    // A window that opens mid-round: the agent's tail is there and the ask that
    // started it is not. An invented round for those turns would put the work
    // under an ask nobody can see.
    const turns = turnsOf([
      hostToolUse(1, "t1", "edit", "a.go"),
      ev(2, "message", {
        role: "assistant",
        speaker: "kin",
        text: "carrying on",
        visibility: { user: true, task: true },
      }),
      userTurn(3, "next thing"),
      ev(4, "message", {
        role: "assistant",
        speaker: "kin",
        text: "done",
        visibility: { user: true, task: true },
      }),
    ]);
    // One agent column before the ask: that tail's own items merged into a single
    // agent turn, so the ask is the second turn, not the third.
    expect(turns.map((turn) => turn.kind)).toEqual(["agent", "user", "agent"]);
    const rounds = roundsOf(turns);

    expect(rounds).toHaveLength(1);
    expect(rounds[0].user).toBe(turns[1]);
    expect([rounds[0].fromSeq, rounds[0].toSeq]).toEqual([3, 4]);
  });

  it("anchors a step at the event that opened it, not the one that closed it", () => {
    const items = buildChatItems(threeRounds(), "kin");
    const progress = items.find((item): item is ProgressItem => item.kind === "progress");
    expect(progress).toBeDefined();

    // The call and its result are one step, anchored at the call: a result can
    // arrive after an interrupt, in a different turn, and moving the step would
    // move the turn's range with it. The turn's own range still reaches the
    // result, because it is closed at the next turn rather than at its last step.
    expect(chatItemSeqRange(progress!)).toEqual({ from: 2, to: 2 });
    // Error and meta items carry no seq at all.
    expect(chatItemSeqRange({ kind: "error", key: "e", message: "boom" })).toBeNull();
    expect(chatItemSeqRange({ kind: "meta", key: "m", label: "note" })).toBeNull();
  });

  it("draws a round's card under the turn that answered it", () => {
    const events = threeRounds();
    const turns = turnsOf(events);

    const carried = turns.map(
      (turn) =>
        roundEvidenceByTurn(events, turns)
          .get(turn)
          ?.files.map((file) => file.path) ?? null,
    );
    expect(carried).toEqual([
      null, // the ask itself
      ["internal/parse.go"], // the turn that answered it
      null,
      null,
      null,
      // The ask at 6 was never answered, so the ask at 9 is the same round: one
      // card at the end of it, reporting the work of both.
      ["CHANGELOG.md", "docs/readme.md"],
    ]);
  });

  it("takes a recorded round over the tool payloads, shell edits included", () => {
    // The daemon compared the two checkpoints that bracket the round, so the
    // list is the disk's: the file the edit tool reported and the one a shell
    // command rewrote, which no payload mentions.
    const events: TaskEvent[] = [
      userTurn(1, "rename the constant"),
      hostToolUse(2, "t1", "edit", "internal/parse.go"),
      hostToolResult(3, "t1", "edit"),
      ev(5, "message", {
        role: "assistant",
        speaker: "kin",
        text: "renamed",
        visibility: { user: true, task: true },
      }),
      userTurn(6, "next"),
      ev(7, "round_changed", {
        from_seq: 1,
        to_seq: 5,
        total: 2,
        files: [
          { path: "internal/parse.go", status: "modified", additions: 3, deletions: 1 },
          { path: "internal/sed.go", status: "modified", additions: 1, deletions: 1 },
        ],
      }),
    ];
    const turns = turnsOf(events);

    const evidence = [...roundEvidenceByTurn(events, turns).values()];
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.source).toBe("workspace");
    expect(evidence[0]!.files.map((file) => file.path).sort()).toEqual([
      "internal/parse.go",
      "internal/sed.go",
    ]);
  });

  it("draws no card for a recorded round that changed nothing, even if a tool wrote", () => {
    // The write happened and the next turn's checkpoint does not contain it: the
    // round left the workspace as it found it, and a card listing the file would
    // claim a change that is not there any more.
    const events: TaskEvent[] = [
      userTurn(1, "try something"),
      hostToolUse(2, "t1", "write", "internal/parse.go"),
      hostToolResult(3, "t1", "write"),
      userTurn(6, "never mind"),
      ev(7, "round_changed", { from_seq: 1, to_seq: 5, total: 0, files: [] }),
    ];

    expect(roundEvidenceByTurn(events, turnsOf(events)).size).toBe(0);
  });

  it("has no card for a round that only asked, or only read", () => {
    const events: TaskEvent[] = [
      userTurn(1, "what does this do?"),
      hostToolUse(2, "r1", "read", "internal/parse.go"),
      hostToolResult(3, "r1", "read"),
      ev(4, "message", {
        role: "assistant",
        speaker: "kin",
        text: "it parses",
        visibility: { user: true, task: true },
      }),
    ];
    const turns = turnsOf(events);

    expect(roundEvidenceByTurn(events, turns).size).toBe(0);
  });

  it("has no card for a round with no seq behind it", () => {
    // A turn whose items are all streamed previews: nothing carries a seq, so
    // there is no slice to read and the card must not guess at one. The events
    // are here and would match, which is what makes this a test.
    const turns: Turn[] = [
      {
        kind: "user",
        item: {
          kind: "message",
          key: "u1",
          speaker: "user",
          text: "do it",
          partial: false,
        },
      },
    ];
    const events: TaskEvent[] = [hostToolUse(1, "t1", "write", "src/a.ts")];

    expect(roundEvidenceByTurn(events, turns).size).toBe(0);
  });
});

describe("pending anchors", () => {
  const asked = [
    ev(1, "message", { role: "user", text: "go" }),
    ev(2, "approval_requested", { approval_id: "ap-1", kind: "exec", payload: {} }),
    ev(3, "user_question_requested", { question_id: "uq-1", payload: {} }),
    ev(4, "message", { role: "assistant", text: "done" }),
  ];

  it("anchors an approval and a question where each was asked", () => {
    const items = buildChatItems(asked, "kin");

    const metas = items.filter((item) => item.kind === "meta");

    expect(metas.map((item) => item.pending)).toEqual([
      { kind: "approval", id: "ap-1" },
      { kind: "question", id: "uq-1" },
    ]);
    expect(metas.map((item) => item.key)).toEqual(["ar-2", "uq-3"]);
  });

  it("keeps the asking event's seq, so the card has somewhere to sit", () => {
    // The page reads this to tell a card it can place from one whose event has
    // scrolled out of the window — the second has to fall back to the end of the
    // stream, and a card nobody can see is a card nobody answers.
    const seqs = pendingRefSeqs(asked);

    expect(seqs.get("ap-1")).toBe(2);
    expect(seqs.get("uq-1")).toBe(3);
  });

  it("still writes the caption for a request it cannot identify", () => {
    // A payload without an id cannot be matched to a card; the caption is what
    // is left, and it must not turn into a crash or a silently dropped event.
    const items = buildChatItems([ev(1, "approval_requested", { kind: "exec" })], "kin");

    expect(items).toEqual([{ kind: "meta", key: "ar-1", label: expect.any(String) }]);
    expect(pendingRefSeqs([ev(1, "approval_requested", { kind: "exec" })]).size).toBe(0);
  });

  it("does not split the turn it interrupted", () => {
    // The meta items carry no seq of their own, so an approval asked mid-turn
    // lands inside the turn it stopped and the round still reads as one round.
    // The asking events themselves (2 and 3) are in no turn at all: a range is a
    // slice of the stream, not a partition of it.
    const turns = groupIntoTurns(buildChatItems(asked, "kin"), "kin");

    expect(turns.map((turn) => [turn.kind, turn.fromSeq, turn.toSeq])).toEqual([
      ["user", 1, 3],
      ["standalone", undefined, undefined],
      ["standalone", undefined, undefined],
      ["agent", 4, 4],
    ]);
  });
});

describe("note sources", () => {
  const reasoning = (seq: number, text: string, partial = false, key = `m${seq}`) =>
    ev(seq, "message", {
      role: "reasoning",
      speaker: "kin",
      content: [{ type: "text", text }],
      partial,
      message_id: key,
      index: 0,
    });
  const narration = (seq: number, text: string, extra: Record<string, unknown> = {}) =>
    ev(seq, "message", {
      role: "assistant",
      speaker: "kin",
      content: [{ type: "text", text }],
      ...extra,
    });

  const notesOf = (events: TaskEvent[]) =>
    buildChatItems(events, "kin")
      .filter((item): item is ProgressItem => item.kind === "progress")
      .flatMap((item) => item.steps.filter((step): step is NoteStep => step.kind === "note"));

  it("reads the reason a message is a note at all, not the words in it", () => {
    // The table is the whole mechanism: a role and a phase, both of which the
    // event states outright. Nothing here looks at the text.
    expect(noteSourceOf({ role: "reasoning" })).toBe("reasoning");
    expect(noteSourceOf({ phase: "plan" })).toBe("plan");
    expect(noteSourceOf({ role: "assistant", phase: "progress" })).toBe("note");
    expect(noteSourceOf({})).toBe("note");
    // A reasoning block that carries a plan phase is still the model thinking,
    // which is the more specific of the two facts.
    expect(noteSourceOf({ role: "reasoning", phase: "plan" })).toBe("reasoning");
    // A word from a subagent is neither the main agent's thinking nor its
    // narration, whatever role or phase travelled with it.
    expect(noteSourceOf({ sidechain: true, role: "assistant", phase: "progress" })).toBe(
      "subagent",
    );
    expect(noteSourceOf({ sidechain: true, role: "reasoning" })).toBe("subagent");
  });

  it("labels every source that has a voice of its own, and only those", () => {
    // The design's table, spelled out: thinking, plan and subagent answer "who
    // said this". Narration is the host's own column and carries no label.
    expect((["reasoning", "plan", "note", "subagent"] as const).map(noteLabelKey)).toEqual([
      "chat.progress.thinking",
      "chat.progress.plan",
      null,
      "chat.progress.subagent",
    ]);
    // Nothing typechecks an i18n path, and a missing one renders itself: the
    // label would read "chat.progress.thinking" on screen.
    for (const source of ["reasoning", "plan", "subagent"] as const) {
      const key = noteLabelKey(source);
      expect(key).not.toBeNull();
      for (const locale of ["zh", "en"] as const) {
        setLocale(locale);
        expect(t(key!)).not.toBe(key);
      }
    }
    setLocale("zh");
  });

  it("marks the model's own thinking, streamed or settled", () => {
    const streamed = notesOf([reasoning(1, "checking who calls this", true)]);
    expect(streamed.map((note) => [note.source, note.text])).toEqual([
      ["reasoning", "checking who calls this"],
    ]);

    // The streamed note is settled by the same block arriving whole: one note,
    // and the source survives the handoff between the two shapes.
    const settled = notesOf([
      reasoning(1, "checking who", true, "m1"),
      reasoning(2, "checking who calls this", false, "m1"),
    ]);
    expect(settled.map((note) => [note.source, note.text])).toEqual([
      ["reasoning", "checking who calls this"],
    ]);
  });

  it("keeps the source when a tool call settles the thinking behind it", () => {
    // The flush path: a partial reasoning chunk becomes a note when the next
    // event closes the stream, and nothing about that event is a reasoning
    // role. The source has to travel with the buffer.
    const notes = notesOf([
      reasoning(1, "reading the parser first", true),
      ev(2, "tool_use", {
        name: "read",
        tool_name: "read",
        tool_use_id: "t1",
        input: { path: "internal/parse.go" },
        speaker: "kin",
        visibility: { user: true, task: true },
      }),
    ]);

    expect(notes.map((note) => [note.source, note.text])).toEqual([
      ["reasoning", "reading the parser first"],
    ]);
  });

  it("marks the plan line, from the plan event and from a plan message alike", () => {
    const fromEvent = buildChatItems(
      [
        ev(1, "plan", {
          speaker: "kin",
          entries: [{ content: "read the parser", status: "in_progress" }],
        }),
      ],
      "kin",
    );
    const planSteps = fromEvent
      .filter((item): item is ProgressItem => item.kind === "progress")
      .flatMap((item) => item.steps.filter((step): step is NoteStep => step.kind === "note"));
    expect(planSteps.map((step) => step.source)).toEqual(["plan"]);

    const fromMessage = notesOf([narration(1, "1. read the parser", { phase: "plan" })]);
    expect(fromMessage.map((note) => note.source)).toEqual(["plan"]);
  });

  it("attributes a note only when it is not the host's own voice", () => {
    const note = (speaker: string, model?: string): NoteStep => ({
      kind: "note",
      key: "n",
      speaker,
      model,
      text: "…",
      status: "done",
      source: "note",
    });

    // A delegated agent's note has to say whose it is.
    expect(noteNeedsAttribution(note("codex", "gpt-5"), "claude-code")).toBe(true);
    // The host's own, under its own name, needs nothing.
    expect(noteNeedsAttribution(note("claude-code"), "claude-code")).toBe(false);
    // And under the names the same column has carried: the product name on
    // legacy rows, and the orchestrator that speaks for the host. Without
    // these two the row would label the host's own thinking as someone
    // else's -- which is what the first screenshot of this change showed.
    expect(noteNeedsAttribution(note("kin"), "claude-code")).toBe(false);
    expect(noteNeedsAttribution(note("orchestrator"), "claude-code")).toBe(false);
    expect(noteNeedsAttribution(note("kin"), "kin")).toBe(false);
  });

  it("calls the rest narration, including a worker's own words", () => {
    const notes = notesOf([
      narration(1, "The script rsyncs over the live directory.", { phase: "progress" }),
      ev(2, "message", {
        role: "assistant",
        speaker: "claude-code",
        agent: "claude-code",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: "I can take the smoke suite." }],
        visibility: { user: false, task: true },
      }),
    ]);

    expect(notes.map((note) => [note.source, note.speaker])).toEqual([
      ["note", "kin"],
      // The worker's note keeps its speaker -- that is what the row draws when
      // it is not the card's own -- while staying a note by source.
      ["note", "claude-code"],
    ]);
  });

  it("says when the words came from a subagent", () => {
    // ACP has no subagent concept; the claude adapter marks the chunk in
    // `_meta`, and the projection keeps the mark instead of folding it into
    // the main agent's narration.
    const notes = notesOf([
      narration(1, "checking the caller", { phase: "progress", sidechain: true }),
      ev(2, "message", {
        role: "assistant",
        speaker: "kin",
        phase: "progress",
        sidechain: true,
        content: [{ type: "text", text: "the caller passes nil" }],
      }),
    ]);

    expect(notes.map((note) => [note.source, note.text])).toEqual([
      ["subagent", "checking the caller"],
      ["subagent", "the caller passes nil"],
    ]);
  });
});

describe("subagent tool calls", () => {
  const toolsOf = (events: TaskEvent[]) =>
    buildChatItems(events, "kin")
      .filter((item): item is ProgressItem => item.kind === "progress")
      .flatMap((item) => item.steps.filter((step): step is ToolStep => step.kind === "tool"));

  it("nests the subagent's call under the call that spawned it", () => {
    const events = [
      ev(1, "tool_use", { name: "task", tool_use_id: "parent", speaker: "kin" }),
      ev(2, "tool_use", {
        name: "read",
        tool_use_id: "child",
        speaker: "kin",
        sidechain: true,
        parent_tool_use_id: "parent",
      }),
      // The result carries no mark of its own: it must land on the child and
      // must not erase what the call said.
      ev(3, "tool_result", { tool_use_id: "child", speaker: "kin", ok: true, output: "contents" }),
    ];

    const top = toolsOf(events);
    expect(top.map((step) => step.key)).toEqual(["tool-parent"]);
    const children = top[0].children ?? [];
    expect(children.map((child) => [child.key, child.sidechain, child.status])).toEqual([
      ["tool-child", true, "done"],
    ]);
    // The numbered column counts the main thread; the child is indented under
    // its parent instead of taking a number.
    expect(progressRows(top).map((row) => [row.step.key, row.depth, row.index])).toEqual([
      ["tool-parent", 0, 1],
      ["tool-child", 1, 0],
    ]);
  });

  it("counts a subagent's call in the card's status and totals", () => {
    const top = toolsOf([
      ev(1, "tool_use", { name: "task", tool_use_id: "parent", speaker: "kin" }),
      ev(2, "tool_use", {
        name: "bash",
        tool_use_id: "child",
        speaker: "kin",
        sidechain: true,
        parent_tool_use_id: "parent",
      }),
      ev(3, "tool_result", { tool_use_id: "parent", speaker: "kin", ok: true }),
      ev(4, "tool_result", { tool_use_id: "child", speaker: "kin", ok: false, output: "boom" }),
    ]);

    // A subagent's failure is the main agent's failure: the card must not read
    // "done" over a call the subagent could not finish.
    expect(summarizeProgressStatus(top, false)).toMatchObject({
      state: "partial_failed",
      doneTools: 1,
      failedTools: 1,
      totalTools: 2,
    });
  });

  it("keeps a call whose parent never arrived visible", () => {
    // A replay can start in the middle of a subagent's work. The row is still
    // marked as a subagent's; what it must never do is disappear.
    const top = toolsOf([
      ev(1, "tool_use", {
        name: "read",
        tool_use_id: "orphan",
        speaker: "kin",
        sidechain: true,
        parent_tool_use_id: "missing",
      }),
    ]);

    expect(top.map((step) => [step.key, step.sidechain])).toEqual([["tool-orphan", true]]);
  });

  it("does not nest a call under itself", () => {
    // The parent id is agent output. A call that names itself is not a child,
    // and making it one would build a cycle the progress box recurses on.
    const top = toolsOf([
      ev(1, "tool_use", {
        name: "read",
        tool_use_id: "self",
        speaker: "kin",
        sidechain: true,
        parent_tool_use_id: "self",
      }),
    ]);

    expect(top.map((step) => step.key)).toEqual(["tool-self"]);
    expect(top[0].children).toBeUndefined();
    expect(progressRows(top).map((row) => row.step.key)).toEqual(["tool-self"]);
  });
});

describe("nameless tool updates", () => {
  const toolsOf = (events: TaskEvent[]) =>
    buildChatItems(events, "kin")
      .filter((item): item is ProgressItem => item.kind === "progress")
      .flatMap((item) => item.steps.filter((step): step is ToolStep => step.kind === "tool"));

  it("keeps the name and summary the call opened with", () => {
    // The ACP adapter leaves `name`/`summary` out of a status-only patch so the
    // console does not rename a row it already named. The projection must not
    // fill the blank with "tool".
    const top = toolsOf([
      ev(1, "tool_use", {
        name: "Read",
        summary: "Read /tmp/marker.txt",
        tool_use_id: "t1",
        speaker: "kin",
      }),
      ev(2, "tool_use", { tool_use_id: "t1", speaker: "kin" }),
    ]);

    expect(top.map((step) => [step.name, step.summary])).toEqual([
      ["Read", "Read /tmp/marker.txt"],
    ]);
  });
});

describe("process timing", () => {
  const at = (seq: number, ts: number, type: string, payload: TaskEvent["payload"]): TaskEvent => ({
    task_id: "task-1",
    event_epoch: 0,
    seq,
    ts,
    type,
    payload,
  });

  const toolsOf = (events: TaskEvent[]) =>
    buildChatItems(events, "kin")
      .filter((item): item is ProgressItem => item.kind === "progress")
      .flatMap((item) => item.steps.filter((step): step is ToolStep => step.kind === "tool"));

  const call = (seq: number, ts: number) =>
    at(seq, ts, "tool_use", { speaker: "kin", tool_use_id: "call-1", name: "bash" });
  const result = (seq: number, ts: number) =>
    at(seq, ts, "tool_result", {
      speaker: "kin",
      tool_use_id: "call-1",
      name: "bash",
      output: "ok",
      ok: true,
    });

  it("carries a tool call's elapsed time from use to result", () => {
    const [tool] = toolsOf([call(1, 1_000_000), result(2, 1_002_500)]);

    expect(tool.durationMs).toBe(2500);
  });

  it("leaves a running tool without a duration", () => {
    const [tool] = toolsOf([call(1, 1_000_000)]);

    expect(tool.status).toBe("running");
    expect(tool.durationMs).toBeUndefined();
  });

  it("measures a progress run from its first to its last stamped event", () => {
    const items = buildChatItems([call(1, 1_000), result(2, 4_000)], "kin");
    const progress = items.find((item): item is ProgressItem => item.kind === "progress");

    expect(progress?.durationMs).toBe(3000);
  });

  it("leaves an unstamped run without a duration", () => {
    const items = buildChatItems([call(1, 0), result(2, 0)], "kin");
    const progress = items.find((item): item is ProgressItem => item.kind === "progress");

    expect(progress?.durationMs).toBeUndefined();
  });

  it("leaves a run with a single stamped event without a duration", () => {
    const items = buildChatItems([call(1, 1_000)], "kin");
    const progress = items.find((item): item is ProgressItem => item.kind === "progress");

    expect(progress?.durationMs).toBeUndefined();
  });

  it("measures a settled card across the groups it merges", () => {
    const ask = (seq: number, ts: number, id: string) =>
      at(seq, ts, "tool_use", { speaker: "kin", tool_use_id: id, name: "bash" });
    const done = (seq: number, ts: number, id: string) =>
      at(seq, ts, "tool_result", {
        speaker: "kin",
        tool_use_id: id,
        name: "bash",
        output: "ok",
        ok: true,
      });
    const say = (seq: number, ts: number, text: string) =>
      at(seq, ts, "message", {
        role: "assistant",
        speaker: "kin",
        content: [{ type: "text", text }],
      });
    const settled = mergeProcessRuns(
      buildChatItems(
        [
          ask(1, 1_000, "call-1"),
          done(2, 2_000, "call-1"),
          say(3, 3_000, "Halfway."),
          ask(4, 4_000, "call-2"),
          done(5, 6_000, "call-2"),
          say(6, 7_000, "Done."),
        ],
        "kin",
        undefined,
        true,
      ),
    );
    const progress = settled.find((item): item is ProgressItem => item.kind === "progress");

    expect(progress?.durationMs).toBe(5000);
  });

  it("leaves a tool whose result predates its call without a duration", () => {
    const [tool] = toolsOf([call(1, 2_000), result(2, 1_000)]);

    expect(tool.durationMs).toBeUndefined();
  });

  it("keeps the start of a call that is re-sighted by a status-only update", () => {
    const [tool] = toolsOf([
      call(1, 1_000),
      at(2, 3_000, "tool_use", { speaker: "kin", tool_use_id: "call-1" }),
      result(3, 4_000),
    ]);

    expect(tool.durationMs).toBe(3000);
  });

  it("leaves a merged card with a single stamped event without a duration", () => {
    const settled = mergeProcessRuns(buildChatItems([call(1, 1_000)], "kin", undefined, true));
    const progress = settled.find((item): item is ProgressItem => item.kind === "progress");

    expect(progress?.durationMs).toBeUndefined();
  });

  it("keeps the daemon's queued-message discard report on the transcript", () => {
    // Stop drops the messages queued behind the canceled round, and the store
    // writes this event in the same transaction (internal/store/pending_prompts.go).
    // It is the only on-screen account of where those messages went: dropping it
    // in projection would leave the reader with messages that silently vanished.
    // It reads as a counted note in the reader's language, not as a failure.
    const message = "1 queued prompt(s) discarded with the canceled task";
    const items = buildChatItems([
      ev(1, "message", { role: "user", content: [{ type: "text", text: "queued" }] }),
      ev(2, "error", { message, count: 1 }),
    ]);

    expect(items.find((item) => item.kind === "meta")).toMatchObject({
      kind: "meta",
      label: t("chat.discardedPrompt"),
    });
  });

  it("R-stop-discard-copy: projects the queued-prompt discard as a counted meta row", () => {
    // The daemon's discard report travels on the "error" channel because that
    // is the channel it has, but a deliberate Stop is not a failure: the row
    // is the quiet, counted note the reader needs to know where the queued
    // messages went. The template is matched, not the whole sentence, so a
    // different count still lands here.
    const before = getLocale();
    setLocale("zh");
    try {
      const items = buildChatItems([
        ev(1, "message", { role: "user", content: [{ type: "text", text: "排队" }] }),
        ev(2, "error", {
          message: "1 queued prompt(s) discarded with the canceled task",
          count: 1,
        }),
        ev(3, "error", {
          message: "3 queued prompt(s) discarded with the canceled task",
          count: 3,
        }),
      ]);

      expect(items).toMatchObject([
        { kind: "message" },
        { kind: "meta", label: "已丢弃 1 条排队消息" },
        { kind: "meta", label: "已丢弃 3 条排队消息" },
      ]);
      expect(items.some((item) => item.kind === "error")).toBe(false);
    } finally {
      setLocale(before);
    }
  });

  it("R-stop-discard-copy: an ordinary error that carries a count stays an error", () => {
    // The count alone is not the signal: only the daemon's discard template
    // is a report. An unrelated failure with a numeric field must still be
    // shown as a failure.
    const items = buildChatItems([ev(1, "error", { message: "boom", count: 2 })]);

    expect(items).toMatchObject([{ kind: "error", message: "boom" }]);
  });
});

/**
 * A context compaction is not the agent's answer. The ACP adapter sends the
 * handoff paragraph as `phase: "compaction"` message chunks and then a
 * `context compacted` notice; the projection owes the reader one quiet item,
 * never a body message and never two hints for one compaction.
 */
describe("context compaction", () => {
  const SUMMARY_FIRST =
    "The messages after this summary are the most recent messages from before compaction, kept verbatim.";
  const SUMMARY_LAST = "Everything before that was folded into the summary above.";
  const SUMMARY = `${SUMMARY_FIRST} ${SUMMARY_LAST}`;

  const userTurn = () =>
    ev(1, "message", {
      role: "user",
      content: [{ type: "text", text: "please fix the parser" }],
    });

  const compactionChunk = (seq: number, text: string, messageId?: string) =>
    ev(seq, "message", {
      role: "assistant",
      speaker: "kin",
      phase: "compaction",
      partial: true,
      content: [{ type: "text", text }],
      visibility: { user: true, task: true },
      ...(messageId ? { message_id: messageId, index: 0 } : {}),
    });

  const compactionFinal = (seq: number, text: string) =>
    ev(seq, "message", {
      role: "assistant",
      speaker: "kin",
      phase: "compaction",
      partial: false,
      content: [{ type: "text", text }],
      visibility: { user: true, task: true },
    });

  const compactionNotice = (seq: number) =>
    ev(seq, "notice", {
      speaker: "acp",
      severity: "info",
      title: "context compacted",
      message: "",
    });

  // The protocol-shaped update the ACP adapter sends once it advertises the
  // session compaction capability: a stable code, the compaction id, its
  // status, and — once completed — the whole summary.
  const compactionUpdate = (
    seq: number,
    id: string,
    status: "in_progress" | "completed" | "failed" | "cancelled",
    summary?: string,
  ) =>
    ev(seq, "notice", {
      speaker: "acp",
      severity: status === "failed" ? "error" : "info",
      title: "context compacted",
      message: summary ?? "",
      code: "context_compacted",
      compaction_id: id,
      status,
    });

  const compactionChunkOf = (seq: number, text: string, id: string) =>
    ev(seq, "message", {
      role: "assistant",
      speaker: "kin",
      phase: "compaction",
      partial: true,
      content: [{ type: "text", text }],
      compaction_id: id,
      visibility: { user: true, task: true },
    });

  const answer = (seq: number, text: string) =>
    ev(seq, "message", {
      role: "assistant",
      speaker: "kin",
      partial: false,
      content: [{ type: "text", text }],
      visibility: { user: true, task: true },
    });

  const compactions = (items: ChatItem[]) => items.filter((item) => item.kind === "compaction");

  it("a compaction is one quiet item, never the final answer", () => {
    const items = buildChatItems(
      [
        userTurn(),
        ev(2, "tool_use", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "bash",
          input: { command: "ls" },
          visibility: { user: true, task: true },
        }),
        ev(3, "tool_result", {
          speaker: "kin",
          tool_use_id: "call-1",
          name: "bash",
          output: "a.ts",
          ok: true,
          visibility: { user: true, task: true },
        }),
        compactionChunk(4, "The messages after this summary "),
        compactionChunk(5, "are the most recent messages before compaction."),
        compactionFinal(6, SUMMARY),
        answer(7, "Fixed the parser."),
      ],
      "kin",
    );

    const found = compactions(items);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ text: SUMMARY, partial: false });
    expect(items.some((item) => item.kind === "message" && item.phase === "compaction")).toBe(
      false,
    );

    // The real answer is the answer: the process fold must not pick the
    // summary as the final message of the run. Before the dedicated kind the
    // handoff paragraph was folded into the tool card as a note, which is the
    // wall of text the reader saw.
    const merged = mergeProcessRuns(items, true);
    expect(
      merged.find((item) => item.kind === "message" && item.text === "Fixed the parser."),
    ).toMatchObject({ kind: "message" });
    expect(compactions(merged)).toHaveLength(1);
    for (const item of merged) {
      if (item.kind !== "progress") continue;
      for (const step of item.steps) {
        expect(step.kind === "note" ? step.text : "").not.toContain(SUMMARY_FIRST);
      }
    }
  });

  it("compaction chunks aggregate into one item while streaming", () => {
    const streaming = buildChatItems(
      [userTurn(), compactionChunk(2, "The messages after "), compactionChunk(3, "this summary")],
      "kin",
      undefined,
      false,
    );

    expect(compactions(streaming)).toHaveLength(1);
    expect(compactions(streaming)[0]).toMatchObject({
      text: "The messages after this summary",
      partial: true,
    });

    const settled = buildChatItems(
      [
        userTurn(),
        compactionChunk(2, "The messages after "),
        compactionChunk(3, "this summary"),
        compactionFinal(4, SUMMARY),
      ],
      "kin",
    );

    expect(compactions(settled)).toHaveLength(1);
    expect(compactions(settled)[0]).toMatchObject({ text: SUMMARY, partial: false });
  });

  it("the context compacted notice folds into the compaction item", () => {
    const items = buildChatItems(
      [
        userTurn(),
        compactionChunk(2, SUMMARY_FIRST),
        compactionNotice(3),
        compactionFinal(4, SUMMARY),
        compactionNotice(5),
        answer(6, "Fixed the parser."),
      ],
      "kin",
    );

    expect(compactions(items)).toHaveLength(1);
    expect(
      items.some(
        (item) => item.kind === "meta" && item.label.toLowerCase().includes("context compacted"),
      ),
    ).toBe(false);
    expect(compactions(items)[0]).toMatchObject({ text: SUMMARY, partial: false });
  });

  it("a compaction notice with no summary yet still yields one running hint", () => {
    const noticeOnly = buildChatItems([userTurn(), compactionNotice(2)], "kin");

    expect(compactions(noticeOnly)).toHaveLength(1);
    expect(compactions(noticeOnly)[0]).toMatchObject({ text: "", partial: true });
    expect(noticeOnly.some((item) => item.kind === "message" && item.speaker !== "user")).toBe(
      false,
    );

    const chunksOnly = buildChatItems(
      [userTurn(), compactionChunk(2, SUMMARY_FIRST)],
      "kin",
      undefined,
      false,
    );

    expect(compactions(chunksOnly)).toHaveLength(1);
    expect(compactions(chunksOnly)[0]).toMatchObject({ partial: true });
    // The half summary is behind the disclosure, not laid into the body.
    expect(chunksOnly.some((item) => item.kind === "message" && item.speaker !== "user")).toBe(
      false,
    );
  });

  it("settling a turn settles a running compaction", () => {
    const items = buildChatItems(
      [userTurn(), compactionChunk(2, SUMMARY_FIRST), ev(3, "result", { is_error: false })],
      "kin",
      undefined,
      false,
    );

    expect(compactions(items)).toHaveLength(1);
    expect(compactions(items)[0]).toMatchObject({ partial: false, text: SUMMARY_FIRST });
  });

  it("a notice before the chunks is the same one item", () => {
    const items = buildChatItems(
      [
        userTurn(),
        compactionNotice(2),
        compactionChunk(3, SUMMARY_FIRST),
        compactionFinal(4, SUMMARY),
      ],
      "kin",
    );

    expect(compactions(items)).toHaveLength(1);
    expect(compactions(items)[0]).toMatchObject({ text: SUMMARY, partial: false });
    expect(items.some((item) => item.kind === "meta")).toBe(false);
  });

  it("two compactions in one turn are two lines", () => {
    const first = "The first summary of the work so far.";
    const second = "The second summary, after more work happened.";
    const items = buildChatItems(
      [
        userTurn(),
        compactionChunk(2, first.slice(0, 10)),
        compactionFinal(3, first),
        ev(4, "result", { is_error: false }),
        compactionChunk(5, second.slice(0, 10)),
        compactionFinal(6, second),
      ],
      "kin",
    );

    const found = compactions(items);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ text: first, partial: false });
    expect(found[1]).toMatchObject({ text: second, partial: false });
  });

  it("keeps the generic thinking cue off a running compaction", () => {
    const running = buildChatItems(
      [userTurn(), compactionChunk(2, SUMMARY_FIRST)],
      "kin",
      undefined,
      false,
    );
    expect(shouldShowGenericThinking(running, true)).toBe(false);

    // Once it settles and nothing else has started, the agent is working
    // again, and the dots are the honest cue.
    const settled = buildChatItems(
      [userTurn(), compactionFinal(2, SUMMARY)],
      "kin",
      undefined,
      false,
    );
    expect(shouldShowGenericThinking(settled, true)).toBe(true);
  });

  // Protocol-driven compaction: the adapter advertises the session capability,
  // so the console settles the compaction from `status` and never from the
  // English title. These events carry the code the adapter writes.

  it("a completed compaction settles and reveals its summary", () => {
    const items = buildChatItems(
      [
        userTurn(),
        compactionUpdate(2, "cmp-1", "in_progress"),
        compactionChunkOf(3, SUMMARY_FIRST, "cmp-1"),
        compactionUpdate(4, "cmp-1", "completed", SUMMARY),
        answer(5, "Fixed the parser."),
      ],
      "kin",
    );

    const found = compactions(items);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ text: SUMMARY, partial: false, key: "compaction-cmp-1" });
    expect(items.some((item) => item.kind === "meta")).toBe(false);
  });

  it("an in-progress compaction stays running until completed", () => {
    const running = buildChatItems(
      [userTurn(), compactionUpdate(2, "cmp-1", "in_progress")],
      "kin",
      undefined,
      false,
    );

    expect(compactions(running)).toHaveLength(1);
    expect(compactions(running)[0]).toMatchObject({ text: "", partial: true });
    expect(running.some((item) => item.kind === "meta")).toBe(false);

    const settled = buildChatItems(
      [
        userTurn(),
        compactionUpdate(2, "cmp-1", "in_progress"),
        compactionUpdate(3, "cmp-1", "completed", SUMMARY),
      ],
      "kin",
      undefined,
      false,
    );

    expect(compactions(settled)).toHaveLength(1);
    expect(compactions(settled)[0]).toMatchObject({ text: SUMMARY, partial: false });
  });

  it("a one-shot summary opens without chunks", () => {
    const items = buildChatItems(
      [
        userTurn(),
        compactionUpdate(2, "cmp-1", "completed", SUMMARY),
        answer(3, "Fixed the parser."),
      ],
      "kin",
    );

    const found = compactions(items);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ text: SUMMARY, partial: false });
  });

  // Claude Code reports a compaction through the same contract: the boundary
  // opens the line without an id, and the summary record settles it. Exactly
  // one folded row, and the row holds the whole summary the disclosure opens.
  it("a boundary and its summary are one folded row with the whole summary", () => {
    const summary = `This session is being continued from a previous conversation that ran out of context.\n\n${"A line of the folded summary.\n".repeat(699)}The last line of the folded summary.`;
    const boundary = ev(2, "notice", {
      severity: "info",
      title: "context compacted",
      message: "",
      code: "context_compacted",
      status: "in_progress",
    });
    const settled = ev(3, "notice", {
      severity: "info",
      title: "context compacted",
      message: summary,
      code: "context_compacted",
      status: "completed",
      compaction_id: "uuid-compact-1",
    });
    const items = buildChatItems(
      [userTurn(), boundary, settled, answer(4, "Fixed the parser.")],
      "kin",
    );

    const found = compactions(items);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ text: summary, partial: false });
    // The handoff paragraph is the disclosure's body, never a timeline
    // message, and the boundary left no second running row behind.
    expect(
      items.some(
        (item) =>
          item.kind === "message" &&
          item.text.includes("This session is being continued from a previous conversation"),
      ),
    ).toBe(false);
  });

  it("a failed compaction is not compacted", () => {
    const failed = buildChatItems(
      [
        userTurn(),
        compactionUpdate(2, "cmp-1", "in_progress"),
        compactionUpdate(3, "cmp-1", "failed", "the agent refused"),
      ],
      "kin",
    );

    // The spinner is gone and no disclosure claims a summary exists; the reader
    // gets one honest line saying the compaction failed, in their language,
    // with the agent's own reason appended when it sent one.
    expect(compactions(failed)).toHaveLength(0);
    expect(failed.filter((item) => item.kind === "meta")).toHaveLength(1);
    const note = failed.find((item) => item.kind === "meta");
    if (note?.kind !== "meta") throw new Error("expected a meta line for a failed compaction");
    expect(note.label).toContain(t("chat.compaction.failed"));
    expect(note.label).toContain("the agent refused");

    const cancelled = buildChatItems(
      [userTurn(), compactionUpdate(2, "cmp-2", "cancelled")],
      "kin",
    );
    expect(compactions(cancelled)).toHaveLength(0);
    expect(cancelled.filter((item) => item.kind === "meta")).toMatchObject([
      { kind: "meta", label: t("chat.compaction.cancelled") },
    ]);
  });

  it("two compactions with different ids are two lines", () => {
    const first = "The first summary of the work so far.";
    const second = "The second summary, after more work happened.";
    const items = buildChatItems(
      [
        userTurn(),
        compactionUpdate(2, "cmp-a", "completed", first),
        compactionUpdate(3, "cmp-b", "completed", second),
      ],
      "kin",
    );

    const found = compactions(items);
    expect(found).toHaveLength(2);
    expect(found.map((item) => item.key)).toEqual(["compaction-cmp-a", "compaction-cmp-b"]);
    expect(found[0]).toMatchObject({ text: first, partial: false });
    expect(found[1]).toMatchObject({ text: second, partial: false });

    // A compaction settling beside another one still running keeps its own
    // line: the id, not "the last compaction in this turn", decides where a
    // summary goes.
    const beside = buildChatItems(
      [
        userTurn(),
        compactionUpdate(2, "cmp-a", "in_progress"),
        compactionUpdate(3, "cmp-b", "completed", second),
      ],
      "kin",
      undefined,
      false,
    );
    const two = compactions(beside);
    expect(two).toHaveLength(2);
    expect(two[0]).toMatchObject({ key: "compaction-cmp-a", text: "", partial: true });
    expect(two[1]).toMatchObject({ key: "compaction-cmp-b", text: second, partial: false });
  });

  it("a legacy title-only notice still folds", () => {
    // An agent that never advertised compaction sent a plain notice; the
    // transcript persisted by an older build has no code. It still folds into
    // one quiet line instead of becoming meta prose.
    const items = buildChatItems(
      [
        userTurn(),
        compactionNotice(2),
        compactionChunk(3, SUMMARY_FIRST),
        compactionFinal(4, SUMMARY),
      ],
      "kin",
    );

    expect(compactions(items)).toHaveLength(1);
    expect(compactions(items)[0]).toMatchObject({ text: SUMMARY, partial: false });

    // And the turn still settles one that never received a final update.
    const settledByTurn = buildChatItems(
      [userTurn(), compactionNotice(2), ev(3, "result", { is_error: false })],
      "kin",
      undefined,
      false,
    );
    expect(compactions(settledByTurn)).toHaveLength(1);
    expect(compactions(settledByTurn)[0]).toMatchObject({ text: "", partial: false });
  });
});
