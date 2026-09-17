package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/mcp"
)

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
