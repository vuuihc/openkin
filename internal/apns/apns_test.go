// KIN-NOTIFY-001: native notifications deliver through APNs.
package apns

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testKey(t *testing.T) (*ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return key, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

func testClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	_, pemBytes := testKey(t)
	key, err := ParsePrivateKey(pemBytes)
	if err != nil {
		t.Fatal(err)
	}
	c, err := New(Config{
		KeyID:      "KEY123",
		TeamID:     "TEAM123",
		Topic:      "dev.openkin.ios",
		PrivateKey: key,
		BaseURL:    baseURL,
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestSendBuildsAPNsRequest(t *testing.T) {
	var seen struct {
		path, topic, pushType, priority, collapse, auth string
		body                                            map[string]any
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.path = r.URL.Path
		seen.topic = r.Header.Get("apns-topic")
		seen.pushType = r.Header.Get("apns-push-type")
		seen.priority = r.Header.Get("apns-priority")
		seen.collapse = r.Header.Get("apns-collapse-id")
		seen.auth = r.Header.Get("authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &seen.body)
		w.Header().Set("apns-id", "APNS-1")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	res := c.Send(context.Background(), "abc123", Sandbox, Notification{
		Title: "Fix the login bug", Body: "Approval needed", URL: "/inbox?focus=a1",
		Kind: "approval", ID: "a1", ThreadID: "a1",
	})
	if !res.OK || res.APNSID != "APNS-1" {
		t.Fatalf("result = %+v", res)
	}
	if seen.path != "/3/device/abc123" {
		t.Errorf("path = %q", seen.path)
	}
	if seen.topic != "dev.openkin.ios" || seen.pushType != "alert" || seen.priority != "10" {
		t.Errorf("headers = topic %q type %q priority %q", seen.topic, seen.pushType, seen.priority)
	}
	if seen.collapse != "a1" {
		t.Errorf("apns-collapse-id = %q, want the target id", seen.collapse)
	}
	parts := strings.Split(strings.TrimPrefix(seen.auth, "bearer "), ".")
	if len(parts) != 3 {
		t.Fatalf("authorization is not a JWT: %q", seen.auth)
	}
	header, _ := base64.RawURLEncoding.DecodeString(parts[0])
	claims, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var h map[string]string
	var cl map[string]any
	_ = json.Unmarshal(header, &h)
	_ = json.Unmarshal(claims, &cl)
	if h["alg"] != "ES256" || h["kid"] != "KEY123" {
		t.Errorf("jwt header = %v", h)
	}
	if cl["iss"] != "TEAM123" {
		t.Errorf("jwt claims = %v", cl)
	}
	// Verify the signature over the signing input with the public key.
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	if len(sig) != 64 {
		t.Fatalf("signature length = %d", len(sig))
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(c.cfg.PrivateKey.Public().(*ecdsa.PublicKey), digest[:],
		new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Error("provider token signature does not verify")
	}
	aps, _ := seen.body["aps"].(map[string]any)
	alert, _ := aps["alert"].(map[string]any)
	if alert["title"] != "Fix the login bug" || alert["body"] != "Approval needed" {
		t.Errorf("alert = %v", alert)
	}
	kin, _ := seen.body["kin"].(map[string]any)
	if kin["kind"] != "approval" || kin["id"] != "a1" || kin["url"] != "/inbox?focus=a1" {
		t.Errorf("kin = %v", kin)
	}
}

func TestSendExpiredToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGone)
		_, _ = w.Write([]byte(`{"reason":"Unregistered"}`))
	}))
	defer srv.Close()

	res := testClient(t, srv.URL).Send(context.Background(), "dead", Production, Notification{Title: "x"})
	if res.OK || !res.Expired || res.Reason != "Unregistered" {
		t.Fatalf("result = %+v", res)
	}
}

// KIN-NOTIFY-001: a transport failure must not copy the device token into the
// reason, which is stored on the row and shown in Settings.
func TestTransportFailureDoesNotLeakTheToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	base := srv.URL
	srv.Close() // nothing is listening: http.Do fails with a *url.Error

	const token = "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb"
	res := testClient(t, base).Send(context.Background(), token, Production, Notification{Title: "x"})
	if res.OK || res.Reason == "" {
		t.Fatalf("result = %+v", res)
	}
	if strings.Contains(res.Reason, token) || strings.Contains(res.Reason, "3/device") {
		t.Fatalf("reason leaked the request URL: %q", res.Reason)
	}
}

