package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

// ErrTaskCanceled is returned by a guarded write that refused to touch a task
// because the user had canceled it. It says the write did not happen, not that
// it failed: the state that made it refuse is the state the caller has to
// respect.
var ErrTaskCanceled = errors.New("task is canceled")

// canceledStatus is the task status a guarded write refuses. It is spelled out
// here rather than taken from the task package, which imports this one.
const canceledStatus = "canceled"

// Store is the SQLite persistence layer.
type Store struct {
	db *sql.DB
}

// Open opens (or creates) the database at path and applies pending migrations.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite allows one writer; serialize via a single connection.
	db.SetMaxOpenConns(1)
	// Single-writer friendly settings for a local daemon.
	if _, err := db.Exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("pragma: %w", err)
	}

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the underlying database.
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// DB returns the underlying *sql.DB (for tests / later packages).
func (s *Store) DB() *sql.DB { return s.db }

// Task is a row in the tasks table.
type Task struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	Agent      string  `json:"agent"`
	Cwd        string  `json:"cwd"`
	Prompt     string  `json:"prompt"`
	Model      *string `json:"model,omitempty"`
	SessionRef *string `json:"session_ref,omitempty"`
	// SessionRefDeviceID names the machine whose agent produced SessionRef. A
	// native session id is only resumable on the machine that made it, so a ref
	// without its provenance is a ref the resume path cannot check — see
	// ensureSessionRefProvenanceSchema and ADR 0022 D6. Empty means the row
	// predates the column, which is read as local.
	SessionRefDeviceID *string  `json:"session_ref_device_id,omitempty"`
	PermissionMode     string   `json:"permission_mode,omitempty"`
	Status             string   `json:"status"`
	ExitCode           *int     `json:"exit_code,omitempty"`
	TokensIn           int      `json:"tokens_in"`
	TokensOut          int      `json:"tokens_out"`
	CostUSD            *float64 `json:"cost_usd,omitempty"`
	CreatedAt          int64    `json:"created_at"`
	StartedAt          *int64   `json:"started_at,omitempty"`
	FinishedAt         *int64   `json:"finished_at,omitempty"`

	// Workspace isolation (ADR 0005). Cwd remains user-selected project path.
	WorkspaceMode       string `json:"workspace_mode"`
	WorkspaceSourceRoot string `json:"workspace_source_root,omitempty"`
	WorkspaceRoot       string `json:"workspace_root,omitempty"`
	ExecutionCwd        string `json:"execution_cwd,omitempty"`
	WorkspaceScope      string `json:"workspace_scope,omitempty"`
	WorkspaceBaseOID    string `json:"workspace_base_oid,omitempty"`
	// WorkspaceBranch is the git branch this task's work is on.
	//
	// For an isolated workspace that is the branch of the generation, and the
	// workspace lifecycle owns it. For a task that runs on another machine there
	// is no generation: the branch is a fact about that machine's checkout,
	// recorded by asking it (workspace.git) and refreshed when someone asks for a
	// fresh answer. One field because it is one question — which branch is this
	// session's work on — and the readers of it (the PR panel's target, the
	// console's branch chip) do not care which machine answered.
	WorkspaceBranch string `json:"workspace_branch,omitempty"`
	// WorkspaceRepo is the repository this task's work is in, canonical and
	// without credentials ("github.com/owner/name"), as the machine that has the
	// files reported it. Empty when nobody has asked yet, which is every task
	// created before this was recorded and every directory that is not a GitHub
	// checkout.
	WorkspaceRepo      string `json:"workspace_repo,omitempty"`
	WorkspacePolicy    string `json:"workspace_policy,omitempty"`
	CurrentWorkspaceID string `json:"current_workspace_id,omitempty"`
	EventEpoch         int64  `json:"event_epoch"`

	// Optional project association (ADR 0008). Empty = not linked.
	ProjectID string `json:"project_id,omitempty"`

	// Optional routine association (ADR 0011). Empty = interactive task.
	RoutineID         string `json:"routine_id,omitempty"`
	RoutineNoteworthy bool   `json:"routine_noteworthy"`
	RoutineTLDR       string `json:"routine_tldr,omitempty"`
	RoutineUnread     bool   `json:"routine_unread"`

	// Optional dispatch selection for auto model routing.
	Dispatch json.RawMessage `json:"dispatch,omitempty"`

	// ExecutingDeviceID is the machine that runs this task's turns. Empty means
	// the daemon serving the request, which is what every task was before a Hub
	// could hand work to another machine (ADR 0022).
	ExecutingDeviceID string `json:"executing_device_id,omitempty"`

	// WorkspaceAnchorID is the portable identity of this task's workspace: which
	// repository, and where inside it. Empty means the cwd is only an address on
	// one machine, which is what every task was before anchors existed.
	WorkspaceAnchorID string `json:"workspace_anchor_id,omitempty"`

	// HubSeq is the task's position in the global sync cursor. A client stores
	// the highest value it has seen and asks for everything after it. Null only
	// for rows written before the cursor existed.
	HubSeq *int64 `json:"hub_seq,omitempty"`

	// OwnerUserID is the account that created this task, and the key account
	// isolation reads. Empty means no account was behind it: a standalone
	// daemon, a routine firing on a timer, an eval run, or a row written before
	// accounts existed. Only the owner of the machine sees those, which is why
	// TaskScope has an All case rather than treating empty as a match.
	OwnerUserID string `json:"owner_user_id,omitempty"`
}

// EffectiveCwd returns the path adapters and workspace file APIs should use.
func (t Task) EffectiveCwd() string {
	if strings.TrimSpace(t.ExecutionCwd) != "" {
		return t.ExecutionCwd
	}
	return t.Cwd
}

// Event is a row in the events table (append-only).
type Event struct {
	TaskID     string          `json:"task_id"`
	EventEpoch int64           `json:"event_epoch"`
	Seq        int             `json:"seq"`
	TS         int64           `json:"ts"`
	Type       string          `json:"type"`
	Payload    json.RawMessage `json:"payload"`
}

const (
	// CacheStatusReported means the provider explicitly supplied cache token data.
	CacheStatusReported = "reported"
	// CacheStatusUnknown means the provider response did not establish cache state.
	CacheStatusUnknown = "unknown"
	// CacheStatusUnsupported means the provider cannot report cache token data.
	CacheStatusUnsupported = "unsupported"
	// CacheStatusMixed means an aggregate contains more than one cache status.
	CacheStatusMixed = "mixed"
)

const (
	// InputSemanticsTotalIncludesCache means input_tokens includes cache reads.
	InputSemanticsTotalIncludesCache = "total_includes_cache"
	// InputSemanticsUncachedOnly means input_tokens excludes cache reads/writes.
	InputSemanticsUncachedOnly = "uncached_only"
	// InputSemanticsUnknown means the adapter could not establish input semantics.
	InputSemanticsUnknown = "unknown"
)

const (
	// CostSourceProvider is a provider-reported cost.
	CostSourceProvider = "provider"
	// CostSourcePriceTable is a local price-table estimate.
	CostSourcePriceTable = "price_table"
	// CostSourceUnknown means cost was not available.
	CostSourceUnknown = "unknown"
)

// UsageRecord is one provider or agent usage observation keyed to its task event.
// Nil token and cost fields represent values the source did not report.
type UsageRecord struct {
	TaskID                string   `json:"task_id"`
	EventEpoch            int64    `json:"event_epoch"`
	EventSeq              int      `json:"event_seq"`
	OccurredAt            int64    `json:"occurred_at"`
	Agent                 string   `json:"agent"`
	Provider              *string  `json:"provider,omitempty"`
	Model                 *string  `json:"model,omitempty"`
	InputTokens           *int     `json:"input_tokens,omitempty"`
	OutputTokens          *int     `json:"output_tokens,omitempty"`
	ReasoningOutputTokens *int     `json:"reasoning_output_tokens,omitempty"`
	CacheReadTokens       *int     `json:"cache_read_tokens,omitempty"`
	CacheWriteTokens      *int     `json:"cache_write_tokens,omitempty"`
	CostUSD               *float64 `json:"cost_usd,omitempty"`
	CostSource            string   `json:"cost_source"`
	CacheStatus           string   `json:"cache_status"`
	InputSemantics        string   `json:"input_semantics"`
}

