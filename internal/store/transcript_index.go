package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"

	"github.com/vuuihc/openkin/internal/attach"
)

// TranscriptMessagesDDL holds the transcript as a reader sees it, one row per
// message, so a search can ask about sentences instead of about the event log.
//
// It is derived data: `events` stays the source of truth, and a missing or
// partial index can always be rebuilt from it. That is why the write path
// tolerates a payload it cannot decode — the event is still served, it is only
// not searchable.
//
// Three columns describe where a row sits in the conversation:
//   - `open` marks the stream buffer: the row the next delta continues. A step
//     the console draws — a tool call, a notice, the result — ends it.
//   - `partial` marks a preview: a row the console may still replace or remove
//     when the authoritative message arrives. Tool events flush a preview into
//     an item without settling it, so `open` and `partial` are not the same
//     question.
//   - `progress` marks a row the console draws in the process box rather than
//     the chat column. Both are readable, but they are separate items on
//     screen, and a search row may not span the two.
//
// `message_key` is the identity the console supersedes by (`message_id` plus
// block index). It repeats when a flush splits one message in two, so the row
// key and the console's key are kept apart.
const TranscriptMessagesDDL = `
CREATE TABLE IF NOT EXISTS transcript_messages (
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stream_key  TEXT NOT NULL,
  message_key TEXT NOT NULL DEFAULT '',
  speaker     TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',
  open        INTEGER NOT NULL DEFAULT 0,
  partial     INTEGER NOT NULL DEFAULT 0,
  progress    INTEGER NOT NULL DEFAULT 0,
  text        TEXT NOT NULL DEFAULT '',
  first_seq   INTEGER NOT NULL,
  last_seq    INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (task_id, stream_key)
);
CREATE INDEX IF NOT EXISTS idx_transcript_messages_last ON transcript_messages(task_id, last_seq DESC);
CREATE INDEX IF NOT EXISTS idx_transcript_messages_ts ON transcript_messages(ts DESC);
CREATE INDEX IF NOT EXISTS idx_transcript_messages_key ON transcript_messages(task_id, message_key);

CREATE TABLE IF NOT EXISTS transcript_index_state (
  task_id     TEXT NOT NULL PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  event_epoch INTEGER NOT NULL DEFAULT 0,
  indexed_seq INTEGER NOT NULL DEFAULT 0
);
`

// transcriptIndexEventTypes are the events the index reads: the ones that carry
// prose, plus the ones that settle the streamed prose before them.
//
// The console flushes its buffer at exactly these points. A boundary the index
// does not copy would glue two bubbles into one searchable row that the find
// bar can never match as a whole, and a hit the reader cannot land on is worse
// than an omitted one.
var transcriptIndexEventTypes = []string{
	"message",
	"tool_use", "tool_result",
	"notice", "plan", "error", "result",
	"approval_requested", "user_question_requested",
	"route_decision", "route_fallback",
	"workspace_provisioning", "workspace_ready", "workspace_active",
	"workspace_finalizing", "workspace_integrated", "workspace_released",
	"workspace_merge_blocked", "workspace_finalize_blocked",
	"workspace_orphaned", "workspace_legacy_pending",
}

var transcriptIndexEventTypesSQL = func() string {
	quoted := make([]string, len(transcriptIndexEventTypes))
	for i, typ := range transcriptIndexEventTypes {
		quoted[i] = "'" + typ + "'"
	}
	return strings.Join(quoted, ",")
}()

func transcriptIndexedEventType(typ string) bool {
	for _, indexed := range transcriptIndexEventTypes {
		if indexed == typ {
			return true
		}
	}
	return false
}

// transcriptEnvelope is the payload shape the adapters write and the console
// renders (`transcriptProjection.ts`). Unknown fields are ignored on purpose:
// adapters add fields over time and a search index must not reject a message
// because someone stamped a new key on it.
type transcriptEnvelope struct {
	Role    string `json:"role"`
	Speaker string `json:"speaker"`
	Agent   string `json:"agent"`
	// The canonical envelope stores the origin under `source`
	// (`task.EventMeta.Source`), and the console reads it there
	// (`decodeCanonicalEventMeta`). Reading `origin` would leave every legacy
	// orchestrator row classified as chat.
	Source     string          `json:"source"`
	Phase      string          `json:"phase"`
	Code       string          `json:"code"`
	Title      string          `json:"title"`
	Message    string          `json:"message"`
	Partial    bool            `json:"partial"`
	MessageID  string          `json:"message_id"`
	Index      json.RawMessage `json:"index"`
	Text       string          `json:"text"`
	Content    json.RawMessage `json:"content"`
	Visibility *struct {
		User *bool `json:"user"`
		Task *bool `json:"task"`
	} `json:"visibility"`
}

