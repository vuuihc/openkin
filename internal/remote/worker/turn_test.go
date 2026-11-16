package worker

import (
	"encoding/json"
	"fmt"
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

func TestTurnResumeValidation(t *testing.T) {
	// An empty list is a real answer: it is how a machine that reconnected with
	// nothing tells the Hub to stop holding its old turns.
	if err := (TurnResume{}).Validate(); err != nil {
		t.Fatalf("an empty resume was refused: %v", err)
	}
	if err := (TurnResume{TurnIDs: []string{"turn-1", "turn-2"}}).Validate(); err != nil {
		t.Fatalf("Validate() = %v", err)
	}
	if err := (TurnResume{TurnIDs: []string{""}}).Validate(); err == nil {
		t.Fatal("a resume with an empty turn id was accepted")
	}
	if err := (TurnResume{TurnIDs: []string{"turn-1", "turn-1"}}).Validate(); err == nil {
		t.Fatal("a resume that lists one turn twice was accepted")
	}
	tooMany := make([]string, MaxResumeTurns+1)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("turn-%d", i)
	}
	if err := (TurnResume{TurnIDs: tooMany}).Validate(); err == nil {
		t.Fatal("a resume past the bound was accepted")
	}
}

// A dispatch can name the files its prompt refers to without carrying them:
// the Node fetches those from the Hub it already has a credential for.
func TestDispatchAttachments(t *testing.T) {
	prompt := "look\n\nAttached image:\n- shot.png: /state/uploads/ab12.png"
	good := Attachment{Path: "/state/uploads/ab12.png", Stored: "ab12.png"}

	dispatch := validDispatch()
	dispatch.Prompt = prompt
	dispatch.Attachments = []Attachment{good}
	if err := dispatch.Validate(); err != nil {
		t.Fatalf("Validate() = %v", err)
	}
	// The frame has to carry it, not just the struct.
	frame, err := NewFrame("turn.dispatch", dispatch)
	if err != nil {
		t.Fatal(err)
	}
	back := Dispatch{}
	if err := json.Unmarshal(frame.Data, &back); err != nil {
		t.Fatal(err)
	}
	if len(back.Attachments) != 1 || back.Attachments[0] != good {
		t.Fatalf("attachments after the wire = %#v", back.Attachments)
	}

	cases := []struct {
		name    string
		mutate  func(*Dispatch)
		wantErr string
	}{
		{
			name:    "path is not in the prompt",
			mutate:  func(d *Dispatch) { d.Attachments[0].Path = "/state/uploads/other.png" },
			wantErr: "does not appear in the prompt",
		},
		{
			name: "same path twice",
			mutate: func(d *Dispatch) {
				d.Attachments = append(d.Attachments, d.Attachments[0])
			},
			wantErr: "listed twice",
		},
		{
			name:    "name with a separator",
			mutate:  func(d *Dispatch) { d.Attachments[0].Stored = "../../kin.db" },
			wantErr: "single safe path element",
		},
		{
			name:    "empty path",
			mutate:  func(d *Dispatch) { d.Attachments[0].Path = "" },
			wantErr: "path is required",
		},
		{
			name:    "control character in path",
			mutate:  func(d *Dispatch) { d.Attachments[0].Path = "/state/uploads/a\nb.png" },
			wantErr: "control character",
		},
		{
			name:    "path past the bound",
			mutate:  func(d *Dispatch) { d.Attachments[0].Path = "/" + strings.Repeat("a", MaxAttachmentPath) },
			wantErr: "exceeds",
		},
		{
			name: "more than a dispatch can carry",
			mutate: func(d *Dispatch) {
				d.Attachments = make([]Attachment, MaxAttachments+1)
				for i := range d.Attachments {
					d.Attachments[i] = Attachment{Path: "/state/uploads/f.png", Stored: "f.png"}
				}
			},
			wantErr: "more than",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := validDispatch()
			d.Prompt = prompt
			d.Attachments = []Attachment{good}
			tc.mutate(&d)
			err := d.Validate()
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("Validate() = %v, want %q", err, tc.wantErr)
			}
		})
	}
}
