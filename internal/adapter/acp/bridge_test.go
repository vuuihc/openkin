package acp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/approvalbridge"
)

// The bridge is where an ACP permission question becomes a Kin approval and the
// answer becomes a protocol outcome. The property that matters most is the one
// §7.5 of the design states as a rule: Kin never invents an allow. Every way of
// not getting an answer has to end in something the agent reads as "not
// permitted".

// allowOnce, allowAlways and rejectOnce are the options a well-behaved agent
// offers; the tests pick subsets of them.
var (
	optAllowOnce   = permissionItem{OptionID: "allow-once", Name: "Allow", Kind: permissionKindAllowOne}
	optAllowAlways = permissionItem{OptionID: "allow-always", Name: "Always", Kind: permissionKindAllowAll}
	optRejectOnce  = permissionItem{OptionID: "reject-once", Name: "Reject", Kind: permissionKindReject1}
)

// writeToolCall is the tool call the fake agent asks about.
const writeToolCall = `{"toolCallId":"call-1","title":"Write file","kind":"edit",
	"status":"pending","rawInput":{"path":"/tmp/x","content":"hi"}}`

// question is one permission request with the given options.
func question(options ...permissionItem) permissionRequest {
	return permissionRequest{
		SessionID: "sess-1",
		ToolCall:  json.RawMessage(writeToolCall),
		Options:   options,
	}
}

// fakeInbox is the daemon this machine runs: it records the question that
// arrived and answers with a decision, or never answers at all.
type fakeInbox struct {
	decision string

	mu      sync.Mutex
	created int
	body    map[string]any
	paths   []string

	server *httptest.Server
}

func newFakeInbox(t *testing.T, decision string) *fakeInbox {
	t.Helper()
	inbox := &fakeInbox{decision: decision}
	inbox.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inbox.mu.Lock()
		inbox.paths = append(inbox.paths, r.Method+" "+r.URL.Path)
		inbox.mu.Unlock()
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/internal/approvals":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("approval body: %v", err)
			}
			inbox.mu.Lock()
			inbox.created++
			inbox.body = body
			inbox.mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "approval-1"})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/wait"):
			if inbox.decision == "" {
				// Nobody ever answers: the wait ends when the turn does.
				<-r.Context().Done()
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"decision": inbox.decision})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(inbox.server.Close)
	return inbox
}

func (f *fakeInbox) asked() (int, map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.created, f.body
}

// bridgeFor builds the bridge one task's run would use.
func bridgeFor(t *testing.T, inbox *fakeInbox) *approvalBridge {
	t.Helper()
	spec := adapter.TaskSpec{
		ID:        "task-1",
		Agent:     "acp",
		Prompt:    "write a file",
		Execution: adapter.ExecutionRef{ID: "exec-1", Agent: "acp", Step: 2, Model: "fast"},
	}
	client := &approvalbridge.Client{}
	if inbox != nil {
		client.DaemonURL = inbox.server.URL
		client.Token = "token-1"
		client.HTTPClient = inbox.server.Client()
	}
	return newApprovalBridge(client, spec)
}

func selected(t *testing.T, response permissionResponse) string {
	t.Helper()
	if response.Outcome.Outcome != "selected" {
		t.Fatalf("outcome = %q, want selected", response.Outcome.Outcome)
	}
	return response.Outcome.OptionID
}

// allowOptionIDs is the set of option ids in a request that mean "yes".
func allowOptionIDs(options []permissionItem) map[string]bool {
	out := map[string]bool{}
	for _, kind := range []string{permissionKindAllowOne, permissionKindAllowAll} {
		if id := optionOfKind(options, kind); id != "" {
			out[id] = true
		}
	}
	return out
}

// assertAnAllowWasEarned is the rule from the design (§7.5) that every path has
// to satisfy: an "allow" answer is only ever the echo of a decision a person
// made. Anything else Kin answers is fine; an invented yes is not.
func assertAnAllowWasEarned(t *testing.T, decision string, options []permissionItem, response permissionResponse) {
	t.Helper()
	if response.Outcome.Outcome != "selected" || !allowOptionIDs(options)[response.Outcome.OptionID] {
		return
	}
	if decision != "approved" {
		t.Fatalf("the agent was told yes on a %q decision: %+v", decision, response.Outcome)
	}
}

