package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/mcp"
	"github.com/vuuihc/openkin/internal/task"
)

// TestAMembersMCPCreateTaskIsBoundWhereItRuns covers the second way into the
// engine, and the one a member can actually walk through.
//
// MCP is not a holder-only surface: the session cookie a browser carries is
// accepted on /mcp like on every other authenticated route, a user principal is
// given read and write scopes, and create_task needs write. Its arguments take
// an executing_device_id. So the only thing between a member and an unbounded
// working directory through this door is the engine guard -- which is the whole
// reason that guard lives in the engine rather than in the REST handler.
//
// The server is wired the way internal/server wires it, device check included,
// so a refusal here is the engine's and not a validator's that a later change
// could move.
//
// Both refusals are the same shape and the same status; only the sentence says
// which rule applied, so each case asserts on the sentence.
func TestAMembersMCPCreateTaskIsBoundWhereItRuns(t *testing.T) {
	const hubDevice = "desktop-hub-1"
	s, _, code := newAuthTestServer(t)
	// The two ids that decide "is this another machine": the desktop id the
	// device check compares against, and the engine's own. internal/server sets
	// both from identity.ID.
	s.DesktopID = hubDevice
	s.Engine.SetRemoteRunner(hubDevice, nil)
	s.MCP = &mcp.Server{
		Store: s.Store, Engine: s.Engine, Version: "test",
		ValidateCreate: func(ctx context.Context, req *task.CreateRequest) error {
			if req == nil {
				return errors.New("create request is required")
			}
			if req.Agent == "" {
				req.Agent = s.Engine.DefaultAgentContext(ctx)
			}
			if err := ValidateTaskCreateRequest(ctx, *req); err != nil {
				return err
			}
			return ValidateExecutingDevice(ctx, s.Store, s.DesktopID, req.ExecutingDeviceID)
		},
	}

	owner := &authClient{t: t, h: s.Handler()}
	claimOwner(t, owner, code)

	// A machine the holder paired. It is the holder's own machine, which is what
	// makes a member naming it worth refusing rather than obeying.
	var pairing pairingSessionResponse
	if err := json.Unmarshal(owner.post("/api/pairing/sessions",
		`{"label":"another machine"}`).Body.Bytes(), &pairing); err != nil {
		t.Fatalf("decode pairing session: %v", err)
	}
	if pairing.Secret == "" {
		t.Fatal("the holder did not get a pairing secret")
	}
	anon := &authClient{t: t, h: s.Handler()}
	paired := anon.post("/api/pairing/exchange", `{"secret":"`+pairing.Secret+`"}`)
	if paired.Code != http.StatusCreated {
		t.Fatalf("pairing exchange: %d %s", paired.Code, paired.Body.String())
	}
	var exchanged pairingExchangeResponse
	if err := json.Unmarshal(paired.Body.Bytes(), &exchanged); err != nil {
		t.Fatalf("decode pairing exchange: %v", err)
	}
	if exchanged.DeviceID == "" {
		t.Fatal("pairing produced no device id to name")
	}

	member := joinedMember(t, s, invite(t, owner), "mcp-bound@example.com")
	holderHome := t.TempDir()
	project := registerProject(t, s, "mcp-bound-project")

	// call runs one create_task on the member's own session cookie and returns
	// the refusal, or "" when the call was accepted.
	//
	// Each call carries its own idempotency key. They are the same request from
	// the tool's point of view, and a repeated key would be answered from the
	// first one's outcome instead of being put to the engine again.
	attempt := 0
	call := func(cwd, device string) string {
		t.Helper()
		if member.cookie == nil {
			t.Fatal("the member has no session cookie")
		}
		attempt++
		args := `{"agent":"claude-code","prompt":"look around","cwd":"` + cwd + `"`
		args += `,"idempotency_key":"mcp-bound-` + strconv.Itoa(attempt) + `"`
		if device != "" {
			args += `,"executing_device_id":"` + device + `"`
		}
		args += `}`
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":` +
			`{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"},` +
			`"name":"create_task","arguments":` + args + `}}`
		req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("MCP-Protocol-Version", "2026-07-28")
		req.AddCookie(member.cookie)
		rec := httptest.NewRecorder()
		member.h.ServeHTTP(rec, req)
		var answer struct {
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &answer); err != nil {
			t.Fatalf("decode the answer to create_task: %v (%s)", err, rec.Body.String())
		}
		if answer.Error == nil {
			return ""
		}
		return answer.Error.Message
	}

	// The move this test exists for: a member naming the holder's other machine.
	// The device rule decides it, and it does so wherever the directory is --
	// which the last case shows by naming a registered project and being refused
	// all the same.
	if got := call(holderHome, exchanged.DeviceID); !strings.Contains(got, "holds this machine") {
		t.Fatalf("a member named the holder's machine over MCP and the device rule is not what refused it: %q", got)
	}
	if got := call(project, exchanged.DeviceID); !strings.Contains(got, "holds this machine") {
		t.Fatalf("naming a machine was not refused for a registered project: %q", got)
	}
	// And with no machine named, the cwd bound is what holds -- so the two rules
	// are both live here rather than one standing in for the other.
	if got := call(holderHome, ""); !strings.Contains(got, "not inside a project") {
		t.Fatalf("the cwd bound is not what refused the member's MCP task: %q", got)
	}
}

func TestPublicMCPRouteUsesDaemonAuth(t *testing.T) {
	s, token := newTestServer(t)
	s.MCP = &mcp.Server{
		Store:   s.Store,
		Engine:  s.Engine,
		Version: "test",
	}
	handler := s.Handler()

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Kin-MCP-Client", "test-client")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"name":"openkin"`) {
		t.Fatalf("body=%s", rec.Body.String())
	}
	session := rec.Header().Get("MCP-Session-Id")
	if session == "" {
		t.Fatal("initialize did not return MCP session")
	}

	req = httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("uninitialized status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2024-11-05"}}}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("MCP-Session-Id", session)
	req.Header.Set("MCP-Protocol-Version", "2024-11-05")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("initialized status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestPublicMCPStateless2026Transport(t *testing.T) {
	s, token := newTestServer(t)
	s.MCP = &mcp.Server{Store: s.Store, Engine: s.Engine, Version: "test"}
	handler := s.Handler()

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28"}}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("MCP-Protocol-Version", "2026-07-28")
	req.Header.Set("Mcp-Method", "initialize")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("MCP-Session-Id") != "" {
		t.Fatalf("initialize status=%d session=%q body=%s", rec.Code, rec.Header().Get("MCP-Session-Id"), rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("MCP-Protocol-Version", "2026-07-28")
	req.Header.Set("Mcp-Method", "tools/list")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("tools/list status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestPublicMCPStateless2026AcceptsStandardHeaders(t *testing.T) {
	s, token := newTestServer(t)
	s.MCP = &mcp.Server{Store: s.Store, Engine: s.Engine, Version: "test"}
	handler := s.Handler()

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("MCP-Protocol-Version", "2026-07-28")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("standard 2026 status=%d body=%s", rec.Code, rec.Body.String())
	}
}
