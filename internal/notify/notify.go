// Package notify sends fire-and-forget webhooks for Bark and ntfy (spec §8).
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
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

// ChannelResult is the outcome of delivering to one configured channel.
type ChannelResult struct {
	Channel string `json:"channel"`
	OK      bool   `json:"ok"`
	// Status is a short success token (e.g. "ok") when OK is true.
	Status string `json:"status,omitempty"`
	// Error is set when OK is false.
	Error string `json:"error,omitempty"`
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

// NotifyRoutine pushes a noteworthy routine report (or is a no-op when noteworthy is false).
func (s *Sender) NotifyRoutine(ctx context.Context, taskID, title, tldr string, noteworthy bool) {
	if !noteworthy {
		return
	}
	if title == "" {
		title = "Routine report"
	}
	body := tldr
	if body == "" {
		body = "A routine has something for you"
	}
	link := s.DeepLink(ctx, "/routines")
	if taskID != "" {
		link = s.DeepLink(ctx, "/tasks/"+url.PathEscape(taskID))
	}
	s.Send(ctx, Payload{Title: title, Body: body, URL: link})
}

// NotifyRoutineFailure pushes a one-shot circuit-breaker alert.
func (s *Sender) NotifyRoutineFailure(ctx context.Context, routineID, title, message string) {
	if title == "" {
		title = "Routine disabled"
	}
	body := message
	if body == "" {
		body = "Routine auto-disabled after repeated failures"
	}
	link := s.DeepLink(ctx, "/routines")
	s.Send(ctx, Payload{Title: title, Body: body, URL: link})
}

// Send posts to all configured channels (fire-and-forget goroutine).
func (s *Sender) Send(ctx context.Context, p Payload) {
	if s == nil || s.Store == nil {
		return
	}
	// Detach from request cancellation; keep a short deadline.
	go func() {
		cctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = s.Deliver(cctx, p)
	}()
}

// Deliver posts synchronously to every configured channel and returns per-channel results.
// Each attempt is logged (channel + outcome). Empty settings yield an empty slice.
func (s *Sender) Deliver(ctx context.Context, p Payload) []ChannelResult {
	if s == nil || s.Store == nil {
		return nil
	}
	bark, _ := s.Store.GetSetting(ctx, KeyBarkURL)
	ntfy, _ := s.Store.GetSetting(ctx, KeyNtfyTopic)
	bark = strings.TrimSpace(bark)
	ntfy = strings.TrimSpace(ntfy)

	var results []ChannelResult
	if bark != "" {
		results = append(results, s.deliverOne(ctx, "bark", func() *http.Request {
			return barkRequest(ctx, bark, p)
		}))
	}
	if ntfy != "" {
		results = append(results, s.deliverOne(ctx, "ntfy", func() *http.Request {
			return ntfyRequest(ctx, ntfy, p)
		}))
	}
	return results
}

// SendSync is like Deliver but returns the first channel error (for tests / callers that want err).
func (s *Sender) SendSync(ctx context.Context, p Payload) error {
	results := s.Deliver(ctx, p)
	for _, r := range results {
		if !r.OK {
			if r.Error != "" {
				return fmt.Errorf("%s: %s", r.Channel, r.Error)
			}
			return fmt.Errorf("%s: failed", r.Channel)
		}
	}
	return nil
}

func (s *Sender) deliverOne(ctx context.Context, channel string, build func() *http.Request) ChannelResult {
	err := s.postWithRetry(ctx, build)
	if err != nil {
		log.Printf("notify: %s failed: %v", channel, err)
		return ChannelResult{Channel: channel, OK: false, Error: err.Error()}
	}
	log.Printf("notify: %s ok", channel)
	return ChannelResult{Channel: channel, OK: true, Status: "ok"}
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

// barkRequest POSTs JSON {title, body, url} to the configured Bark device URL as-is.
// bark_url is typically https://api.day.app/DEVICEKEY — do not append /push (that form
// expects device_key in the JSON body when POSTing to the server root).
func barkRequest(ctx context.Context, barkURL string, p Payload) *http.Request {
	endpoint := strings.TrimRight(barkURL, "/")
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
