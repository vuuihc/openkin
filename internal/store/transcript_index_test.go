package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func openTranscriptStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func appendPayload(t *testing.T, s *Store, taskID string, payload map[string]any) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendEvent(context.Background(), taskID, "message", raw); err != nil {
		t.Fatal(err)
	}
}

func delta(text string) map[string]any {
	return map[string]any{
		"role":    "assistant",
		"content": []map[string]any{{"type": "text", "text": text}},
		"partial": true,
	}
}

func searchAll(t *testing.T, s *Store, q string) []TranscriptHit {
	t.Helper()
	hits, _, err := s.SearchTranscript(context.Background(), TranscriptSearchOpts{
		Scope: TaskScope{All: true},
		Query: q,
	})
	if err != nil {
		t.Fatal(err)
	}
	return hits
}

// A query that is split across two deltas is still a match: the reader sees one
// message, so the search must see one message.
func TestTranscriptIndexCoalescesStreamedDeltas(t *testing.T) {
	s := openTranscriptStore(t)
	seedTranscriptTask(t, s, "01IDX000000000000000000001", "Deploy notes", "")

	appendPayload(t, s, "01IDX000000000000000000001", delta("please de"))
	appendPayload(t, s, "01IDX000000000000000000001", delta("ploy the release"))
	appendPayload(t, s, "01IDX000000000000000000001", delta(" carefully"))

	hits := searchAll(t, s, "deploy the release")
	if len(hits) != 1 {
		t.Fatalf("hits=%d want 1: %+v", len(hits), hits)
	}
	if !strings.Contains(hits[0].Snippet, "deploy the release carefully") {
		t.Fatalf("snippet=%q is not the whole sentence", hits[0].Snippet)
	}
}

// The deltas were previews; the complete message is what the conversation
// keeps, so the preview must not survive as a second row.
func TestTranscriptIndexFinalReplacesPreview(t *testing.T) {
	s := openTranscriptStore(t)
	seedTranscriptTask(t, s, "01IDX000000000000000000002", "Deploy notes", "")

	appendPayload(t, s, "01IDX000000000000000000002", delta("rotate the old token"))
	appendPayload(t, s, "01IDX000000000000000000002", map[string]any{
		"role":    "assistant",
		"content": []map[string]any{{"type": "text", "text": "rotate the new token"}},
		"partial": false,
	})

	hits := searchAll(t, s, "rotate the")
	if len(hits) != 1 {
		t.Fatalf("hits=%d want 1: %+v", len(hits), hits)
	}
	if strings.Contains(hits[0].Snippet, "old") {
		t.Fatalf("the superseded preview is still searchable: %+v", hits)
	}
	if !strings.Contains(hits[0].Snippet, "new") {
		t.Fatalf("snippet=%q is not the final message", hits[0].Snippet)
	}
	if got := searchAll(t, s, "old token"); len(got) != 0 {
		t.Fatalf("the replaced preview answered %+v", got)
	}
}

// A complete message with no words draws nothing, and the console drops the
// preview it supersedes. Leaving that preview behind would answer a search with
// words the reader cannot find anywhere on screen.
func TestTranscriptIndexDropsThePreviewABlankFinalCloses(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000016"
	seedTranscriptTask(t, s, taskID, "Blank final", "")

	appendPayload(t, s, taskID, delta("the abandoned words"))
	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"content": []map[string]any{{"type": "text", "text": ""}},
		"partial": false,
	})

	if hits := searchAll(t, s, "abandoned"); len(hits) != 0 {
		t.Fatalf("the dropped preview still answers: %+v", hits)
	}
}

// Two messages that name their block must not merge: the delta of the second
// answer is not a continuation of the first.
func TestTranscriptIndexKeepsIdentifiedMessagesApart(t *testing.T) {
	s := openTranscriptStore(t)
	seedTranscriptTask(t, s, "01IDX000000000000000000003", "Two answers", "")

	first := delta("the first answer")
	first["message_id"] = "m1"
	first["index"] = 0
	appendPayload(t, s, "01IDX000000000000000000003", first)

	second := delta("the second answer")
	second["message_id"] = "m2"
	second["index"] = 0
	appendPayload(t, s, "01IDX000000000000000000003", second)

	if got := searchAll(t, s, "the first answer"); len(got) != 1 {
		t.Fatalf("first answer hits=%+v", got)
	}
	if got := searchAll(t, s, "the second answer"); len(got) != 1 {
		t.Fatalf("second answer hits=%+v", got)
	}
	// The joined text would be the two bodies glued together, with no separator
	// to hide the mistake.
	if got := searchAll(t, s, "the first answerthe second"); len(got) != 0 {
		t.Fatalf("the two answers merged: %+v", got)
	}
}