func TestProviderTokenIsCached(t *testing.T) {
	var auths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auths = append(auths, r.Header.Get("authorization"))
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	c.now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	for i := 0; i < 2; i++ {
		if res := c.Send(context.Background(), "t", Production, Notification{Title: "x"}); !res.OK {
			t.Fatalf("send %d: %+v", i, res)
		}
	}
	if len(auths) != 2 || auths[0] != auths[1] {
		t.Fatalf("provider token was re-minted: %v", auths)
	}
}

func TestNewRequiresCredentials(t *testing.T) {
	if _, err := New(Config{Topic: "x"}); err != ErrNotConfigured {
		t.Fatalf("err = %v", err)
	}
}

func TestParsePrivateKeyRejectsGarbage(t *testing.T) {
	if _, err := ParsePrivateKey([]byte("not a key")); err == nil {
		t.Fatal("expected an error")
	}
}

// recordingSettings serves the non-secret metadata and records every key a
// passive check asks for. Reading the private key here is the bug the type
// exists to catch, so it answers with an error rather than a key.
type recordingSettings struct {
	values map[string]string
	read   []string
}

func (r *recordingSettings) GetSetting(_ context.Context, key string) (string, error) {
	r.read = append(r.read, key)
	if key == KeyPrivateKey {
		return "", errors.New("passive status read the private key")
	}
	return r.values[key], nil
}

// KIN-NOTIFY-001: Settings may say "configured" from metadata alone. Reading
// the key on a passive view either fails there or puts a secret in a path that
// was only meant to answer yes/no; every one of the three fields is required,
// because an identity missing one cannot send.
func TestConfiguredInSettingsRequiresMetadataAndNeverReadsTheKey(t *testing.T) {
	full := map[string]string{KeyKeyID: "KEY123", KeyTeamID: "TEAM123", KeyTopic: "dev.openkin.ios"}
	settings := &recordingSettings{values: full}
	if !ConfiguredInSettings(context.Background(), settings) {
		t.Fatal("complete metadata reported as unconfigured")
	}
	for _, key := range settings.read {
		if key == KeyPrivateKey {
			t.Fatal("passive status read the private key")
		}
	}

	for _, missing := range []string{KeyKeyID, KeyTeamID, KeyTopic} {
		partial := map[string]string{}
		for key, value := range full {
			if key != missing {
				partial[key] = value
			}
		}
		if ConfiguredInSettings(context.Background(), &recordingSettings{values: partial}) {
			t.Fatalf("reported configured without %s", missing)
		}
	}
}

// `kin notify apns --status` answers from metadata alone. A key that does not
// parse is a send-time problem; asking whether the node is configured must not
// turn into a secret read or a failure.
func TestStatusReportsTopicAndEnvironmentWithoutTheKey(t *testing.T) {
	settings := &recordingSettings{values: map[string]string{
		KeyKeyID: "KEY123", KeyTeamID: "TEAM123", KeyTopic: "dev.openkin.ios",
		KeyPrivateKey: "not a signing key",
	}}
	topic, env, ok := Status(context.Background(), settings)
	if !ok || topic != "dev.openkin.ios" || env != Production {
		t.Fatalf("status = %q / %q / %v", topic, env, ok)
	}
	for _, key := range settings.read {
		if key == KeyPrivateKey {
			t.Fatal("status read the private key")
		}
	}

	settings = &recordingSettings{values: map[string]string{
		KeyKeyID: "KEY123", KeyTeamID: "TEAM123", KeyTopic: "dev.openkin.ios",
		KeyEnvironment: string(Sandbox),
	}}
	if _, env, ok := Status(context.Background(), settings); !ok || env != Sandbox {
		t.Fatalf("status = %q / %v, want the recorded environment", env, ok)
	}

	if _, _, ok := Status(context.Background(), &recordingSettings{values: map[string]string{
		KeyKeyID: "KEY123",
	}}); ok {
		t.Fatal("status reported configured without a team id and topic")
	}
}

