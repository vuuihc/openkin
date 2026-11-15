package store

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentSessionMetadataRoundTripAndBindingProjection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kin.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	task := Task{
		ID:        "task-session-binding",
		Title:     "session host",
		Agent:     "kin",
		Cwd:       "/tmp/project",
		Prompt:    "continue",
		Status:    "succeeded",
		CreatedAt: NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	row, err := st.UpsertAgentSession(ctx, AgentSession{
		AgentID:       "codex",
		ExternalRef:   "codex-1",
		SourceURI:     "file:///tmp/codex-1.jsonl",
		Title:         "hello",
		Cwd:           "/tmp/project",
		Status:        "idle",
		Capabilities:  []string{"session_history_read"},
		Metadata:      map[string]string{"format": "codex"},
		SourceCursor:  "rev-1",
		ContentDigest: "digest-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if row.ID == "" || row.SourceURI == "" || row.Metadata["format"] != "codex" {
		t.Fatalf("row=%+v", row)
	}

	updated, err := st.UpsertAgentSession(ctx, AgentSession{
		AgentID:      "codex",
		ExternalRef:  "codex-1",
		Title:        "renamed",
		Cwd:          "/tmp/project",
		Status:       "active",
		SourceCursor: "rev-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.ID != row.ID || updated.Title != "renamed" || updated.Status != "active" {
		t.Fatalf("updated=%+v", updated)
	}

	binding, err := st.InsertTaskAgentSession(ctx, TaskAgentSession{
		TaskID:         task.ID,
		AgentSessionID: row.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if binding.State != "attached" || binding.Role != "host" {
		t.Fatalf("binding=%+v", binding)
	}

	linked := true
	rows, err := st.ListAgentSessions(ctx, AgentSessionListOpts{Linked: &linked, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || !rows[0].Linked || rows[0].ID != row.ID {
		t.Fatalf("linked rows=%+v", rows)
	}
	bindings, err := st.ListTaskAgentSessions(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(bindings) != 1 || bindings[0].AgentSession == nil {
		t.Fatalf("bindings=%+v", bindings)
	}

	_, err = st.InsertTaskAgentSession(ctx, TaskAgentSession{
		ID:             "second-binding",
		TaskID:         task.ID,
		AgentSessionID: row.ID,
	})
	if err == nil || !strings.Contains(err.Error(), "UNIQUE") {
		t.Fatalf("duplicate active binding error=%v", err)
	}
	if err := st.DetachTaskAgentSessions(ctx, task.ID, "handoff"); err != nil {
		t.Fatal(err)
	}
	detached, err := st.GetAgentSession(ctx, "", "codex", "codex-1")
	if err != nil {
		t.Fatal(err)
	}
	if detached.Linked {
		t.Fatalf("session remains linked after detach: %+v", detached)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	got, err := reopened.GetAgentSession(ctx, "", "codex", "codex-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != row.ID || got.Linked {
		t.Fatalf("reopened=%+v", got)
	}
}

func TestNormalizeAutoImportMode(t *testing.T) {
	tests := []struct {
		input string
		want  string
		ok    bool
	}{
		{input: "", want: AutoImportPrompt, ok: true},
		{input: " ENABLED ", want: AutoImportEnabled, ok: true},
		{input: AutoImportDisabled, want: AutoImportDisabled, ok: true},
		{input: "always", ok: false},
	}
	for _, tt := range tests {
		got, err := NormalizeAutoImportMode(tt.input)
		if (err == nil) != tt.ok {
			t.Fatalf("input=%q err=%v, ok=%v", tt.input, err, tt.ok)
		}
		if tt.ok && got != tt.want {
			t.Fatalf("input=%q got=%q want=%q", tt.input, got, tt.want)
		}
	}
}

func TestAgentSessionMigrationFrom31PreservesTasks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kin.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	task := Task{
		ID:        "task-before-session-migration",
		Title:     "preserve me",
		Agent:     "codex",
		Cwd:       "/tmp/project",
		Prompt:    "hello",
		Status:    "succeeded",
		CreatedAt: NowMilli(),
	}
	if err := st.InsertTask(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB().Exec(`
		DROP TABLE task_agent_sessions;
		DROP TABLE agent_sessions;
		PRAGMA user_version = 31;
	`); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	got, err := reopened.GetTask(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != task.Title {
		t.Fatalf("task after migration=%+v", got)
	}
	for _, table := range []string{"agent_sessions", "task_agent_sessions"} {
		var name string
		if err := reopened.DB().QueryRow(
			`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table,
		).Scan(&name); err != nil {
			t.Fatalf("table %s after migration: %v", table, err)
		}
	}
}

func TestCrossProviderHandoffKeepsNamespacedMetadataOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kin.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	task := Task{
		ID:        "task-cross-provider",
		Title:     "cross provider",
		Agent:     "claude-code",
		Cwd:       "/tmp/project",
		Prompt:    "continue",
		Status:    "running",
		CreatedAt: NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	claude, err := st.UpsertAgentSession(ctx, AgentSession{
		AgentID: "claude-code", ExternalRef: "shared-ref",
		SourceURI: "file:///tmp/claude.jsonl", Cwd: task.Cwd,
		Title: "Claude source", Capabilities: []string{"session_history_read"},
	})
	if err != nil {
		t.Fatal(err)
	}
	droid, err := st.UpsertAgentSession(ctx, AgentSession{
		AgentID: "droid", ExternalRef: "shared-ref",
		SourceURI: "file:///tmp/droid.jsonl", Cwd: task.Cwd,
		Title: "Droid source", Capabilities: []string{"session_history_read"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if claude.ID == droid.ID || claude.AgentID == droid.AgentID {
		t.Fatalf("provider namespace collapsed: claude=%+v droid=%+v", claude, droid)
	}
	first, err := st.InsertTaskAgentSession(ctx, TaskAgentSession{
		TaskID: task.ID, AgentSessionID: claude.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DetachTaskAgentSessions(ctx, task.ID, "handoff to droid"); err != nil {
		t.Fatal(err)
	}
	second, err := st.InsertTaskAgentSession(ctx, TaskAgentSession{
		TaskID: task.ID, AgentSessionID: droid.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	bindings, err := st.ListTaskAgentSessions(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(bindings) != 2 {
		t.Fatalf("handoff bindings=%+v", bindings)
	}
	seenFirst, seenSecond := false, false
	for _, binding := range bindings {
		if binding.AgentSession == nil || binding.AgentSession.ContentDigest != "" {
			t.Fatalf("binding copied provider content: %+v", binding)
		}
		seenFirst = seenFirst || binding.ID == first.ID
		seenSecond = seenSecond || binding.ID == second.ID
	}
	if !seenFirst || !seenSecond {
		t.Fatalf("handoff binding ids missing: %+v", bindings)
	}
}

// The same ref on two machines is two sessions, not one row overwritten: each
// machine's agent issues its own ids (ADR 0022 D7).
func TestAgentSessionIdentityIncludesTheMachine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kin.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()

	laptop, err := st.UpsertAgentSession(ctx, AgentSession{
		DeviceID: "laptop", AgentID: "claude-code", ExternalRef: "session-1",
		Title: "on the laptop", Cwd: "/code/openkin",
	})
	if err != nil {
		t.Fatal(err)
	}
	studio, err := st.UpsertAgentSession(ctx, AgentSession{
		DeviceID: "studio", AgentID: "claude-code", ExternalRef: "session-1",
		Title: "on the studio", Cwd: "/srv/openkin",
	})
	if err != nil {
		t.Fatal(err)
	}
	if laptop.ID == studio.ID {
		t.Fatalf("two machines collapsed into one session row: %+v", laptop)
	}

	// Re-reporting one machine's session updates that row and only that row.
	again, err := st.UpsertAgentSession(ctx, AgentSession{
		DeviceID: "laptop", AgentID: "claude-code", ExternalRef: "session-1",
		Title: "renamed on the laptop",
	})
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != laptop.ID || again.Title != "renamed on the laptop" {
		t.Fatalf("second report of the laptop session=%+v", again)
	}
	untouched, err := st.GetAgentSession(ctx, "studio", "claude-code", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	if untouched.Title != "on the studio" {
		t.Fatalf("the studio session was overwritten: %+v", untouched)
	}
	// A machine's own ref is not visible under another machine's name.
	if _, err := st.GetAgentSession(ctx, "nas", "claude-code", "session-1"); err == nil {
		t.Fatal("a ref resolved on a machine that never reported it")
	}

	rows, err := st.ListAgentSessions(ctx, AgentSessionListOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].DeviceID == "" || rows[1].DeviceID == "" {
		t.Fatalf("listed sessions=%+v", rows)
	}
}

// Rows written before a session's identity named a machine belong to the
// database's owner, and adopting them must not touch rows that already name one.
func TestAdoptUnownedAgentSessions(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	if _, err := s.UpsertAgentSession(ctx, AgentSession{
		AgentID: "codex", ExternalRef: "old", DeviceID: "",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertAgentSession(ctx, AgentSession{
		AgentID: "codex", ExternalRef: "remote", DeviceID: "studio",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.AdoptUnownedAgentSessions(ctx, "laptop"); err != nil {
		t.Fatal(err)
	}
	if err := s.AdoptUnownedAgentSessions(ctx, "laptop"); err != nil {
		t.Fatal(err)
	}
	adopted, err := s.GetAgentSession(ctx, "laptop", "codex", "old")
	if err != nil {
		t.Fatalf("unowned row was not adopted: %v", err)
	}
	if adopted.DeviceID != "laptop" {
		t.Fatalf("adopted row=%+v", adopted)
	}
	other, err := s.GetAgentSession(ctx, "studio", "codex", "remote")
	if err != nil || other.DeviceID != "studio" {
		t.Fatalf("a row naming another machine was rewritten: %+v err=%v", other, err)
	}
	// Without a device to adopt into, nothing is claimed.
	if err := s.AdoptUnownedAgentSessions(ctx, "  "); err != nil {
		t.Fatal(err)
	}
}
