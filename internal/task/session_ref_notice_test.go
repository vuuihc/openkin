package task

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/store"
)

// noticesIn returns the notice events a task has, as decoded payloads.
func noticesIn(t *testing.T, st *store.Store, taskID string) []map[string]any {
	t.Helper()
	evs, err := st.ListEvents(context.Background(), taskID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, ev := range evs {
		if ev.Type != "notice" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(ev.Payload, &m); err != nil {
			t.Fatalf("notice payload is not an object: %v", err)
		}
		out = append(out, m)
	}
	return out
}

// foreignRefEngine builds a task whose native session ref was minted on another
// machine, which is the state the whole slice is about.
func foreignRefEngine(t *testing.T) (*Engine, *store.Store, store.Task) {
	t.Helper()
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	e.SetRemoteRunner("this-machine", nil)

	row := store.Task{
		ID:                 "01TESTNOTICEFOREIGN000000000",
		Title:              "started elsewhere",
		Agent:              "claude-code",
		Cwd:                "/tmp",
		Prompt:             "first",
		Status:             StatusSucceeded,
		CreatedAt:          store.NowMilli(),
		SessionRef:         strPtr("other-session"),
		SessionRefDeviceID: strPtr("other-machine"),
	}
	if err := st.InsertTask(ctx, row); err != nil {
		t.Fatal(err)
	}
	return e, st, row
}

// A cross-device rebuild is announced in the transcript.
//
// The agent is told by the context pack it receives. The person is told here:
// the answer they get is written by an agent that was handed a summary rather
// than the conversation, and a reader who is not told that cannot tell the
// difference between "it forgot" and "it disagreed".
func TestACrossDeviceRebuildIsAnnouncedInTheTranscript(t *testing.T) {
	ctx := context.Background()
	e, st, row := foreignRefEngine(t)
	// A paired machine that has said hello, so the sentence can name it.
	if err := st.RecordDeviceHello(ctx, "other-machine", store.Device{
		Label: "studio", Platform: "darwin", Role: "node",
	}, nil, store.NowMilli()); err != nil {
		t.Fatal(err)
	}

	if _, err := e.FollowUpWith(ctx, row.ID, FollowUpRequest{Prompt: "second"}); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, row.ID, StatusSucceeded, 2*time.Second)

	notices := noticesIn(t, st, row.ID)
	if len(notices) != 1 {
		t.Fatalf("got %d notices, want 1: %+v", len(notices), notices)
	}
	n := notices[0]
	// The console renders title and message joined as one status line and knows
	// only the severities it has a glyph for; an opaque payload renders as
	// nothing at all, which is the silence this replaces.
	title, _ := n["title"].(string)
	message, _ := n["message"].(string)
	if strings.TrimSpace(title) == "" || strings.TrimSpace(message) == "" {
		t.Fatalf("notice has nothing to render: %+v", n)
	}
	if severity, _ := n["severity"].(string); severity != "info" {
		t.Fatalf("severity = %q, want info: nothing has gone wrong", severity)
	}
	if !strings.Contains(message, "studio") {
		t.Fatalf("the notice does not say which machine: %q", message)
	}
	if n["session_ref_device_id"] != "other-machine" {
		t.Fatalf("the notice does not carry the raw origin: %+v", n)
	}
}

// The same refusal on the create path, and the reason the sentence is written
// where the ref is refused rather than where the pack is built.
//
// A task created with a session attached from another machine has nothing to
// rebuild from, so it takes no pack and never enters that branch. It is still
// the same thing happening to the same person: the session they attached is not
// the one this turn continues.
func TestAnAttachedForeignRefIsAnnouncedOnTheFirstTurn(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	e.SetRemoteRunner("this-machine", nil)

	created, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "carry on",
		SessionRef: "other-session", SessionRefDeviceID: "other-machine",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 2*time.Second)

	ad.mu.Lock()
	spec := ad.lastSpec
	ad.mu.Unlock()
	if spec.SessionRef != "" {
		t.Fatalf("the adapter was handed %q from another machine", spec.SessionRef)
	}
	notices := noticesIn(t, st, created.ID)
	if len(notices) != 1 {
		t.Fatalf("got %d notices, want 1: %+v", len(notices), notices)
	}
	message, _ := notices[0]["message"].(string)
	if !strings.Contains(message, "other-machine") {
		t.Fatalf("the notice names no machine: %q", message)
	}
	// This task is brand new, so there is no Kin transcript and the agent got
	// nothing but the prompt above. A sentence saying Kin continued from its own
	// transcript would name a mechanism that never ran, which is the kind of
	// quiet untruth this slice exists to remove.
	if strings.Contains(message, "transcript") {
		t.Fatalf("the notice claims a transcript this task never had: %q", message)
	}
}