// ensureTranscriptIndexSchema creates the derived tables on any database that
// lacks them. The DDL is idempotent, so this runs on every open rather than
// only on a version bump; the backfill in Open fills it from `events`.
func (s *Store) ensureTranscriptIndexSchema() error {
	if _, err := s.db.Exec(TranscriptMessagesDDL); err != nil {
		return fmt.Errorf("ensure transcript index: %w", err)
	}
	return nil
}

// prepareTranscriptIndex creates the supporting index and folds any indexed
// event written before this index existed into it.
//
// A database can be missing `events` entirely — an old, hand-built fixture in a
// migration test is the one that exists — and there is nothing to derive there.
// The check is cheap and keeps Open honest on every shape it is handed.
func (s *Store) prepareTranscriptIndex(ctx context.Context) error {
	exists, err := s.hasTable(ctx, "events")
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	if err := s.ensureTranscriptIndexEventIndex(); err != nil {
		return err
	}
	return s.backfillTranscriptIndex(ctx)
}

func (s *Store) hasTable(ctx context.Context, name string) (bool, error) {
	var found string
	err := s.db.QueryRowContext(ctx,
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect schema: %w", err)
	}
	return true, nil
}

// ensureTranscriptIndexEventIndex is separate from the DDL above because it
// touches `events`, the one table a partial-schema fixture may not have yet.
func (s *Store) ensureTranscriptIndexEventIndex() error {
	// The backfill asks "which tasks have indexable events past their
	// watermark" on every start. Without this index that question scans the
	// whole event log; with it, it walks only the rows the index reads.
	if _, err := s.db.Exec(`CREATE INDEX IF NOT EXISTS idx_events_type_task_seq ON events(type, task_id, seq)`); err != nil {
		return fmt.Errorf("ensure transcript index event index: %w", err)
	}
	return nil
}

// indexTranscriptMessageTx folds one event into the derived transcript inside
// the caller's transaction, so the index can never be behind an event that
// committed.
//
// Streaming adapters persist every delta as a message with `partial: true`
// (`claudecode`, `droid`, the Kin agent), and the console concatenates those
// deltas into one bubble. Searching the event log would answer with one row per
// fragment — `ploy the release` for an answer that says `deploy the release` —
// so this mirrors the console's projection: consecutive deltas of the same
// message become one row, the authoritative message replaces the preview it
// closes, and the steps the console draws end the stream.
//
// A payload it cannot decode is not an error: the event is still valid history,
// it just cannot be searched.
func indexTranscriptMessageTx(
	ctx context.Context, tx *sql.Tx, taskID string, epoch, seq, ts int64, eventType string, payload []byte,
) error {
	if !transcriptIndexedEventType(eventType) {
		return nil
	}
	stateEpoch, watermark, err := transcriptWatermarkTx(ctx, tx, taskID)
	if err != nil {
		return err
	}
	if stateEpoch != epoch {
		// A retry or a truncation started a new timeline without pruning the
		// index — an older build, or any path that bumps the epoch directly. The
		// events that are left are what the console re-projects, so rebuild from
		// them rather than trusting rows folded before the change.
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM transcript_messages WHERE task_id = ?`, taskID); err != nil {
			return fmt.Errorf("reset transcript index: %w", err)
		}
		return replayTranscriptEventsTx(ctx, tx, taskID, epoch)
	}
	if seq <= watermark {
		// Already folded in. A replay from the watermark can overlap the hook.
		return nil
	}
	var env transcriptEnvelope
	if err := json.Unmarshal(payload, &env); err == nil {
		if err := applyTranscriptEventTx(ctx, tx, taskID, seq, ts, eventType, &env); err != nil {
			return err
		}
	}
	return setTranscriptWatermarkTx(ctx, tx, taskID, epoch, seq)
}

// resetTranscriptIndexFromTx rebuilds the index from the events that are left
// after a truncation or a retry.
//
// The old rows cannot simply be kept: a preview that straddled the cut, or one
// that a deleted message had superseded, no longer describes what the console
// re-projects from the kept events.
func resetTranscriptIndexFromTx(ctx context.Context, tx *sql.Tx, taskID string, epoch int64) error {
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM transcript_messages WHERE task_id = ?`, taskID); err != nil {
		return fmt.Errorf("reset transcript index: %w", err)
	}
	return replayTranscriptEventsTx(ctx, tx, taskID, epoch)
}

// applyTranscriptEventTx folds one decoded event: a message is projected, and
// anything else that the console draws closes the stream before it.
func applyTranscriptEventTx(
	ctx context.Context, tx *sql.Tx, taskID string, seq, ts int64, eventType string, env *transcriptEnvelope,
) error {
	if eventType == "message" {
		return applyTranscriptMessageTx(ctx, tx, taskID, seq, ts, env)
	}
	host := ""
	if eventType == "tool_use" || eventType == "tool_result" {
		var err error
		host, err = transcriptHostSpeakerTx(ctx, tx, taskID, env)
		if err != nil {
			return err
		}
	}
	return flushTranscriptStreamTx(ctx, tx, taskID, eventType, env, host)
}

