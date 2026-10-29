package notify

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// clicks is the far end of Send, which is a goroutine by design, so every test
// that reads what arrived has to synchronise with the handler that wrote it.
type clicks struct {
	mu    sync.Mutex
	items []string
}

func (c *clicks) add(v string) {
	c.mu.Lock()
	c.items = append(c.items, v)
	c.mu.Unlock()
}

func (c *clicks) all() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.items...)
}

func (c *clicks) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items)
}

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

// TestNotifyBarkBaseURLPath asserts Bark form (a): POST JSON to the device URL
// as-is (https://host/DEVICEKEY), not …/DEVICEKEY/push.
func TestNotifyBarkBaseURLPath(t *testing.T) {
	var gotPath string
	var gotMethod string
	var gotCT string
	var got map[string]string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotCT = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"code":200,"message":"success"}`))
	}))
	defer srv.Close()

	// Base-style bark URL: https://host/DEVICEKEY (no /push suffix).
	deviceURL := srv.URL + "/DEVICEKEY"
	s := &Sender{
		Store: memSettings{
			KeyBarkURL: deviceURL,
			KeyBaseURL: "http://phone.local",
		},
		Client: &http.Client{Timeout: 2 * time.Second},
	}
	results := s.Deliver(context.Background(), Payload{
		Title: "t", Body: "b", URL: "http://phone.local/tasks/1",
	})
	if len(results) != 1 {
		t.Fatalf("results = %#v", results)
	}
	if !results[0].OK || results[0].Channel != "bark" {
		t.Fatalf("result = %#v", results[0])
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("method = %s", gotMethod)
	}
	if gotPath != "/DEVICEKEY" {
		t.Fatalf("path = %q, want /DEVICEKEY (must not append /push)", gotPath)
	}
	if gotCT != "application/json" {
		t.Fatalf("content-type = %q", gotCT)
	}
	if got["title"] != "t" || got["body"] != "b" || got["url"] != "http://phone.local/tasks/1" {
		t.Fatalf("payload = %#v", got)
	}
}

func TestNotifyBarkPayload(t *testing.T) {
	var got map[string]string
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
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
	if gotPath != "/devicekey" {
		t.Fatalf("path = %q, want /devicekey", gotPath)
	}
	if got["title"] != "t" || got["body"] != "b" || got["url"] != "http://phone.local/tasks/1" {
		t.Fatalf("payload = %#v", got)
	}
}

func TestDeliverLogsAndResultsBothChannels(t *testing.T) {
	barkOK := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer barkOK.Close()
	ntfyFail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer ntfyFail.Close()

	s := &Sender{
		Store: memSettings{
			KeyBarkURL:   barkOK.URL + "/key",
			KeyNtfyTopic: ntfyFail.URL + "/topic",
		},
		Client: &http.Client{Timeout: 2 * time.Second},
	}
	results := s.Deliver(context.Background(), Payload{Title: "a", Body: "b"})
	if len(results) != 2 {
		t.Fatalf("len(results)=%d", len(results))
	}
	byCh := map[string]ChannelResult{}
	for _, r := range results {
		byCh[r.Channel] = r
	}
	if !byCh["bark"].OK {
		t.Fatalf("bark: %#v", byCh["bark"])
	}
	if byCh["ntfy"].OK || byCh["ntfy"].Error == "" {
		t.Fatalf("ntfy: %#v", byCh["ntfy"])
	}
}

func TestDeepLink(t *testing.T) {
	s := &Sender{Store: memSettings{KeyBaseURL: "http://192.168.1.5:7777/"}}
	got := s.DeepLink(context.Background(), "/approvals")
	if got != "http://192.168.1.5:7777/approvals" {
		t.Fatalf("deep link = %q", got)
	}
}

// TestNotifyApprovalNamesTheApproval: the push has to carry the id of the thing
// it is about. Without it the link is the inbox in general and the person who
// taps it lands on a list, not on the decision — which is the difference between
// a notification you can act on from a phone and one you have to go looking
// after. Same shape as the question push, so the page has one rule to implement.
func TestNotifyApprovalNamesTheApproval(t *testing.T) {
	s := &Sender{Store: memSettings{KeyBaseURL: "http://host:7777"}}

	got := s.inboxFocusLink(context.Background(), "appr 1/2")
	if got != "http://host:7777/inbox?focus=appr+1%2F2" {
		t.Fatalf("approval link = %q", got)
	}
	// No id: the page, not a link that names nothing.
	if got := s.inboxFocusLink(context.Background(), ""); got != "http://host:7777/inbox" {
		t.Fatalf("empty-id link = %q", got)
	}
}

// TestNotifyApprovalClickIsTheApprovalURL drives the real send path, so the link
// asserted above is the link that leaves the machine.
func TestNotifyApprovalClickIsTheApprovalURL(t *testing.T) {
	var got clicks
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.add(r.Header.Get("Click"))
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
	s.NotifyApproval(context.Background(), "appr1", "task1", "Approval needed")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if got.len() > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if all := got.all(); len(all) != 1 || all[0] != "http://host:7777/inbox?focus=appr1" {
		t.Fatalf("click = %v", all)
	}
}

func TestNotifyQuestionAndQuotaUseActionableLinks(t *testing.T) {
	var got clicks
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.add(r.Header.Get("Click"))
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
	if err := s.SendSync(context.Background(), Payload{
		Title: "question", Body: "answer", URL: s.DeepLink(context.Background(), "/inbox?focus=q1"),
	}); err != nil {
		t.Fatal(err)
	}
	s.NotifyUserQuestion(context.Background(), "q1", "task1", "Choose")
	s.NotifyQuota(context.Background(), "task1", "Build", "waiting", time.Now().Add(time.Minute).Unix())
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && got.len() < 3 {
		time.Sleep(20 * time.Millisecond)
	}
	all := got.all()
	if len(all) < 3 {
		t.Fatalf("notification clicks = %v", all)
	}
	seen := map[string]bool{}
	for _, click := range all {
		seen[click] = true
	}
	for _, want := range []string{
		"http://host:7777/inbox?focus=q1",
		"http://host:7777/tasks/task1",
	} {
		if !seen[want] {
			t.Fatalf("missing click %q in %v", want, all)
		}
	}
}

type stubPusher struct {
	got  []Payload
	fail bool
}

func (p *stubPusher) Push(_ context.Context, payload Payload) []ChannelResult {
	p.got = append(p.got, payload)
	if p.fail {
		return []ChannelResult{{Channel: "push", Error: "boom"}}
	}
	return []ChannelResult{{Channel: "push", OK: true, Status: "ok"}}
}

// Every channel sees the same event, and one channel's result does not speak
// for another's: the settings page shows the list, and a reader debugging a
// missing notification needs to know which door it failed at.
func TestDeliverIncludesBrowserPush(t *testing.T) {
	pusher := &stubPusher{}
	s := &Sender{Store: memSettings{"notify.ntfy_topic": "http://ntfy.example.net/topic"}, Push: pusher}
	results := s.Deliver(context.Background(), Payload{Title: "Approval needed", Body: "b", URL: "/inbox?focus=a1"})
	if len(pusher.got) != 1 || pusher.got[0].Title != "Approval needed" {
		t.Fatalf("pusher got %+v", pusher.got)
	}
	var sawPush bool
	for _, res := range results {
		if res.Channel == "push" {
			sawPush = true
			if !res.OK {
				t.Fatalf("push result = %+v", res)
			}
		}
	}
	if !sawPush {
		t.Fatalf("no push result in %+v", results)
	}
}

// ctxPusher records the context it was called with. A push that runs behind a
// hanging webhook sees an expired one — and reports success to nobody.
type ctxPusher struct {
	mu     sync.Mutex
	err    error
	called bool
}

func (p *ctxPusher) Push(ctx context.Context, _ Payload) []ChannelResult {
	p.mu.Lock()
	p.err = ctx.Err()
	p.called = true
	p.mu.Unlock()
	return []ChannelResult{{Channel: "push", OK: true, Status: "ok"}}
}

func (p *ctxPusher) outcome() (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.called, p.err
}

// A webhook that never answers must not spend the notification's whole budget.
// Browser push is the channel a person enabled so their phone rings while the
// console is closed; running it behind two Bark retries made a dead Bark URL
// silently disable it.
func TestDeliverDoesNotLetASlowWebhookStarvePush(t *testing.T) {
	// The handler holds the request open until the test is done with it, so
	// Bark is still "thinking" while the deadline passes. `release` is closed
	// before the server is, or Close would wait on the handler forever.
	release := make(chan struct{})
	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer hang.Close()
	defer close(release)

	pusher := &ctxPusher{}
	s := &Sender{
		Store:  memSettings{"notify.bark_url": hang.URL + "/key"},
		Client: &http.Client{}, // only the caller's deadline ends the request
		Push:   pusher,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	results := s.Deliver(ctx, Payload{Title: "x"})
	called, errAtCall := pusher.outcome()
	if !called {
		t.Fatal("push never ran")
	}
	if errAtCall != nil {
		t.Fatalf("push ran with an expired context: %v", errAtCall)
	}
	var okPush bool
	for _, r := range results {
		if r.Channel == "push" && r.OK {
			okPush = true
		}
	}
	if !okPush {
		t.Fatalf("results = %+v", results)
	}
}

func TestDeliverKeepsWebhooksWhenPushFails(t *testing.T) {
	var clicks atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clicks.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	s := &Sender{
		Store:  memSettings{"notify.ntfy_topic": srv.URL},
		Client: &http.Client{Timeout: 2 * time.Second},
		Push:   &stubPusher{fail: true},
	}
	results := s.Deliver(context.Background(), Payload{Title: "x"})
	if clicks.Load() != 1 {
		t.Fatalf("ntfy received %d requests", clicks.Load())
	}
	var okPush, okNtfy bool
	for _, res := range results {
		if res.Channel == "push" && !res.OK {
			okPush = true
		}
		if res.Channel == "ntfy" && res.OK {
			okNtfy = true
		}
	}
	if !okPush || !okNtfy {
		t.Fatalf("results = %+v", results)
	}
}
