package webpush

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestKeysRoundTripThroughSettings(t *testing.T) {
	keys, err := GenerateKeys()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	restored, err := KeysFromPrivate(keys.PrivateKey())
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if string(restored.PublicKey()) != string(keys.PublicKey()) {
		t.Fatal("the restored pair derives a different public key")
	}
	if len(keys.PublicKey()) != 65 || keys.PublicKey()[0] != 0x04 {
		t.Fatalf("public key is not an uncompressed point: %x", keys.PublicKey())
	}
	if len(keys.PrivateKey()) != 32 {
		t.Fatalf("private key is %d bytes", len(keys.PrivateKey()))
	}
}

func TestAuthorizationIsAValidVapidToken(t *testing.T) {
	keys, err := GenerateKeys()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	now := time.Unix(1_700_000_000, 0)
	header, err := keys.Authorization("https://push.example.net/send/abc", "mailto:owner@example.com", now)
	if err != nil {
		t.Fatalf("authorization: %v", err)
	}
	if !strings.HasPrefix(header, "vapid t=") {
		t.Fatalf("header = %q", header)
	}
	parts := strings.SplitN(strings.TrimPrefix(header, "vapid t="), ", k=", 2)
	if len(parts) != 2 {
		t.Fatalf("header has no key: %q", header)
	}
	if parts[1] != keys.PublicKeyBase64() {
		t.Fatal("header does not carry the public key")
	}
	token := parts[0]
	if !keys.VerifySignature(token) {
		t.Fatal("signature does not verify")
	}

	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		t.Fatalf("token has %d segments", len(segments))
	}
	hb, _ := base64.RawURLEncoding.DecodeString(segments[0])
	var head map[string]string
	_ = json.Unmarshal(hb, &head)
	if head["alg"] != "ES256" || head["typ"] != "JWT" {
		t.Fatalf("header = %v", head)
	}
	cb, _ := base64.RawURLEncoding.DecodeString(segments[1])
	var claims struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}
	_ = json.Unmarshal(cb, &claims)
	if claims.Aud != "https://push.example.net" {
		t.Fatalf("aud = %q", claims.Aud)
	}
	if claims.Sub != "mailto:owner@example.com" {
		t.Fatalf("sub = %q", claims.Sub)
	}
	if want := now.Add(vapidLifetime).Unix(); claims.Exp != want {
		t.Fatalf("exp = %d, want %d", claims.Exp, want)
	}
}

func TestAuthorizationRefusesPlainHTTP(t *testing.T) {
	keys, _ := GenerateKeys()
	if _, err := keys.Authorization("http://push.example.net/x", "", time.Now()); err == nil {
		t.Fatal("expected an error")
	}
}

type memStore struct {
	mu   sync.Mutex
	subs []Subscription
	gone []string
}

func (m *memStore) ListPushSubscriptions(context.Context) ([]Subscription, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Subscription(nil), m.subs...), nil
}

func (m *memStore) DeletePushSubscription(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gone = append(m.gone, id)
	return nil
}

func subscriptionKeys(t *testing.T) (p256dh, auth string) {
	t.Helper()
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	secret := make([]byte, 16)
	if _, err := rand.Read(secret); err != nil {
		t.Fatalf("secret: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
		base64.RawURLEncoding.EncodeToString(secret)
}

func TestSendPostsAnEncryptedMessage(t *testing.T) {
	p256dh, auth := subscriptionKeys(t)
	var gotBody []byte
	var gotAuth, gotEncoding string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotEncoding = r.Header.Get("Content-Encoding")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	store := &memStore{subs: []Subscription{{ID: "s1", Endpoint: srv.URL + "/send/1", P256DH: p256dh, Auth: auth}}}
	keys, _ := GenerateKeys()
	svc := &Service{Store: store, Keys: keys, Client: srv.Client()}

	results := svc.Send(context.Background(), Payload{Title: "Approval needed", Body: "Task x", URL: "/inbox?focus=a1"})
	if len(results) != 1 || !results[0].OK {
		t.Fatalf("results = %+v", results)
	}
	if gotEncoding != "aes128gcm" {
		t.Fatalf("content-encoding = %q", gotEncoding)
	}
	if !strings.HasPrefix(gotAuth, "vapid t=") {
		t.Fatalf("authorization = %q", gotAuth)
	}
	if len(gotBody) < 86+1+16 {
		t.Fatalf("body is %d bytes", len(gotBody))
	}
	if len(store.gone) != 0 {
		t.Fatalf("a delivered subscription was deleted: %v", store.gone)
	}
}

// A push service accepts the POST where it published the endpoint. Following a
// redirect would let a stored endpoint aim this daemon's request somewhere it
// never agreed to send to.
func TestSendDoesNotFollowARedirect(t *testing.T) {
	p256dh, auth := subscriptionKeys(t)
	var followed atomic.Bool
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/elsewhere" {
			followed.Store(true)
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Redirect(w, r, "/elsewhere", http.StatusTemporaryRedirect)
	}))
	defer srv.Close()

	client := srv.Client()
	client.CheckRedirect = refuseRedirect
	store := &memStore{subs: []Subscription{{ID: "s1", Endpoint: srv.URL + "/send/1", P256DH: p256dh, Auth: auth}}}
	svc := &Service{Store: store, Keys: mustKeys(t), Client: client}

	results := svc.Send(context.Background(), Payload{Title: "x"})
	if len(results) != 1 || results[0].OK {
		t.Fatalf("results = %+v", results)
	}
	if followed.Load() {
		t.Fatal("the redirect was followed")
	}
	if len(store.gone) != 0 {
		t.Fatalf("a redirect deleted the subscription: %v", store.gone)
	}
}

