package task

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

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