// A row can hold a ref that is present and blank. Nothing enforces a non-empty
// external ref at the store, so a catalog row with an empty one attaches as
// exactly that. It is not a session, and saying a session started on another
// machine would be a statement about something that does not exist.
func TestABlankRefIsNotAnnounced(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	e.SetRemoteRunner("this-machine", nil)

	row := store.Task{
		ID:                 "01TESTNOTICEBLANK0000000000",
		Title:              "attached nothing",
		Agent:              "claude-code",
		Cwd:                "/tmp",
		Prompt:             "first",
		Status:             StatusSucceeded,
		CreatedAt:          store.NowMilli(),
		SessionRef:         strPtr("   "),
		SessionRefDeviceID: strPtr("other-machine"),
	}
	if err := st.InsertTask(ctx, row); err != nil {
		t.Fatal(err)
	}
	got, err := e.Get(ctx, row.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.SessionRef == nil {
		t.Fatal("fixture is wrong: the ref did not survive the round trip")
	}

	if _, err := e.FollowUpWith(ctx, row.ID, FollowUpRequest{Prompt: "second"}); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, row.ID, StatusSucceeded, 2*time.Second)

	if notices := noticesIn(t, st, row.ID); len(notices) != 0 {
		t.Fatalf("a task with no session was announced as resuming one: %+v", notices)
	}
}

// The control. A notice on every turn is not an announcement, it is noise, and
// it would pass every assertion above.
func TestAnOrdinaryResumeSaysNothing(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	e.SetRemoteRunner("this-machine", nil)

	created, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 2*time.Second)

	if _, err := e.FollowUpWith(ctx, created.ID, FollowUpRequest{Prompt: "second"}); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 2*time.Second)

	if notices := noticesIn(t, st, created.ID); len(notices) != 0 {
		t.Fatalf("a resume that worked was announced anyway: %+v", notices)
	}
}

// A machine the Hub has never heard from still gets named. The id is opaque but
// it is not wrong, and "somewhere else" is not an answer to "where".
func TestTheAnnouncementFallsBackToTheDeviceID(t *testing.T) {
	ctx := context.Background()
	e, st, row := foreignRefEngine(t)

	if _, err := e.FollowUpWith(ctx, row.ID, FollowUpRequest{Prompt: "second"}); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, row.ID, StatusSucceeded, 2*time.Second)

	notices := noticesIn(t, st, row.ID)
	if len(notices) != 1 {
		t.Fatalf("got %d notices, want 1", len(notices))
	}
	message, _ := notices[0]["message"].(string)
	if !strings.Contains(message, "other-machine") {
		t.Fatalf("the notice names no machine: %q", message)
	}
}

// fakeSessionHooks is an agent that keeps Kin's own transcript. Reset is the
// only thing the interface asks for, and the engine calls it when it rebuilds a
// sealed context pack instead of resuming.
type fakeSessionHooks struct {
	mu     sync.Mutex
	resets int
}

func (h *fakeSessionHooks) Reset(context.Context, string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.resets++
	return nil
}

// managedTranscriptEngine is an engine whose agent keeps its own transcript,
// which is the kind the notice was wrong about: its continuity does not run
// through the native session ref at all.
func managedTranscriptEngine(t *testing.T, hooks agent.SessionHooks) (*Engine, *store.Store, *fakeAdapter) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ad := &fakeAdapter{events: successEvents()}
	reg, err := agent.NewRegistry(agent.Entry{
		ID: "kin", Name: "Kin", Kind: agent.KindCLI,
		Caps:   []agent.Capability{agent.CapabilityRun, agent.CapabilityResume},
		Runner: ad, Sessions: hooks,
	})
	if err != nil {
		t.Fatal(err)
	}
	e := NewEngine(st, reg, NewBus(), 1)
	t.Cleanup(e.Close)
	if err := e.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	return e, st, ad
}