// A message identified by id and block index is replaced by its own final, not
// by a later message's — and not *into* a later message's row either. The second
// preview is open when the first final arrives; superseding by speaker and role
// would overwrite the message that is still streaming.
func TestTranscriptIndexIdentifiedFinalReplacesOnlyItself(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000004"
	seedTranscriptTask(t, s, taskID, "Identified", "")

	preview := delta("keep this text")
	preview["message_id"] = "m1"
	preview["index"] = 0
	appendPayload(t, s, taskID, preview)

	other := delta("the other answer")
	other["message_id"] = "m2"
	other["index"] = 0
	appendPayload(t, s, taskID, other)

	final := map[string]any{
		"role":       "assistant",
		"content":    []map[string]any{{"type": "text", "text": "keep this text exactly"}},
		"partial":    false,
		"message_id": "m1",
		"index":      0,
	}
	appendPayload(t, s, taskID, final)

	hits := searchAll(t, s, "keep this text")
	if len(hits) != 1 {
		t.Fatalf("hits=%d want 1: %+v", len(hits), hits)
	}
	if !strings.Contains(hits[0].Snippet, "exactly") {
		t.Fatalf("snippet=%q is the preview, not the final", hits[0].Snippet)
	}
	if got := searchAll(t, s, "the other answer"); len(got) != 1 {
		t.Fatalf("the message still streaming was overwritten: %+v", got)
	}
}

// An adapter that only streams deltas — ACP does — must still be searchable,
// and one answer must not become one row per chunk.
func TestTranscriptIndexPartialOnlyAdapterIsSearchable(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000005"
	seedTranscriptTask(t, s, taskID, "ACP", "")

	chunk := delta("the answer is ")
	chunk["message_id"] = "chunk-1"
	appendPayload(t, s, taskID, chunk)
	chunk = delta("forty two")
	chunk["message_id"] = "chunk-1"
	appendPayload(t, s, taskID, chunk)

	hits := searchAll(t, s, "forty two")
	if len(hits) != 1 {
		t.Fatalf("hits=%d want 1: %+v", len(hits), hits)
	}
	if !strings.Contains(hits[0].Snippet, "the answer is forty two") {
		t.Fatalf("snippet=%q is a fragment", hits[0].Snippet)
	}
}

// Every message the projection draws is readable: the chat column shows the
// host's answers, and the process box shows reasoning, plan/progress, worker
// and orchestrator rows once it is unfolded. The find bar reaches both, so the
// index keeps both.
func TestTranscriptIndexKeepsWhatTheProcessBoxDraws(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000006"
	seedTranscriptTask(t, s, taskID, "Process box", "")

	cases := []map[string]any{
		{
			"role":    "reasoning",
			"content": []map[string]any{{"type": "text", "text": "HIDDEN_TOKEN thinking"}},
			"partial": false,
		},
		{
			"role":    "assistant",
			"phase":   "progress",
			"content": []map[string]any{{"type": "text", "text": "HIDDEN_TOKEN progress"}},
			"partial": false,
		},
		{
			"role":       "assistant",
			"visibility": map[string]any{"task": true, "user": false},
			"content":    []map[string]any{{"type": "text", "text": "HIDDEN_TOKEN worker"}},
			"partial":    false,
			"speaker":    "worker-a",
		},
		{
			"role":    "assistant",
			"source":  "delegate",
			"content": []map[string]any{{"type": "text", "text": "HIDDEN_TOKEN delegate"}},
			"partial": false,
		},
		{
			"role":    "assistant",
			"source":  "orchestrator",
			"content": []map[string]any{{"type": "text", "text": "HIDDEN_TOKEN orchestrator"}},
			"partial": false,
		},
	}
	for _, payload := range cases {
		appendPayload(t, s, taskID, payload)
	}

	if hits := searchAll(t, s, "HIDDEN_TOKEN"); len(hits) != len(cases) {
		t.Fatalf("hits=%d want %d: %+v", len(hits), len(cases), hits)
	}
}