// applyTranscriptMessageTx decides whether a message continues the row being
// streamed, replaces what it supersedes, or starts a new one.
//
// The rules come from the console's projection, which is the authority on what
// a reader sees. Every non-blank message it draws is indexed — in the chat
// column or in the process box, both are readable and the find bar reaches
// both. What is not indexed is the text it never draws as prose: old kinagent
// tool dumps become a step, not a message.
func applyTranscriptMessageTx(ctx context.Context, tx *sql.Tx, taskID string, seq, ts int64, env *transcriptEnvelope) error {
	host, err := transcriptHostSpeakerTx(ctx, tx, taskID, env)
	if err != nil {
		return err
	}
	speaker := env.resolvedSpeaker(host)
	role := env.Role
	text := env.text()
	// The text is kept exactly as streamed: trimming each delta would glue the
	// last word of one chunk to the first word of the next ("release" +
	// " carefully" -> "releasecarefully"). Only a wholly blank message is
	// dropped, which is what the console does with it.
	blank := strings.TrimSpace(text) == ""
	identity := env.identity(speaker, role)
	progress := env.asProgress(host)

	// Old kinagent builds dumped tool calls into message prose. The console
	// turns those into a progress step: the words never reach the transcript as
	// text, so they close the stream and are not indexed.
	if transcriptIsLegacyToolDump(text) {
		return closeTranscriptStreamsTx(ctx, tx, taskID)
	}

	if env.Partial {
		last, err := lastTranscriptMessageTx(ctx, tx, taskID)
		if err != nil {
			return err
		}
		// A delta continues the open row when it is the same speaker, the same
		// side of the process box, and — when it names its block — the same
		// message. The role is deliberately not compared: the console does not
		// split a stream over it either.
		joinable := last != nil && last.open && last.speaker == speaker &&
			last.progress == progress &&
			(identity == "" || last.messageKey == identity)
		if joinable {
			if blank {
				return nil
			}
			_, err := tx.ExecContext(ctx, `
				UPDATE transcript_messages
				SET text = text || ?, last_seq = ?, ts = ?
				WHERE task_id = ? AND stream_key = ?`,
				text, seq, ts, taskID, last.key)
			if err != nil {
				return fmt.Errorf("append transcript delta: %w", err)
			}
			return nil
		}
		if err := closeTranscriptStreamsTx(ctx, tx, taskID); err != nil {
			return err
		}
		if blank {
			// Nothing to start a row with, and the stream before it is closed.
			return nil
		}
		key := identity
		if key == "" {
			key = transcriptRunPrefix + fmt.Sprint(seq)
		}
		key, err = freeTranscriptKeyTx(ctx, tx, taskID, key, seq)
		if err != nil {
			return err
		}
		return insertTranscriptMessageTx(ctx, tx, taskID, transcriptRow{
			key: key, messageKey: identity, speaker: speaker, role: role,
			progress: progress, open: true, partial: true, text: text,
		}, seq, ts)
	}

	// A complete message closes the previews it supersedes, whether or not it
	// has words to put in their place: the console removes them before it
	// decides not to draw anything.
	if speaker != "user" {
		if err := supersedeTranscriptPreviewsTx(ctx, tx, taskID, speaker, identity); err != nil {
			return err
		}
	}
	if err := dropSupersededBufferTx(ctx, tx, taskID, speaker, role, identity); err != nil {
		return err
	}
	if blank {
		return nil
	}
	key := identity
	if key == "" {
		key = fmt.Sprintf("msg-%d", seq)
	}
	return insertTranscriptMessageTx(ctx, tx, taskID, transcriptRow{
		key: key, messageKey: identity, speaker: speaker, role: role,
		progress: progress, text: text,
	}, seq, ts)
}

const transcriptRunPrefix = "run-"

// supersedeTranscriptPreviewsTx removes the finished previews a complete
// message supersedes, the way the console's backward scan does. Notes are
// excluded: the console's scan only removes message items, and a note is
// replaced through its own key instead.
//
// The scan stops at the last user message. It does not stop at notices, plans
// or errors the way the console's does — the index keeps no rows for them — so
// it can remove a preview the console would have kept. That direction loses a
// hit; the other would answer with text nobody can land on.
func supersedeTranscriptPreviewsTx(ctx context.Context, tx *sql.Tx, taskID, speaker, identity string) error {
	if identity != "" {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM transcript_messages
			WHERE task_id = ? AND message_key = ? AND partial = 1 AND progress = 0
			  AND last_seq > `+transcriptRoundStartSQL,
			taskID, identity, taskID); err != nil {
			return fmt.Errorf("supersede transcript preview: %w", err)
		}
		return nil
	}
	var key string
	err := tx.QueryRowContext(ctx, `
		SELECT stream_key FROM transcript_messages
		WHERE task_id = ? AND partial = 1 AND progress = 0 AND open = 0 AND speaker = ?
		  AND last_seq > `+transcriptRoundStartSQL+`
		ORDER BY last_seq DESC LIMIT 1`,
		taskID, speaker, taskID).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("find transcript preview: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM transcript_messages WHERE task_id = ? AND stream_key = ?`,
		taskID, key); err != nil {
		return fmt.Errorf("supersede transcript preview: %w", err)
	}
	return nil
}

