package routines

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// CreateParams is one Routine as a client asks for it, before defaults,
// validation and scheduling are applied. It is the wire shape the REST console
// sends; the MCP tool reads the same fields, so both paths create the same
// record from the same words.
type CreateParams struct {
	Title     string `json:"title"`
	ProjectID string `json:"project_id"`
	Cwd       string `json:"cwd"`
	Agent     string `json:"agent"`
	// Model is optional; empty means the agent's own default.
	Model           string `json:"model"`
	PermissionMode  string `json:"permission_mode"`
	Prompt          string `json:"prompt"`
	IntervalSecs    int64  `json:"interval_secs"`
	Enabled         *bool  `json:"enabled"`
	MissedRunPolicy string `json:"missed_run_policy"`
	Lane            string `json:"lane"`
	// Recurrence is a wall-clock rule as JSON, empty for an interval routine.
	Recurrence string `json:"recurrence"`
	// NextDueAt optional; default = now (fires on next tick / run-now).
	NextDueAt *int64 `json:"next_due_at"`
}

// ValidationError reports a Routine a client asked for that cannot be stored:
// missing fields, an unfireable rule, an unusable agent or permission mode.
// Every path that creates a Routine treats it as the caller's mistake (HTTP
// 400, MCP invalid-params) rather than a machine failure.
type ValidationError struct {
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

func invalidRoutine(format string, args ...any) error {
	return &ValidationError{Message: fmt.Sprintf(format, args...)}
}

// ValidateCreateFunc is the machine's own check that an agent exists and the
// permission mode is one it accepts. The API and MCP supply the same rule, so a
// Routine cannot be created through one door and refused through the other.
type ValidateCreateFunc func(context.Context, task.CreateRequest) error

// Create validates a Routine and stores it. It is the one place defaults are
// applied, because a Routine created from the console and one created through
// MCP must mean the same thing.
func Create(ctx context.Context, st *store.Store, validate ValidateCreateFunc, p CreateParams) (store.Routine, error) {
	p.Cwd = strings.TrimSpace(p.Cwd)
	p.Prompt = strings.TrimSpace(p.Prompt)
	if p.Cwd == "" || p.Prompt == "" {
		return store.Routine{}, invalidRoutine("cwd and prompt are required")
	}
	recurrence, err := ParseRecurrence(p.Recurrence)
	if err != nil {
		return store.Routine{}, invalidRoutine("%s", err)
	}
	intervalSecs := p.IntervalSecs
	if recurrence != nil && intervalSecs <= 0 {
		// A wall-clock routine's pace is the rule's own period. Asking the
		// user for an interval they will never see honoured would be noise.
		intervalSecs = recurrence.NominalIntervalSeconds(time.Now())
	}
	if intervalSecs <= 0 {
		return store.Routine{}, invalidRoutine("interval_secs must be > 0")
	}
	now := time.Now().UnixMilli()
	enabled := true
	if p.Enabled != nil {
		enabled = *p.Enabled
	}
	next := now
	if p.NextDueAt != nil && *p.NextDueAt > 0 {
		next = *p.NextDueAt
	} else if recurrence != nil {
		// The first run is the rule's next occurrence, not "as soon as the
		// scheduler looks": creating a weekday-morning routine on a Tuesday
		// afternoon must not run it on Tuesday afternoon.
		at, ok := FirstRun(recurrence, time.UnixMilli(now))
		if !ok {
			return store.Routine{}, invalidRoutine("recurrence has no future occurrence")
		}
		next = at
	}
	agent := strings.TrimSpace(p.Agent)
	if agent == "" {
		agent = "kin"
	}
	perm := strings.TrimSpace(p.PermissionMode)
	if perm == "" {
		perm = "default"
	}
	model := strings.TrimSpace(p.Model)
	policy := strings.ToLower(strings.TrimSpace(p.MissedRunPolicy))
	if policy == "" {
		policy = "coalesce"
	}
	if policy != "coalesce" && policy != "skip" {
		return store.Routine{}, invalidRoutine("missed_run_policy must be coalesce or skip")
	}
	if validate != nil {
		if err := validate(ctx, task.CreateRequest{Agent: agent, PermissionMode: perm}); err != nil {
			return store.Routine{}, invalidRoutine("%s", err)
		}
	}
	lane := strings.TrimSpace(p.Lane)
	if lane == "" {
		lane = "routine"
	}
	projectID := strings.TrimSpace(p.ProjectID)
	if projectID == "" {
		if resolved, err := st.ResolveProjectIDForCwd(ctx, p.Cwd); err == nil {
			projectID = resolved
		}
	}
	title := strings.TrimSpace(p.Title)
	if title == "" {
		// Truncate prompt as fallback title.
		runes := []rune(p.Prompt)
		if len(runes) > 48 {
			title = string(runes[:48]) + "…"
		} else {
			title = p.Prompt
		}
	}
	rec := store.Routine{
		ID:              ulid.Make().String(),
		ProjectID:       projectID,
		Cwd:             p.Cwd,
		Agent:           agent,
		Model:           model,
		PermissionMode:  perm,
		Prompt:          p.Prompt,
		IntervalSecs:    intervalSecs,
		Enabled:         enabled,
		NextDueAt:       next,
		CreatedAt:       now,
		Title:           title,
		MissedRunPolicy: policy,
		Lane:            lane,
		Recurrence:      p.Recurrence,
	}
	if err := st.InsertRoutine(ctx, rec); err != nil {
		return store.Routine{}, err
	}
	return rec, nil
}

// FirstRun is the instant a wall-clock rule's next run lands on, in unix ms.
// Create, patch and the console's preview all read a rule through this, so the
// form cannot promise a time the daemon would not use.
func FirstRun(rule *Recurrence, now time.Time) (int64, bool) {
	at, ok := rule.Next(now)
	if !ok {
		return 0, false
	}
	return at.UnixMilli(), true
}