// An agent that keeps its own transcript is not told its session was refused.
//
// The sentence this suppresses is a claim about this machine — "this machine
// cannot resume it" — and for an agent whose continuity runs through Kin's
// transcript rather than through the ref, it is false in both directions:
// nothing refused the ref, and the conversation does survive the move. Firing
// anyway reports a refusal that did not happen, on the one kind of agent whose
// continuity is not in the ref, and a person reading it goes looking for a
// context that was dropped when nothing was.
//
// The ref is withheld from the adapter either way, which is asserted beside it:
// the two decisions are separate, and the notice is the only one this test is
// about.
func TestAManagedTranscriptAgentIsNotToldItsSessionWasRefused(t *testing.T) {
	ctx := context.Background()
	hooks := &fakeSessionHooks{}
	e, st, ad := managedTranscriptEngine(t, hooks)
	e.SetRemoteRunner("this-machine", nil)

	created, err := e.Create(ctx, CreateRequest{
		Agent: "kin", Cwd: "/tmp", Prompt: "carry on",
		SessionRef: "other-session", SessionRefDeviceID: "other-machine",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 2*time.Second)
	// Both paths to the gate, because the notice is written where every turn
	// exits and the two arrive there differently: a first turn with a session
	// attached from elsewhere, and a follow-up that rebuilds a context pack out
	// of Kin's own transcript.
	if _, err := e.FollowUpWith(ctx, created.ID, FollowUpRequest{Prompt: "second"}); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 2*time.Second)

	if notices := noticesIn(t, st, created.ID); len(notices) != 0 {
		t.Fatalf("an agent that keeps its own transcript was told its session was refused: %+v", notices)
	}
	ad.mu.Lock()
	specs := append([]adapter.TaskSpec(nil), ad.specs...)
	started := ad.started
	ad.mu.Unlock()
	// Every turn, not the last one: the second turn mints a session of its own
	// and legitimately resumes that, so looking only at the end would miss the
	// hand-over this is about.
	for i, spec := range specs {
		if spec.SessionRef == "other-session" {
			t.Fatalf("turn %d handed the adapter %q, a ref another machine's agent minted", i+1, spec.SessionRef)
		}
	}
	// The turns really ran, and the second one really rebuilt rather than
	// resumed: without this the test passes for the reason it is meant to
	// exclude — a turn that failed before it could have said anything.
	if started != 2 {
		t.Fatalf("the adapter ran %d turns, want 2", started)
	}
	hooks.mu.Lock()
	resets := hooks.resets
	hooks.mu.Unlock()
	if resets == 0 {
		t.Fatal("no context pack was rebuilt on the follow-up, so the ref was not actually refused there")
	}
}

// The control for the test above, and the reason the predicate may not simply
// answer "managed" for everything: the same engine, the same foreign ref, an
// agent of the other kind — and the person is told.
func TestAnAgentWhoseContinuityIsTheRefIsStillTold(t *testing.T) {
	ctx := context.Background()
	e, st, _ := managedTranscriptEngine(t, nil)
	e.SetRemoteRunner("this-machine", nil)

	created, err := e.Create(ctx, CreateRequest{
		Agent: "kin", Cwd: "/tmp", Prompt: "carry on",
		SessionRef: "other-session", SessionRefDeviceID: "other-machine",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 2*time.Second)

	if notices := noticesIn(t, st, created.ID); len(notices) != 1 {
		t.Fatalf("got %d notices, want 1: %+v", len(notices), notices)
	}
}

// The predicate itself, which is where the two tests above get their answer.
//
// An agent this daemon cannot classify answers true, and that direction is
// deliberate: the turn fails a few lines later with a sentence about the unknown
// agent, and suppressing a refusal because its agent could not be looked up is
// the wrong way to be quiet.
func TestResumeUsesNativeRefIsAboutWhetherTheAgentKeepsItsOwnTranscript(t *testing.T) {
	managed, _, _ := managedTranscriptEngine(t, &fakeSessionHooks{})
	plain, _ := testEngine(t, 4, &fakeAdapter{events: successEvents()})

	cases := []struct {
		name  string
		on    *Engine
		agent string
		want  bool
	}{
		{name: "an agent with a managed transcript", on: managed, agent: "kin", want: false},
		{name: "an agent without one", on: plain, agent: "claude-code", want: true},
		{name: "an agent this daemon does not know", on: managed, agent: "nobody", want: true},
		{name: "an engine with no registry at all", on: &Engine{}, agent: "kin", want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.on.resumeUsesNativeRef(tc.agent); got != tc.want {
				t.Fatalf("resumeUsesNativeRef(%q) = %v, want %v", tc.agent, got, tc.want)
			}
		})
	}
}