// transcriptRoundStartSQL is the seq of the last user message, the point the
// console's backward scans stop at.
const transcriptRoundStartSQL = `COALESCE((SELECT MAX(last_seq) FROM transcript_messages WHERE task_id = ? AND speaker = 'user'), 0)`

// dropSupersededBufferTx ends the open stream the way a complete message does:
// it removes the buffer it supersedes, and flushes (keeps) it otherwise.
func dropSupersededBufferTx(ctx context.Context, tx *sql.Tx, taskID, speaker, role, identity string) error {
	var key, messageKey, bufferSpeaker, bufferRole string
	err := tx.QueryRowContext(ctx, `
		SELECT stream_key, message_key, speaker, role FROM transcript_messages
		WHERE task_id = ? AND open = 1
		ORDER BY last_seq DESC LIMIT 1`, taskID).
		Scan(&key, &messageKey, &bufferSpeaker, &bufferRole)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read transcript buffer: %w", err)
	}
	supersedes := (identity != "" && messageKey == identity) ||
		(identity == "" && bufferSpeaker == speaker && bufferRole == role)
	if !supersedes {
		return closeTranscriptStreamsTx(ctx, tx, taskID)
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM transcript_messages WHERE task_id = ? AND stream_key = ?`,
		taskID, key); err != nil {
		return fmt.Errorf("drop transcript preview: %w", err)
	}
	return nil
}

type transcriptRow struct {
	key        string
	messageKey string
	speaker    string
	role       string
	text       string
	progress   bool
	open       bool
	partial    bool
}

// freeTranscriptKeyTx keeps a streamed message's key unique when a flush split
// it in two: both halves carry the same console identity, and the row key
// cannot.
func freeTranscriptKeyTx(ctx context.Context, tx *sql.Tx, taskID, key string, seq int64) (string, error) {
	var taken int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM transcript_messages WHERE task_id = ? AND stream_key = ?`,
		taskID, key).Scan(&taken); err != nil {
		return "", fmt.Errorf("inspect transcript key: %w", err)
	}
	if taken == 0 {
		return key, nil
	}
	return fmt.Sprintf("%s@%d", key, seq), nil
}