func (r UsageRecord) validate() error {
	if strings.TrimSpace(r.TaskID) == "" {
		return fmt.Errorf("usage record task_id is required")
	}
	if r.EventSeq < 1 {
		return fmt.Errorf("usage record event_seq must be >= 1")
	}
	if r.OccurredAt <= 0 {
		return fmt.Errorf("usage record occurred_at must be > 0")
	}
	if strings.TrimSpace(r.Agent) == "" {
		return fmt.Errorf("usage record agent is required")
	}
	for _, field := range []struct {
		name  string
		value *int
	}{
		{"input_tokens", r.InputTokens},
		{"output_tokens", r.OutputTokens},
		{"reasoning_output_tokens", r.ReasoningOutputTokens},
		{"cache_read_tokens", r.CacheReadTokens},
		{"cache_write_tokens", r.CacheWriteTokens},
	} {
		if field.value != nil && *field.value < 0 {
			return fmt.Errorf("usage record %s must be >= 0", field.name)
		}
	}
	if r.CostUSD != nil && *r.CostUSD < 0 {
		return fmt.Errorf("usage record cost_usd must be >= 0")
	}
	if !validUsageEnum(r.CostSource, CostSourceProvider, CostSourcePriceTable, CostSourceUnknown) {
		return fmt.Errorf("invalid usage record cost_source %q", r.CostSource)
	}
	if !validUsageEnum(r.CacheStatus, CacheStatusReported, CacheStatusUnknown, CacheStatusUnsupported) {
		return fmt.Errorf("invalid usage record cache_status %q", r.CacheStatus)
	}
	if !validUsageEnum(r.InputSemantics, InputSemanticsTotalIncludesCache, InputSemanticsUncachedOnly, InputSemanticsUnknown) {
		return fmt.Errorf("invalid usage record input_semantics %q", r.InputSemantics)
	}
	return nil
}

func validUsageEnum(value string, values ...string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

// ListTasksOpts filters for ListTasks.
type ListTasksOpts struct {
	Status    string // empty = all
	Limit     int    // 0 = default 50
	Before    string // ULID cursor: only tasks with id < before
	ProjectID string // empty = all; filter by project
	// OrderByActivity sorts by the newest finished_at, started_at, or created_at
	// value first. The default preserves id-desc order for existing paged callers.
	OrderByActivity bool
	// Query is a case-insensitive substring match on title, prompt, cwd, agent, id.
	// Empty = no text filter. LIKE metacharacters are escaped.
	Query string
	// RoutineID filters tasks spawned by a routine. Special values:
	//   ""  = no filter
	//   "*" = any non-null routine_id (routine runs feed)
	//   id  = that routine only
	RoutineID string
	// RoutineUnreadOnly keeps only unread routine runs (implies routine runs).
	RoutineUnreadOnly bool
	// Scope is what the caller is allowed to see. The zero value matches
	// nothing, so every request-facing caller must set it; see TaskScope.
	Scope TaskScope
}

// HasActiveTasks reports whether any task requires the daemon to remain
// available. It is used by process-level guards during startup and after
// dropped event subscriptions.
func (s *Store) HasActiveTasks(ctx context.Context) (bool, error) {
	var found int
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM tasks
			WHERE status IN (?, ?, ?, ?, ?)
		)`,
		"queued", "running", "waiting_approval", "waiting_input", "retrying",
	).Scan(&found)
	return found == 1, err
}

func scanTask(scanner interface {
	Scan(dest ...any) error
}) (Task, error) {
	var t Task
	var model, sessionRef, sessionRefDevice sql.NullString
	var exitCode sql.NullInt64
	var costUSD sql.NullFloat64
	var startedAt, finishedAt sql.NullInt64
	var permissionMode sql.NullString
	var workspaceMode, sourceRoot, workspaceRoot, executionCwd sql.NullString
	var workspaceScope, baseOID, branch, repo sql.NullString
	var projectID sql.NullString
	var routineID sql.NullString
	var routineNoteworthy, routineUnread int
	var routineTLDR sql.NullString
	var dispatch sql.NullString
	var executingDevice sql.NullString
	var anchorID sql.NullString
	var ownerUserID sql.NullString
	if err := scanner.Scan(
		&t.ID, &t.Title, &t.Agent, &t.Cwd, &t.Prompt,
		&model, &sessionRef, &sessionRefDevice, &permissionMode, &t.Status,
		&exitCode, &t.TokensIn, &t.TokensOut, &costUSD,
		&t.CreatedAt, &startedAt, &finishedAt,
		&workspaceMode, &sourceRoot, &workspaceRoot, &executionCwd,
		&workspaceScope, &baseOID, &branch, &repo, &projectID,
		&routineID, &routineNoteworthy, &routineTLDR, &routineUnread,
		&t.WorkspacePolicy, &t.CurrentWorkspaceID, &t.EventEpoch,
		&dispatch, &executingDevice, &anchorID, &t.HubSeq, &ownerUserID,
	); err != nil {
		return Task{}, err
	}
	if permissionMode.Valid && permissionMode.String != "" {
		t.PermissionMode = permissionMode.String
	} else {
		t.PermissionMode = "default"
	}
	if workspaceMode.Valid && workspaceMode.String != "" {
		t.WorkspaceMode = workspaceMode.String
	} else {
		t.WorkspaceMode = "shared"
	}
	if sourceRoot.Valid {
		t.WorkspaceSourceRoot = sourceRoot.String
	}
	if workspaceRoot.Valid {
		t.WorkspaceRoot = workspaceRoot.String
	}
	if executionCwd.Valid {
		t.ExecutionCwd = executionCwd.String
	}
	if workspaceScope.Valid && workspaceScope.String != "" {
		t.WorkspaceScope = workspaceScope.String
	} else {
		t.WorkspaceScope = "."
	}
	if baseOID.Valid {
		t.WorkspaceBaseOID = baseOID.String
	}
	if branch.Valid {
		t.WorkspaceBranch = branch.String
	}
	if repo.Valid {
		t.WorkspaceRepo = repo.String
	}
	if projectID.Valid {
		t.ProjectID = projectID.String
	}
	if executingDevice.Valid {
		t.ExecutingDeviceID = executingDevice.String
	}
	if anchorID.Valid {
		t.WorkspaceAnchorID = anchorID.String
	}
	if routineID.Valid {
		t.RoutineID = routineID.String
	}
	t.RoutineNoteworthy = routineNoteworthy != 0
	if routineTLDR.Valid {
		t.RoutineTLDR = routineTLDR.String
	}
	t.RoutineUnread = routineUnread != 0
	if model.Valid {
		t.Model = &model.String
	}
	if sessionRef.Valid {
		t.SessionRef = &sessionRef.String
	}
	if sessionRefDevice.Valid {
		t.SessionRefDeviceID = &sessionRefDevice.String
	}
	if exitCode.Valid {
		v := int(exitCode.Int64)
		t.ExitCode = &v
	}
	if costUSD.Valid {
		t.CostUSD = &costUSD.Float64
	}
	if startedAt.Valid {
		t.StartedAt = &startedAt.Int64
	}
	if finishedAt.Valid {
		t.FinishedAt = &finishedAt.Int64
	}
	if dispatch.Valid && dispatch.String != "" {
		t.Dispatch = json.RawMessage(dispatch.String)
	}
	if ownerUserID.Valid {
		t.OwnerUserID = ownerUserID.String
	}
	return t, nil
}

const taskColumns = `id, title, agent, cwd, prompt, model, session_ref, session_ref_device_id, permission_mode, status, exit_code, tokens_in, tokens_out, cost_usd, created_at, started_at, finished_at, workspace_mode, workspace_source_root, workspace_root, execution_cwd, workspace_scope, workspace_base_oid, workspace_branch, workspace_repo, project_id, routine_id, routine_noteworthy, routine_tldr, routine_unread, workspace_policy, current_workspace_id, event_epoch, dispatch, executing_device_id, workspace_anchor_id, hub_seq, owner_user_id`

// escapeLike escapes \, %, and _ so user input is treated as a literal substring.
func escapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}

// ListTasks returns tasks ordered by id descending (ULID ≈ time), or by recent
// activity when requested.
func (s *Store) ListTasks(ctx context.Context, opts ListTasksOpts) ([]Task, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	var b strings.Builder
	args := make([]any, 0, 4)
	b.WriteString(`SELECT ` + taskColumns + ` FROM tasks WHERE 1=1`)
	scopeCond, scopeArgs := opts.Scope.predicate("")
	b.WriteString(` AND ` + scopeCond)
	args = append(args, scopeArgs...)
	if opts.Status != "" {
		b.WriteString(` AND status = ?`)
		args = append(args, opts.Status)
	}
	if opts.ProjectID != "" {
		b.WriteString(` AND project_id = ?`)
		args = append(args, opts.ProjectID)
	}
	if opts.RoutineUnreadOnly {
		b.WriteString(` AND routine_id IS NOT NULL AND routine_unread = 1`)
	} else if opts.RoutineID == "*" {
		b.WriteString(` AND routine_id IS NOT NULL`)
	} else if opts.RoutineID != "" {
		b.WriteString(` AND routine_id = ?`)
		args = append(args, opts.RoutineID)
	}
	if opts.Before != "" {
		b.WriteString(` AND id < ?`)
		args = append(args, opts.Before)
	}
	if q := strings.TrimSpace(opts.Query); q != "" {
		// Bound runaway queries from the UI search box.
		if len(q) > 200 {
			q = q[:200]
		}
		pat := "%" + escapeLike(q) + "%"
		b.WriteString(` AND (
			title LIKE ? ESCAPE '\' OR
			prompt LIKE ? ESCAPE '\' OR
			cwd LIKE ? ESCAPE '\' OR
			agent LIKE ? ESCAPE '\' OR
			id LIKE ? ESCAPE '\'
		)`)
		args = append(args, pat, pat, pat, pat, pat)
	}
	if opts.OrderByActivity {
		b.WriteString(` ORDER BY MAX(COALESCE(finished_at, 0), COALESCE(started_at, 0), created_at) DESC, id DESC LIMIT ?`)
	} else {
		b.WriteString(` ORDER BY id DESC LIMIT ?`)
	}
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	defer rows.Close()

	out := make([]Task, 0)
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("scan task: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// TaskChangePage is one page of the global change feed: what a client asks for
// when it reconnects and wants everything it missed.
type TaskChangePage struct {
	// Tasks are the tasks whose rows changed after the cursor, oldest change
	// first. Deleted holds the ids of tasks that no longer exist.
	Tasks   []Task   `json:"sessions"`
	Deleted []string `json:"deleted"`
	// NextCursor is the cursor to send back next time. With no changes it is the
	// cursor that came in, so a client that polls an idle Hub never moves.
	NextCursor int64 `json:"next_cursor"`
	// HasMore reports that the page was cut short and the client should ask again.
	HasMore bool `json:"has_more"`
}

// ListTaskChangesSince returns every task change after the cursor, tasks and
// deletions merged into one chronological order so the cursor can never step
// over a change in either stream.
//
// Deletions are part of the feed because a client cannot notice an absent row.
// Tasks and tombstones are numbered by the same sequence, so ordering them
// together is what makes a single integer cursor sufficient.
//
// The scope filters the feed, and the cursor it returns is the position of the
// last change the caller could actually see — not the last change that exists.
// That is sound because the scope's condition is stable: a task's owner is set
// when the row is inserted and never rewritten, so "everything after my cursor
// that I can see" can never miss a row that later enters the scope. The index on
// (owner_user_id, hub_seq) is what keeps the seek honest, so a member does not
// rescan another account's changes on every poll.
func (s *Store) ListTaskChangesSince(ctx context.Context, since int64, limit int, scope TaskScope) (TaskChangePage, error) {
	if limit <= 0 {
		limit = 200
	}
	if limit > 500 {
		limit = 500
	}
	if since < 0 {
		since = 0
	}
	taskCond, taskArgs := scope.predicate("tasks")
	tombCond, tombArgs := scope.predicate("task_tombstones")
	// The cursor test sits inside each branch, next to that branch's scope, so
	// SQLite can serve both from (owner_user_id, hub_seq) instead of building the
	// account's whole history and filtering it afterwards. Moving it out here is
	// otherwise free: a NULL hub_seq fails `hub_seq > ?` instead of comparing as
	// 0, and 0 is not above any cursor this can be called with, so the same rows
	// come back either way.
	args := append([]any{}, taskArgs...)
	args = append(args, since)
	args = append(args, tombArgs...)
	args = append(args, since, limit+1)
	// One extra row tells us whether the page was cut short.
	rows, err := s.db.QueryContext(ctx, `
		SELECT kind, ref, seq FROM (
			SELECT 'task' AS kind, id AS ref, hub_seq AS seq FROM tasks
				WHERE `+taskCond+` AND hub_seq > ?
			UNION ALL
			SELECT 'deleted' AS kind, task_id AS ref, hub_seq AS seq FROM task_tombstones
				WHERE `+tombCond+` AND hub_seq > ?
		)
		ORDER BY seq ASC
		LIMIT ?`, args...)
	if err != nil {
		return TaskChangePage{}, fmt.Errorf("list task changes: %w", err)
	}
	type change struct {
		kind string
		ref  string
		seq  int64
	}
	var changes []change
	for rows.Next() {
		var c change
		if err := rows.Scan(&c.kind, &c.ref, &c.seq); err != nil {
			rows.Close()
			return TaskChangePage{}, fmt.Errorf("scan task change: %w", err)
		}
		changes = append(changes, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return TaskChangePage{}, fmt.Errorf("iterate task changes: %w", err)
	}
	rows.Close()

	page := TaskChangePage{Tasks: []Task{}, Deleted: []string{}, NextCursor: since}
	if len(changes) > limit {
		page.HasMore = true
		changes = changes[:limit]
	}
	if len(changes) == 0 {
		return page, nil
	}
	ids := make([]string, 0, len(changes))
	for _, c := range changes {
		if c.kind == "task" {
			ids = append(ids, c.ref)
		} else {
			page.Deleted = append(page.Deleted, c.ref)
		}
	}
	if len(ids) > 0 {
		byID, err := s.tasksByID(ctx, ids)
		if err != nil {
			return TaskChangePage{}, err
		}
		for _, id := range ids {
			if t, ok := byID[id]; ok {
				page.Tasks = append(page.Tasks, t)
			}
		}
	}
	// The cursor is the last change in the feed, not the last task: a page that
	// ended on a deletion still moved forward.
	page.NextCursor = changes[len(changes)-1].seq
	return page, nil
}

// CurrentHubSeq returns the end of the change feed.
//
// A client takes this before it builds a snapshot from the ordinary list
// endpoints, then follows the cursor from there. Reading it first is what makes
// the pair safe: a change that lands between the two calls is delivered twice,
// which costs nothing, rather than being delivered by neither.
func (s *Store) CurrentHubSeq(ctx context.Context) (int64, error) {
	var maxSeq sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `
		SELECT MAX(hub_seq) FROM (
			SELECT hub_seq FROM tasks
			UNION ALL
			SELECT hub_seq FROM task_tombstones
		)`).Scan(&maxSeq); err != nil {
		return 0, fmt.Errorf("current hub_seq: %w", err)
	}
	if !maxSeq.Valid {
		return 0, nil
	}
	return maxSeq.Int64, nil
}

// tasksByID loads the given tasks, keyed by id, in one query.
func (s *Store) tasksByID(ctx context.Context, ids []string) (map[string]Task, error) {
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+taskColumns+` FROM tasks WHERE id IN (`+placeholders(len(ids))+`)`, args...)
	if err != nil {
		return nil, fmt.Errorf("load changed tasks: %w", err)
	}
	defer rows.Close()
	out := make(map[string]Task, len(ids))
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("scan changed task: %w", err)
		}
		out[t.ID] = t
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func placeholders(n int) string {
	if n <= 0 {
		return "NULL"
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// GetTask returns a single task by id.
func (s *Store) GetTask(ctx context.Context, id string) (Task, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM tasks WHERE id = ?`, id)
	t, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, ErrNotFound
	}
	if err != nil {
		return Task{}, fmt.Errorf("get task: %w", err)
	}
	return t, nil
}