// A host row and a summary row are chat, not progress: both must stay.
func TestTranscriptIndexKeepsHostAndSummaryRows(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000007"
	if err := s.InsertTask(context.Background(), Task{
		ID: taskID, Title: "Host", Agent: "kinagent", Cwd: "/tmp", Prompt: "p",
		Status: "finished", CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}

	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"speaker": "kinagent",
		"content": []map[string]any{{"type": "text", "text": "VISIBLE_TOKEN host answer"}},
		"partial": false,
	})
	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"phase":   "summary",
		"source":  "orchestrator",
		"content": []map[string]any{{"type": "text", "text": "VISIBLE_TOKEN summary"}},
		"partial": false,
	})

	if hits := searchAll(t, s, "VISIBLE_TOKEN"); len(hits) != 2 {
		t.Fatalf("hits=%d want 2: %+v", len(hits), hits)
	}
}

// `readVisibility` fills in a missing `task` as true, so a stamp that names
// only `user: false` is task-only: the console draws it in the process box,
// which is a different item from the bubble streaming next to it. Both are
// searchable; they are not one message.
func TestTranscriptIndexReadsAVisibilityStampLikeTheConsole(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000018"
	seedTranscriptTask(t, s, taskID, "Stamp", "")

	left := delta("STAMP_TOKEN left")
	left["speaker"] = "claude-code"
	appendPayload(t, s, taskID, left)

	right := delta("STAMP_TOKEN right")
	right["speaker"] = "claude-code"
	right["visibility"] = map[string]any{"user": false}
	appendPayload(t, s, taskID, right)

	if hits := searchAll(t, s, "leftSTAMP_TOKEN right"); len(hits) != 0 {
		t.Fatalf("a task-only row was folded into the chat stream: %+v", hits)
	}
	if hits := searchAll(t, s, "STAMP_TOKEN"); len(hits) != 2 {
		t.Fatalf("hits=%d want 2: %+v", len(hits), hits)
	}
}

// A row that stamps a visibility but no speaker still speaks with the host: the
// console hands `resolveSpeaker` the task's agent (`task.agent || "kin"`), not
// the bare "assistant" a missing name would produce. The name is what a later
// final of the same block matches on, so the two have to agree.
func TestTranscriptIndexNamesTheHostForAStampedSpeakerlessRow(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000026"
	seedTranscriptTask(t, s, taskID, "Stamped host", "")

	preview := delta("HOSTNAME_TOKEN preview")
	preview["visibility"] = map[string]any{"task": true}
	preview["message_id"] = "m1"
	preview["index"] = 0
	appendPayload(t, s, taskID, preview)

	// The legacy final of the same block names neither a speaker nor a
	// visibility: it resolves to the task's agent.
	appendPayload(t, s, taskID, map[string]any{
		"role":       "assistant",
		"message_id": "m1",
		"index":      0,
		"content":    []map[string]any{{"type": "text", "text": "HOSTNAME_TOKEN final"}},
	})

	if hits := searchAll(t, s, "HOSTNAME_TOKEN preview"); len(hits) != 0 {
		t.Fatalf("the final did not replace its own preview: %+v", hits)
	}
	if hits := searchAll(t, s, "HOSTNAME_TOKEN final"); len(hits) != 1 {
		t.Fatalf("hits=%d want 1: %+v", len(hits), hits)
	}
}

// Phase-less orchestrator rows are the oldest history: the console keeps the
// wrap-up by its wording and hides the rest, so the index must make the same
// call instead of hiding every one of them.
func TestTranscriptIndexKeepsLegacyOrchestratorSummaries(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000017"
	seedTranscriptTask(t, s, taskID, "Legacy summary", "")

	for _, text := range []string{"Done: shipped it", "完成：已合并", "worker chatter"} {
		appendPayload(t, s, taskID, map[string]any{
			"role":    "assistant",
			"source":  "orchestrator",
			"content": []map[string]any{{"type": "text", "text": text}},
			"partial": false,
		})
	}

	if hits := searchAll(t, s, "shipped it"); len(hits) != 1 {
		t.Fatalf("the legacy wrap-up is not searchable: %+v", hits)
	}
	if hits := searchAll(t, s, "已合并"); len(hits) != 1 {
		t.Fatalf("the Chinese wrap-up is not searchable: %+v", hits)
	}
	// The chatter is drawn in the process box, so it answers too; it is not the
	// wrap-up and must not be mistaken for one.
	if hits := searchAll(t, s, "worker chatter"); len(hits) != 1 {
		t.Fatalf("process-box chatter is not searchable: %+v", hits)
	}
}

