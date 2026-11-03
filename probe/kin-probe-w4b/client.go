package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxErrorBody = 512

// APIError is a non-2xx response. It never contains request credentials.
type APIError struct {
	Method string
	Path   string
	Status int
	Body   string
}

func (e *APIError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("%s %s: HTTP %d", e.Method, e.Path, e.Status)
	}
	return fmt.Sprintf("%s %s: HTTP %d: %s", e.Method, e.Path, e.Status, e.Body)
}

// Client speaks the documented daemon HTTP contract with one credential.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *Client) WithToken(token string) *Client {
	return &Client{baseURL: c.baseURL, token: token, http: c.http}
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	return c.doHeaders(ctx, method, path, query, body, out, nil)
}

func (c *Client) doHeaders(ctx context.Context, method, path string, query url.Values, body, out any, headers map[string]string) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("%s %s: encode request: %w", method, path, err)
		}
		rdr = bytes.NewReader(b)
	}
	u := c.baseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return fmt.Errorf("%s %s: read response: %w", method, path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{Method: method, Path: path, Status: resp.StatusCode, Body: truncate(strings.TrimSpace(string(data)), maxErrorBody)}
	}
	if out != nil {
		if len(bytes.TrimSpace(data)) == 0 {
			return fmt.Errorf("%s %s: empty response body, want JSON", method, path)
		}
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("%s %s: decode response: %w (body %.200s)", method, path, err, data)
		}
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ---- pairing ----

type PairingSession struct {
	Secret    string `json:"secret"`
	ExpiresAt int64  `json:"expires_at"`
}

type PairingExchange struct {
	DeviceID    string `json:"device_id"`
	Token       string `json:"token"`
	Label       string `json:"label"`
	DesktopID   string `json:"desktop_id"`
	DesktopName string `json:"desktop_name"`
}

func (c *Client) CreatePairingSession(ctx context.Context, label string) (PairingSession, error) {
	var out PairingSession
	err := c.do(ctx, http.MethodPost, "/api/pairing/sessions", nil, map[string]string{"label": label}, &out)
	if err != nil {
		return out, err
	}
	if out.Secret == "" {
		return out, fmt.Errorf("pairing session response has no secret")
	}
	return out, nil
}

func (c *Client) ExchangePairingSecret(ctx context.Context, secret, label string) (PairingExchange, error) {
	return c.exchange(ctx, secret, label, false)
}

// ExchangePairingSecretRecovery repeats an exchange whose response was lost.
// The daemon answers 200 with the same credential instead of consuming a
// second pairing, within five minutes of the successful exchange.
func (c *Client) ExchangePairingSecretRecovery(ctx context.Context, secret, label string) (PairingExchange, error) {
	return c.exchange(ctx, secret, label, true)
}

func (c *Client) exchange(ctx context.Context, secret, label string, recovery bool) (PairingExchange, error) {
	var out PairingExchange
	req := map[string]string{"secret": secret, "label": label}
	var headers map[string]string
	if recovery {
		headers = map[string]string{"X-Kin-Pairing-Recovery": "1"}
	}
	err := c.doHeaders(ctx, http.MethodPost, "/api/pairing/exchange", nil, req, &out, headers)
	if err != nil {
		return out, err
	}
	if out.DeviceID == "" || out.Token == "" {
		return out, fmt.Errorf("pairing exchange response missing device_id or token")
	}
	return out, nil
}

// ---- devices ----

type Device struct {
	ID             string            `json:"id"`
	Label          string            `json:"label"`
	Platform       string            `json:"platform"`
	Arch           string            `json:"arch"`
	Role           string            `json:"role"`
	KinVersion     string            `json:"kin_version"`
	Reachability   string            `json:"reachability"`
	LastSeenAt     int64             `json:"last_seen_at"`
	CreatedAt      int64             `json:"created_at"`
	RevokedAt      int64             `json:"revoked_at"`
	Agents         []json.RawMessage `json:"agents"`
	WorkspaceRoots []string          `json:"workspace_roots"`
}

func (c *Client) Devices(ctx context.Context) ([]Device, error) {
	var out []Device
	err := c.do(ctx, http.MethodGet, "/api/devices", nil, nil, &out)
	return out, err
}

func (c *Client) RevokeDevice(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/api/devices/"+url.PathEscape(id)+"/revoke", nil, nil, nil)
}

// ---- session feed ----

type ChangePage struct {
	Sessions   []Task   `json:"sessions"`
	Deleted    []string `json:"deleted"`
	NextCursor int64    `json:"next_cursor"`
	HasMore    bool     `json:"has_more"`
}

func (c *Client) Cursor(ctx context.Context) (int64, error) {
	var out struct {
		Cursor int64 `json:"cursor"`
	}
	err := c.do(ctx, http.MethodGet, "/api/sessions/cursor", nil, nil, &out)
	return out.Cursor, err
}

// ChangePage reads one page of the global change feed. A nil since omits
// updated_since, which starts from the beginning of the history.
func (c *Client) ChangePage(ctx context.Context, since *int64, limit int) (ChangePage, error) {
	q := url.Values{}
	if since != nil {
		q.Set("updated_since", fmt.Sprintf("%d", *since))
	}
	if limit > 0 {
		q.Set("limit", fmt.Sprintf("%d", limit))
	}
	var out ChangePage
	err := c.do(ctx, http.MethodGet, "/api/sessions", q, nil, &out)
	return out, err
}

