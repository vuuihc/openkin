package notify

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

type memSettings map[string]string

func (m memSettings) GetSetting(_ context.Context, key string) (string, error) {
	v, ok := m[key]
	if !ok {
		return "", errNotFound
	}
	return v, nil
}

type notFound string

func (e notFound) Error() string { return string(e) }

var errNotFound = notFound("not found")

func TestNotifyNtfyPayloadAndRetry(t *testing.T) {
	var hits atomic.Int32
	var titles []string
	var bodies []string
	var clicks []string
	var failFirst atomic.Bool
	failFirst.Store(true)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := hits.Add(1)
		body, _ := io.ReadAll(r.Body)
		titles = append(titles, r.Header.Get("Title"))
		clicks = append(clicks, r.Header.Get("Click"))
		bodies = append(bodies, string(body))
		if failFirst.Load() && n == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	s := &Sender{
		Store: memSettings{
			KeyNtfyTopic: srv.URL + "/kin-test",
			KeyBaseURL:   "http://example.test:7777",
		},
		Client: &http.Client{Timeout: 2 * time.Second},
	}

	err := s.SendSync(context.Background(), Payload{
		Title: "Approval needed",
		Body:  "Task abc needs approval",
		URL:   "http://example.test:7777/approvals",
	})
	if err != nil {
		t.Fatalf("SendSync: %v", err)
	}
	if hits.Load() != 2 {
		t.Fatalf("hits = %d, want 2 (fail once + retry)", hits.Load())
	}
	if titles[len(titles)-1] != "Approval needed" {
		t.Fatalf("title = %q", titles[len(titles)-1])
	}
	if clicks[len(clicks)-1] != "http://example.test:7777/approvals" {
		t.Fatalf("click = %q", clicks[len(clicks)-1])
	}
	if bodies[len(bodies)-1] != "Task abc needs approval" {
		t.Fatalf("body = %q", bodies[len(bodies)-1])
	}
}

func TestNotifyBarkPayload(t *testing.T) {
	var got map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/devicekey/push" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	s := &Sender{
		Store: memSettings{
			KeyBarkURL: srv.URL + "/devicekey",
			KeyBaseURL: "http://phone.local",
		},
		Client: &http.Client{Timeout: 2 * time.Second},
	}
	if err := s.SendSync(context.Background(), Payload{
		Title: "t", Body: "b", URL: "http://phone.local/tasks/1",
	}); err != nil {
		t.Fatal(err)
	}
	if got["title"] != "t" || got["body"] != "b" || got["url"] != "http://phone.local/tasks/1" {
		t.Fatalf("payload = %#v", got)
	}
}

func TestDeepLink(t *testing.T) {
	s := &Sender{Store: memSettings{KeyBaseURL: "http://192.168.1.5:7777/"}}
	got := s.DeepLink(context.Background(), "/approvals")
	if got != "http://192.168.1.5:7777/approvals" {
		t.Fatalf("deep link = %q", got)
	}
}

func TestNotifyApprovalUsesDeepLink(t *testing.T) {
	var click string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		click = r.Header.Get("Click")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	s := &Sender{
		Store: memSettings{
			KeyNtfyTopic: srv.URL,
			KeyBaseURL:   "http://host:7777",
		},
		Client: &http.Client{Timeout: 2 * time.Second},
	}
	// Use SendSync path via NotifyApproval's Send — wait briefly.
	s.NotifyApproval(context.Background(), "appr1", "task1", "Approval needed")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if click != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if click != "http://host:7777/approvals" {
		t.Fatalf("click = %q", click)
	}
}
