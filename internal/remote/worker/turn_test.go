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