func TestAPersonDecidesWhatTheAgentIsTold(t *testing.T) {
	for _, tc := range []struct {
		name     string
		decision string
		options  []permissionItem
		// want is the option id the agent should be told, or "" for any answer
		// that is not an allow.
		want string
	}{
		{
			name:     "approve",
			decision: "approved",
			options:  []permissionItem{optAllowOnce, optAllowAlways, optRejectOnce},
			want:     "allow-once",
		},
		{
			name:     "approve when only always is offered",
			decision: "approved",
			options:  []permissionItem{optAllowAlways, optRejectOnce},
			want:     "allow-always",
		},
		{
			name:     "deny",
			decision: "denied",
			options:  []permissionItem{optAllowOnce, optRejectOnce},
			want:     "reject-once",
		},
		{
			// A person said yes and the agent offered no way to say it. The
			// question was never put to anyone (there is no button that could
			// change the answer), so the agent hears "no" in its own terms.
			name:     "approve with no allow option",
			decision: "approved",
			options:  []permissionItem{optRejectOnce},
			want:     "reject-once",
		},
		{
			name:     "an expiry is not a yes",
			decision: "expired",
			options:  []permissionItem{optAllowOnce},
		},
		{
			// A decision Kin does not recognize must not be read as consent.
			name:     "a word Kin does not know",
			decision: "maybe",
			options:  []permissionItem{optAllowOnce},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inbox := newFakeInbox(t, tc.decision)
			response, recorded := bridgeFor(t, inbox).requestPermission(context.Background(), question(tc.options...))
			// The flag is what tells the adapter whether the engine has already
			// written this question into the transcript. It has to agree with
			// what the inbox actually received.
			if created, _ := inbox.asked(); recorded != (created == 1) {
				t.Fatalf("recorded = %v with %d rows in the inbox", recorded, created)
			}
			assertAnAllowWasEarned(t, tc.decision, tc.options, response)
			if tc.want == "" {
				return
			}
			if got := selected(t, response); got != tc.want {
				t.Fatalf("optionId = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestTheQuestionCarriesWhatAPersonNeedsToDecide: the row in the inbox is the
// only thing a person sees, so the tool, its input and the options the agent
// offered all have to be in it — and the turn it belongs to has to be on it,
// since the inbox is shared by every task on the hub.
func TestTheQuestionCarriesWhatAPersonNeedsToDecide(t *testing.T) {
	inbox := newFakeInbox(t, "approved")
	_, recorded := bridgeFor(t, inbox).requestPermission(context.Background(), question(optAllowOnce, optRejectOnce))

	created, body := inbox.asked()
	if created != 1 {
		t.Fatalf("the inbox got %d questions, want 1", created)
	}
	if !recorded {
		// The row is the engine's to record; the adapter must not say it again.
		t.Fatal("a question that reached the inbox was reported as unrecorded")
	}
	if body["task_id"] != "task-1" || body["kind"] != "tool_use" {
		t.Fatalf("body = %v", body)
	}
	if body["execution_id"] != "exec-1" || body["execution_agent"] != "acp" ||
		body["execution_step"] != float64(2) || body["execution_model"] != "fast" {
		t.Fatalf("the question lost the turn that asked it: %v", body)
	}
	payload, ok := body["payload"].(map[string]any)
	if !ok {
		t.Fatalf("payload = %v", body["payload"])
	}
	if payload["tool_name"] != "Write file" || payload["tool_use_id"] != "call-1" ||
		payload["tool_kind"] != "edit" {
		t.Fatalf("payload = %v", payload)
	}
	input, ok := payload["input"].(map[string]any)
	if !ok || input["path"] != "/tmp/x" {
		t.Fatalf("the tool input a person is approving is missing: %v", payload["input"])
	}
	options, ok := payload["options"].([]any)
	if !ok || len(options) != 2 {
		t.Fatalf("the options are how a denial is read back: %v", payload["options"])
	}
}

// TestNothingIsAskedWhenTheAnswerIsAlreadyNo: a request with no allow option is
// a question whose answer cannot be anything but no. Putting it in the inbox
// would show a person a button that changes nothing.
func TestNothingIsAskedWhenTheAnswerIsAlreadyNo(t *testing.T) {
	for name, options := range map[string][]permissionItem{
		"only rejects":      {optRejectOnce},
		"no options at all": {},
		"an allow Kin cannot name": {
			{OptionID: "", Name: "Allow", Kind: permissionKindAllowOne},
		},
		"a kind Kin does not know": {
			{OptionID: "go", Name: "Go", Kind: "allow_this_time"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			inbox := newFakeInbox(t, "approved")
			response, recorded := bridgeFor(t, inbox).requestPermission(context.Background(), question(options...))
			if created, _ := inbox.asked(); created != 0 {
				t.Fatalf("a person was asked a question with one possible answer (%d rows)", created)
			}
			if recorded {
				// No row exists, so no engine event does: the adapter's own event
				// is the only trace of a question Kin answered on its own.
				t.Fatal("a question nobody was asked was reported as recorded")
			}
			assertAnAllowWasEarned(t, "approved", options, response)
		})
	}
}

// TestAnUnansweredQuestionIsNotAPermission covers the ways Kin fails to get a
// decision. Each one has to reach the agent as `cancelled`, which is the only
// outcome the protocol defines for "no answer".
func TestAnUnansweredQuestionIsNotAPermission(t *testing.T) {
	t.Run("a turn that is cancelled while the question is open", func(t *testing.T) {
		inbox := newFakeInbox(t, "")
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			time.Sleep(20 * time.Millisecond)
			cancel()
		}()
		response, recorded := bridgeFor(t, inbox).requestPermission(ctx, question(optAllowOnce, optRejectOnce))
		if response.Outcome.Outcome != "cancelled" {
			t.Fatalf("outcome = %+v, want cancelled", response.Outcome)
		}
		if _, body := inbox.asked(); body == nil {
			t.Fatal("the question never reached the inbox")
		} else if !recorded {
			// The row outlives the wait: it is in the inbox (and in the
			// transcript) whether or not an answer ever came back.
			t.Fatal("a question with a row was reported as unrecorded")
		}
	})

	t.Run("a daemon that cannot open a question", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "nope", http.StatusInternalServerError)
		}))
		t.Cleanup(server.Close)
		client := &approvalbridge.Client{DaemonURL: server.URL, Token: "token-1", HTTPClient: server.Client()}
		bridge := newApprovalBridge(client, adapter.TaskSpec{ID: "task-1"})
		response, recorded := bridge.requestPermission(context.Background(), question(optAllowOnce))
		if response.Outcome.Outcome != "cancelled" {
			t.Fatalf("outcome = %+v, want cancelled", response.Outcome)
		}
		if recorded {
			t.Fatal("a question that was never created was reported as recorded")
		}
	})

	t.Run("no daemon configured", func(t *testing.T) {
		for name, bridge := range map[string]*approvalBridge{
			"nil bridge":     nil,
			"no client":      {client: &approvalbridge.Client{}},
			"no token":       newApprovalBridge(&approvalbridge.Client{DaemonURL: "http://127.0.0.1:1"}, adapter.TaskSpec{}),
			"nothing at all": {},
		} {
			t.Run(name, func(t *testing.T) {
				response, recorded := bridge.requestPermission(context.Background(), question(optAllowOnce, optRejectOnce))
				if response.Outcome.Outcome != "cancelled" {
					t.Fatalf("outcome = %+v, want cancelled", response.Outcome)
				}
				if recorded {
					t.Fatal("a question with no inbox behind it was reported as recorded")
				}
			})
		}
	})
}