// The test above injects the policy to reach a local server; this one pins it
// to the client the daemon actually uses.
func TestDefaultClientCarriesTheRedirectPolicy(t *testing.T) {
	if defaultClient.CheckRedirect == nil {
		t.Fatal("the default client would follow a redirect")
	}
}

func TestSendDropsASubscriptionThePushServiceRetired(t *testing.T) {
	p256dh, auth := subscriptionKeys(t)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGone)
	}))
	defer srv.Close()

	store := &memStore{subs: []Subscription{{ID: "s1", Endpoint: srv.URL + "/send/1", P256DH: p256dh, Auth: auth}}}
	svc := &Service{Store: store, Keys: mustKeys(t), Client: srv.Client()}

	results := svc.Send(context.Background(), Payload{Title: "x"})
	if len(results) != 1 || results[0].OK {
		t.Fatalf("results = %+v", results)
	}
	if len(store.gone) != 1 || store.gone[0] != "s1" {
		t.Fatalf("gone = %v", store.gone)
	}
}

func TestSendKeepsASubscriptionAfterATransientFailure(t *testing.T) {
	p256dh, auth := subscriptionKeys(t)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	store := &memStore{subs: []Subscription{{ID: "s1", Endpoint: srv.URL + "/send/1", P256DH: p256dh, Auth: auth}}}
	svc := &Service{Store: store, Keys: mustKeys(t), Client: srv.Client()}
	if results := svc.Send(context.Background(), Payload{Title: "x"}); len(results) != 1 || results[0].OK {
		t.Fatalf("results = %+v", results)
	}
	if len(store.gone) != 0 {
		t.Fatalf("a 500 deleted the subscription: %v", store.gone)
	}
}

func TestSendDropsAnUnusableSubscription(t *testing.T) {
	store := &memStore{subs: []Subscription{{ID: "bad", Endpoint: "https://push.example.net/x", P256DH: "AAAA", Auth: "AAAA"}}}
	svc := &Service{Store: store, Keys: mustKeys(t)}
	if results := svc.Send(context.Background(), Payload{Title: "x"}); len(results) != 1 || results[0].OK {
		t.Fatalf("results = %+v", results)
	}
	if len(store.gone) != 1 {
		t.Fatalf("unusable keys did not drop the row: %v", store.gone)
	}
}

func TestSendRefusesAPrivateEndpoint(t *testing.T) {
	// The default client is the guard; a test client would bypass it, so this
	// one goes through the real transport and must fail before connecting.
	p256dh, auth := subscriptionKeys(t)
	store := &memStore{subs: []Subscription{{ID: "s1", Endpoint: "https://127.0.0.1:9/send/1", P256DH: p256dh, Auth: auth}}}
	svc := &Service{Store: store, Keys: mustKeys(t)}
	results := svc.Send(context.Background(), Payload{Title: "x"})
	if len(results) != 1 || results[0].OK {
		t.Fatalf("results = %+v", results)
	}
	if !strings.Contains(results[0].Error, "refusing") {
		t.Fatalf("expected the dialer's refusal, got %q", results[0].Error)
	}
}

// The dialer's guard is deny-by-default. Each row below is an address a forged
// or careless subscription must not be able to aim this daemon at -- including
// the carrier-grade NAT range, which is also what a Tailscale name resolves to.
func TestPublicAddr(t *testing.T) {
	cases := []struct {
		ip     string
		public bool
	}{
		{"8.8.8.8", true},
		{"2606:4700:4700::1111", true},
		{"100.128.0.1", true}, // just past the CGNAT range
		{"127.0.0.1", false},
		{"10.1.2.3", false},
		{"172.16.0.1", false},
		{"192.168.1.42", false},
		{"169.254.1.1", false},
		{"100.64.0.1", false}, // CGNAT / Tailscale
		{"100.127.255.255", false},
		{"198.18.0.1", false}, // benchmarking
		{"198.19.255.255", false},
		{"192.0.0.1", false}, // IETF protocol assignments
		{"0.1.2.3", false},
		{"0.0.0.0", false},
		{"255.255.255.255", false},
		{"224.0.0.1", false},
		{"fe80::1", false},
		{"fc00::1", false},
		{"::1", false},
		{"::", false},
		{"64:ff9b::7f00:1", false}, // NAT64 wrapping 127.0.0.1
		{"::ffff:10.0.0.1", false}, // IPv4-mapped private address
	}
	for _, tc := range cases {
		ip := net.ParseIP(tc.ip)
		if ip == nil {
			t.Fatalf("bad test address %q", tc.ip)
		}
		if got := publicAddr(ip); got != tc.public {
			t.Errorf("publicAddr(%s) = %v, want %v", tc.ip, got, tc.public)
		}
	}
}

func TestManageableEndpoint(t *testing.T) {
	cases := []struct {
		in  string
		bad bool
	}{
		{"https://push.example.net/send/abc", false},
		{"http://push.example.net/send/abc", true},
		{"", true},
		{"not a url", true},
		{"/send/abc", true},
	}
	for _, tc := range cases {
		err := ManageableEndpoint(tc.in)
		if (err != nil) != tc.bad {
			t.Errorf("ManageableEndpoint(%q) = %v", tc.in, err)
		}
	}
}

func mustKeys(t *testing.T) *Keys {
	t.Helper()
	k, err := GenerateKeys()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	return k
}
