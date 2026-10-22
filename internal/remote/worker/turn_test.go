package worker

import (
	"encoding/json"
	"strings"
	"testing"
)

func validDispatch() Dispatch {
	return Dispatch{
		TurnID:         "turn-1",
		TaskID:         "task-1",
		Agent:          "claude-code",
		Cwd:            "/code/kin",
		Prompt:         "fix the failing test",
		PermissionMode: "default",
	}
}

func TestDispatchValidation(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*Dispatch)
		wantErr string
	}{
		{name: "valid"},
		{name: "no turn id", mutate: func(d *Dispatch) { d.TurnID = "  " }, wantErr: "turn_id is required"},
		{name: "no task id", mutate: func(d *Dispatch) { d.TaskID = "" }, wantErr: "task_id is required"},
		{name: "no agent", mutate: func(d *Dispatch) { d.Agent = "" }, wantErr: "agent is required"},
		{name: "no prompt", mutate: func(d *Dispatch) { d.Prompt = "   " }, wantErr: "no prompt"},
		{name: "huge prompt", mutate: func(d *Dispatch) { d.Prompt = strings.Repeat("x", MaxPrompt+1) }, wantErr: "exceeds"},
		{name: "huge model", mutate: func(d *Dispatch) { d.Model = strings.Repeat("m", MaxAgentID+1) }, wantErr: "model exceeds"},
		{name: "huge session ref", mutate: func(d *Dispatch) { d.SessionRef = strings.Repeat("s", MaxSessionRef+1) }, wantErr: "session_ref exceeds"},
		{name: "huge cwd", mutate: func(d *Dispatch) { d.Cwd = strings.Repeat("c", MaxCwd+1) }, wantErr: "cwd exceeds"},
		{name: "resume without cwd is fine", mutate: func(d *Dispatch) { d.Cwd = ""; d.SessionRef = "abc" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dispatch := validDispatch()
			if tc.mutate != nil {
				tc.mutate(&dispatch)
			}
			err := dispatch.Validate()
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("Validate() = %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate() accepted %+v", dispatch)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("Validate() = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestTurnEventValidation(t *testing.T) {
	valid := TurnEvent{TurnID: "turn-1", Seq: 1, Event: json.RawMessage(`{"type":"message"}`)}
	if err := valid.Validate(); err != nil {
		t.Fatalf("Validate() = %v", err)
	}
	for _, tc := range []struct {
		name    string
		event   TurnEvent
		wantErr string
	}{
		{name: "no turn", event: TurnEvent{Seq: 1, Event: valid.Event}, wantErr: "turn_id is required"},
		{name: "seq zero", event: TurnEvent{TurnID: "t", Seq: 0, Event: valid.Event}, wantErr: "out of range"},
		{name: "seq negative", event: TurnEvent{TurnID: "t", Seq: -1, Event: valid.Event}, wantErr: "out of range"},
		{name: "seq absurd", event: TurnEvent{TurnID: "t", Seq: MaxTurnSeq + 1, Event: valid.Event}, wantErr: "out of range"},
		{name: "no payload", event: TurnEvent{TurnID: "t", Seq: 1}, wantErr: "no payload"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.event.Validate()
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("Validate() = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestTurnStartedValidation(t *testing.T) {
	if err := (TurnStarted{TurnID: "turn-1"}).Validate(); err != nil {
		t.Fatalf("Validate() = %v", err)
	}
	if err := (TurnStarted{}).Validate(); err == nil {
		t.Fatal("a start ack with no turn was accepted")
	}
}

func TestTurnFinishValidation(t *testing.T) {
	for _, status := range []string{TurnOK, TurnError, TurnCanceled} {
		if err := (TurnFinish{TurnID: "t", Status: status}).Validate(); err != nil {
			t.Errorf("status %q: %v", status, err)
		}
	}
	if err := (TurnFinish{TurnID: "t", Status: "finished"}).Validate(); err == nil {
		t.Fatal("an unknown status was accepted")
	}
	if err := (TurnFinish{TurnID: "", Status: TurnOK}).Validate(); err == nil {
		t.Fatal("a finish with no turn was accepted")
	}
}

func TestTurnFramesRoundTrip(t *testing.T) {
	// Every frame a turn needs has to survive the envelope, or the two halves of
	// the protocol disagree about what is on the wire.
	for _, tc := range []struct {
		kind    string
		payload any
	}{
		{kind: "turn.dispatch", payload: validDispatch()},
		{kind: "turn.event", payload: TurnEvent{TurnID: "turn-1", Seq: 2, Event: json.RawMessage(`{"type":"result"}`)}},
		// The ack that tells the Hub the dispatch arrived. A frame kind that is
		// never registered is a frame that can never be built, and the sender can
		// only warn: the Node would look connected and the Hub would end the turn
		// for never starting it.
		{kind: "turn.started", payload: TurnStarted{TurnID: "turn-1"}},
		{kind: "turn.finish", payload: TurnFinish{TurnID: "turn-1", Status: TurnError, Error: "boom"}},
		{kind: "turn.cancel", payload: TurnCancel{TurnID: "turn-1", Reason: "user stopped it"}},
	} {
		frame, err := NewFrame(tc.kind, tc.payload)
		if err != nil {
			t.Fatalf("%s: %v", tc.kind, err)
		}
		if err := frame.Validate(); err != nil {
			t.Fatalf("%s: %v", tc.kind, err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(frame.Data, &decoded); err != nil {
			t.Fatalf("%s: %v", tc.kind, err)
		}
		if len(decoded) == 0 {
			t.Fatalf("%s encoded to nothing", tc.kind)
		}
	}

	// The kinds that nothing ever sent are gone, so a stale Node cannot look
	// like it is speaking the protocol.
	for _, kind := range []string{"assignment", "event", "cancel", "task_event"} {
		if _, err := NewFrame(kind, map[string]string{}); err == nil {
			t.Errorf("frame kind %q is still accepted", kind)
		}
	}
}
