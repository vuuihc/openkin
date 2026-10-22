package acp

import (
	"encoding/json"
	"fmt"
	"strings"
)

// The Agent Client Protocol, v1 (stable).
//
// Kin speaks it as the *client*: the agent runs as a subprocess of this daemon
// and talks newline-delimited JSON-RPC 2.0 over stdin/stdout. There is no
// official Go SDK, so this is hand-written the same way the MCP server in this
// repository is (ADR 0007: builtin plugins, no third-party protocol runtimes).
//
// Only the v1 subset Kin needs is declared. Method names and payload shapes are
// taken from the protocol schema, not from memory:
// `@agentclientprotocol/sdk/schema/schema.json`. Fields the schema marks
// UNSTABLE (`usage` on a prompt response, the per-session model list) are
// decoded when present but never required.
const (
	jsonRPCVersion = "2.0"
	// protocolVersion is the v1 stable version. v2 is a draft and is
	// deliberately not negotiated (see the design doc §7.1).
	protocolVersion = 1
	// clientName is what the agent sees in its logs as the thing driving it.
	clientName = "kin"
)

// Agent-facing methods (client → agent).
const (
	methodInitialize       = "initialize"
	methodSessionNew       = "session/new"
	methodSessionLoad      = "session/load"
	methodSessionPrompt    = "session/prompt"
	methodSessionCancel    = "session/cancel" // notification, no response
	methodSetConfigOption  = "session/set_config_option"
	methodSessionUpdate    = "session/update" // notification, agent → client
	methodRequestPerm      = "session/request_permission"
	methodMethodNotFound   = -32601
	methodInvalidParams    = -32602
	methodInternalError    = -32603
	configCategoryModel    = "model"
	permissionKindAllowOne = "allow_once"
	permissionKindAllowAll = "allow_always"
	permissionKindReject1  = "reject_once"
	permissionKindRejectAl = "reject_always"
)

// envelope is one JSON-RPC 2.0 message. ID is raw because the protocol allows a
// string or a number and Kin echoes back whatever the agent chose: parse it
// into a Go type and a numeric id the agent sent would come back a string.
type envelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("%d: %s", e.Code, e.Message)
}

// idString renders an id for the pending table, which is keyed by the string
// form Kin itself allocated. Anything else (a number the agent chose, or no id
// at all) is not a response to a request from here.
func (e envelope) idString() string {
	if len(e.ID) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(e.ID, &s); err == nil {
		return s
	}
	return string(e.ID)
}

// isRequest reports whether the agent is asking Kin something and expects an
// answer. A message with a method and an id is a request; with a method and no
// id it is a notification.
func (e envelope) isRequest() bool { return e.Method != "" && len(e.ID) > 0 }

type initializeParams struct {
	ProtocolVersion    int                `json:"protocolVersion"`
	ClientCapabilities clientCapabilities `json:"clientCapabilities"`
	ClientInfo         implementation     `json:"clientInfo"`
}

// clientCapabilities declares what Kin will do for the agent.
//
// Everything is off. Kin implements exactly one reverse method
// (`session/request_permission`); advertising fs or terminal here would invite
// an agent to route its file edits and shell commands through a client that
// would have to answer `method not found`, which is a worse failure than the
// agent using its own tools from the start.
type clientCapabilities struct{}

type implementation struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}

// initializeResult is the agent's half of the handshake.
type initializeResult struct {
	ProtocolVersion   int               `json:"protocolVersion"`
	AgentCapabilities agentCapabilities `json:"agentCapabilities"`
	AgentInfo         *implementation   `json:"agentInfo,omitempty"`
}

type agentCapabilities struct {
	// LoadSession is whether `session/load` is supported. Resuming a task's
	// session on the same machine depends on it.
	LoadSession bool `json:"loadSession"`
}

type newSessionParams struct {
	Cwd        string `json:"cwd"`
	McpServers []any  `json:"mcpServers"`
}

type loadSessionParams struct {
	SessionID  string `json:"sessionId"`
	Cwd        string `json:"cwd"`
	McpServers []any  `json:"mcpServers"`
}

// sessionResult is what `session/new` and `session/load` both answer with.
//
// The schema's `modes` is deliberately not decoded: Kin does not act on a mode
// id, and a session whose only model selector is a mode is reported as "this
// agent does not offer a model setting" rather than silently run on a model the
// user did not choose (see applyModel).
type sessionResult struct {
	SessionID     string              `json:"sessionId"`
	ConfigOptions []sessionConfigItem `json:"configOptions"`
}

// sessionConfigItem is one entry of `configOptions`. Only the fields Kin acts
// on are decoded: the id to send back, and whether this is the model selector.
type sessionConfigItem struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Category      string `json:"category"`
	Type          string `json:"type"`
	CurrentValue  string `json:"currentValue"`
	Description   string `json:"description"`
	SelectOptions []struct {
		Value string `json:"value"`
		Name  string `json:"name"`
	} `json:"options"`
}

// modelConfigID returns the id of the model selector, if the agent offered one.
func (s sessionResult) modelConfigID() string {
	for _, item := range s.ConfigOptions {
		if strings.EqualFold(strings.TrimSpace(item.Category), configCategoryModel) {
			return strings.TrimSpace(item.ID)
		}
	}
	return ""
}

