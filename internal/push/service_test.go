package push

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"

	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/store"
)

func openService(t *testing.T) (*Service, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return &Service{Store: st}, st
}

func keys(t *testing.T) (p256dh, auth string) {
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

func TestPublicKeyIsMintedOnceAndSurvivesARestart(t *testing.T) {
	svc, st := openService(t)
	first, err := svc.PublicKey(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// A second Service stands in for the next process: it holds no cached key
	// and must find the one in settings.
	next := &Service{Store: st}
	second, err := next.PublicKey(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("the VAPID key changed across a restart; every subscription would stop verifying")
	}
}

func TestPushDeliversAndPrunes(t *testing.T) {
	svc, st := openService(t)
	ctx := context.Background()
	p256dh, auth := keys(t)

	var mu sync.Mutex
	status := http.StatusCreated
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.WriteHeader(status)
	}))
	defer ts.Close()
	svc.Client = ts.Client()

	if err := st.SavePushSubscription(ctx, store.PushSubscription{
		ID: "s1", Endpoint: ts.URL + "/send/1", P256DH: p256dh, Auth: auth, CreatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	results := svc.Push(ctx, notify.Payload{Title: "Approval needed", Body: "Task x", URL: "/inbox?focus=a1"})
	if len(results) != 1 || !results[0].OK || results[0].Channel != "push" {
		t.Fatalf("results = %+v", results)
	}

	mu.Lock()
	status = http.StatusGone
	mu.Unlock()
	results = svc.Push(ctx, notify.Payload{Title: "Approval needed"})
	if len(results) != 1 || results[0].OK {
		t.Fatalf("second results = %+v", results)
	}
	if n, _ := st.CountPushSubscriptions(ctx); n != 0 {
		t.Fatalf("a retired subscription was kept: %d", n)
	}
}

func TestPushWithNoSubscriptionsSaysNothing(t *testing.T) {
	svc, _ := openService(t)
	if results := svc.Push(context.Background(), notify.Payload{Title: "x"}); results != nil {
		t.Fatalf("results = %+v", results)
	}
}

func TestValidateRegistration(t *testing.T) {
	p256dh, auth := keys(t)
	if err := ValidateRegistration("https://push.example.net/x", p256dh, auth); err != nil {
		t.Fatalf("valid registration refused: %v", err)
	}
	if err := ValidateRegistration("http://push.example.net/x", p256dh, auth); err == nil {
		t.Fatal("plain http accepted")
	}
	if err := ValidateRegistration("https://push.example.net/x", "not-base64!", auth); err == nil {
		t.Fatal("bad p256dh accepted")
	}
	if err := ValidateRegistration("https://push.example.net/x", p256dh, "AAAA"); err == nil {
		t.Fatal("short auth accepted")
	}
}