// ---- tasks ----

type Task struct {
	ID             string  `json:"id"`
	Title          string  `json:"title"`
	Agent          string  `json:"agent"`
	Cwd            string  `json:"cwd"`
	Prompt         string  `json:"prompt"`
	Model          *string `json:"model"`
	PermissionMode string  `json:"permission_mode"`
	Status         string  `json:"status"`
	ExitCode       *int    `json:"exit_code"`
	TokensIn       int64   `json:"tokens_in"`
	TokensOut      int64   `json:"tokens_out"`
	CreatedAt      int64   `json:"created_at"`
	StartedAt      *int64  `json:"started_at"`
	FinishedAt     *int64  `json:"finished_at"`
	WorkspaceMode  string  `json:"workspace_mode"`
	EventEpoch     int64   `json:"event_epoch"`
	HubSeq         *int64  `json:"hub_seq"`
	ArchivedAt     int64   `json:"archived_at"`
}

func (t Task) Terminal() bool {
	switch t.Status {
	case "succeeded", "failed", "canceled":
		return true
	}
	return false
}

type CreateTaskRequest struct {
	Agent          string `json:"agent,omitempty"`
	Cwd            string `json:"cwd"`
	Prompt         string `json:"prompt"`
	Model          string `json:"model,omitempty"`
	Title          string `json:"title,omitempty"`
	PermissionMode string `json:"permission_mode,omitempty"`
	WorkspaceMode  string `json:"workspace_mode,omitempty"`
}

func (c *Client) CreateTask(ctx context.Context, req CreateTaskRequest) (Task, error) {
	var out Task
	err := c.do(ctx, http.MethodPost, "/api/tasks", nil, req, &out)
	return out, err
}

func (c *Client) GetTask(ctx context.Context, id string) (Task, error) {
	var out Task
	err := c.do(ctx, http.MethodGet, "/api/tasks/"+url.PathEscape(id), nil, nil, &out)
	return out, err
}

func (c *Client) PromptTask(ctx context.Context, id, prompt string) (Task, error) {
	var out Task
	err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(id)+"/prompt", nil, map[string]string{"prompt": prompt}, &out)
	return out, err
}

func (c *Client) DeleteTask(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/tasks/"+url.PathEscape(id), nil, nil, nil)
}

func (c *Client) CancelTask(ctx context.Context, id string) (Task, error) {
	var out Task
	err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(id)+"/cancel", nil, nil, &out)
	return out, err
}

// ---- task events ----

type TaskEvent struct {
	TaskID     string           `json:"task_id"`
	EventEpoch int64            `json:"event_epoch"`
	Seq        int64            `json:"seq"`
	Ts         int64            `json:"ts"`
	Type       string           `json:"type"`
	Payload    TaskEventPayload `json:"payload"`
}

type TaskEventPayload struct {
	Partial     *bool           `json:"partial"`
	Text        string          `json:"text"`
	Role        string          `json:"role"`
	Speaker     string          `json:"speaker"`
	Source      string          `json:"source"`
	MessageID   string          `json:"message_id"`
	Status      string          `json:"status"`
	Kind        string          `json:"kind"`
	ApprovalID  string          `json:"approval_id"`
	QuestionID  string          `json:"question_id"`
	Decision    string          `json:"decision"`
	Interrupted bool            `json:"interrupted"`
	ToolName    string          `json:"tool_name"`
	Name        string          `json:"name"`
	Input       json.RawMessage `json:"input"`
	Output      string          `json:"output"`
	OK          bool            `json:"ok"`
	Content     json.RawMessage `json:"content"`
}

func (c *Client) TaskEvents(ctx context.Context, id string, sinceSeq int64) ([]TaskEvent, error) {
	q := url.Values{}
	q.Set("since_seq", fmt.Sprintf("%d", sinceSeq))
	var out []TaskEvent
	err := c.do(ctx, http.MethodGet, "/api/tasks/"+url.PathEscape(id)+"/events", q, nil, &out)
	return out, err
}

// ---- approvals ----

type Approval struct {
	ID         string `json:"id"`
	TaskID     string `json:"task_id"`
	Kind       string `json:"kind"`
	Decision   string `json:"decision"`
	CreatedAt  int64  `json:"created_at"`
	DecidedAt  *int64 `json:"decided_at"`
	DecidedVia string `json:"decided_via"`
	TaskTitle  string `json:"task_title"`
	TaskAgent  string `json:"task_agent"`
}

func (c *Client) Approvals(ctx context.Context, status string) ([]Approval, error) {
	q := url.Values{}
	if status != "" {
		q.Set("status", status)
	}
	var out []Approval
	err := c.do(ctx, http.MethodGet, "/api/approvals", q, nil, &out)
	return out, err
}

func (c *Client) DecideApproval(ctx context.Context, id, decision string) (Approval, error) {
	var out Approval
	err := c.do(ctx, http.MethodPost, "/api/approvals/"+url.PathEscape(id)+"/decision", nil, map[string]string{"decision": decision}, &out)
	return out, err
}

// ---- websocket-bus message envelope (shared with the SSE data line) ----

type wsMessage struct {
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
}