func insertTranscriptMessageTx(ctx context.Context, tx *sql.Tx, taskID string, row transcriptRow, seq, ts int64) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO transcript_messages
			(task_id, stream_key, message_key, speaker, role, open, partial, progress, text, first_seq, last_seq, ts)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(task_id, stream_key) DO UPDATE SET
			message_key = excluded.message_key,
			speaker = excluded.speaker,
			role = excluded.role,
			open = excluded.open,
			partial = excluded.partial,
			progress = excluded.progress,
			text = excluded.text,
			first_seq = excluded.first_seq,
			last_seq = excluded.last_seq,
			ts = excluded.ts`,
		taskID, row.key, row.messageKey, row.speaker, row.role,
		boolInt(row.open), boolInt(row.partial), boolInt(row.progress),
		row.text, seq, seq, ts)
	if err != nil {
		return fmt.Errorf("insert transcript message: %w", err)
	}
	return nil
}

type transcriptMessageRow struct {
	key        string
	messageKey string
	speaker    string
	role       string
	progress   bool
	open       bool
}

func lastTranscriptMessageTx(ctx context.Context, tx *sql.Tx, taskID string) (*transcriptMessageRow, error) {
	var row transcriptMessageRow
	var progress, open int
	err := tx.QueryRowContext(ctx, `
		SELECT stream_key, message_key, speaker, role, progress, open
		FROM transcript_messages
		WHERE task_id = ?
		ORDER BY last_seq DESC
		LIMIT 1`, taskID).
		Scan(&row.key, &row.messageKey, &row.speaker, &row.role, &progress, &open)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read transcript tail: %w", err)
	}
	row.progress = progress == 1
	row.open = open == 1
	return &row, nil
}

// flushTranscriptStreamTx mirrors the console's flush points. A false positive
// splits a message the reader sees whole (a missed hit); a false negative glues
// two they see apart (a dead hit), so the list follows the projection exactly.
func flushTranscriptStreamTx(
	ctx context.Context, tx *sql.Tx, taskID, eventType string, env *transcriptEnvelope, host string,
) error {
	if !transcriptFlushesStream(eventType, env, host) {
		return nil
	}
	if err := closeTranscriptStreamsTx(ctx, tx, taskID); err != nil {
		return err
	}
	if eventType == "result" || eventType == "error" {
		// The console settles every preview of the round at a terminal event:
		// a later message is no longer replacing any of them.
		if _, err := tx.ExecContext(ctx, `
			UPDATE transcript_messages SET partial = 0, open = 0
			WHERE task_id = ? AND progress = 0 AND last_seq > `+transcriptRoundStartSQL,
			taskID, taskID); err != nil {
			return fmt.Errorf("settle transcript previews: %w", err)
		}
	}
	return nil
}

func transcriptFlushesStream(eventType string, env *transcriptEnvelope, host string) bool {
	switch eventType {
	case "tool_use", "tool_result":
		return env.userFacing(host)
	case "notice":
		// A withdrawal note is always drawn; any other notice needs a label.
		return env.Code == "prompt_withdrawn" ||
			strings.TrimSpace(env.Title) != "" || strings.TrimSpace(env.Message) != ""
	case "plan", "approval_requested", "user_question_requested",
		"route_decision", "route_fallback", "result":
		return true
	case "error":
		return !transcriptCancelNoise(env.Message)
	default:
		// Every workspace event type the index reads is one the console labels;
		// the unlabelled ones never reach here.
		return strings.HasPrefix(eventType, "workspace_")
	}
}

func closeTranscriptStreamsTx(ctx context.Context, tx *sql.Tx, taskID string) error {
	if _, err := tx.ExecContext(ctx,
		`UPDATE transcript_messages SET open = 0 WHERE task_id = ? AND open = 1`, taskID); err != nil {
		return fmt.Errorf("close transcript stream: %w", err)
	}
	return nil
}

func transcriptWatermarkTx(ctx context.Context, tx *sql.Tx, taskID string) (int64, int64, error) {
	var epoch, seq int64
	err := tx.QueryRowContext(ctx,
		`SELECT event_epoch, indexed_seq FROM transcript_index_state WHERE task_id = ?`, taskID).
		Scan(&epoch, &seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, fmt.Errorf("read transcript watermark: %w", err)
	}
	return epoch, seq, nil
}

func setTranscriptWatermarkTx(ctx context.Context, tx *sql.Tx, taskID string, epoch, seq int64) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO transcript_index_state (task_id, event_epoch, indexed_seq) VALUES (?, ?, ?)
		ON CONFLICT(task_id) DO UPDATE SET
			event_epoch = excluded.event_epoch,
			indexed_seq = excluded.indexed_seq`,
		taskID, epoch, seq)
	if err != nil {
		return fmt.Errorf("write transcript watermark: %w", err)
	}
	return nil
}

// transcriptHostSpeakerTx names the speaker the console gives the task's own
// column: `task.agent || "kin"` (`TaskDetailPage`). The console passes that name
// to `resolveSpeaker` for every row, so even a row that stamps a visibility and
// no speaker resolves to the host — not to the bare "assistant" a missing name
// would produce. Rows that already name their speaker never consult it.
func transcriptHostSpeakerTx(ctx context.Context, tx *sql.Tx, taskID string, env *transcriptEnvelope) (string, error) {
	switch env.speakerName() {
	case "kin", "orchestrator", "user":
		return "", nil
	}
	var agent string
	if err := tx.QueryRowContext(ctx, `SELECT agent FROM tasks WHERE id = ?`, taskID).Scan(&agent); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "kin", nil
		}
		return "", fmt.Errorf("read task agent: %w", err)
	}
	if agent == "" {
		return "kin", nil
	}
	return agent, nil
}

// speakerName resolves who said this, with the same precedence the console
// uses: explicit speaker, then agent, then a user turn, then a source that is a
// real agent name rather than a control label.
func (e *transcriptEnvelope) speakerName() string {
	if s := strings.TrimSpace(e.Speaker); s != "" {
		return s
	}
	if s := strings.TrimSpace(e.Agent); s != "" {
		return s
	}
	if e.Role == "user" {
		return "user"
	}
	if s := strings.TrimSpace(e.Source); s != "" && !transcriptControlSource(s) {
		return s
	}
	return ""
}

// resolvedSpeaker is `resolveSpeaker`: with nothing stamped, the host speaks.
func (e *transcriptEnvelope) resolvedSpeaker(hostAgent string) string {
	if s := e.speakerName(); s != "" {
		return s
	}
	if hostAgent != "" {
		return hostAgent
	}
	return "assistant"
}

// transcriptControlSource mirrors the console's `CONTROL_SOURCE_LABELS`: these
// name why a row exists, not who wrote it.
func transcriptControlSource(s string) bool {
	switch s {
	case "follow_up", "create", "orchestrator", "delegate", "host", "user",
		"system", "assistant", "interrupt", "retry", "resume":
		return true
	}
	return false
}

