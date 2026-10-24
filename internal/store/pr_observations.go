package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// CI states as persisted in pr_observations.ci_state.
//
// The vocabulary lives here rather than in the package that derives it, for the
// same reason WorkspaceState does: this is the set of values the database and
// the console have to agree on, and the derivation is free to change without
// changing them.
const (
	CINone    = "none"
	CIPending = "pending"
	CISuccess = "success"
	CIFailure = "failure"
)

// PRObservation is the cached, fallible view of one (repo, branch) pair on a
// forge.
//
// It is not a record of something Kin owns. Every field below `ObservedAt` was
// true at the moment it was read and may be false now; every field above
// `AttemptedAt` is what the last read said, which may be older than the last
// attempt. The two halves are written by different methods on purpose — see
// migrationPRObservations.
type PRObservation struct {
	Repo       string `json:"repo"`
	HeadBranch string `json:"head_branch"`
	TaskID     string `json:"task_id"`

	// Number is nil when a *successful* query found no pull request for the
	// branch. It is also nil when no query has ever succeeded, which
	// ObservedAt distinguishes.
	Number     *int   `json:"number,omitempty"`
	URL        string `json:"url,omitempty"`
	Title      string `json:"title,omitempty"`
	State      string `json:"state,omitempty"` // open | closed | merged
	IsDraft    bool   `json:"is_draft,omitempty"`
	BaseBranch string `json:"base_branch,omitempty"`
	HeadOID    string `json:"head_oid,omitempty"`
	CIState    string `json:"ci_state,omitempty"`   // none | pending | success | failure
	CISummary  string `json:"ci_summary,omitempty"` // JSON: counts + failing check names
	Source     string `json:"source,omitempty"`     // gh | anonymous

	// CommentsSeen is the highest comment id already handed to the session, so
	// feeding comments back is idempotent. It is a cursor, not an observation,
	// and observation writes never touch it.
	CommentsSeen int64 `json:"comments_seen,omitempty"`

	ObservedAt *int64 `json:"observed_at,omitempty"`

	// AttemptedAt and LastError describe the most recent query, successful or
	// not. LastError is empty exactly when that attempt succeeded.
	AttemptedAt int64  `json:"attempted_at"`
	LastError   string `json:"last_error,omitempty"`
}

const prObservationColumns = `repo, head_branch, task_id, number, url, title, state,
	is_draft, base_branch, head_oid, ci_state, ci_summary, comments_seen, source,
	observed_at, attempted_at, last_error`

func scanPRObservation(row interface{ Scan(...any) error }) (PRObservation, error) {
	var (
		o          PRObservation
		number     sql.NullInt64
		observedAt sql.NullInt64
	)
	err := row.Scan(&o.Repo, &o.HeadBranch, &o.TaskID, &number, &o.URL, &o.Title,
		&o.State, &o.IsDraft, &o.BaseBranch, &o.HeadOID, &o.CIState, &o.CISummary,
		&o.CommentsSeen, &o.Source, &observedAt, &o.AttemptedAt, &o.LastError)
	if err != nil {
		return PRObservation{}, err
	}
	if number.Valid {
		n := int(number.Int64)
		o.Number = &n
	}
	if observedAt.Valid {
		ms := observedAt.Int64
		o.ObservedAt = &ms
	}
	return o, nil
}

