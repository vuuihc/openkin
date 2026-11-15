// kin-probe is an independent OpenKin client written against the public
// contract only: api/openapi.yaml, docs/adr/0022, docs/adr/0024 and README.md.
// It exists to measure how far that contract carries a developer who has not
// read the server or the first-party UI.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// APIError carries a non-2xx response.
type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("HTTP %d: %s", e.Status, e.Body)
}

// Client is a bearer-authenticated OpenKin HTTP client.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		HTTP:    &http.Client{Timeout: 90 * time.Second},
	}
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil {
		return err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &APIError{Status: resp.StatusCode, Body: truncate(strings.TrimSpace(string(data)), 400)}
	}
	if out != nil && len(bytes.TrimSpace(data)) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("%s %s: decode response: %w", method, path, err)
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

// ---- contract types (only the fields this probe consumes) ----

type Task struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Agent      string `json:"agent"`
	Cwd        string `json:"cwd"`
	Prompt     string `json:"prompt"`
	Status     string `json:"status"`
	TokensIn   int64  `json:"tokens_in"`
	TokensOut  int64  `json:"tokens_out"`
	CreatedAt  int64  `json:"created_at"`
	FinishedAt *int64 `json:"finished_at"`
	HubSeq     *int64 `json:"hub_seq"`
	EventEpoch int64  `json:"event_epoch"`
}

type SessionPage struct {
	Sessions   []Task   `json:"sessions"`
	Deleted    []string `json:"deleted"`
	NextCursor int64    `json:"next_cursor"`
	HasMore    bool     `json:"has_more"`
}

type CursorResponse struct {
	Cursor int64 `json:"cursor"`
}

type TaskEvent struct {
	TaskID     string          `json:"task_id"`
	EventEpoch int64           `json:"event_epoch"`
	Seq        int64           `json:"seq"`
	Ts         int64           `json:"ts"`
	Type       string          `json:"type"`
	Payload    json.RawMessage `json:"payload"`
}