// stamped reports whether the row carries a visibility the console would read.
// `readVisibility` ignores an object with neither flag, and so must this.
func (e *transcriptEnvelope) stamped() bool {
	return e.Visibility != nil && (e.Visibility.User != nil || e.Visibility.Task != nil)
}

// userFlag is the explicit `visibility.user` the console trusts first.
//
// `readVisibility` fills a missing `user` with false, so a stamp that names
// only `task` is still an explicit answer: it says this row is not the user's.
func (e *transcriptEnvelope) userFlag() (bool, bool) {
	if !e.stamped() {
		return false, false
	}
	return e.Visibility.User != nil && *e.Visibility.User, true
}

// taskOnly mirrors `isTaskOnlyMeta`: the row belongs to the process box, not
// the chat column. It is still drawn, so it is still searchable — it only
// marks which side of a flush boundary the row sits on.
func (e *transcriptEnvelope) taskOnly(hostAgent string) bool {
	if e.speakerName() == "user" {
		return false
	}
	user, task, ok := e.effectiveVisibility(hostAgent)
	return ok && !user && task
}

// effectiveVisibility mirrors `readVisibility` + `legacyVisibilityFor`: the
// flags the console actually reads, with a missing `task` defaulting to true.
func (e *transcriptEnvelope) effectiveVisibility(hostAgent string) (user, task, ok bool) {
	if e.stamped() {
		user = e.Visibility.User != nil && *e.Visibility.User
		task = e.Visibility.Task == nil || *e.Visibility.Task
		return user, task, true
	}
	speaker := e.speakerName()
	if transcriptHostVoice(speaker, hostAgent) || e.Source == "orchestrator" || e.Source == "delegate" {
		return true, true, true
	}
	if speaker != "" && speaker != "assistant" {
		return false, true, true
	}
	return true, true, true
}

// transcriptHostVoice mirrors `isHostVoice`, including the console's case where
// no host name is known yet (the row names itself).
func transcriptHostVoice(speaker, hostAgent string) bool {
	return speaker == "kin" || speaker == "orchestrator" || (hostAgent != "" && speaker == hostAgent)
}

// asProgress mirrors `isProgressMessageMeta`: whether the console draws this
// message in the process box instead of the chat column.
func (e *transcriptEnvelope) asProgress(hostAgent string) bool {
	speaker := e.resolvedSpeaker(hostAgent)
	if speaker == "user" {
		return false
	}
	if e.taskOnly(hostAgent) {
		return true
	}
	if e.Role == "reasoning" {
		return true
	}
	switch e.Phase {
	case "summary":
		return false
	case "plan", "progress":
		return true
	}
	if e.Source == "delegate" {
		return true
	}
	if e.Source == "orchestrator" {
		// Phase-less orchestrator rows are the oldest history; the console keeps
		// the wrap-up by its wording and draws the rest in the process box.
		if (!e.stamped() || e.Phase == "") && transcriptLegacySummaryWording(e.text()) {
			return false
		}
		return true
	}
	return false
}

// userFacing mirrors `isUserFacingEvent`: whether a tool step belongs to the
// chat column. A task-only worker tool is not the host's own step and does not
// end the stream — the console keeps drawing the same card across it.
func (e *transcriptEnvelope) userFacing(hostAgent string) bool {
	if e.Source == "orchestrator" || e.Source == "delegate" {
		return true
	}
	if user, ok := e.userFlag(); ok {
		return user
	}
	speaker := e.resolvedSpeaker(hostAgent)
	return speaker == "user" || transcriptHostVoice(speaker, hostAgent)
}

// transcriptLegacySummaryWording mirrors `isLegacyOrchestratorSummaryWording`:
// phases were stamped after the first orchestrator summaries shipped, so stored
// history says it in the text instead.
func transcriptLegacySummaryWording(text string) bool {
	s := strings.TrimSpace(text)
	prefixes := []string{"完成：", "完成:", "完成（有失败）：", "完成（有失败）:"}
	for _, prefix := range prefixes {
		if strings.HasPrefix(s, prefix) {
			return true
		}
	}
	lower := strings.ToLower(s)
	for _, word := range []string{"done", "completed"} {
		rest, ok := strings.CutPrefix(lower, word)
		if !ok {
			continue
		}
		if strings.HasPrefix(rest, ":") || strings.HasPrefix(rest, "：") {
			return true
		}
		// The console's `\s*` covers more than ASCII; use the same set Go calls
		// space rather than silently narrowing it.
		if strings.HasPrefix(strings.TrimLeftFunc(rest, unicode.IsSpace), "(") {
			return true
		}
	}
	return false
}

// transcriptLegacyToolDump mirrors `isLegacyToolDumpMessage`, including its
// multi-line flag: the console tests the trimmed text with `/m`, so a dump line
// after prose still makes the message a step.
var transcriptLegacyToolDump = regexp.MustCompile(
	"(?m)^\\*\\*(bash|read_file|write_file|edit_file|list_dir|glob)\\*\\*\\s*\\n```")