// The canonical envelope stores the origin under `source`, and the console
// reads it there. A row that names it sits on the other side of the process
// box, so a stream on either side of it is not one message.
func TestTranscriptIndexReadsTheOriginFromSource(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000029"
	seedTranscriptTask(t, s, taskID, "Origin", "")

	appendPayload(t, s, taskID, delta("beforeORIGIN_TOKEN"))
	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"source":  "orchestrator",
		"partial": true,
		"content": []map[string]any{{"type": "text", "text": "ORIGIN_TOKEN mid"}},
	})
	appendPayload(t, s, taskID, delta("afterORIGIN_TOKEN"))

	if hits := searchAll(t, s, "beforeORIGIN_TOKENORIGIN_TOKEN"); len(hits) != 0 {
		t.Fatalf("an orchestrator row was folded into the chat stream: %+v", hits)
	}
	if hits := searchAll(t, s, "ORIGIN_TOKEN mid"); len(hits) != 1 {
		t.Fatalf("the orchestrator row is not searchable: %+v", hits)
	}
}

// Legacy rows without a visibility stamp: the task's own agent is the chat
// column, anyone else is drawn in the process box. Both are readable, and the
// worker's row ends the host's stream instead of joining it.
func TestTranscriptIndexDrawsLegacyWorkerRowsInTheProcessBox(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000008"
	if err := s.InsertTask(context.Background(), Task{
		ID: taskID, Title: "Legacy", Agent: "kinagent", Cwd: "/tmp", Prompt: "p",
		Status: "finished", CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	appendPayload(t, s, taskID, delta("LEGACY_TOKEN first half"))
	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"speaker": "worker-b",
		"content": []map[string]any{{"type": "text", "text": "LEGACY_TOKEN worker"}},
		"partial": false,
	})
	appendPayload(t, s, taskID, delta("LEGACY_TOKEN second half"))

	if hits := searchAll(t, s, "halfLEGACY_TOKEN"); len(hits) != 0 {
		t.Fatalf("the worker row did not separate the host's stream: %+v", hits)
	}
	if hits := searchAll(t, s, "LEGACY_TOKEN"); len(hits) != 3 {
		t.Fatalf("hits=%d want 3: %+v", len(hits), hits)
	}
}

// The console tests for a legacy tool dump with `/m`: a dump line after prose
// still makes the whole message a step, not a bubble. The prose beside it is
// then on no screen and must not answer.
func TestTranscriptIndexTreatsALateLegacyDumpAsAStep(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000027"
	seedTranscriptTask(t, s, taskID, "Late dump", "")

	appendPayload(t, s, taskID, delta("BEFORE_DUMP_TOKEN "))
	appendPayload(t, s, taskID, map[string]any{
		"role": "assistant",
		"content": []map[string]any{{"type": "text",
			"text": "PROSEONLY_TOKEN prose\n**bash**\n```\nls\n```"}},
	})
	appendPayload(t, s, taskID, delta("AFTER_DUMP_TOKEN"))

	if hits := searchAll(t, s, "PROSEONLY_TOKEN"); len(hits) != 0 {
		t.Fatalf("a legacy tool dump was indexed as prose: %+v", hits)
	}
	if hits := searchAll(t, s, "BEFORE_DUMP_TOKEN AFTER_DUMP_TOKEN"); len(hits) != 0 {
		t.Fatalf("the dump did not end the stream: %+v", hits)
	}
	if hits := searchAll(t, s, "BEFORE_DUMP_TOKEN"); len(hits) != 1 {
		t.Fatalf("the stream before the dump is not searchable: %+v", hits)
	}
}

