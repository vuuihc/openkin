// Package approvemcp implements the stdio MCP server for Claude Code's
// --permission-prompt-tool (spec §4.2). No MCP SDK: JSON-RPC 2.0 over
// newline-delimited JSON on stdin/stdout.
package approvemcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Env vars (set by per-task MCP config).
const (
	EnvTaskID = "KIN_TASK_ID"
	EnvDaemon = "KIN_DAEMON"
	EnvToken  = "KIN_TOKEN"
)

// Run is the `kin approve-mcp` entrypoint. Logs protocol traffic to stderr only.
func Run(ctx context.Context) error {
	taskID := os.Getenv(EnvTaskID)
	daemon := strings.TrimRight(os.Getenv(EnvDaemon), "/")
	token := os.Getenv(EnvToken)
	if taskID == "" || daemon == "" || token == "" {
		return fmt.Errorf("approve-mcp requires %s, %s, %s", EnvTaskID, EnvDaemon, EnvToken)
	}

	client := &http.Client{Timeout: 0} // long-polls managed per-request
	s := &server{
		taskID: taskID,
		daemon: daemon,
		token:  token,
		client: client,
		in:     os.Stdin,
		out:    os.Stdout,
		err:    os.Stderr,
	}
	return s.loop(ctx)
}

type server struct {
	taskID string
	daemon string
	token  string
	client *http.Client
	in     io.Reader
	out    io.Writer
	err    io.Writer
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *server) logf(format string, args ...any) {
	fmt.Fprintf(s.err, "kin approve-mcp: "+format+"\n", args...)
}

func (s *server) loop(ctx context.Context) error {
	sc := bufio.NewScanner(s.in)
	// Large tool inputs (file contents, diffs).
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)

	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		s.logf("<< %s", truncate(line, 500))

		var req rpcRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			s.logf("invalid json: %v", err)
			continue
		}

		// Notifications have no id — handle and do not reply.
		if len(req.ID) == 0 || string(req.ID) == "null" {
			s.handleNotification(req)
			continue
		}

		resp := s.handle(ctx, req)
		if err := s.write(resp); err != nil {
			return err
		}
	}
	return sc.Err()
}

func (s *server) handleNotification(req rpcRequest) {
	switch req.Method {
	case "notifications/initialized", "initialized":
		// ignore
	default:
		s.logf("ignore notification %s", req.Method)
	}
}

func (s *server) handle(ctx context.Context, req rpcRequest) rpcResponse {
	switch req.Method {
	case "initialize":
		return s.handleInitialize(req)
	case "tools/list":
		return s.handleToolsList(req)
	case "tools/call":
		return s.handleToolsCall(ctx, req)
	case "ping":
		return rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{}}
	default:
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32601, Message: "method not found: " + req.Method},
		}
	}
}

func (s *server) handleInitialize(req rpcRequest) rpcResponse {
	protocolVersion := "2024-11-05"
	var params struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(req.Params, &params)
	if params.ProtocolVersion != "" {
		protocolVersion = params.ProtocolVersion
	}
	return rpcResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result: map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities": map[string]any{
				"tools": map[string]any{},
			},
			"serverInfo": map[string]any{
				"name":    "kin",
				"version": "0.0.0-dev",
			},
		},
	}
}

func (s *server) handleToolsList(req rpcRequest) rpcResponse {
	return rpcResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result: map[string]any{
			"tools": []map[string]any{
				{
					"name":        "approve",
					"description": "Request permission from the Kin console for a tool use",
					"inputSchema": map[string]any{
						"type":                 "object",
						"additionalProperties": true,
					},
				},
			},
		},
	}
}