// transcriptIsLegacyToolDump mirrors `isLegacyToolDumpMessage`.
func transcriptIsLegacyToolDump(text string) bool {
	if text == "" {
		return false
	}
	return transcriptLegacyToolDump.MatchString(strings.TrimSpace(text))
}

// transcriptCancelNoise mirrors `isCancelNoise`: an abort is not a failure, and
// the console does not settle the stream for it.
func transcriptCancelNoise(message string) bool {
	s := strings.ToLower(strings.TrimSpace(message))
	if s == "" {
		return false
	}
	switch s {
	case "canceled", "cancelled", "context canceled", "context cancelled":
		return true
	}
	return strings.Contains(s, "stream error") && strings.Contains(s, "cancel") ||
		strings.Contains(s, "cancel") && strings.Contains(s, "received from peer")
}

// identity is the message key the console supersedes previews by. It carries
// the speaker, the role, the message id and the block index, because any one of
// them alone repeats: two agents can stream a block 0, and one agent can stream
// several blocks of one message.
func (e *transcriptEnvelope) identity(speaker, role string) string {
	id := strings.TrimSpace(e.MessageID)
	index := normalizeTranscriptIndex(e.Index)
	if id == "" || index == "" {
		return ""
	}
	return speaker + "\x1f" + role + "\x1f" + id + "#" + index
}

// text is the prose the console draws, extracted the way `extractText` does:
// a string body, or the `text` of every content block, falling back to a flat
// `text` field.
func (e *transcriptEnvelope) text() string {
	text := e.Text
	if extracted := extractTranscriptText(e.Content); extracted != "" {
		text = extracted
	}
	if e.speakerName() == "user" {
		// The composer appends the files' local paths to the prompt, and the
		// console hides them behind a name-only summary. An index that kept the
		// paths would answer with text nobody can read on screen.
		text = transcriptDisplayUserPrompt(text)
	}
	return text
}

// transcriptDisplayUserPrompt mirrors `displayUserPrompt`: the block's file
// names stay, its paths go.
func transcriptDisplayUserPrompt(text string) string {
	body, entries := attach.Split(text)
	if len(entries) == 0 {
		return text
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Label)
	}
	summary := "Attached: " + strings.Join(names, ", ")
	if body = strings.TrimSpace(body); body == "" {
		return summary
	}
	return body + "\n\n" + summary
}

func extractTranscriptText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var body string
	if err := json.Unmarshal(raw, &body); err == nil {
		return body
	}
	// A block whose `text` is not a string still reaches the screen (the console
	// stringifies it), so one odd block must not erase the rest of the message.
	var blocks []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	var b strings.Builder
	for _, block := range blocks {
		if text, ok := block["text"]; ok {
			b.WriteString(scalarText(text))
		}
	}
	return b.String()
}

func scalarText(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var n json.Number
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&n); err == nil {
		return n.String()
	}
	return ""
}

func normalizeTranscriptIndex(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var n json.Number
	if err := dec.Decode(&n); err == nil {
		return n.String()
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return strings.TrimSpace(s)
	}
	return ""
}