// The index is derived: a database that already has message events gets them
// folded in at open, and a replay over the same events must not double them.
func TestTranscriptIndexBackfillsExistingEventsOnce(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000009"
	seedTranscriptTask(t, s, taskID, "Backfill", "")

	// Write the events the way an older binary would have: straight into the
	// log, with no index row and no watermark.
	payload, err := json.Marshal(map[string]any{
		"role":    "assistant",
		"content": []map[string]any{{"type": "text", "text": "BACKFILL_TOKEN already here"}},
		"partial": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`
		INSERT INTO events (task_id, seq, ts, type, payload) VALUES (?, 1, ?, 'message', ?)`,
		taskID, NowMilli(), string(payload)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DELETE FROM transcript_index_state WHERE task_id = ?`, taskID); err != nil {
		t.Fatal(err)
	}
	if hits := searchAll(t, s, "BACKFILL_TOKEN"); len(hits) != 0 {
		t.Fatalf("the raw event was already indexed: %+v", hits)
	}

	if err := s.backfillTranscriptIndex(context.Background()); err != nil {
		t.Fatal(err)
	}
	if hits := searchAll(t, s, "BACKFILL_TOKEN"); len(hits) != 1 {
		t.Fatalf("hits=%d want 1: %+v", len(hits), hits)
	}

	// A second pass must not append the text again.
	if _, err := s.db.Exec(`DELETE FROM transcript_index_state WHERE task_id = ?`, taskID); err != nil {
		t.Fatal(err)
	}
	if err := s.backfillTranscriptIndex(context.Background()); err != nil {
		t.Fatal(err)
	}
	hits := searchAll(t, s, "BACKFILL_TOKEN")
	if len(hits) != 1 || strings.Count(hits[0].Snippet, "already here") != 1 {
		t.Fatalf("replay duplicated the message: %+v", hits)
	}
}

// A backfill has to remember that it ran. The task is selected for indexing by
// the absence of a state row, so a replay that folds rows without writing its
// watermark asks for the same work at every open — and because the row it wrote
// last time is now the newest open stream, the partial tail joins its own copy
// and the text doubles. A complete message hides this: its key is its seq, so
// the second pass updates the same row instead of appending.
func TestTranscriptIndexBackfillsAPartialTailOnce(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000028"
	seedTranscriptTask(t, s, taskID, "Partial backfill", "")

	// The event a streaming adapter leaves when the task is interrupted: one
	// partial delta and nothing after it.
	payload, err := json.Marshal(delta("please deploy the release carefully"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`
		INSERT INTO events (task_id, seq, ts, type, payload) VALUES (?, 1, ?, 'message', ?)`,
		taskID, NowMilli(), string(payload)); err != nil {
		t.Fatal(err)
	}

	if err := s.backfillTranscriptIndex(context.Background()); err != nil {
		t.Fatal(err)
	}
	var states int
	if err := s.db.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM transcript_index_state WHERE task_id = ?`, taskID).Scan(&states); err != nil {
		t.Fatal(err)
	}
	if states != 1 {
		t.Fatalf("the backfill wrote no watermark: states=%d", states)
	}

	// The state row is what tells the next open this task is done.
	if err := s.backfillTranscriptIndex(context.Background()); err != nil {
		t.Fatal(err)
	}
	if hits := searchAll(t, s, "carefullyplease"); len(hits) != 0 {
		t.Fatalf("the partial tail was replayed over its own row: %+v", hits)
	}
	if hits := searchAll(t, s, "carefully"); len(hits) != 1 {
		t.Fatalf("hits=%d want 1: %+v", len(hits), hits)
	}
}

// A payload the index cannot read is history that is not searchable; it must
// not fail the append that stores it.
func TestTranscriptIndexIgnoresMalformedPayload(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000010"
	seedTranscriptTask(t, s, taskID, "Malformed", "")

	if _, err := s.AppendEvent(context.Background(), taskID, "message", []byte(`{"role":`)); err != nil {
		t.Fatalf("a malformed payload failed the append: %v", err)
	}
	if hits := searchAll(t, s, "role"); len(hits) != 0 {
		t.Fatalf("malformed payload answered %+v", hits)
	}
}

// The console reads text from a string body and from a flat `text` field as
// well as from content blocks; the index must not be narrower than the screen.
func TestTranscriptIndexReadsEveryTextShape(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000011"
	seedTranscriptTask(t, s, taskID, "Shapes", "")

	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"content": "SHAPE_TOKEN string body",
		"partial": false,
	})
	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"text":    "SHAPE_TOKEN flat field",
		"partial": false,
	})

	if hits := searchAll(t, s, "SHAPE_TOKEN"); len(hits) != 2 {
		t.Fatalf("hits=%d want 2: %+v", len(hits), hits)
	}
}

// A task whose epoch advanced without the index being pruned — an older build,
// or any path that bumps it directly — keeps its events; the console stamps
// them with the current epoch and still shows them. The index rebuilds from
// what is left instead of dropping the kept timeline.
func TestTranscriptIndexRebuildsTheKeptTimelineOnANewEpoch(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000015"
	seedTranscriptTask(t, s, taskID, "New epoch", "")

	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"content": []map[string]any{{"type": "text", "text": "OLD_EPOCH_TOKEN"}},
	})
	if _, err := s.db.Exec(`UPDATE tasks SET event_epoch = event_epoch + 1 WHERE id = ?`, taskID); err != nil {
		t.Fatal(err)
	}
	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"content": []map[string]any{{"type": "text", "text": "NEW_EPOCH_TOKEN"}},
	})

	if hits := searchAll(t, s, "OLD_EPOCH_TOKEN"); len(hits) != 1 {
		t.Fatalf("the kept timeline was dropped: %+v", hits)
	}
	if hits := searchAll(t, s, "NEW_EPOCH_TOKEN"); len(hits) != 1 {
		t.Fatalf("the new epoch is not searchable: %+v", hits)
	}
}