// DeleteTask removes a task and all task-scoped rows (events, approvals,
// kin_messages, usage, checkpoints). Artifacts keep their files; source_task_id
// is nulled so library entries remain readable.
func (s *Store) DeleteTask(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin delete task: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Read the owner before the row goes: the tombstone has to carry it, because
	// after the delete there is nothing left to ask. A deletion that reached
	// every client would hand a member the id of a task they were never shown.
	var owner sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT owner_user_id FROM tasks WHERE id = ?`, id).Scan(&owner); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("lookup task: %w", err)
	}

	// Child tables without ON DELETE CASCADE (legacy schema).
	for _, q := range []string{
		`DELETE FROM events WHERE task_id = ?`,
		`DELETE FROM approvals WHERE task_id = ?`,
		`DELETE FROM user_questions WHERE task_id = ?`,
		`DELETE FROM kin_messages WHERE task_id = ?`,
		`DELETE FROM usage_records WHERE task_id = ?`,
		`DELETE FROM task_checkpoints WHERE task_id = ?`,
		`DELETE FROM routine_dispatches WHERE task_id = ?`,
		`DELETE FROM mcp_task_origins WHERE task_id = ?`,
		`DELETE FROM a2a_idempotency WHERE task_id = ?`,
		`DELETE FROM a2a_operations WHERE task_id = ?`,
		// A deleted task's pull-request rows would otherwise stay in the watch
		// set Reconcile polls, spending queries on a pull request nobody can
		// reach any more — the task that named it is gone from every screen.
		`DELETE FROM pr_observations WHERE task_id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, q, id); err != nil {
			return fmt.Errorf("delete task children: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE artifacts SET source_task_id = NULL WHERE source_task_id = ?`, id); err != nil {
		return fmt.Errorf("detach artifacts: %w", err)
	}
	// Allocate the tombstone's number while the row is still here. nextHubSeq is
	// MAX(hub_seq)+1 over tasks and tombstones, and the row being deleted is part
	// of that MAX — so asking afterwards lets the tombstone land on the deleted
	// row's own number, and the one client that most needs the news, the one that
	// already synced up to that number, is the one that never hears it. Deleting
	// the most recently changed task is the common case, not a corner.
	hubSeq, err := nextHubSeq(ctx, tx)
	if err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM tasks WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete task: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	// The row is gone, so the deletion itself carries the cursor: a syncing
	// client sees the tombstone, drops the task, and the number is never reused.
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO task_tombstones (task_id, hub_seq, deleted_at, owner_user_id) VALUES (?, ?, ?, ?)`,
		id, hubSeq, time.Now().UnixMilli(), owner); err != nil {
		return fmt.Errorf("record task deletion: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete task: %w", err)
	}
	return nil
}

// InsertTask inserts a new task row. Status should be "queued".
func (s *Store) InsertTask(ctx context.Context, t Task) error {
	var model, sessionRef, sessionRefDevice any
	if t.Model != nil {
		model = *t.Model
	}
	if t.SessionRef != nil {
		sessionRef = *t.SessionRef
	}
	// Written together with the ref, never apart: a ref whose provenance is
	// missing reads as "local", which is a claim about a machine and not
	// something to leave to a caller's memory.
	if t.SessionRefDeviceID != nil {
		sessionRefDevice = *t.SessionRefDeviceID
	}
	perm := t.PermissionMode
	if perm == "" {
		perm = "default"
	}
	wsMode := t.WorkspaceMode
	if wsMode == "" {
		wsMode = "shared"
	}
	wsScope := t.WorkspaceScope
	if wsScope == "" {
		wsScope = "."
	}
	var projectID any
	if t.ProjectID != "" {
		projectID = t.ProjectID
	}
	var routineID any
	if t.RoutineID != "" {
		routineID = t.RoutineID
	}
	var anchorID any
	if t.WorkspaceAnchorID != "" {
		anchorID = t.WorkspaceAnchorID
	}
	var executingDevice any
	if t.ExecutingDeviceID != "" {
		executingDevice = t.ExecutingDeviceID
	}
	// NULL, not '', when no account asked for this task. The scope predicate
	// compares owner_user_id for equality, so an empty string would read as an
	// account whose id is empty instead of as "nobody".
	var ownerUserID any
	if t.OwnerUserID != "" {
		ownerUserID = t.OwnerUserID
	}
	noteworthy := 0
	if t.RoutineNoteworthy {
		noteworthy = 1
	}
	unread := 0
	if t.RoutineUnread {
		unread = 1
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin insert task: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// A new task is a change like any other: it takes a cursor so a client that
	// is already synced learns about it without refetching the list.
	hubSeq, err := nextHubSeq(ctx, tx)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO tasks (
			id, title, agent, cwd, prompt, model, session_ref, session_ref_device_id, permission_mode, status,
			exit_code, tokens_in, tokens_out, cost_usd,
			created_at, started_at, finished_at,
			workspace_mode, workspace_source_root, workspace_root, execution_cwd,
			workspace_scope, workspace_base_oid, workspace_branch, workspace_repo, project_id,
			routine_id, routine_noteworthy, routine_tldr, routine_unread,
				workspace_policy, current_workspace_id, event_epoch, dispatch,
			executing_device_id, workspace_anchor_id, hub_seq, owner_user_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		t.ID, t.Title, t.Agent, t.Cwd, t.Prompt, model, sessionRef, sessionRefDevice, perm, t.Status,
		t.ExitCode, t.TokensIn, t.TokensOut, t.CostUSD,
		t.CreatedAt, t.StartedAt, t.FinishedAt,
		wsMode, t.WorkspaceSourceRoot, t.WorkspaceRoot, t.ExecutionCwd,
		wsScope, t.WorkspaceBaseOID, t.WorkspaceBranch, t.WorkspaceRepo, projectID,
		routineID, noteworthy, t.RoutineTLDR, unread,
		t.WorkspacePolicy, t.CurrentWorkspaceID, t.EventEpoch,
		dispatchJSON(t.Dispatch), executingDevice, anchorID, hubSeq, ownerUserID,
	); err != nil {
		return fmt.Errorf("insert task: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit insert task: %w", err)
	}
	return nil
}

// dispatchJSON converts a json.RawMessage to a value suitable for SQL.
// nil or empty returns nil (SQL NULL); otherwise returns the string.
func dispatchJSON(d json.RawMessage) any {
	if len(d) == 0 {
		return nil
	}
	return string(d)
}

// TaskPatch is a partial update applied by the engine.
type TaskPatch struct {
	Status     *string
	Title      *string
	Agent      *string
	SessionRef *string
	// SessionRefDeviceID is written in the same patch as SessionRef. Setting it
	// alone describes a machine for a ref that is not there, which is why
	// ClearSessionRef clears both.
	SessionRefDeviceID *string
	ClearSessionRef    bool // sets session_ref and its provenance NULL (handoff across agents or devices)
	Prompt             *string
	Model              *string // set task model for subsequent turns
	ClearModel         bool    // sets model NULL
	PermissionMode     *string
	ExitCode           *int
	ClearExitCode      bool
	TokensIn           *int
	TokensOut          *int
	CostUSD            *float64
	StartedAt          *int64
	FinishedAt         *int64
	ClearFinishedAt    bool
	ProjectID          *string // set or clear (empty string clears)
	RoutineID          *string // set or clear (empty string clears)
	RoutineNoteworthy  *bool
	RoutineTLDR        *string
	RoutineUnread      *bool
	// ExecutingDeviceID moves the task to another machine. Empty means this
	// daemon; a task cannot be moved while a turn is in flight.
	ExecutingDeviceID *string
	// WorkspaceRepo and WorkspaceBranch record where this task's work is, as the
	// machine holding the files reported it (workspace.git). Nil leaves them
	// alone, because a machine that cannot answer must not erase the last answer
	// it gave — an offline machine is not a repository-less one.
	WorkspaceRepo   *string
	WorkspaceBranch *string
}

// UpdateTask applies a patch to a task row.
func (s *Store) UpdateTask(ctx context.Context, id string, p TaskPatch) error {
	return s.updateTask(ctx, id, p, "")
}

// UpdateTaskUnlessCanceled is UpdateTask for a write the user's cancel has to be
// able to refuse: the patch lands only while the row is not `canceled`, and
// ErrTaskCanceled comes back when it is. The predicate is in the statement
// rather than in a read before it, because the cancel it guards against is
// written by another goroutine -- a read here would leave open the very window
// it is meant to close.
func (s *Store) UpdateTaskUnlessCanceled(ctx context.Context, id string, p TaskPatch) error {
	return s.updateTask(ctx, id, p, canceledStatus)
}

// updateTask applies a patch, refusing to touch a row whose status is
// refuseStatus. Empty refuseStatus applies the patch to any row that exists.
func (s *Store) updateTask(ctx context.Context, id string, p TaskPatch, refuseStatus string) error {
	// Build dynamic SET; always require at least one field.
	sets := make([]string, 0, 12)
	args := make([]any, 0, 13)
	if p.Status != nil {
		sets = append(sets, "status = ?")
		args = append(args, *p.Status)
	}
	if p.Title != nil {
		sets = append(sets, "title = ?")
		args = append(args, *p.Title)
	}
	if p.Agent != nil {
		sets = append(sets, "agent = ?")
		args = append(args, *p.Agent)
	}
	if p.ClearSessionRef {
		// Both together. A row with a provenance and no ref reads as "the ref is
		// still over on that machine", which is a worse answer than "there is no
		// ref" -- the resume path would go looking for one.
		sets = append(sets, "session_ref = NULL", "session_ref_device_id = NULL")
	} else if p.SessionRef != nil {
		// The provenance is written on every ref replacement, including when the
		// caller has none to give. Leaving the old one in place would attach the
		// previous machine's name to a ref it never produced, which is worse than
		// having no provenance at all: "unknown" reads as local, "another
		// machine" sends the resume path down the handoff branch.
		sets = append(sets, "session_ref = ?", "session_ref_device_id = ?")
		args = append(args, *p.SessionRef)
		if p.SessionRefDeviceID != nil {
			args = append(args, *p.SessionRefDeviceID)
		} else {
			args = append(args, nil)
		}
	} else if p.SessionRefDeviceID != nil {
		// A ref that is already stored, with its provenance now known.
		sets = append(sets, "session_ref_device_id = ?")
		args = append(args, *p.SessionRefDeviceID)
	}
	if p.Prompt != nil {
		sets = append(sets, "prompt = ?")
		args = append(args, *p.Prompt)
	}
	if p.ClearModel {
		sets = append(sets, "model = NULL")
	} else if p.Model != nil {
		sets = append(sets, "model = ?")
		args = append(args, *p.Model)
	}
	if p.PermissionMode != nil {
		sets = append(sets, "permission_mode = ?")
		args = append(args, *p.PermissionMode)
	}
	if p.ClearExitCode {
		sets = append(sets, "exit_code = NULL")
	} else if p.ExitCode != nil {
		sets = append(sets, "exit_code = ?")
		args = append(args, *p.ExitCode)
	}
	if p.TokensIn != nil {
		sets = append(sets, "tokens_in = ?")
		args = append(args, *p.TokensIn)
	}
	if p.TokensOut != nil {
		sets = append(sets, "tokens_out = ?")
		args = append(args, *p.TokensOut)
	}
	if p.CostUSD != nil {
		sets = append(sets, "cost_usd = ?")
		args = append(args, *p.CostUSD)
	}
	if p.StartedAt != nil {
		sets = append(sets, "started_at = ?")
		args = append(args, *p.StartedAt)
	}
	if p.ClearFinishedAt {
		sets = append(sets, "finished_at = NULL")
	} else if p.FinishedAt != nil {
		sets = append(sets, "finished_at = ?")
		args = append(args, *p.FinishedAt)
	}
	if p.ProjectID != nil {
		if *p.ProjectID == "" {
			sets = append(sets, "project_id = NULL")
		} else {
			sets = append(sets, "project_id = ?")
			args = append(args, *p.ProjectID)
		}
	}
	if p.RoutineID != nil {
		if *p.RoutineID == "" {
			sets = append(sets, "routine_id = NULL")
		} else {
			sets = append(sets, "routine_id = ?")
			args = append(args, *p.RoutineID)
		}
	}
	if p.RoutineNoteworthy != nil {
		v := 0
		if *p.RoutineNoteworthy {
			v = 1
		}
		sets = append(sets, "routine_noteworthy = ?")
		args = append(args, v)
	}
	if p.RoutineTLDR != nil {
		sets = append(sets, "routine_tldr = ?")
		args = append(args, *p.RoutineTLDR)
	}
	if p.RoutineUnread != nil {
		v := 0
		if *p.RoutineUnread {
			v = 1
		}
		sets = append(sets, "routine_unread = ?")
		args = append(args, v)
	}
	if p.ExecutingDeviceID != nil {
		// Empty means this daemon, which is SQL NULL: the same absence the
		// column has for every row written before a task could run elsewhere.
		var device any
		if *p.ExecutingDeviceID != "" {
			device = *p.ExecutingDeviceID
		}
		sets = append(sets, "executing_device_id = ?")
		args = append(args, device)
	}
	if p.WorkspaceRepo != nil {
		sets = append(sets, "workspace_repo = ?")
		args = append(args, *p.WorkspaceRepo)
	}
	if p.WorkspaceBranch != nil {
		sets = append(sets, "workspace_branch = ?")
		args = append(args, *p.WorkspaceBranch)
	}
	if len(sets) == 0 {
		return nil
	}
	args = append(args, id)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin update task: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	q := `UPDATE tasks SET ` + strings.Join(sets, ", ") + ` WHERE id = ?`
	queryArgs := args
	if refuseStatus != "" {
		q += ` AND status <> ?`
		queryArgs = append(append([]any{}, args...), refuseStatus)
	}
	res, err := tx.ExecContext(ctx, q, queryArgs...)
	if err != nil {
		return fmt.Errorf("update task: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		if refuseStatus != "" {
			// Either the write was refused or the row is gone, and only the row can
			// say which. The caller needs them apart: one means the user stopped
			// this task, the other means there is no such task.
			var status string
			switch err := tx.QueryRowContext(ctx,
				`SELECT status FROM tasks WHERE id = ?`, id).Scan(&status); {
			case errors.Is(err, sql.ErrNoRows):
				return ErrNotFound
			case err != nil:
				return fmt.Errorf("read task status after a refused update: %w", err)
			case status == refuseStatus:
				return ErrTaskCanceled
			}
		}
		return ErrNotFound
	}
	if err := touchTaskHubSeq(ctx, tx, id); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit update task: %w", err)
	}
	return nil
}

// FinishTask atomically persists a terminal task state and consumes any retry
// resume marker that belonged to the attempt being terminated.
//
// The set below deliberately includes the terminal statuses. Reconciliation
// after a restart finishes a task that a crash already marked ended — a
// `failed` row whose work turned out to have landed becomes `succeeded` — so a
// terminal-to-terminal write is a thing this must keep doing. What follows is
// that the store cannot be the gate on "a task ends once"; a plain update
// guarded by the row's own status would have to refuse exactly the write
// reconciliation exists to make.
//
// The gate is the engine's active-run entry instead, and it holds because the
// two sides that can meet while a delivery for one task is in flight both go
// through it: `finishRun` and `finishQueuedRun` refuse to write unless the
// entry still names their execution and retire it under the same lock, while
// `cancelTask` and `cancelUnstarted` retire it in the critical section that
// carries their own write. Those four are the protocol. The other writers of a
// terminal status are not part of it — the restart reconciliation in
// workspace_lifecycle.go, `failStart`'s no-execution branch, and the patches
// that move a row *out* of a terminal state when a follow-up revives it — and
// each is safe only for where it runs, not because of anything this function
// enforces.
func (s *Store) FinishTask(
	ctx context.Context,
	id, status string,
	finishedAt int64,
	exitCode *int,
	costUSD *float64,
	allowQueued bool,
) error {
	switch status {
	case "succeeded", "failed", "canceled":
	default:
		return fmt.Errorf("finish task with non-terminal status %q", status)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin finish task: %w", err)
	}
	defer tx.Rollback()

	sets := []string{"status = ?", "finished_at = ?"}
	args := []any{status, finishedAt}
	if exitCode != nil {
		sets = append(sets, "exit_code = ?")
		args = append(args, *exitCode)
	}
	if costUSD != nil {
		sets = append(sets, "cost_usd = ?")
		args = append(args, *costUSD)
	}
	allowed := []string{
		"'running'",
		"'waiting_approval'",
		"'waiting_input'",
		"'succeeded'",
		"'failed'",
		"'canceled'",
	}
	if allowQueued {
		allowed = append(allowed, "'queued'")
	}
	args = append(args, id)
	res, err := tx.ExecContext(
		ctx,
		`UPDATE tasks SET `+strings.Join(sets, ", ")+
			` WHERE id = ? AND status IN (`+strings.Join(allowed, ", ")+`)`,
		args...,
	)
	if err != nil {
		return fmt.Errorf("finish task: %w", err)
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrConflict
	}
	if _, err := tx.ExecContext(
		ctx,
		`DELETE FROM retry_restore_intents WHERE task_id = ?`,
		id,
	); err != nil {
		return fmt.Errorf("consume retry restore intent: %w", err)
	}
	if err := touchTaskHubSeq(ctx, tx, id); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit finish task: %w", err)
	}
	return nil
}

// AppendEvent inserts the next event for a task (monotonically increasing seq).
// Returns the stored event. Must be called before any WS broadcast (spec §3).
func (s *Store) AppendEvent(ctx context.Context, taskID, typ string, payload json.RawMessage) (Event, error) {
	if payload == nil {
		payload = json.RawMessage(`{}`)
	}
	ts := time.Now().UnixMilli()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Event{}, fmt.Errorf("begin event tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	seq, err := nextEventSeq(ctx, tx, taskID)
	if err != nil {
		return Event{}, err
	}
	var eventEpoch int64
	if err := tx.QueryRowContext(ctx, `SELECT event_epoch FROM tasks WHERE id = ?`, taskID).Scan(&eventEpoch); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Event{}, ErrNotFound
		}
		return Event{}, fmt.Errorf("read task event epoch: %w", err)
	}
	hubSeq, err := nextHubSeq(ctx, tx)
	if err != nil {
		return Event{}, err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO events (task_id, seq, ts, type, payload)
		VALUES (?, ?, ?, ?, ?)`,
		taskID, seq, ts, typ, string(payload),
	); err != nil {
		return Event{}, fmt.Errorf("insert event: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE tasks SET hub_seq = ? WHERE id = ?`, hubSeq, taskID); err != nil {
		return Event{}, fmt.Errorf("advance task hub_seq: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Event{}, fmt.Errorf("commit event: %w", err)
	}
	return Event{
		TaskID:     taskID,
		EventEpoch: eventEpoch,
		Seq:        seq,
		TS:         ts,
		Type:       typ,
		Payload:    payload,
	}, nil
}

// AppendUsageEvent persists a usage event, its normalized ledger row, and the
// compatible task token/cost summary in one transaction.
func (s *Store) AppendUsageEvent(ctx context.Context, taskID, typ string, payload json.RawMessage, record UsageRecord) (Event, Task, error) {
	if payload == nil {
		payload = json.RawMessage(`{}`)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Event{}, Task{}, fmt.Errorf("begin usage event tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	seq, err := nextEventSeq(ctx, tx, taskID)
	if err != nil {
		return Event{}, Task{}, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT event_epoch FROM tasks WHERE id = ?`, taskID).Scan(&record.EventEpoch); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Event{}, Task{}, ErrNotFound
		}
		return Event{}, Task{}, fmt.Errorf("read task event epoch: %w", err)
	}
	hubSeq, err := nextHubSeq(ctx, tx)
	if err != nil {
		return Event{}, Task{}, err
	}
	ts := time.Now().UnixMilli()
	record.TaskID = taskID
	record.EventSeq = seq
	record.OccurredAt = ts
	if err := record.validate(); err != nil {
		return Event{}, Task{}, err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO events (task_id, seq, ts, type, payload)
		VALUES (?, ?, ?, ?, ?)`,
		taskID, seq, ts, typ, string(payload),
	); err != nil {
		return Event{}, Task{}, fmt.Errorf("insert usage event: %w", err)
	}
	if err := insertUsageRecord(ctx, tx, record); err != nil {
		return Event{}, Task{}, err
	}

	input := logicalUsageInput(record)
	output := intValueOrZero(record.OutputTokens)
	result, err := tx.ExecContext(ctx, `
		UPDATE tasks
		SET tokens_in = tokens_in + ?,
		    tokens_out = tokens_out + ?,
		    hub_seq = ?,
		    cost_usd = CASE
		      WHEN ? IS NULL THEN cost_usd
		      ELSE COALESCE(cost_usd, 0) + ?
		    END
		WHERE id = ?`,
		input, output, hubSeq, record.CostUSD, record.CostUSD, taskID,
	)
	if err != nil {
		return Event{}, Task{}, fmt.Errorf("update task usage summary: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return Event{}, Task{}, ErrNotFound
	}

	task, err := scanTask(tx.QueryRowContext(ctx, `SELECT `+taskColumns+` FROM tasks WHERE id = ?`, taskID))
	if err != nil {
		return Event{}, Task{}, fmt.Errorf("read task usage summary: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Event{}, Task{}, fmt.Errorf("commit usage event: %w", err)
	}
	event := Event{TaskID: taskID, EventEpoch: record.EventEpoch, Seq: seq, TS: ts, Type: typ, Payload: payload}
	return event, task, nil
}

func nextEventSeq(ctx context.Context, tx *sql.Tx, taskID string) (int, error) {
	var maxSeq sql.NullInt64
	if err := tx.QueryRowContext(ctx, `
		SELECT MAX(seq) FROM events WHERE task_id = ?`, taskID).Scan(&maxSeq); err != nil {
		return 0, fmt.Errorf("max seq: %w", err)
	}
	if !maxSeq.Valid {
		return 1, nil
	}
	return int(maxSeq.Int64) + 1, nil
}

// hub_seq is what a client stores so it can ask "what changed since I was last
// here" without refetching the world. It is advanced by the writer of the task
// row, in the same transaction as the change that caused it, so a reader that
// has seen hub_seq = N can never observe a task whose row changed but whose
// cursor did not (ADR 0022: only a Hub allocates it, and a standalone daemon is
// a Hub with an in-process Node).
//
// The maximum is taken over tombstones as well as live tasks. A deleted task
// takes its cursor with it, and without the tombstone the next allocation would
// reuse a number that had already been handed out, leaving every synced client
// blind to whatever got stamped with the reused value.
//
// MAX+1 needs no counter row and no lock because the store is single-writer by
// construction: MaxOpenConns(1) serializes every write in the process, which is
// exactly the guarantee events.seq already relies on.
func nextHubSeq(ctx context.Context, tx *sql.Tx) (int64, error) {
	var maxSeq sql.NullInt64
	if err := tx.QueryRowContext(ctx, `
		SELECT MAX(hub_seq) FROM (
			SELECT hub_seq FROM tasks
			UNION ALL
			SELECT hub_seq FROM task_tombstones
		)`).Scan(&maxSeq); err != nil {
		return 0, fmt.Errorf("max hub_seq: %w", err)
	}
	if !maxSeq.Valid {
		return 1, nil
	}
	return maxSeq.Int64 + 1, nil
}

// touchTaskHubSeq marks a task row as changed for cursor-driven readers. Call it
// inside the transaction that made the change, including for changes that
// append no event: a status flip or a renamed workspace is still something a
// client has to hear about, and an update that skips this is an update that
// only reaches clients who happen to refetch.
func touchTaskHubSeq(ctx context.Context, tx *sql.Tx, taskID string) error {
	hubSeq, err := nextHubSeq(ctx, tx)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE tasks SET hub_seq = ? WHERE id = ?`, hubSeq, taskID); err != nil {
		return fmt.Errorf("advance task hub_seq: %w", err)
	}
	return nil
}

func logicalUsageInput(record UsageRecord) int {
	input := intValueOrZero(record.InputTokens)
	if record.InputSemantics == InputSemanticsUncachedOnly {
		input += intValueOrZero(record.CacheReadTokens) + intValueOrZero(record.CacheWriteTokens)
	}
	return input
}

func intValueOrZero(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

// InsertUsageRecord persists one normalized usage observation. The task event
// identified by (task_id, event_epoch, event_seq) is its stable idempotency key.
func (s *Store) InsertUsageRecord(ctx context.Context, r UsageRecord) error {
	if err := r.validate(); err != nil {
		return err
	}
	return insertUsageRecord(ctx, s.db, r)
}

type usageRecordExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func insertUsageRecord(ctx context.Context, exec usageRecordExecer, r UsageRecord) error {
	_, err := exec.ExecContext(ctx, `
		INSERT INTO usage_records (
			task_id, event_epoch, event_seq, occurred_at, agent, provider, model,
			input_tokens, output_tokens, reasoning_output_tokens,
			cache_read_tokens, cache_write_tokens, cost_usd,
			cost_source, cache_status, input_semantics
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.TaskID, r.EventEpoch, r.EventSeq, r.OccurredAt, r.Agent, r.Provider, r.Model,
		r.InputTokens, r.OutputTokens, r.ReasoningOutputTokens,
		r.CacheReadTokens, r.CacheWriteTokens, r.CostUSD,
		r.CostSource, r.CacheStatus, r.InputSemantics,
	)
	if err != nil {
		return fmt.Errorf("insert usage record: %w", err)
	}
	return nil
}

// ListUsageRecords returns task usage observations in event order.
func (s *Store) ListUsageRecords(ctx context.Context, taskID string) ([]UsageRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
			SELECT task_id, event_epoch, event_seq, occurred_at, agent, provider, model,
		       input_tokens, output_tokens, reasoning_output_tokens,
		       cache_read_tokens, cache_write_tokens, cost_usd,
		       cost_source, cache_status, input_semantics
		FROM usage_records
		WHERE task_id = ?
			ORDER BY event_epoch ASC, event_seq ASC`, taskID)
	if err != nil {
		return nil, fmt.Errorf("list usage records: %w", err)
	}
	defer rows.Close()

	records := make([]UsageRecord, 0)
	for rows.Next() {
		var r UsageRecord
		var provider, model sql.NullString
		var input, output, reasoning, cacheRead, cacheWrite sql.NullInt64
		var cost sql.NullFloat64
		if err := rows.Scan(
			&r.TaskID, &r.EventEpoch, &r.EventSeq, &r.OccurredAt, &r.Agent, &provider, &model,
			&input, &output, &reasoning, &cacheRead, &cacheWrite, &cost,
			&r.CostSource, &r.CacheStatus, &r.InputSemantics,
		); err != nil {
			return nil, fmt.Errorf("scan usage record: %w", err)
		}
		if provider.Valid {
			r.Provider = &provider.String
		}
		if model.Valid {
			r.Model = &model.String
		}
		r.InputTokens = nullableInt(input)
		r.OutputTokens = nullableInt(output)
		r.ReasoningOutputTokens = nullableInt(reasoning)
		r.CacheReadTokens = nullableInt(cacheRead)
		r.CacheWriteTokens = nullableInt(cacheWrite)
		if cost.Valid {
			v := cost.Float64
			r.CostUSD = &v
		}
		records = append(records, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return records, nil
}

func nullableInt(v sql.NullInt64) *int {
	if !v.Valid {
		return nil
	}
	i := int(v.Int64)
	return &i
}

// ListEvents returns events for a task with seq > sinceSeq, ordered by seq asc.
func (s *Store) ListEvents(ctx context.Context, taskID string, sinceSeq int) ([]Event, error) {
	return s.ListEventsLimit(ctx, taskID, sinceSeq, 0)
}

// ListEventsLimit returns at most limit events. A non-positive limit preserves
// the historical unbounded behavior for internal callers.
func (s *Store) ListEventsLimit(ctx context.Context, taskID string, sinceSeq, limit int) ([]Event, error) {
	query := `
			SELECT e.task_id, t.event_epoch, e.seq, e.ts, e.type, e.payload
			FROM events e
			JOIN tasks t ON t.id = e.task_id
			WHERE e.task_id = ? AND e.seq > ?
			ORDER BY e.seq ASC`
	args := []any{taskID, sinceSeq}
	if limit > 0 {
		if limit > 500 {
			limit = 500
		}
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	defer rows.Close()

	out := make([]Event, 0)
	for rows.Next() {
		var e Event
		var payload string
		if err := rows.Scan(&e.TaskID, &e.EventEpoch, &e.Seq, &e.TS, &e.Type, &payload); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		e.Payload = json.RawMessage(payload)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// TruncateEventsFrom atomically starts a new event epoch and deletes events
// with seq >= fromSeq. Usage remains immutable across retries and is keyed by
// epoch so actual spend is never erased.
func (s *Store) TruncateEventsFrom(ctx context.Context, taskID string, fromSeq int) error {
	if fromSeq < 1 {
		return fmt.Errorf("fromSeq must be >= 1")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin truncate events: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM events WHERE task_id = ? AND seq >= ?`, taskID, fromSeq); err != nil {
		return fmt.Errorf("truncate events: %w", err)
	}
	// A reader that already synced up to the old head must be told the tail is
	// gone, so the truncation advances the global cursor like any other change.
	hubSeq, err := nextHubSeq(ctx, tx)
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx,
		`UPDATE tasks SET event_epoch = event_epoch + 1, hub_seq = ? WHERE id = ?`, hubSeq, taskID)
	if err != nil {
		return fmt.Errorf("advance event epoch: %w", err)
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit truncate events: %w", err)
	}
	return nil
}

// CopyEventsToTask copies events with seq <= maxSeq from src to dst, renumbering from 1.
// Returns the number of events copied.
func (s *Store) CopyEventsToTask(ctx context.Context, srcID, dstID string, maxSeq int) (int, error) {
	if maxSeq < 1 {
		return 0, fmt.Errorf("maxSeq must be >= 1")
	}
	// Load fully first so we do not hold a query connection open across BeginTx
	// (SQLite single-connection pools would otherwise deadlock).
	type row struct {
		ts      int64
		typ     string
		payload string
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT ts, type, payload
		FROM events
		WHERE task_id = ? AND seq <= ?
		ORDER BY seq ASC`, srcID, maxSeq)
	if err != nil {
		return 0, fmt.Errorf("list events for copy: %w", err)
	}
	var batch []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.ts, &r.typ, &r.payload); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan event for copy: %w", err)
		}
		batch = append(batch, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin copy events: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for i, r := range batch {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO events (task_id, seq, ts, type, payload)
			VALUES (?, ?, ?, ?, ?)`,
			dstID, i+1, r.ts, r.typ, r.payload,
		); err != nil {
			return 0, fmt.Errorf("insert copied event: %w", err)
		}
	}
	if len(batch) > 0 {
		if err := touchTaskHubSeq(ctx, tx, dstID); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit copy events: %w", err)
	}
	return len(batch), nil
}

// StartQueuedTask atomically claims a queued task and consumes any durable
// retry-resume marker. A retry intent remains until this transition so a crash
// after retry completion can reconstruct the in-memory queue.
func (s *Store) StartQueuedTask(ctx context.Context, taskID string, startedAt int64) (Task, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Task{}, fmt.Errorf("begin task start: %w", err)
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `
		UPDATE tasks
		SET status = 'running', started_at = COALESCE(started_at, ?)
		WHERE id = ? AND status = 'queued'`, startedAt, taskID)
	if err != nil {
		return Task{}, fmt.Errorf("start queued task: %w", err)
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return Task{}, ErrConflict
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM retry_restore_intents WHERE task_id = ?`, taskID); err != nil {
		return Task{}, fmt.Errorf("consume retry restore intent: %w", err)
	}
	if err := touchTaskHubSeq(ctx, tx, taskID); err != nil {
		return Task{}, err
	}
	task, err := scanTask(tx.QueryRowContext(ctx,
		`SELECT `+taskColumns+` FROM tasks WHERE id = ?`, taskID))
	if err != nil {
		return Task{}, fmt.Errorf("read started task: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Task{}, fmt.Errorf("commit task start: %w", err)
	}
	return task, nil
}

// FailOrphaned marks queued/running tasks as failed after a daemon restart.
// Queued retries with a durable restore intent are excluded so recovery can
// reconstruct their in-memory queue.
// Returns the IDs that were failed so the caller can append error events.
func (s *Store) FailOrphaned(ctx context.Context) ([]string, error) {
	now := time.Now().UnixMilli()
	rows, err := s.db.QueryContext(ctx, `
		SELECT id FROM tasks
		WHERE status IN ('queued', 'running', 'waiting_approval')
		  AND NOT EXISTS (
			SELECT 1 FROM retry_restore_intents r WHERE r.task_id = tasks.id
		  )`)
	if err != nil {
		return nil, fmt.Errorf("select orphans: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin fail orphans: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, `
			UPDATE tasks SET status = 'failed', finished_at = ?
			WHERE id = ? AND status IN ('queued', 'running', 'waiting_approval')
			  AND NOT EXISTS (
				SELECT 1 FROM retry_restore_intents r WHERE r.task_id = tasks.id
			  )`,
			now, id,
		); err != nil {
			return nil, fmt.Errorf("fail orphan %s: %w", id, err)
		}
		if err := touchTaskHubSeq(ctx, tx, id); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit fail orphans: %w", err)
	}
	return ids, nil
}

// RecentCwds returns distinct cwd values from recent tasks (most recent first).
//
// Only tasks that ran here count. A task executed by another device stores a
// path in that device's filesystem, and this machine usually holds a different
// checkout of the same repository at the same address; offering it as a
// suggestion is how a new task silently starts work in the wrong one.
func (s *Store) RecentCwds(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 10
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT cwd FROM (
			SELECT cwd, MAX(created_at) AS last_used
			FROM tasks
			WHERE executing_device_id IS NULL OR executing_device_id = ''
			GROUP BY cwd
			ORDER BY last_used DESC
			LIMIT ?
		)`, limit)
	if err != nil {
		return nil, fmt.Errorf("recent cwds: %w", err)
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var cwd string
		if err := rows.Scan(&cwd); err != nil {
			return nil, err
		}
		out = append(out, cwd)
	}
	return out, rows.Err()
}

// GetSetting reads a settings key.
func (s *Store) GetSetting(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return v, nil
}

// SetSetting upserts a settings key.
func (s *Store) SetSetting(ctx context.Context, key, value string) error {
	return s.SetSettings(ctx, map[string]string{key: value})
}

// SetSettings atomically upserts a set of settings.
func (s *Store) SetSettings(ctx context.Context, values map[string]string) error {
	if len(values) == 0 {
		return nil
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, key := range keys {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO settings (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, values[key]); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// UsageRow is one day × agent aggregate for GET /api/usage/summary (M4).
type UsageRow struct {
	Date  string `json:"date"` // YYYY-MM-DD (UTC)
	Agent string `json:"agent"`
	// Provider is the runtime provider id for routing attribution.
	Provider string `json:"provider,omitempty"`
	Tasks    int    `json:"tasks"`
	UsageTotals
}

// UsageModelSubtotal is a task usage subtotal grouped by model.
type UsageModelSubtotal struct {
	Model string `json:"model"`
	UsageTotals
}

// UsageCostSourceSubtotal is a task usage subtotal grouped by cost source.
type UsageCostSourceSubtotal struct {
	CostSource string `json:"cost_source"`
	UsageTotals
}

// UsageTotals is the shared token, cache, cost, and coverage shape used by
// task subtotals and task-level usage responses.
type UsageTotals struct {
	TokensIn                 int64    `json:"tokens_in"`
	TokensOut                int64    `json:"tokens_out"`
	CostUSD                  *float64 `json:"cost_usd"`
	RequestCount             int      `json:"request_count"`
	ReasoningOutputTokens    int64    `json:"reasoning_output_tokens"`
	CacheReadTokens          int64    `json:"cache_read_tokens"`
	CacheWriteTokens         int64    `json:"cache_write_tokens"`
	CacheEligibleInputTokens int64    `json:"cache_eligible_input_tokens"`
	CacheHitRate             *float64 `json:"cache_hit_rate"`
	CacheCoverage            *float64 `json:"cache_coverage"`
	CacheStatus              string   `json:"cache_status"`
}

// TaskUsage is the cache-aware usage view for one task.
type TaskUsage struct {
	TaskID string `json:"task_id"`
	UsageTotals
	ModelSubtotals      []UsageModelSubtotal      `json:"model_subtotals"`
	CostSourceSubtotals []UsageCostSourceSubtotal `json:"cost_source_subtotals"`
}

// UsageSummary returns per-day, per-agent aggregates over the last `days` days (UTC).
// days defaults to 30 when <= 0; capped at 366.
func (s *Store) UsageSummary(ctx context.Context, days int) ([]UsageRow, error) {
	if days <= 0 {
		days = 30
	}
	if days > 366 {
		days = 366
	}
	// Inclusive window: start of (today - (days-1)) UTC in unix ms.
	now := time.Now().UTC()
	startDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).
		AddDate(0, 0, -(days - 1))
	startMS := startDay.UnixMilli()

	rows, err := s.db.QueryContext(ctx, `
			SELECT task_id, event_epoch, event_seq, occurred_at, agent, provider, model,
	       input_tokens, output_tokens, reasoning_output_tokens,
	       cache_read_tokens, cache_write_tokens, cost_usd,
	       cost_source, cache_status, input_semantics
		FROM usage_records WHERE occurred_at >= ?`, startMS)
	if err != nil {
		return nil, fmt.Errorf("usage summary: %w", err)
	}
	defer rows.Close()
	type aggregateKey struct{ date, agent, provider string }
	aggregates := map[aggregateKey]*usageAccumulator{}
	tasksByKey := map[aggregateKey]map[string]struct{}{}
	for rows.Next() {
		r, err := scanUsageRecord(rows)
		if err != nil {
			return nil, fmt.Errorf("scan usage: %w", err)
		}
		prov := ""
		if r.Provider != nil {
			prov = *r.Provider
		}
		key := aggregateKey{date: usageDate(r.OccurredAt), agent: r.Agent, provider: prov}
		if aggregates[key] == nil {
			aggregates[key] = &usageAccumulator{}
			tasksByKey[key] = map[string]struct{}{}
		}
		aggregates[key].addRecord(r)
		tasksByKey[key][r.TaskID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close usage summary rows: %w", err)
	}

	// Tasks without ledger rows retain their historical task totals. Their cache
	// state is unknown, rather than a misleading reported zero.
	legacyRows, err := s.db.QueryContext(ctx, `
		SELECT t.id, t.agent, t.tokens_in, t.tokens_out, t.cost_usd, t.created_at
		FROM tasks t
		WHERE t.created_at >= ?
		  AND NOT EXISTS (SELECT 1 FROM usage_records u WHERE u.task_id = t.id)`, startMS)
	if err != nil {
		return nil, fmt.Errorf("usage summary legacy tasks: %w", err)
	}
	defer legacyRows.Close()
	for legacyRows.Next() {
		var id, agent string
		var in, out int64
		var cost sql.NullFloat64
		var created int64
		if err := legacyRows.Scan(&id, &agent, &in, &out, &cost, &created); err != nil {
			return nil, fmt.Errorf("scan legacy usage task: %w", err)
		}
		key := aggregateKey{date: usageDate(created), agent: agent, provider: ""}
		if aggregates[key] == nil {
			aggregates[key] = &usageAccumulator{}
			tasksByKey[key] = map[string]struct{}{}
		}
		aggregates[key].addLegacy(in, out, nullableFloat(cost))
		tasksByKey[key][id] = struct{}{}
	}
	if err := legacyRows.Err(); err != nil {
		return nil, err
	}

	out := make([]UsageRow, 0, len(aggregates))
	for key, aggregate := range aggregates {
		totals := aggregate.totals()
		out = append(out, UsageRow{Date: key.date, Agent: key.agent, Provider: key.provider, Tasks: len(tasksByKey[key]), UsageTotals: totals})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Date == out[j].Date {
			if out[i].Agent == out[j].Agent {
				return out[i].Provider < out[j].Provider
			}
			return out[i].Agent < out[j].Agent
		}
		return out[i].Date > out[j].Date
	})
	return out, nil
}

// TaskUsage returns cache-aware totals and model/cost-source breakdowns for a task.
func (s *Store) TaskUsage(ctx context.Context, taskID string) (TaskUsage, error) {
	task, err := s.GetTask(ctx, taskID)
	if err != nil {
		return TaskUsage{}, err
	}
	records, err := s.ListUsageRecords(ctx, taskID)
	if err != nil {
		return TaskUsage{}, err
	}
	if len(records) == 0 {
		a := usageAccumulator{}
		a.addLegacy(int64(task.TokensIn), int64(task.TokensOut), task.CostUSD)
		return TaskUsage{TaskID: taskID, UsageTotals: a.totals(), ModelSubtotals: []UsageModelSubtotal{}, CostSourceSubtotals: []UsageCostSourceSubtotal{}}, nil
	}
	total := usageAccumulator{}
	byModel := map[string]*usageAccumulator{}
	byCost := map[string]*usageAccumulator{}
	for _, record := range records {
		total.addRecord(record)
		model := "unknown"
		if record.Model != nil && *record.Model != "" {
			model = *record.Model
		}
		if byModel[model] == nil {
			byModel[model] = &usageAccumulator{}
		}
		byModel[model].addRecord(record)
		if byCost[record.CostSource] == nil {
			byCost[record.CostSource] = &usageAccumulator{}
		}
		byCost[record.CostSource].addRecord(record)
	}
	result := TaskUsage{TaskID: taskID, UsageTotals: total.totals(), ModelSubtotals: make([]UsageModelSubtotal, 0, len(byModel)), CostSourceSubtotals: make([]UsageCostSourceSubtotal, 0, len(byCost))}
	for model, subtotal := range byModel {
		result.ModelSubtotals = append(result.ModelSubtotals, UsageModelSubtotal{Model: model, UsageTotals: subtotal.totals()})
	}
	for source, subtotal := range byCost {
		result.CostSourceSubtotals = append(result.CostSourceSubtotals, UsageCostSourceSubtotal{CostSource: source, UsageTotals: subtotal.totals()})
	}
	sort.Slice(result.ModelSubtotals, func(i, j int) bool { return result.ModelSubtotals[i].Model < result.ModelSubtotals[j].Model })
	sort.Slice(result.CostSourceSubtotals, func(i, j int) bool {
		return result.CostSourceSubtotals[i].CostSource < result.CostSourceSubtotals[j].CostSource
	})
	return result, nil
}

type usageAccumulator struct {
	tokensIn, tokensOut, reasoning, cacheRead, cacheWrite  int64
	requests, knownInput, eligibleInput, eligibleCacheRead int64
	cost                                                   float64
	costCount                                              int
	statuses                                               map[string]struct{}
}

func (a *usageAccumulator) addRecord(r UsageRecord) {
	a.tokensIn += int64(logicalUsageInput(r))
	a.tokensOut += int64(intValueOrZero(r.OutputTokens))
	a.reasoning += int64(intValueOrZero(r.ReasoningOutputTokens))
	a.cacheRead += int64(intValueOrZero(r.CacheReadTokens))
	a.cacheWrite += int64(intValueOrZero(r.CacheWriteTokens))
	a.requests++
	if r.InputTokens != nil {
		a.knownInput += int64(logicalUsageInput(r))
		if r.CacheStatus == CacheStatusReported && r.InputSemantics != InputSemanticsUnknown {
			a.eligibleInput += int64(logicalUsageInput(r))
			a.eligibleCacheRead += int64(intValueOrZero(r.CacheReadTokens))
		}
	}
	if r.CostUSD != nil {
		a.cost += *r.CostUSD
		a.costCount++
	}
	if a.statuses == nil {
		a.statuses = map[string]struct{}{}
	}
	a.statuses[r.CacheStatus] = struct{}{}
}

func (a *usageAccumulator) addLegacy(input, output int64, cost *float64) {
	a.tokensIn += input
	a.tokensOut += output
	a.knownInput += input
	if cost != nil {
		a.cost += *cost
		a.costCount++
	}
	if a.statuses == nil {
		a.statuses = map[string]struct{}{}
	}
	a.statuses[CacheStatusUnknown] = struct{}{}
}

func (a *usageAccumulator) totals() UsageTotals {
	t := UsageTotals{
		TokensIn: a.tokensIn, TokensOut: a.tokensOut, RequestCount: int(a.requests),
		ReasoningOutputTokens: a.reasoning, CacheReadTokens: a.cacheRead, CacheWriteTokens: a.cacheWrite,
		CacheEligibleInputTokens: a.eligibleInput, CacheStatus: aggregateCacheStatus(a.statuses),
	}
	if a.costCount > 0 {
		cost := a.cost
		t.CostUSD = &cost
	}
	if a.eligibleInput > 0 {
		rate := float64(a.eligibleCacheRead) / float64(a.eligibleInput)
		t.CacheHitRate = &rate
	}
	if a.knownInput > 0 {
		coverage := float64(a.eligibleInput) / float64(a.knownInput)
		t.CacheCoverage = &coverage
	}
	return t
}

func aggregateCacheStatus(statuses map[string]struct{}) string {
	if len(statuses) == 0 {
		return CacheStatusUnknown
	}
	if len(statuses) > 1 {
		return CacheStatusMixed
	}
	for status := range statuses {
		return status
	}
	return CacheStatusUnknown
}

func scanUsageRecord(scanner interface{ Scan(...any) error }) (UsageRecord, error) {
	var r UsageRecord
	var provider, model sql.NullString
	var input, output, reasoning, cacheRead, cacheWrite sql.NullInt64
	var cost sql.NullFloat64
	if err := scanner.Scan(
		&r.TaskID, &r.EventEpoch, &r.EventSeq, &r.OccurredAt, &r.Agent, &provider, &model,
		&input, &output, &reasoning, &cacheRead, &cacheWrite, &cost,
		&r.CostSource, &r.CacheStatus, &r.InputSemantics,
	); err != nil {
		return UsageRecord{}, err
	}
	if provider.Valid {
		r.Provider = &provider.String
	}
	if model.Valid {
		r.Model = &model.String
	}
	r.InputTokens = nullableInt(input)
	r.OutputTokens = nullableInt(output)
	r.ReasoningOutputTokens = nullableInt(reasoning)
	r.CacheReadTokens = nullableInt(cacheRead)
	r.CacheWriteTokens = nullableInt(cacheWrite)
	r.CostUSD = nullableFloat(cost)
	return r, nil
}

func nullableFloat(v sql.NullFloat64) *float64 {
	if !v.Valid {
		return nil
	}
	f := v.Float64
	return &f
}

func usageDate(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02") }

// LoadPriceTable returns the configured price table, or the default if unset/invalid.
func (s *Store) LoadPriceTable(ctx context.Context) PriceTable {
	raw, err := s.GetSetting(ctx, KeyPriceTable)
	if err != nil || strings.TrimSpace(raw) == "" {
		return DefaultPriceTable()
	}
	t, err := ParsePriceTable(raw)
	if err != nil {
		return DefaultPriceTable()
	}
	return t
}

// NowMilli is a testable clock helper.
func NowMilli() int64 { return time.Now().UnixMilli() }