// KIN-NOTIFY-001: Apple rejects a collapse id over 64 bytes.
func TestCollapseIDFitsTheHeaderLimit(t *testing.T) {
	for _, tc := range []struct {
		in, want string
	}{
		{"", ""},
		{"a1", "a1"},
		{strings.Repeat("x", 64), strings.Repeat("x", 64)},
		{strings.Repeat("y", 65), strings.Repeat("y", 64)},
	} {
		if got := collapseID(tc.in); got != tc.want {
			t.Errorf("collapseID(%d bytes) = %q", len(tc.in), got)
		}
	}
}

// KIN-NOTIFY-001: Apple refuses a payload over 4 KiB. The limit is enforced on
// the actual serialized body, so JSON escaping (<>& and control characters) and
// multibyte text cannot sneak past a byte-based string cutoff. The routing
// fields survive; only title and body shrink.
func TestSendClipsPayloadTo4KiBOnTheWire(t *testing.T) {
	var bodies [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		bodies = append(bodies, raw)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	longTitle := "报<&>\n" + strings.Repeat("告", 3000)
	longBody := strings.Repeat("><&", 3000) + "☃"
	res := c.Send(context.Background(), "tok", Sandbox, Notification{
		Title: longTitle, Body: longBody,
		URL: "/machines/dev-1/tasks/task-9", Kind: "routine", ID: "task-9", ThreadID: "task-9",
	})
	if !res.OK || res.Reason != "" {
		t.Fatalf("result = %+v", res)
	}
	if len(bodies) != 1 {
		t.Fatalf("requests = %d, want 1", len(bodies))
	}
	if len(bodies[0]) > 4096 {
		t.Fatalf("serialized body = %d bytes, over 4096", len(bodies[0]))
	}
	var decoded map[string]any
	if err := json.Unmarshal(bodies[0], &decoded); err != nil {
		t.Fatalf("body is not valid JSON: %v", err)
	}
	kin, _ := decoded["kin"].(map[string]any)
	if kin["kind"] != "routine" || kin["id"] != "task-9" || kin["url"] != "/machines/dev-1/tasks/task-9" {
		t.Fatalf("routing fields were not preserved: %v", kin)
	}
	aps, _ := decoded["aps"].(map[string]any)
	if aps["thread-id"] != "task-9" {
		t.Fatalf("thread-id was not preserved: %v", aps)
	}
	alert, _ := aps["alert"].(map[string]any)
	title, _ := alert["title"].(string)
	body, _ := alert["body"].(string)
	if !strings.HasPrefix(longTitle, title) {
		t.Fatalf("title was not a UTF-8 prefix of the source")
	}
	if !strings.HasPrefix(longBody, body) {
		t.Fatalf("body was not a UTF-8 prefix of the source")
	}
	if title == longTitle && body == longBody {
		t.Fatalf("expected the oversized alert text to be clipped")
	}
}

// TestSendRejectsImpossibleMetadata: when the routing fields alone exceed the
// cap there is no alert text left to clip, so the send fails before any HTTP
// request is made.
func TestSendRejectsImpossibleMetadata(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := testClient(t, srv.URL)
	res := c.Send(context.Background(), "tok", Sandbox, Notification{
		Title: "x", Body: "y",
		URL:      "/routines?d=" + strings.Repeat("x", 4000),
		Kind:     "routine",
		ID:       strings.Repeat("r", 4000),
		ThreadID: strings.Repeat("t", 4000),
	})
	if res.OK {
		t.Fatalf("oversized metadata send succeeded: %+v", res)
	}
	if requests != 0 {
		t.Fatalf("an impossible metadata payload reached Apple (%d requests)", requests)
	}
}
