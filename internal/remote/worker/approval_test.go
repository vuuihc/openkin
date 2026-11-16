package worker

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestApprovalFrameBoundsAreEnforcedOnBothEnds pins the sizes an approval frame
// is allowed to be. Every one of these is checked by the receiver and, since a
// frame the receiver rejects is a question the sender silently loses, by the
// sender too: a payload the wire will not carry has to be refused where an agent
// can still be told why.
func TestApprovalFrameBoundsAreEnforcedOnBothEnds(t *testing.T) {
	long := func(n int) string { return strings.Repeat("x", n) }

	for _, tc := range []struct {
		name    string
		request ApprovalRequest
		wantErr bool
	}{
		{
			name:    "the shape a device sends",
			request: ApprovalRequest{RequestID: "req-1", TurnID: "turn-1", Kind: "tool_use"},
		},
		{
			name: "a payload at the limit",
			request: ApprovalRequest{RequestID: "req-1", TurnID: "turn-1",
				Payload: json.RawMessage(`"` + long(MaxApprovalPayload-2) + `"`)},
		},
		{
			name: "a payload past the limit",
			request: ApprovalRequest{RequestID: "req-1", TurnID: "turn-1",
				Payload: json.RawMessage(`"` + long(MaxApprovalPayload) + `"`)},
			wantErr: true,
		},
		{
			name:    "no request id",
			request: ApprovalRequest{TurnID: "turn-1"},
			wantErr: true,
		},
		{
			name:    "a request id past the limit",
			request: ApprovalRequest{RequestID: long(MaxApprovalID + 1), TurnID: "turn-1"},
			wantErr: true,
		},
		{
			name:    "no turn",
			request: ApprovalRequest{RequestID: "req-1"},
			wantErr: true,
		},
		{
			name:    "a kind past the limit",
			request: ApprovalRequest{RequestID: "req-1", TurnID: "turn-1", Kind: long(MaxApprovalKind + 1)},
			wantErr: true,
		},
		{
			name:    "an agent past the limit",
			request: ApprovalRequest{RequestID: "req-1", TurnID: "turn-1", Agent: long(MaxApprovalAgent + 1)},
			wantErr: true,
		},
		{
			name:    "a model past the limit",
			request: ApprovalRequest{RequestID: "req-1", TurnID: "turn-1", Model: long(MaxApprovalModel + 1)},
			wantErr: true,
		},
		{
			name:    "a negative step",
			request: ApprovalRequest{RequestID: "req-1", TurnID: "turn-1", Step: -1},
			wantErr: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.request.Validate()
			if tc.wantErr && err == nil {
				t.Fatal("a frame the wire cannot carry was accepted")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("a valid frame was refused: %v", err)
			}
		})
	}
}

// TestAnApprovalStatusIsEitherAnAnswerOrARefusal keeps the two halves of the
// Hub's reply from arriving at once: a device reading "accepted" and a reason it
// was not accepted in the same frame has no way to choose between them.
func TestAnApprovalStatusIsEitherAnAnswerOrARefusal(t *testing.T) {
	long := func(n int) string { return strings.Repeat("x", n) }

	for _, tc := range []struct {
		name    string
		status  ApprovalStatus
		wantErr bool
	}{
		{name: "accepted", status: ApprovalStatus{RequestID: "req-1", ApprovalID: "apr-1"}},
		{name: "refused", status: ApprovalStatus{RequestID: "req-1", Error: "not this turn"}},
		{name: "neither", status: ApprovalStatus{RequestID: "req-1"}, wantErr: true},
		{
			name:    "both",
			status:  ApprovalStatus{RequestID: "req-1", ApprovalID: "apr-1", Error: "no"},
			wantErr: true,
		},
		{
			name:    "a reason past the limit",
			status:  ApprovalStatus{RequestID: "req-1", Error: long(MaxApprovalError + 1)},
			wantErr: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.status.Validate()
			if tc.wantErr && err == nil {
				t.Fatal("a status the device cannot read was accepted")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("a valid status was refused: %v", err)
			}
		})
	}
}

// TestADecisionIsOneOfThreeWords pins the vocabulary against the store's: the
// Hub sends what the store recorded, and anything else is a frame this device
// would have to guess at.
func TestADecisionIsOneOfThreeWords(t *testing.T) {
	for _, decision := range []string{ApprovalApproved, ApprovalDenied, ApprovalExpired} {
		if err := (ApprovalDecision{RequestID: "req-1", Decision: decision}).Validate(); err != nil {
			t.Fatalf("%q was refused: %v", decision, err)
		}
	}
	for _, decision := range []string{"", "pending", "maybe"} {
		if err := (ApprovalDecision{RequestID: "req-1", Decision: decision}).Validate(); err == nil {
			t.Fatalf("%q was accepted as a decision", decision)
		}
	}
}