// MessagePayload is the observed shape of a `message` event payload. The
// contract declares `payload: {}` with no schema, so this was reconstructed
// from the wire.
type MessagePayload struct {
	Role    string `json:"role"`
	Partial bool   `json:"partial"`
	Index   *int   `json:"index"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

type Approval struct {
	ID         string          `json:"id"`
	TaskID     string          `json:"task_id"`
	Kind       string          `json:"kind"`
	Decision   string          `json:"decision"`
	DecidedVia *string         `json:"decided_via"`
	CreatedAt  int64           `json:"created_at"`
	DecidedAt  *int64          `json:"decided_at"`
	Payload    json.RawMessage `json:"payload"`
}

type PairingSessionResponse struct {
	Secret    string `json:"secret"`
	ExpiresAt int64  `json:"expires_at"`
}

type PairingExchangeResponse struct {
	DeviceID    string `json:"device_id"`
	Token       string `json:"token"`
	Label       string `json:"label"`
	DesktopID   string `json:"desktop_id"`
	DesktopName string `json:"desktop_name"`
}

// ---- endpoints ----

func (c *Client) Cursor(ctx context.Context) (int64, error) {
	var out CursorResponse
	err := c.do(ctx, http.MethodGet, "/api/sessions/cursor", nil, &out)
	return out.Cursor, err
}

// SessionPage reads one page of the global change feed. since == 0 walks from
// the beginning, which the contract calls the snapshot path.
func (c *Client) SessionPage(ctx context.Context, since int64, limit int) (*SessionPage, error) {
	q := url.Values{}
	q.Set("updated_since", strconv.FormatInt(since, 10))
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var out SessionPage
	err := c.do(ctx, http.MethodGet, "/api/sessions?"+q.Encode(), nil, &out)
	return &out, err
}

// DrainFeed pages until has_more is false. It returns every session seen, the
// deleted ids, the final cursor, and the number of requests it took.
func (c *Client) DrainFeed(ctx context.Context, since int64, limit, maxPages int) ([]Task, []string, int64, int, error) {
	var sessions []Task
	var deleted []string
	cursor := since
	pages := 0
	for {
		page, err := c.SessionPage(ctx, cursor, limit)
		if err != nil {
			return sessions, deleted, cursor, pages, err
		}
		pages++
		sessions = append(sessions, page.Sessions...)
		deleted = append(deleted, page.Deleted...)
		if page.NextCursor < cursor {
			return sessions, deleted, cursor, pages, fmt.Errorf("feed cursor moved backwards: %d -> %d", cursor, page.NextCursor)
		}
		if page.HasMore && page.NextCursor == cursor {
			return sessions, deleted, cursor, pages, fmt.Errorf("feed reports has_more at cursor %d without advancing", cursor)
		}
		cursor = page.NextCursor
		if !page.HasMore || (maxPages > 0 && pages >= maxPages) {
			return sessions, deleted, cursor, pages, nil
		}
	}
}

func (c *Client) Task(ctx context.Context, id string) (*Task, error) {
	var out Task
	err := c.do(ctx, http.MethodGet, "/api/tasks/"+url.PathEscape(id), nil, &out)
	return &out, err
}

func (c *Client) CreateTask(ctx context.Context, body map[string]any) (*Task, error) {
	var out Task
	err := c.do(ctx, http.MethodPost, "/api/tasks", body, &out)
	return &out, err
}

func (c *Client) FollowUp(ctx context.Context, taskID, prompt string) (*Task, error) {
	var out Task
	err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/prompt",
		map[string]any{"prompt": prompt}, &out)
	return &out, err
}

func (c *Client) TaskEvents(ctx context.Context, taskID string, sinceSeq int64) ([]TaskEvent, error) {
	path := fmt.Sprintf("/api/tasks/%s/events?since_seq=%d", url.PathEscape(taskID), sinceSeq)
	var out []TaskEvent
	err := c.do(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

func (c *Client) Approvals(ctx context.Context, status string) ([]Approval, error) {
	path := "/api/approvals"
	if status != "" {
		path += "?status=" + url.QueryEscape(status)
	}
	var out []Approval
	err := c.do(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

func (c *Client) Decide(ctx context.Context, approvalID, decision string) (*Approval, error) {
	var out Approval
	err := c.do(ctx, http.MethodPost, "/api/approvals/"+url.PathEscape(approvalID)+"/decision",
		map[string]any{"decision": decision}, &out)
	return &out, err
}

// withToken returns a shallow copy that uses token. Mutating c.Token instead
// would race with the SSE goroutine, which reads the token when it opens the
// stream.
func (c *Client) withToken(token string) *Client {
	cp := *c
	cp.Token = token
	return &cp
}

func (c *Client) CreatePairingSession(ctx context.Context, masterToken, label string) (*PairingSessionResponse, error) {
	var out PairingSessionResponse
	err := c.withToken(masterToken).do(ctx, http.MethodPost, "/api/pairing/sessions", map[string]any{"label": label}, &out)
	return &out, err
}

func (c *Client) ExchangePairing(ctx context.Context, secret, label string) (*PairingExchangeResponse, error) {
	var out PairingExchangeResponse
	err := c.do(ctx, http.MethodPost, "/api/pairing/exchange",
		map[string]any{"secret": secret, "label": label}, &out)
	return &out, err
}

func (c *Client) RevokeDevice(ctx context.Context, deviceID, masterToken string) error {
	return c.withToken(masterToken).do(ctx, http.MethodPost, "/api/devices/"+url.PathEscape(deviceID)+"/revoke", nil, nil)
}

func (c *Client) ArchiveTask(ctx context.Context, taskID string) error {
	return c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/archive", nil, nil)
}

// DeleteTask is not in the contract; the probe tries it only on its own task to
// learn whether an undocumented cleanup path exists.
func (c *Client) DeleteTask(ctx context.Context, taskID string) error {
	return c.do(ctx, http.MethodDelete, "/api/tasks/"+url.PathEscape(taskID), nil, nil)
}

// DeleteTaskAs repeats the undocumented delete with another credential, so the
// probe can tell "route missing" from "device tokens are not allowed".
func (c *Client) DeleteTaskAs(ctx context.Context, taskID, token string) error {
	return c.withToken(token).DeleteTask(ctx, taskID)
}
