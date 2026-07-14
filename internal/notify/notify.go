// Package notify sends fire-and-forget webhooks for Bark and ntfy (spec §8).
package notify

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

// Setting keys (spec §8).
const (
	KeyBarkURL   = "notify.bark_url"
	KeyNtfyTopic = "notify.ntfy_topic"
	KeyBaseURL   = "ui.base_url"
)

// SettingsReader loads notification-related settings.
type SettingsReader interface {
	GetSetting(ctx context.Context, key string) (string, error)
}

// Payload is the notification content.
type Payload struct {
	Title string
	Body  string
	// URL is the deep link opened when the user taps the notification.
	URL string
}

// Sender posts notifications to configured Bark / ntfy endpoints.
// Fire-and-forget: 5s timeout, one retry (spec §8).
type Sender struct {
	Store  SettingsReader
	Client *http.Client
	// BaseURLOverride skips the store for ui.base_url (tests).
	BaseURLOverride string
}

func (s *Sender) client() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return &http.Client{Timeout: 5 * time.Second}
}

// BaseURL returns ui.base_url (trimmed, no trailing slash) or override.
func (s *Sender) BaseURL(ctx context.Context) string {
	if s.BaseURLOverride != "" {
		return strings.TrimRight(s.BaseURLOverride, "/")
	}
	if s.Store == nil {
		return ""
	}
	v, err := s.Store.GetSetting(ctx, KeyBaseURL)
	if err != nil {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(v), "/")
}

// DeepLink builds base + path (+ optional query).
func (s *Sender) DeepLink(ctx context.Context, path string) string {
	base := s.BaseURL(ctx)
	if base == "" {
		return path
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return base + path
}

// NotifyApproval sends an approval_requested notification.
func (s *Sender) NotifyApproval(ctx context.Context, approvalID, taskID, title string) {
	if title == "" {
		title = "Approval needed"
	}
	body := "Task requires approval"
	if taskID != "" {
		body = fmt.Sprintf("Task %s needs approval", shortID(taskID))
	}
	link := s.DeepLink(ctx, "/approvals")
	s.Send(ctx, Payload{Title: title, Body: body, URL: link})
}

// NotifyTaskTerminal sends a notification when a task reaches a terminal status.
func (s *Sender) NotifyTaskTerminal(ctx context.Context, taskID, taskTitle, status string) {
	title := "Task " + status
	if taskTitle != "" {
		title = taskTitle + " — " + status
	}
	body := fmt.Sprintf("Task %s is %s", shortID(taskID), status)
	link := s.DeepLink(ctx, "/tasks/"+url.PathEscape(taskID))
	s.Send(ctx, Payload{Title: title, Body: body, URL: link})
}

// Send posts to all configured channels (fire-and-forget goroutine).
func (s *Sender) Send(ctx context.Context, p Payload) {
	if s == nil || s.Store == nil {
		return
	}
	bark, _ := s.Store.GetSetting(ctx, KeyBarkURL)
	ntfy, _ := s.Store.GetSetting(ctx, KeyNtfyTopic)
	bark = strings.TrimSpace(bark)
	ntfy = strings.TrimSpace(ntfy)
	if bark == "" && ntfy == "" {
		return
	}
	// Detach from request cancellation; keep a short deadline.
	go func() {
		cctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if bark != "" {
			_ = s.postWithRetry(cctx, func() *http.Request {
				return barkRequest(cctx, bark, p)
			})
		}
		if ntfy != "" {
			_ = s.postWithRetry(cctx, func() *http.Request {
				return ntfyRequest(cctx, ntfy, p)
			})
		}
	}()
}

// SendSync is like Send but waits (for tests).
func (s *Sender) SendSync(ctx context.Context, p Payload) error {
	if s == nil || s.Store == nil {
		return nil
	}
	bark, _ := s.Store.GetSetting(ctx, KeyBarkURL)
	ntfy, _ := s.Store.GetSetting(ctx, KeyNtfyTopic)
	var first error
	if b := strings.TrimSpace(bark); b != "" {
		if err := s.postWithRetry(ctx, func() *http.Request {
			return barkRequest(ctx, b, p)
		}); err != nil && first == nil {
			first = err
		}
	}
	if n := strings.TrimSpace(ntfy); n != "" {
		if err := s.postWithRetry(ctx, func() *http.Request {
			return ntfyRequest(ctx, n, p)
		}); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (s *Sender) postWithRetry(ctx context.Context, build func() *http.Request) error {
	var last error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(200 * time.Millisecond):
			}
		}
		req := build()
		if req == nil {
			return fmt.Errorf("nil request")
		}
		resp, err := s.client().Do(req)
		if err != nil {
			last = err
			continue
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return nil
		}
		last = fmt.Errorf("status %d", resp.StatusCode)
	}
	return last
}

// barkRequest POSTs JSON {title, body, url} to the Bark server URL.
// bark_url may be a base like https://api.day.app/DEVICEKEY or a full endpoint.
func barkRequest(ctx context.Context, barkURL string, p Payload) *http.Request {
	endpoint := strings.TrimRight(barkURL, "/")
	// If it does not look like it already ends with /push, append path style
	// compatible with Bark open API: POST {base}/push with JSON body.
	if !strings.HasSuffix(endpoint, "/push") {
		endpoint = endpoint + "/push"
	}
	body, _ := json.Marshal(map[string]string{
		"title": p.Title,
		"body":  p.Body,
		"url":   p.URL,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	return req
}

// ntfyRequest POSTs to https://ntfy.sh/<topic> (or a full URL topic).
func ntfyRequest(ctx context.Context, topic string, p Payload) *http.Request {
	endpoint := topic
	if !strings.Contains(topic, "://") {
		endpoint = "https://ntfy.sh/" + strings.TrimPrefix(topic, "/")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(p.Body))
	if err != nil {
		return nil
	}
	req.Header.Set("Title", p.Title)
	if p.URL != "" {
		req.Header.Set("Click", p.URL)
	}
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	return req
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