func (s *server) handleToolsCall(ctx context.Context, req rpcRequest) rpcResponse {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return rpcErr(req.ID, -32602, "invalid params: "+err.Error())
	}
	if params.Name != "approve" {
		return rpcErr(req.ID, -32602, "unknown tool: "+params.Name)
	}
	if len(params.Arguments) == 0 {
		params.Arguments = json.RawMessage(`{}`)
	}

	// POST /internal/approvals
	approvalID, err := s.postApproval(ctx, params.Arguments)
	if err != nil {
		s.logf("post approval: %v", err)
		// Fail closed: deny so the agent does not hang forever.
		// Distinct message from a human deny so operators can tell
		// "bridge/task_id broken" from "user tapped Deny".
		return toolResult(req.ID, denyJSONMsg("approval request failed: "+err.Error()))
	}

	// Long-poll until decided.
	decision, err := s.waitDecision(ctx, approvalID)
	if err != nil {
		s.logf("wait decision: %v", err)
		return toolResult(req.ID, denyJSONMsg("approval wait failed: "+err.Error()))
	}

	switch decision {
	case "approved":
		return toolResult(req.ID, allowJSON(params.Arguments))
	default:
		// denied, expired, or anything else → deny
		return toolResult(req.ID, denyJSON())
	}
}

func (s *server) postApproval(ctx context.Context, payload json.RawMessage) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"task_id": s.taskID,
		"kind":    "tool_use",
		"payload": json.RawMessage(payload),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.daemon+"/internal/approvals", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", "application/json")

	// Bound the POST itself (not the wait).
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req = req.WithContext(cctx)

	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("POST /internal/approvals: %s: %s", resp.Status, truncate(string(data), 200))
	}
	var a struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(data, &a); err != nil {
		return "", err
	}
	if a.ID == "" {
		return "", fmt.Errorf("empty approval id")
	}
	s.logf("created approval %s", a.ID)
	return a.ID, nil
}

func (s *server) waitDecision(ctx context.Context, id string) (string, error) {
	for {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		url := fmt.Sprintf("%s/internal/approvals/%s/wait?timeout=30", s.daemon, id)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("Authorization", "Bearer "+s.token)

		// Allow slightly more than server timeout.
		cctx, cancel := context.WithTimeout(ctx, 35*time.Second)
		req = req.WithContext(cctx)
		resp, err := s.client.Do(req)
		cancel()
		if err != nil {
			// Transient network error: brief pause then retry.
			s.logf("wait poll error: %v", err)
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(time.Second):
				continue
			}
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return "", fmt.Errorf("wait: %s: %s", resp.Status, truncate(string(data), 200))
		}
		var a struct {
			Decision string `json:"decision"`
		}
		if err := json.Unmarshal(data, &a); err != nil {
			return "", err
		}
		if a.Decision == "" || a.Decision == "pending" {
			// Timed out still pending — poll again.
			continue
		}
		s.logf("decision %s for %s", a.Decision, id)
		return a.Decision, nil
	}
}

func (s *server) write(resp rpcResponse) error {
	data, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	s.logf(">> %s", truncate(string(data), 500))
	_, err = s.out.Write(append(data, '\n'))
	return err
}

func toolResult(id json.RawMessage, text string) rpcResponse {
	return rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result: map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": text},
			},
		},
	}
}

func rpcErr(id json.RawMessage, code int, msg string) rpcResponse {
	return rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &rpcError{Code: code, Message: msg},
	}
}

// allowJSON builds Claude Code's expected permission response.
// updatedInput is the tool's input object when present in arguments, else the whole arguments.
func allowJSON(arguments json.RawMessage) string {
	updated := extractUpdatedInput(arguments)
	b, _ := json.Marshal(map[string]any{
		"behavior":     "allow",
		"updatedInput": updated,
	})
	return string(b)
}

func denyJSON() string {
	return denyJSONMsg("denied via Kin console")
}

func denyJSONMsg(message string) string {
	if message == "" {
		message = "denied via Kin console"
	}
	b, _ := json.Marshal(map[string]any{
		"behavior": "deny",
		"message":  message,
	})
	return string(b)
}

func extractUpdatedInput(arguments json.RawMessage) any {
	var m map[string]any
	if err := json.Unmarshal(arguments, &m); err != nil {
		return json.RawMessage(arguments)
	}
	// Claude Code permission tool shapes observed:
	//   {tool_name, input, tool_use_id}
	//   {tool_name, tool_input}
	//   {input: {...}}
	// updatedInput must be the tool's own input object.
	for _, key := range []string{"input", "tool_input", "toolInput", "arguments"} {
		if inp, ok := m[key]; ok {
			return inp
		}
	}
	return m
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