// modelOffered reports whether the model selector lists that value.
//
// Setting a model the agent does not offer would be refused by a strict agent
// and silently ignored by a lax one, and either way the turn would run on a
// model nobody chose (M2.3's lesson: never substitute quietly).
func (s sessionResult) modelOffered(model string) bool {
	for _, item := range s.ConfigOptions {
		if !strings.EqualFold(strings.TrimSpace(item.Category), configCategoryModel) {
			continue
		}
		for _, option := range item.SelectOptions {
			if option.Value == model {
				return true
			}
		}
	}
	return false
}

type setConfigOptionParams struct {
	SessionID string `json:"sessionId"`
	ConfigID  string `json:"configId"`
	Value     string `json:"value"`
}

type promptParams struct {
	SessionID string           `json:"sessionId"`
	Prompt    []map[string]any `json:"prompt"`
}

// promptResult is how a turn ends: the agent answers the `session/prompt`
// request when it is done, so this is the response whose arrival is the result
// event.
type promptResult struct {
	StopReason string       `json:"stopReason"`
	Usage      *promptUsage `json:"usage,omitempty"`
}

// promptUsage is what a prompt response says a turn cost.
//
// Decoded, never booked, and the reason is in the schema itself: the type is
// marked UNSTABLE ("may be removed or changed at any point"), the field on the
// response is documented as "token usage for this turn", and the fields inside
// it are documented as "total input tokens across all turns" and "sum of all
// token types across session". Kin's usage records are deltas, so there is
// nothing here it can honestly add up (see finishTurn).
type promptUsage struct {
	InputTokens       int  `json:"inputTokens"`
	OutputTokens      int  `json:"outputTokens"`
	TotalTokens       int  `json:"totalTokens"`
	ThoughtTokens     *int `json:"thoughtTokens"`
	CachedReadTokens  *int `json:"cachedReadTokens"`
	CachedWriteTokens *int `json:"cachedWriteTokens"`
}

// Stop reasons, from the schema's StopReason enum. `max_tokens` and
// `max_turn_requests` are deliberately not named here: they end a turn with a
// truncated answer, which is still an answer, so they take the path `end_turn`
// takes.
const (
	stopEndTurn    = "end_turn"
	stopRefusal    = "refusal"
	stopCancelled  = "cancelled"
	sessionUpdateK = "sessionUpdate"
)

// sessionNotification is the params of one `session/update`.
type sessionNotification struct {
	SessionID string          `json:"sessionId"`
	Update    json.RawMessage `json:"update"`
}

// permissionRequest is the params of one `session/request_permission`.
type permissionRequest struct {
	SessionID string           `json:"sessionId"`
	ToolCall  json.RawMessage  `json:"toolCall"`
	Options   []permissionItem `json:"options"`
}

type permissionItem struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
}

// permissionResponse is the answer to `session/request_permission`.
//
// The nesting is not a mistake: the response has an `outcome` field whose value
// is itself an object discriminated by `outcome`.
type permissionResponse struct {
	Outcome permissionOutcome `json:"outcome"`
}

type permissionOutcome struct {
	Outcome  string `json:"outcome"`
	OptionID string `json:"optionId,omitempty"`
}

// cancelledOutcome is the answer the protocol requires when a turn is
// cancelled, and the only answer Kin ever gives when it cannot get a real
// decision (design §7.5: never auto-allow).
func cancelledOutcome() permissionResponse {
	return permissionResponse{Outcome: permissionOutcome{Outcome: "cancelled"}}
}

// selectedOutcome picks one of the options the agent actually offered.
//
// An option id Kin made up would be a protocol violation, so a kind with no
// matching option in this request downgrades to `cancelled` rather than
// guessing.
func selectedOutcome(options []permissionItem, kind string) (permissionResponse, bool) {
	if optionID := optionOfKind(options, kind); optionID != "" {
		return permissionResponse{Outcome: permissionOutcome{Outcome: "selected", OptionID: optionID}}, true
	}
	return cancelledOutcome(), false
}

func optionOfKind(options []permissionItem, kind string) string {
	for _, option := range options {
		if option.Kind == kind && strings.TrimSpace(option.OptionID) != "" {
			return option.OptionID
		}
	}
	return ""
}

// hasAllowOption reports whether this request can be approved at all.
//
// An agent that offers only reject options is asking a question whose answer is
// already no; treating it as an approval request would put a button in front of
// a person that cannot change the outcome.
func hasAllowOption(options []permissionItem) bool {
	return optionOfKind(options, permissionKindAllowOne) != "" ||
		optionOfKind(options, permissionKindAllowAll) != ""
}

func requestEnvelope(id, method string, params any) envelope {
	return envelope{JSONRPC: jsonRPCVersion, ID: mustMarshal(id), Method: method, Params: mustMarshal(params)}
}

func notificationEnvelope(method string, params any) envelope {
	return envelope{JSONRPC: jsonRPCVersion, Method: method, Params: mustMarshal(params)}
}

func responseEnvelope(id json.RawMessage, result any) envelope {
	return envelope{JSONRPC: jsonRPCVersion, ID: id, Result: mustMarshal(result)}
}

func errorEnvelope(id json.RawMessage, code int, message string) envelope {
	return envelope{JSONRPC: jsonRPCVersion, ID: id, Error: &rpcError{Code: code, Message: message}}
}

// mustMarshal encodes a payload for the wire. The values here are maps of
// strings and decoded JSON; an encoding failure would be a programming error,
// and the alternative — dropping the message — would leave the agent waiting
// forever for an answer.
func mustMarshal(v any) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`null`)
	}
	return data
}