// A progress row between two visible deltas ends the visible stream, exactly as
// it does on screen, so the two answers are not glued into one sentence.
func TestTranscriptIndexProgressRowEndsTheStream(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000012"
	seedTranscriptTask(t, s, taskID, "Interleaved", "")

	appendPayload(t, s, taskID, delta("STREAM_TOKEN first half"))
	appendPayload(t, s, taskID, map[string]any{
		"role":    "reasoning",
		"phase":   "progress",
		"content": []map[string]any{{"type": "text", "text": "thinking"}},
		"partial": true,
	})
	appendPayload(t, s, taskID, delta("STREAM_TOKEN second half"))

	if hits := searchAll(t, s, "first half STREAM_TOKEN second"); len(hits) != 0 {
		t.Fatalf("an interleaved progress row did not end the stream: %+v", hits)
	}
	if hits := searchAll(t, s, "STREAM_TOKEN"); len(hits) != 2 {
		t.Fatalf("hits=%d want 2: %+v", len(hits), hits)
	}
}

// Truncating a task deletes its tail and starts a new epoch. The index has to
// forget the deleted messages — and it has to accept the events that reuse
// those seq numbers, or the new timeline would never be searchable.
func TestTranscriptIndexFollowsTruncation(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000013"
	seedTranscriptTask(t, s, taskID, "Truncated", "")

	appendPayload(t, s, taskID, map[string]any{
		"role":    "user",
		"content": []map[string]any{{"type": "text", "text": "KEEP_TOKEN question"}},
	})
	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"content": []map[string]any{{"type": "text", "text": "DROP_TOKEN answer"}},
	})

	if err := s.TruncateEventsFrom(context.Background(), taskID, 2); err != nil {
		t.Fatal(err)
	}
	if hits := searchAll(t, s, "DROP_TOKEN"); len(hits) != 0 {
		t.Fatalf("a truncated message is still searchable: %+v", hits)
	}
	if hits := searchAll(t, s, "KEEP_TOKEN"); len(hits) != 1 {
		t.Fatalf("the kept message was lost: %+v", hits)
	}

	// Seq 2 is handed out again in the new epoch; it must be indexed.
	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"content": []map[string]any{{"type": "text", "text": "NEW_TOKEN answer"}},
	})
	if hits := searchAll(t, s, "NEW_TOKEN"); len(hits) != 1 {
		t.Fatalf("the new epoch is not searchable: %+v", hits)
	}
}

// Truncating from a seq that does not exist deletes nothing but still starts a
// new epoch. The watermark must not move past the head, or the next message
// would be skipped as "already folded in".
func TestTranscriptIndexKeepsUpAfterATruncationPastTheHead(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000019"
	seedTranscriptTask(t, s, taskID, "Past the head", "")

	appendPayload(t, s, taskID, map[string]any{
		"role":    "user",
		"content": []map[string]any{{"type": "text", "text": "KEPT_TOKEN question"}},
	})
	if err := s.TruncateEventsFrom(context.Background(), taskID, 9); err != nil {
		t.Fatal(err)
	}
	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"content": []map[string]any{{"type": "text", "text": "LATER_TOKEN answer"}},
	})

	if hits := searchAll(t, s, "LATER_TOKEN"); len(hits) != 1 {
		t.Fatalf("the message after the truncation is not searchable: %+v", hits)
	}
	if hits := searchAll(t, s, "KEPT_TOKEN"); len(hits) != 1 {
		t.Fatalf("the kept message was lost: %+v", hits)
	}
}