// RecordPRObservation stores a successful query.
//
// This is the only path that can clear Number, and it earns that by having
// actually asked. A successful answer of "no pull request for this branch" is
// information and supersedes an older number; a failed query is not, which is
// why it goes through RecordPRFailure instead.
//
// ObservedAt and AttemptedAt are the caller's to set, and mean when the question
// was asked rather than when the answer arrived. Together with the WHERE clause
// below they make the row a function of the newest question asked rather than the
// last answer to land: two questions can be in flight for one branch at once —
// the background pass reading a row while someone taps refresh — and the answer
// that arrives second is not necessarily the one that was asked second. Without
// the guard, a slow read that saw an open pull request overwrites the merged
// state a later read already recorded, and the console goes backwards.
//
// A tie applies: two answers to questions asked in the same millisecond are both
// current, and the later write of the two says nothing older.
//
// The attempt columns are written differently from the observation ones on
// purpose, because they are a different clock. AttemptedAt only ever moves
// forward, and a success clears LastError only when it also answers the newest
// attempt. The pair of them is what keeps this write — which is newer than the
// recorded *observation* but may be older than the recorded *attempt* — from
// erasing the failure of a question asked after it. Without that, the row would
// say the last attempt succeeded when the last attempt is the one that failed.
func (s *Store) RecordPRObservation(ctx context.Context, o PRObservation) error {
	if o.Repo == "" || o.HeadBranch == "" || o.TaskID == "" {
		return fmt.Errorf("pr observation needs repo, head_branch, and task_id")
	}
	now := time.Now().UnixMilli()
	if o.AttemptedAt == 0 {
		o.AttemptedAt = now
	}
	if o.ObservedAt == nil {
		o.ObservedAt = &now
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO pr_observations (`+prObservationColumns+`)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
ON CONFLICT(repo, head_branch) DO UPDATE SET
  task_id      = excluded.task_id,
  number       = excluded.number,
  url          = excluded.url,
  title        = excluded.title,
  state        = excluded.state,
  is_draft     = excluded.is_draft,
  base_branch  = excluded.base_branch,
  head_oid     = excluded.head_oid,
  ci_state     = excluded.ci_state,
  ci_summary   = excluded.ci_summary,
  source       = excluded.source,
  observed_at  = excluded.observed_at,
  attempted_at = MAX(excluded.attempted_at, pr_observations.attempted_at),
  last_error   = CASE WHEN excluded.attempted_at >= pr_observations.attempted_at
                      THEN '' ELSE pr_observations.last_error END
WHERE excluded.observed_at >= COALESCE(pr_observations.observed_at, 0)`,
		o.Repo, o.HeadBranch, o.TaskID, o.Number, o.URL, o.Title, o.State,
		o.IsDraft, o.BaseBranch, o.HeadOID, o.CIState, o.CISummary,
		o.CommentsSeen, o.Source, o.ObservedAt, o.AttemptedAt)
	if err != nil {
		return fmt.Errorf("record pr observation: %w", err)
	}
	return nil
}

// RecordPRFailure stores a failed query.
//
// It writes the attempt columns and nothing else. The previous successful
// observation stays exactly as it was, which is what lets the console say
// "last seen 12 minutes ago, this attempt failed: <why>" instead of losing the
// pull request because the network blinked.
//
// attemptedAt is when the question was asked, not when the failure came back,
// and a failure answering a question older than the attempt already recorded is
// dropped: it has nothing newer to say than what is on the row. A question asked
// in the same millisecond as the recorded attempt does apply — both are current,
// and the reason is the more useful half of a tie.
func (s *Store) RecordPRFailure(ctx context.Context, repo, branch, taskID, reason string, attemptedAt time.Time) error {
	if repo == "" || branch == "" {
		return fmt.Errorf("pr failure needs repo and head_branch")
	}
	if attemptedAt.IsZero() {
		attemptedAt = time.Now()
	}
	at := attemptedAt.UnixMilli()
	_, err := s.db.ExecContext(ctx, `
INSERT INTO pr_observations (repo, head_branch, task_id, attempted_at, last_error)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(repo, head_branch) DO UPDATE SET
  attempted_at = excluded.attempted_at,
  last_error   = excluded.last_error
WHERE excluded.attempted_at >= pr_observations.attempted_at`,
		repo, branch, taskID, at, reason)
	if err != nil {
		return fmt.Errorf("record pr failure: %w", err)
	}
	return nil
}

// GetPRObservation returns the cached view of one pair, or ok=false if no
// attempt has ever been recorded for it.
func (s *Store) GetPRObservation(ctx context.Context, repo, branch string) (PRObservation, bool, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+prObservationColumns+` FROM pr_observations WHERE repo = ? AND head_branch = ?`,
		repo, branch)
	o, err := scanPRObservation(row)
	if errors.Is(err, sql.ErrNoRows) {
		return PRObservation{}, false, nil
	}
	if err != nil {
		return PRObservation{}, false, fmt.Errorf("get pr observation: %w", err)
	}
	return o, true, nil
}

// ListPRObservationsByTask returns every branch observation recorded for a task,
// newest branch first. A task can have more than one: each workspace generation
// gets its own branch.
//
// Empty is an empty slice rather than nil, because this feeds a JSON array and
// a nil slice marshals to `null`.
func (s *Store) ListPRObservationsByTask(ctx context.Context, taskID string) ([]PRObservation, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+prObservationColumns+` FROM pr_observations WHERE task_id = ? ORDER BY head_branch DESC`,
		taskID)
	if err != nil {
		return nil, fmt.Errorf("list pr observations: %w", err)
	}
	defer rows.Close()

	out := []PRObservation{}
	for rows.Next() {
		o, err := scanPRObservation(rows)
		if err != nil {
			return nil, fmt.Errorf("scan pr observation: %w", err)
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// ListOpenPRObservations returns observations whose pull request is still open,
// oldest attempt first, capped at limit.
//
// This is the whole watch set for the background pass. A branch with no pull
// request has nothing that changes on its own, so polling it in the background
// would spend rate limit to re-learn a fact that only the user can change.
func (s *Store) ListOpenPRObservations(ctx context.Context, limit int) ([]PRObservation, error) {
	if limit <= 0 {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+prObservationColumns+` FROM pr_observations
		 WHERE state = 'open' AND number IS NOT NULL
		 ORDER BY attempted_at ASC, head_branch ASC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("list open pr observations: %w", err)
	}
	defer rows.Close()

	var out []PRObservation
	for rows.Next() {
		o, err := scanPRObservation(rows)
		if err != nil {
			return nil, fmt.Errorf("scan open pr observation: %w", err)
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// AdvancePRCommentsSeen moves the fed-back cursor forward. It never moves
// backward, so two overlapping feeds cannot replay a comment.
func (s *Store) AdvancePRCommentsSeen(ctx context.Context, repo, branch string, seen int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE pr_observations SET comments_seen = ?
		 WHERE repo = ? AND head_branch = ? AND comments_seen < ?`,
		seen, repo, branch, seen)
	if err != nil {
		return fmt.Errorf("advance pr comments cursor: %w", err)
	}
	return nil
}
