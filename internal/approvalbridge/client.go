// Package approvalbridge provides the authenticated HTTP client used by
// agent adapters to bridge permission and user-question requests into Kin.
package approvalbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	defaultRequestTimeout = 15 * time.Second
	defaultWaitTimeout    = 35 * time.Second
	defaultRetryDelay     = time.Second
)

// Execution identifies the concrete adapter run that owns a request.
type Execution struct {
	ID    string
	Agent string
	Step  int
	Model string
}

// Question is one question presented through Kin's user-question API.
type Question struct {
	Text        string
	Header      string
	Options     []QuestionOption
	MultiSelect bool
}

// QuestionOption is one selectable answer.
type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// QuestionAnswer is the terminal answer returned by Kin.
type QuestionAnswer struct {
	Status    string          `json:"-"`
	Selected  []string        `json:"selected"`
	OtherText string          `json:"other_text"`
	Raw       json.RawMessage `json:"-"`
}

// Client calls Kin's loopback-only approval APIs.
type Client struct {
	DaemonURL          string
	Token              string
	HTTPClient         *http.Client
	RequestTimeout     time.Duration
	WaitRequestTimeout time.Duration
	RetryDelay         time.Duration
}

// CreateApproval creates a pending Kin approval and returns its id.
func (c *Client) CreateApproval(ctx context.Context, taskID, kind string, payload json.RawMessage, exec Execution) (string, error) {
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	body := map[string]any{
		"task_id": taskID,
		"kind":    kind,
		"payload": payload,
	}
	addExecution(body, exec)
	var result struct {
		ID string `json:"id"`
	}
	if err := c.post(ctx, "/internal/approvals", body, &result); err != nil {
		return "", err
	}
	if strings.TrimSpace(result.ID) == "" {
		return "", fmt.Errorf("empty approval id")
	}
	return result.ID, nil
}

// WaitApproval waits until an approval is no longer pending.
func (c *Client) WaitApproval(ctx context.Context, id string) (string, error) {
	for {
		var result struct {
			Decision string `json:"decision"`
		}
		err := c.get(ctx, "/internal/approvals/"+url.PathEscape(id)+"/wait?timeout=30", &result)
		if err != nil {
			var permanent *responseError
			if errors.As(err, &permanent) {
				return "", err
			}
			if !c.retry(ctx) {
				return "", ctx.Err()
			}
			continue
		}
		if result.Decision != "" && result.Decision != "pending" {
			return result.Decision, nil
		}
	}
}

// CreateUserQuestion creates one pending Kin user question and returns its id.
func (c *Client) CreateUserQuestion(ctx context.Context, taskID string, question Question, exec Execution) (string, error) {
	body := map[string]any{
		"task_id":      taskID,
		"question":     question.Text,
		"header":       question.Header,
		"options":      question.Options,
		"multi_select": question.MultiSelect,
	}
	addExecution(body, exec)
	var result struct {
		ID string `json:"id"`
	}
	if err := c.post(ctx, "/internal/user-questions", body, &result); err != nil {
		return "", err
	}
	if strings.TrimSpace(result.ID) == "" {
		return "", fmt.Errorf("empty user question id")
	}
	return result.ID, nil
}

// WaitUserQuestion waits until a user question is answered or expires.
func (c *Client) WaitUserQuestion(ctx context.Context, id string) (QuestionAnswer, error) {
	for {
		var result struct {
			Status   string          `json:"status"`
			Response json.RawMessage `json:"response"`
		}
		err := c.get(ctx, "/internal/user-questions/"+url.PathEscape(id)+"/wait?timeout=30", &result)
		if err != nil {
			var permanent *responseError
			if errors.As(err, &permanent) {
				return QuestionAnswer{}, err
			}
			if !c.retry(ctx) {
				return QuestionAnswer{}, ctx.Err()
			}
			continue
		}
		if result.Status == "" || result.Status == "pending" {
			continue
		}
		answer := QuestionAnswer{Status: result.Status, Raw: result.Response}
		if len(result.Response) > 0 && string(result.Response) != "null" {
			if err := json.Unmarshal(result.Response, &answer); err != nil {
				return QuestionAnswer{}, fmt.Errorf("decode user question answer: %w", err)
			}
			answer.Status = result.Status
			answer.Raw = result.Response
		}
		return answer, nil
	}
}

func (c *Client) post(ctx context.Context, path string, body any, result any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	reqCtx, cancel := context.WithTimeout(ctx, c.requestTimeout())
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, c.baseURL()+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	return c.do(req, result)
}

func (c *Client) get(ctx context.Context, path string, result any) error {
	reqCtx, cancel := context.WithTimeout(ctx, c.waitTimeout())
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, c.baseURL()+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	return c.do(req, result)
}

func (c *Client) do(req *http.Request, result any) error {
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &responseError{err: fmt.Errorf("%s %s: %s: %s", req.Method, req.URL.Path, resp.Status, truncate(string(data), 200))}
	}
	if err := json.Unmarshal(data, result); err != nil {
		return &responseError{err: fmt.Errorf("decode %s %s: %w", req.Method, req.URL.Path, err)}
	}
	return nil
}

type responseError struct {
	err error
}

func (e *responseError) Error() string {
	return e.err.Error()
}

func (e *responseError) Unwrap() error {
	return e.err
}

func (c *Client) retry(ctx context.Context) bool {
	timer := time.NewTimer(c.retryDelay())
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (c *Client) baseURL() string {
	return strings.TrimRight(c.DaemonURL, "/")
}

func (c *Client) requestTimeout() time.Duration {
	if c.RequestTimeout > 0 {
		return c.RequestTimeout
	}
	return defaultRequestTimeout
}

func (c *Client) waitTimeout() time.Duration {
	if c.WaitRequestTimeout > 0 {
		return c.WaitRequestTimeout
	}
	return defaultWaitTimeout
}

func (c *Client) retryDelay() time.Duration {
	if c.RetryDelay > 0 {
		return c.RetryDelay
	}
	return defaultRetryDelay
}

func addExecution(body map[string]any, exec Execution) {
	if exec.ID != "" {
		body["execution_id"] = exec.ID
	}
	if exec.Agent != "" {
		body["execution_agent"] = exec.Agent
	}
	if exec.Step > 0 {
		body["execution_step"] = exec.Step
	}
	if exec.Model != "" {
		body["execution_model"] = exec.Model
	}
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}