// A retry deletes the tail and writes a fresh prompt in the same transaction;
// the old answer must stop answering and the prompt must answer immediately.
func TestTranscriptIndexFollowsRetry(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000014"
	if err := s.InsertTask(context.Background(), Task{
		ID: taskID, Title: "Retried", Agent: "claude-code", Cwd: "/tmp", Prompt: "p",
		Status: "succeeded", CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	appendPayload(t, s, taskID, map[string]any{
		"role":    "user",
		"content": []map[string]any{{"type": "text", "text": "OLD_QUESTION_TOKEN"}},
	})
	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"content": []map[string]any{{"type": "text", "text": "OLD_ANSWER_TOKEN"}},
	})
	payload, err := json.Marshal(map[string]any{
		"role":    "user",
		"content": []map[string]any{{"type": "text", "text": "RETRY_TOKEN try again"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyRetryMutation(context.Background(), RetryMutation{
		TaskID:             taskID,
		FromSeq:            2,
		ExpectedEventEpoch: 0,
		Prompt:             "try again",
		UserPayload:        payload,
	}); err != nil {
		t.Fatal(err)
	}

	if hits := searchAll(t, s, "OLD_ANSWER_TOKEN"); len(hits) != 0 {
		t.Fatalf("the retried-away answer is still searchable: %+v", hits)
	}
	if hits := searchAll(t, s, "RETRY_TOKEN"); len(hits) != 1 {
		t.Fatalf("the retry prompt is not searchable: %+v", hits)
	}
}

// Kinagent streams a turn as progress notes and then sends the authoritative
// turn message with phase progress. The console removes the preview that final
// supersedes; keeping it would answer with words that are no longer on screen
// anywhere the find bar can land.
func TestTranscriptIndexDropsThePreviewACompleteNoteCloses(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000020"
	seedTranscriptTask(t, s, taskID, "Turn note", "")

	preview := delta("the abandoned words")
	preview["phase"] = "progress"
	appendPayload(t, s, taskID, preview)
	appendPayload(t, s, taskID, map[string]any{
		"role":    "assistant",
		"phase":   "progress",
		"content": []map[string]any{{"type": "text", "text": "the settled words"}},
		"partial": false,
	})

	if hits := searchAll(t, s, "abandoned"); len(hits) != 0 {
		t.Fatalf("the superseded note preview still answers: %+v", hits)
	}
	if hits := searchAll(t, s, "settled"); len(hits) != 1 {
		t.Fatalf("the final note is not searchable: %+v", hits)
	}
}

// A tool step the console draws ends the streamed text before it. The adapter
// keeps stamping the same message identity after the step, and the two halves
// are two bubbles on screen — one row in the index would answer a query the
// find bar can never land.
func TestTranscriptIndexToolStepEndsTheStream(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000021"
	seedTranscriptTask(t, s, taskID, "Tool between", "")

	first := delta("first half ")
	first["message_id"] = "m1"
	first["index"] = 0
	appendPayload(t, s, taskID, first)
	if _, err := s.AppendEvent(context.Background(), taskID, "tool_use",
		[]byte(`{"speaker":"kin","name":"bash","input":{"command":"ls"}}`)); err != nil {
		t.Fatal(err)
	}
	second := delta("second half")
	second["message_id"] = "m1"
	second["index"] = 0
	appendPayload(t, s, taskID, second)

	if hits := searchAll(t, s, "first half second half"); len(hits) != 0 {
		t.Fatalf("the tool step did not end the stream: %+v", hits)
	}
	if hits := searchAll(t, s, "first half"); len(hits) != 1 {
		t.Fatalf("the first half is not searchable: %+v", hits)
	}
	if hits := searchAll(t, s, "second half"); len(hits) != 1 {
		t.Fatalf("the second half is not searchable: %+v", hits)
	}
}

// `readVisibility` fills a missing `user` with false, so a stamp that names only
// `task` is the console saying "not the chat column". A worker's tool step is
// drawn in the process box and the host's stream keeps flowing across it; only
// the host's own steps end it.
func TestTranscriptIndexTaskOnlyToolDoesNotEndTheStream(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000025"
	seedTranscriptTask(t, s, taskID, "Task-only step", "")

	appendPayload(t, s, taskID, delta("before STAMPED_STEP_TOKEN"))
	if _, err := s.AppendEvent(context.Background(), taskID, "tool_use",
		[]byte(`{"speaker":"claude-code","visibility":{"task":true},"name":"bash"}`)); err != nil {
		t.Fatal(err)
	}
	appendPayload(t, s, taskID, delta("after STAMPED_STEP_TOKEN"))

	if hits := searchAll(t, s, "before STAMPED_STEP_TOKENafter"); len(hits) != 1 {
		t.Fatalf("a task-only step split the chat stream: %+v", hits)
	}
	if hits := searchAll(t, s, "STAMPED_STEP_TOKEN"); len(hits) != 1 {
		t.Fatalf("hits=%d want 1: %+v", len(hits), hits)
	}
}

// The backfill replays the log the same way the live hook folds it, steps
// included: a database written before the index existed must split its streams
// where the console does, not only where its messages happen to be.
func TestTranscriptIndexBackfillsStreamBoundaries(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000022"
	seedTranscriptTask(t, s, taskID, "Backfill steps", "")

	raw := []struct {
		typ     string
		payload string
	}{
		{"message", `{"role":"assistant","partial":true,"message_id":"m1","index":0,"content":[{"type":"text","text":"before "}]}`},
		{"tool_use", `{"speaker":"kin","name":"bash"}`},
		{"message", `{"role":"assistant","partial":true,"message_id":"m1","index":0,"content":[{"type":"text","text":"after"}]}`},
	}
	for i, ev := range raw {
		if _, err := s.db.Exec(`
			INSERT INTO events (task_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)`,
			taskID, i+1, NowMilli(), ev.typ, ev.payload); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.Exec(`DELETE FROM transcript_index_state WHERE task_id = ?`, taskID); err != nil {
		t.Fatal(err)
	}

	if err := s.backfillTranscriptIndex(context.Background()); err != nil {
		t.Fatal(err)
	}
	if hits := searchAll(t, s, "before after"); len(hits) != 0 {
		t.Fatalf("the backfill glued the halves together: %+v", hits)
	}
	if hits := searchAll(t, s, "before "); len(hits) != 1 {
		t.Fatalf("the first half is missing: %+v", hits)
	}
	if hits := searchAll(t, s, "after"); len(hits) != 1 {
		t.Fatalf("the second half is missing: %+v", hits)
	}
}

// The console keys a message block by speaker, role, id and index. Two agents
// can stream block 0 of the same message id; one row each, not one row that
// overwrites the other.
func TestTranscriptIndexKeepsOneBlockFromTwoSpeakersApart(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000023"
	seedTranscriptTask(t, s, taskID, "Two voices", "")

	for _, speaker := range []string{"kin", "worker-b"} {
		payload := delta("SHARED_ID_TOKEN from " + speaker)
		payload["speaker"] = speaker
		payload["message_id"] = "m1"
		payload["index"] = 0
		appendPayload(t, s, taskID, payload)
	}

	if hits := searchAll(t, s, "SHARED_ID_TOKEN"); len(hits) != 2 {
		t.Fatalf("hits=%d want 2: %+v", len(hits), hits)
	}

	// One speaker's final replaces only its own preview. The other agent is
	// still streaming block 0 of its message, and the console keeps it: the
	// identity carries the speaker for exactly this case.
	appendPayload(t, s, taskID, map[string]any{
		"role":       "assistant",
		"speaker":    "worker-b",
		"message_id": "m1",
		"index":      0,
		"content":    []map[string]any{{"type": "text", "text": "WORKER_FINAL_TOKEN"}},
	})
	if hits := searchAll(t, s, "SHARED_ID_TOKEN from kin"); len(hits) != 1 {
		t.Fatalf("the other speaker's preview was dropped: %+v", hits)
	}
	if hits := searchAll(t, s, "SHARED_ID_TOKEN from worker-b"); len(hits) != 0 {
		t.Fatalf("a speaker's preview outlived its own final: %+v", hits)
	}
	if hits := searchAll(t, s, "WORKER_FINAL_TOKEN"); len(hits) != 1 {
		t.Fatalf("the final is missing: %+v", hits)
	}
}

// The composer appends the uploads' local paths to the prompt; the console
// hides them behind a name-only summary, so a search must not answer with a
// path that is on no screen.
func TestTranscriptIndexHidesUploadPathsLikeTheConsole(t *testing.T) {
	s := openTranscriptStore(t)
	taskID := "01IDX000000000000000000024"
	seedTranscriptTask(t, s, taskID, "Upload", "")

	appendPayload(t, s, taskID, map[string]any{
		"role": "user",
		"content": []map[string]any{{"type": "text", "text": "look at this\n\n" +
			"Attached image:\n- shot.png: /Users/me/.kin/uploads/ab12.png"}},
	})

	if hits := searchAll(t, s, "ab12.png"); len(hits) != 0 {
		t.Fatalf("the hidden upload path answered: %+v", hits)
	}
	if hits := searchAll(t, s, "shot.png"); len(hits) != 1 {
		t.Fatalf("the file name the reader sees is not searchable: %+v", hits)
	}
	if hits := searchAll(t, s, "look at this"); len(hits) != 1 {
		t.Fatalf("the prompt itself is not searchable: %+v", hits)
	}
}
