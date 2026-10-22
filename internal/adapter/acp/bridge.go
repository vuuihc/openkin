package acp

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/approvalbridge"
)

// approvalBridge turns an ACP permission request into a Kin approval and back.
//
// This is the one place where the protocol's blocking, connection-local
// question becomes the product's queued, auditable, cross-device one: the agent
// waits here while the question sits in the Hub's inbox, possibly in front of a
// person on another machine entirely.
type approvalBridge struct {
	client    *approvalbridge.Client
	taskID    string
	execution approvalbridge.Execution
}

func newApprovalBridge(client *approvalbridge.Client, spec adapter.TaskSpec) *approvalBridge {
	return &approvalBridge{
		client: client,
		taskID: spec.ID,
		execution: approvalbridge.Execution{
			ID:    spec.Execution.ID,
			Agent: spec.Execution.Agent,
			Step:  spec.Execution.Step,
			Model: spec.Execution.Model,
		},
	}
}

// requestPermission asks a person, and answers the agent in the protocol's
// terms.
//
// Every way of not getting an answer converges on `cancelled`: no bridge, a
// failed create, a failed wait, a decision that is not an approval, a turn that
// was cancelled while the question was open. The protocol permits a client to
// auto-decide; Kin does not, and the one outcome it must never invent is
// `selected` with an allow option (design §7.5).
//
// The second result says whether the question reached an inbox. A question that
// did has a row and an `approval_requested` event the engine writes itself
// (internal/task), so a caller that recorded one of its own would put the same
// question in the transcript twice — the copy arriving, worse, only after the
// person had already answered it.
func (b *approvalBridge) requestPermission(ctx context.Context, request permissionRequest) (permissionResponse, bool) {
	options := request.Options
	if len(options) == 0 {
		return cancelledOutcome(), false
	}
	// A request with no allow option is a question whose answer is already no.
	// Putting it in front of a person would be showing them a button that
	// cannot change anything.
	if !hasAllowOption(options) {
		if response, ok := selectedOutcome(options, permissionKindReject1); ok {
			return response, false
		}
		return cancelledOutcome(), false
	}
	if b == nil || b.client == nil || b.client.DaemonURL == "" || b.client.Token == "" {
		return cancelledOutcome(), false
	}

	id, err := b.client.CreateApproval(ctx, b.taskID, "tool_use", b.payload(request), b.execution)
	if err != nil {
		return cancelledOutcome(), false
	}
	decision, err := b.client.WaitApproval(ctx, id)
	if err != nil {
		return cancelledOutcome(), true
	}
	switch decision {
	case "approved":
		if response, ok := selectedOutcome(options, permissionKindAllowOne); ok {
			return response, true
		}
		if response, ok := selectedOutcome(options, permissionKindAllowAll); ok {
			return response, true
		}
		// The decision was yes and the agent offered no way to say yes.
		return cancelledOutcome(), true
	case "denied":
		if response, ok := selectedOutcome(options, permissionKindReject1); ok {
			return response, true
		}
		if response, ok := selectedOutcome(options, permissionKindRejectAl); ok {
			return response, true
		}
		return cancelledOutcome(), true
	default:
		// `expired` and anything else: the question outlived its answer.
		return cancelledOutcome(), true
	}
}

// payload is what the approval card shows: the same shape the CLI adapters put
// in the inbox, plus the options the agent offered, so a decision that is not
// simply yes or no can be read back later.
func (b *approvalBridge) payload(request permissionRequest) json.RawMessage {
	var call toolCall
	_ = json.Unmarshal(request.ToolCall, &call)

	payload := map[string]any{
		"tool_name":   toolName(call),
		"tool_use_id": call.ToolCallID,
		"options":     request.Options,
	}
	if len(call.RawInput) > 0 && string(call.RawInput) != "null" {
		payload["input"] = call.RawInput
	} else if len(request.ToolCall) > 0 {
		payload["input"] = request.ToolCall
	}
	if kind := strings.TrimSpace(call.Kind); kind != "" {
		payload["tool_kind"] = kind
	}
	return mustMarshal(payload)
}
