package api

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	pushsvc "github.com/vuuihc/openkin/internal/push"
)

func newPushTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	s, token := newTestServer(t)
	s.Push = &pushsvc.Service{Store: s.Store}
	return s, token
}

func pushKeys(t *testing.T) (p256dh, auth string) {
	t.Helper()
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, 16)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
		base64.RawURLEncoding.EncodeToString(secret)
}

func doJSON(t *testing.T, h http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestPushConfigIsStableAndAuthenticated(t *testing.T) {
	s, token := newPushTestServer(t)
	h := s.Handler()

	rr := doJSON(t, h, http.MethodGet, "/api/push/config", "", nil)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("without a token: %d", rr.Code)
	}

	rr = doJSON(t, h, http.MethodGet, "/api/push/config", token, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("config: %d %s", rr.Code, rr.Body.String())
	}
	var first pushConfigResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if first.PublicKey == "" || first.Subscribed != 0 {
		t.Fatalf("config = %+v", first)
	}

	// The key a browser subscribed with must keep verifying after the console
	// reloads — a regenerated pair would silently stop every existing
	// subscription.
	rr = doJSON(t, h, http.MethodGet, "/api/push/config", token, nil)
	var second pushConfigResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &second)
	if second.PublicKey != first.PublicKey {
		t.Fatal("the public key changed between reads")
	}
}

func TestPushSubscribeAndUnsubscribe(t *testing.T) {
	s, token := newPushTestServer(t)
	h := s.Handler()
	p256dh, auth := pushKeys(t)

	rr := doJSON(t, h, http.MethodPost, "/api/push/subscribe", token, map[string]any{
		"endpoint": "https://push.example.net/send/abc",
		"keys":     map[string]string{"p256dh": p256dh, "auth": auth},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("subscribe: %d %s", rr.Code, rr.Body.String())
	}
	var created map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &created)
	if created["id"] == "" {
		t.Fatal("subscribe returned no id")
	}

	// Subscribing the same browser again is an update, not a second row.
	rr = doJSON(t, h, http.MethodPost, "/api/push/subscribe", token, map[string]any{
		"endpoint": "https://push.example.net/send/abc",
		"keys":     map[string]string{"p256dh": p256dh, "auth": auth},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("second subscribe: %d", rr.Code)
	}
	n, err := s.Store.CountPushSubscriptions(context.Background())
	if err != nil || n != 1 {
		t.Fatalf("count = %d, %v", n, err)
	}

	rr = doJSON(t, h, http.MethodDelete, "/api/push/subscribe", token, map[string]string{
		"endpoint": "https://push.example.net/send/abc",
	})
	if rr.Code != http.StatusNoContent {
		t.Fatalf("unsubscribe: %d %s", rr.Code, rr.Body.String())
	}
	if n, _ := s.Store.CountPushSubscriptions(context.Background()); n != 0 {
		t.Fatalf("count after unsubscribe = %d", n)
	}
}

func TestPushSubscribeRefusesWhatCannotWork(t *testing.T) {
	s, token := newPushTestServer(t)
	h := s.Handler()
	p256dh, auth := pushKeys(t)

	cases := []struct {
		name string
		body map[string]any
	}{
		{"plain http", map[string]any{
			"endpoint": "http://push.example.net/send/abc",
			"keys":     map[string]string{"p256dh": p256dh, "auth": auth},
		}},
		{"no endpoint", map[string]any{
			"endpoint": "",
			"keys":     map[string]string{"p256dh": p256dh, "auth": auth},
		}},
		{"bad point", map[string]any{
			"endpoint": "https://push.example.net/send/abc",
			"keys":     map[string]string{"p256dh": base64.RawURLEncoding.EncodeToString([]byte("short")), "auth": auth},
		}},
		{"bad secret", map[string]any{
			"endpoint": "https://push.example.net/send/abc",
			"keys":     map[string]string{"p256dh": p256dh, "auth": base64.RawURLEncoding.EncodeToString(make([]byte, 8))},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := doJSON(t, h, http.MethodPost, "/api/push/subscribe", token, tc.body)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status %d, want 400", rr.Code)
			}
		})
	}
	if n, _ := s.Store.CountPushSubscriptions(context.Background()); n != 0 {
		t.Fatalf("a refused registration was stored: %d", n)
	}
}

func TestPushTestDeliversToSubscribedBrowser(t *testing.T) {
	s, token := newPushTestServer(t)
	var mu sync.Mutex
	var received int
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		received++
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	}))
	defer ts.Close()
	// The guard that refuses private addresses is the transport's; the test
	// client carries the test server's certificate and nothing else.
	s.Push.Client = ts.Client()
	h := s.Handler()
	p256dh, auth := pushKeys(t)

	rr := doJSON(t, h, http.MethodPost, "/api/push/subscribe", token, map[string]any{
		"endpoint": ts.URL + "/send/abc",
		"keys":     map[string]string{"p256dh": p256dh, "auth": auth},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("subscribe: %d %s", rr.Code, rr.Body.String())
	}

	rr = doJSON(t, h, http.MethodPost, "/api/push/test", token, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("test: %d %s", rr.Code, rr.Body.String())
	}
	var got notifyTestResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || len(got.Results) != 1 || got.Results[0].Channel != "push" {
		t.Fatalf("results = %+v", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if received != 1 {
		t.Fatalf("the push service received %d requests", received)
	}
}

func TestPushTestWithoutSubscribersIsAnEmptySuccessShape(t *testing.T) {
	s, token := newPushTestServer(t)
	h := s.Handler()
	rr := doJSON(t, h, http.MethodPost, "/api/push/test", token, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d", rr.Code)
	}
	var got notifyTestResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if got.OK || got.Results == nil || len(got.Results) != 0 {
		t.Fatalf("results = %+v", got)
	}
}