// backfillTranscriptIndex folds indexed events written before this index
// existed into it. It is resumable — the watermark advances per batch — so a
// crash mid-backfill costs the work since the last batch, not the whole pass.
func (s *Store) backfillTranscriptIndex(ctx context.Context) error {
	tasks, err := s.transcriptTasksNeedingIndex(ctx)
	if err != nil {
		return err
	}
	for _, taskID := range tasks {
		if err := s.replayTranscriptTask(ctx, taskID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) transcriptTasksNeedingIndex(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT e.task_id
		FROM events e
		JOIN tasks t ON t.id = e.task_id
		LEFT JOIN transcript_index_state s ON s.task_id = e.task_id
		WHERE e.type IN (`+transcriptIndexEventTypesSQL+`)
		  AND (s.task_id IS NULL OR s.event_epoch != t.event_epoch OR e.seq > s.indexed_seq)`)
	if err != nil {
		return nil, fmt.Errorf("list tasks needing transcript index: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

const transcriptReplayBatch = 500

func (s *Store) replayTranscriptTask(ctx context.Context, taskID string) error {
	epoch, err := s.taskEventEpoch(ctx, taskID)
	if err != nil {
		return err
	}
	stateEpoch, watermark, err := s.transcriptWatermark(ctx, taskID)
	if err != nil {
		return err
	}
	if stateEpoch != epoch {
		// The events that are left belong to the current timeline; anything the
		// old index held describes a transcript the console no longer shows.
		if err := s.resetTranscriptTaskIndex(ctx, taskID, epoch); err != nil {
			return err
		}
		watermark = 0
	}
	for {
		events, err := s.transcriptEventBatch(ctx, taskID, watermark)
		if err != nil {
			return err
		}
		if len(events) == 0 {
			// Only reachable if another process truncated the events between the
			// selector and this batch. Earlier batches have already committed
			// their rows with their watermark, so the pair stays consistent and
			// the next open asks again.
			return nil
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin transcript replay: %w", err)
		}
		for _, ev := range events {
			if err := applyTranscriptEventRowTx(ctx, tx, taskID, ev); err != nil {
				_ = tx.Rollback()
				return err
			}
		}
		watermark = events[len(events)-1].seq
		// The watermark is written with the rows it describes. Without it the task
		// keeps looking unindexed — the selector looks for a state row, not for
		// rows — so every Open replays over rows the last replay wrote, and a
		// streaming tail joins its own copy and doubles the text.
		if err := setTranscriptWatermarkTx(ctx, tx, taskID, epoch, watermark); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit transcript replay: %w", err)
		}
	}
}

// replayTranscriptEventsTx rebuilds a task's index from the events still in the
// log, inside the caller's transaction. It is used when the timeline changed
// underneath the index: retry, truncation, or an epoch bump.
func replayTranscriptEventsTx(ctx context.Context, tx *sql.Tx, taskID string, epoch int64) error {
	watermark := int64(0)
	for {
		events, err := transcriptEventBatchTx(ctx, tx, taskID, watermark)
		if err != nil {
			return err
		}
		if len(events) == 0 {
			return setTranscriptWatermarkTx(ctx, tx, taskID, epoch, watermark)
		}
		for _, ev := range events {
			if err := applyTranscriptEventRowTx(ctx, tx, taskID, ev); err != nil {
				return err
			}
		}
		watermark = events[len(events)-1].seq
	}
}

type transcriptEventRow struct {
	seq     int64
	ts      int64
	typ     string
	payload []byte
}

func applyTranscriptEventRowTx(ctx context.Context, tx *sql.Tx, taskID string, ev transcriptEventRow) error {
	var env transcriptEnvelope
	if err := json.Unmarshal(ev.payload, &env); err != nil {
		// A payload the index cannot read is history that is not searchable; it
		// must not fail the append that stores it.
		return nil
	}
	return applyTranscriptEventTx(ctx, tx, taskID, ev.seq, ev.ts, ev.typ, &env)
}

func (s *Store) transcriptWatermark(ctx context.Context, taskID string) (int64, int64, error) {
	var epoch, seq int64
	err := s.db.QueryRowContext(ctx,
		`SELECT event_epoch, indexed_seq FROM transcript_index_state WHERE task_id = ?`, taskID).
		Scan(&epoch, &seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, fmt.Errorf("read transcript watermark: %w", err)
	}
	return epoch, seq, nil
}

func (s *Store) taskEventEpoch(ctx context.Context, taskID string) (int64, error) {
	var epoch int64
	err := s.db.QueryRowContext(ctx, `SELECT event_epoch FROM tasks WHERE id = ?`, taskID).Scan(&epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read task event epoch: %w", err)
	}
	return epoch, nil
}

func (s *Store) resetTranscriptTaskIndex(ctx context.Context, taskID string, epoch int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin transcript reset: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM transcript_messages WHERE task_id = ?`, taskID); err != nil {
		return fmt.Errorf("reset transcript index: %w", err)
	}
	if err := setTranscriptWatermarkTx(ctx, tx, taskID, epoch, 0); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit transcript reset: %w", err)
	}
	return nil
}

func (s *Store) transcriptEventBatch(ctx context.Context, taskID string, after int64) ([]transcriptEventRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT seq, ts, type, payload FROM events
		WHERE task_id = ? AND type IN (`+transcriptIndexEventTypesSQL+`) AND seq > ?
		ORDER BY seq
		LIMIT ?`, taskID, after, transcriptReplayBatch)
	if err != nil {
		return nil, fmt.Errorf("read transcript events: %w", err)
	}
	defer rows.Close()
	return scanTranscriptEventRows(rows)
}

// transcriptEventBatchTx is the same read inside a transaction, for a replay
// that must see events this transaction has not committed yet.
func transcriptEventBatchTx(ctx context.Context, tx *sql.Tx, taskID string, after int64) ([]transcriptEventRow, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT seq, ts, type, payload FROM events
		WHERE task_id = ? AND type IN (`+transcriptIndexEventTypesSQL+`) AND seq > ?
		ORDER BY seq
		LIMIT ?`, taskID, after, transcriptReplayBatch)
	if err != nil {
		return nil, fmt.Errorf("read transcript events: %w", err)
	}
	defer rows.Close()
	return scanTranscriptEventRows(rows)
}

func scanTranscriptEventRows(rows *sql.Rows) ([]transcriptEventRow, error) {
	var out []transcriptEventRow
	for rows.Next() {
		var ev transcriptEventRow
		if err := rows.Scan(&ev.seq, &ev.ts, &ev.typ, &ev.payload); err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return out, rows.Err()
}
