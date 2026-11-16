package api

// KIN-NOTIFY-001: device registration, ownership, and failure reporting.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/apns"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// scriptedAPNs answers with one prepared result and records what it was asked
// to send, so the endpoint tests never reach Apple.
type scriptedAPNs struct {
	mu      sync.Mutex
	result  apns.Result
	tokens  []string
	payload []apns.Notification
}

func (f *scriptedAPNs) Configured() bool { return true }

func (f *scriptedAPNs) Send(ctx context.Context, token string, env apns.Environment, n apns.Notification) apns.Result {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tokens = append(f.tokens, token)
	f.payload = append(f.payload, n)
	return f.result
}

func (f *scriptedAPNs) sent() ([]string, []apns.Notification) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.tokens...), append([]apns.Notification(nil), f.payload...)
}

func pushDeviceRequest(t *testing.T, h http.Handler, token, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

const testAPNsToken = "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb"

func TestPushDeviceRegisterValidation(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	cases := []struct{ name, body string }{
		{"invalid json", `{`},
		{"short install", `{"install_id":"short","platform":"ios","token":"` + testAPNsToken + `","environment":"sandbox"}`},
		{"install punctuation", `{"install_id":"has space here","platform":"ios","token":"` + testAPNsToken + `","environment":"sandbox"}`},
		{"wrong platform", `{"install_id":"install-0001","platform":"android","token":"` + testAPNsToken + `","environment":"sandbox"}`},
		{"short token", `{"install_id":"install-0001","platform":"ios","token":"abcd","environment":"sandbox"}`},
		{"non-hex token", `{"install_id":"install-0001","platform":"ios","token":"` + strings.Repeat("zz", 32) + `","environment":"sandbox"}`},
		{"missing environment", `{"install_id":"install-0001","platform":"ios","token":"` + testAPNsToken + `"}`},
		{"wrong environment", `{"install_id":"install-0001","platform":"ios","token":"` + testAPNsToken + `","environment":"staging"}`},
		{"long name", `{"install_id":"install-0001","platform":"ios","token":"` + testAPNsToken + `","environment":"sandbox","name":"` + strings.Repeat("n", 101) + `"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rr := pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices", c.body)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
			}
			if strings.Contains(rr.Body.String(), testAPNsToken) {
				t.Fatal("response echoed the device token")
			}
		})
	}

	// A rejected registration must not leave a row behind.
	n, err := s.Store.CountPushDevices(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("devices=%d after rejected registrations", n)
	}
}

// KIN-NOTIFY-001: a member's registration must name the login that made it.
// The auth wiring always supplies one; a principal without it is refused
// rather than stored as a row no logout could ever reach.
func TestRegisterRefusesAMemberPrincipalWithoutASession(t *testing.T) {
	s, _, _ := newAuthTestServer(t)
	h := s.Handler()
	s.Auth.SetSessionLookup(func(_ context.Context, token string) (remote.Principal, bool) {
		if token != "session-value" {
			return remote.Principal{}, false
		}
		return remote.Principal{Kind: remote.PrincipalUser, UserID: "user-1", Role: store.RoleMember}, true
	})
	body := `{"install_id":"install-phone","platform":"ios","token":"` + testAPNsToken +
		`","environment":"sandbox"}`
	req := httptest.NewRequest(http.MethodPost, "/api/push/devices", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: remote.SessionCookieName, Value: "session-value"})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	n, err := s.Store.CountPushDevices(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("devices=%d after a refused registration", n)
	}
}

func TestPushDeviceRegisterAndReregister(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	body := `{"install_id":"install-0001","platform":"ios","token":"` + testAPNsToken + `","environment":"sandbox","name":"iPhone"}`
	rr := pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", rr.Code, rr.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == "" {
		t.Fatal("register returned no id")
	}

	// The same installation re-registers after a token rotation: the row keeps
	// its id and the old token, which Apple no longer accepts, is replaced.
	newToken := strings.Repeat("1a", 32)
	body = `{"install_id":"install-0001","platform":"ios","token":"` + newToken + `","environment":"production"}`
	rr = pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices", body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("re-register: %d %s", rr.Code, rr.Body.String())
	}
	var again struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &again); err != nil {
		t.Fatal(err)
	}
	if again.ID != created.ID {
		t.Fatalf("id changed on re-register: %q -> %q", created.ID, again.ID)
	}
	devices, err := s.Store.ListPushDevices(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].Token != newToken || devices[0].Environment != "production" {
		t.Fatalf("devices=%+v", devices)
	}
}

func TestPushDeviceListOmitsTokenAndReportsCredentials(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	body := `{"install_id":"install-0001","platform":"ios","token":"` + testAPNsToken + `","environment":"sandbox","name":"iPhone"}`
	if rr := pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices", body); rr.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", rr.Code, rr.Body.String())
	}

	// Credentials are metadata on the node; the status must not need the key.
	for key, value := range map[string]string{
		apns.KeyKeyID: "KEY123", apns.KeyTeamID: "TEAM123", apns.KeyTopic: "dev.openkin.ios",
	} {
		if err := s.Store.SetSetting(context.Background(), key, value); err != nil {
			t.Fatal(err)
		}
	}
	rr := pushDeviceRequest(t, h, token, http.MethodGet, "/api/push/devices", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rr.Code, rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), testAPNsToken) {
		t.Fatalf("list leaked the token: %s", rr.Body.String())
	}
	var out pushDevicesResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.APNsConfigured {
		t.Fatal("apns_configured=false with credentials configured")
	}
	if len(out.Devices) != 1 || out.Devices[0].Name != "iPhone" || out.Devices[0].Environment != "sandbox" {
		t.Fatalf("devices=%+v", out.Devices)
	}

	// Without credentials the page must say so rather than imply the phone is on.
	if err := s.Store.DeleteSettings(context.Background(),
		apns.KeyKeyID, apns.KeyTeamID, apns.KeyTopic); err != nil {
		t.Fatal(err)
	}
	rr = pushDeviceRequest(t, h, token, http.MethodGet, "/api/push/devices", "")
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.APNsConfigured {
		t.Fatal("apns_configured=true without credentials")
	}
}

// `kin notify apns` writes credentials from another process. A list or a test
// send built from the startup snapshot would keep claiming the node cannot
// reach iPhones until the daemon restarts.
func TestPushDeviceUsesCredentialsLoadedAfterStartup(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	body := `{"install_id":"install-0001","platform":"ios","token":"` + testAPNsToken + `","environment":"sandbox"}`
	rr := pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices", body)
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	fake := &scriptedAPNs{result: apns.Result{OK: true, Status: http.StatusOK}}
	s.APNsFor = func(context.Context) (APNsSender, error) { return fake, nil }
	for key, value := range map[string]string{
		apns.KeyKeyID: "KEY123", apns.KeyTeamID: "TEAM123", apns.KeyTopic: "dev.openkin.ios",
	} {
		if err := s.Store.SetSetting(context.Background(), key, value); err != nil {
			t.Fatal(err)
		}
	}

	rr = pushDeviceRequest(t, h, token, http.MethodGet, "/api/push/devices", "")
	var list pushDevicesResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if !list.APNsConfigured {
		t.Fatal("list still says APNs is unconfigured after the credentials appeared")
	}

	rr = pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices/test", `{"id":"`+created.ID+`"}`)
	var test pushTestResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &test); err != nil {
		t.Fatal(err)
	}
	if !test.OK || len(test.Results) != 1 {
		t.Fatalf("test=%+v", test)
	}
	if tokens, _ := fake.sent(); len(tokens) != 1 || tokens[0] != testAPNsToken {
		t.Fatalf("live client was not used: %v", tokens)
	}
}

func TestPushDeviceDelete(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	body := `{"install_id":"install-0001","platform":"ios","token":"` + testAPNsToken + `","environment":"sandbox"}`
	rr := pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices", body)
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	if rr := pushDeviceRequest(t, h, token, http.MethodDelete, "/api/push/devices/missing", ""); rr.Code != http.StatusNotFound {
		t.Fatalf("unknown delete: %d", rr.Code)
	}
	if rr := pushDeviceRequest(t, h, token, http.MethodDelete, "/api/push/devices/"+created.ID, ""); rr.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rr.Code, rr.Body.String())
	}
	if rr := pushDeviceRequest(t, h, token, http.MethodDelete, "/api/push/devices/"+created.ID, ""); rr.Code != http.StatusNotFound {
		t.Fatalf("second delete: %d", rr.Code)
	}
}

func TestPushDeviceTestEndpoint(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	body := `{"install_id":"install-0001","platform":"ios","token":"` + testAPNsToken + `","environment":"sandbox"}`
	rr := pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices", body)
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	testBody := `{"id":"` + created.ID + `"}`

	// No credentials: the page gets a configured=false answer and no send.
	rr = pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices/test", testBody)
	if rr.Code != http.StatusOK {
		t.Fatalf("unconfigured test: %d %s", rr.Code, rr.Body.String())
	}
	var unconfigured pushTestResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &unconfigured); err != nil {
		t.Fatal(err)
	}
	if unconfigured.Configured || unconfigured.OK || len(unconfigured.Results) != 0 {
		t.Fatalf("unconfigured=%+v", unconfigured)
	}

	fake := &scriptedAPNs{result: apns.Result{OK: true, Status: http.StatusOK}}
	s.APNs = fake
	rr = pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices/test", testBody)
	if rr.Code != http.StatusOK {
		t.Fatalf("test: %d %s", rr.Code, rr.Body.String())
	}
	var ok pushTestResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &ok); err != nil {
		t.Fatal(err)
	}
	if !ok.OK || !ok.Configured || len(ok.Results) != 1 || ok.Results[0].Channel != "apns" || !ok.Results[0].OK {
		t.Fatalf("response=%+v", ok)
	}
	sentTokens, sentPayloads := fake.sent()
	if len(sentTokens) != 1 || sentTokens[0] != testAPNsToken {
		t.Fatalf("sent=%v", sentTokens)
	}
	if sentPayloads[0].Kind != "test" || sentPayloads[0].URL != "/settings" {
		t.Fatalf("payload=%+v", sentPayloads[0])
	}
	device, err := s.Store.GetPushDevice(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if device.LastOKAt == 0 || device.LastError != "" {
		t.Fatalf("device after success=%+v", device)
	}

	// A token Apple will never accept again is deleted, not left to fail every
	// later notification.
	fake.mu.Lock()
	fake.result = apns.Result{Status: http.StatusGone, Reason: "Unregistered", Expired: true}
	fake.mu.Unlock()
	rr = pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices/test", testBody)
	if rr.Code != http.StatusOK {
		t.Fatalf("expired test: %d %s", rr.Code, rr.Body.String())
	}
	var expired pushTestResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &expired); err != nil {
		t.Fatal(err)
	}
	if expired.OK || len(expired.Results) != 1 || expired.Results[0].Error != "Unregistered" || expired.Results[0].Status != "" {
		t.Fatalf("expired=%+v", expired)
	}
	if _, err := s.Store.GetPushDevice(context.Background(), created.ID); err == nil {
		t.Fatal("expired device still registered")
	}
}

// A store that cannot answer is not a missing row: 404 would make the console
// treat the registration as gone and forget the pending deletion.
func TestPushDeviceStoreFailureIsNotNotFound(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()
	body := `{"install_id":"install-0001","platform":"ios","token":"` + testAPNsToken + `","environment":"sandbox"}`
	rr := pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices", body)
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if err := s.Store.Close(); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/push/devices", ""},
		{http.MethodDelete, "/api/push/devices/" + created.ID, ""},
		{http.MethodPost, "/api/push/devices/test", `{"id":"` + created.ID + `"}`},
	} {
		if rr := pushDeviceRequest(t, h, token, tc.method, tc.path, tc.body); rr.Code != http.StatusInternalServerError {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, rr.Code, rr.Body.String())
		}
	}
}

func TestPushDeviceRoutesRequireAuth(t *testing.T) {
	s, _ := newTestServer(t)
	h := s.Handler()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/push/devices"},
		{http.MethodPost, "/api/push/devices"},
		{http.MethodDelete, "/api/push/devices/x"},
		{http.MethodPost, "/api/push/devices/test"},
	} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}")))
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s: %d", tc.method, tc.path, rr.Code)
		}
	}
}

// A member may register the phone they are holding and manage that row; they
// may not see, test, or delete the owner's. The row carries the account so
// APNs delivery does not ring a member's phone for someone else's work.
func TestPushDeviceRoutesScopeMembersToTheirOwnRows(t *testing.T) {
	s, _, code := newAuthTestServer(t)
	h := s.Handler()
	owner := &authClient{t: t, h: h}
	claimOwner(t, owner, code)
	member := joinMember(t, s, h, "member-account", "member@example.com")

	if _, err := s.Store.SavePushDevice(context.Background(), store.PushDevice{
		ID: "pd1", InstallID: "install-0001", Platform: "ios", Token: testAPNsToken,
		Environment: "sandbox", UpdatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	// The owner's operator-wide row is not theirs to see.
	rec := member.do(http.MethodGet, "/api/push/devices", "")
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), `"pd1"`) {
		t.Fatalf("member list: %d %s", rec.Code, rec.Body.String())
	}
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodDelete, "/api/push/devices/pd1", ""},
		{http.MethodPost, "/api/push/devices/test", `{"id":"pd1"}`},
	} {
		if rec := member.do(tc.method, tc.path, tc.body); rec.Code != http.StatusForbidden {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, rec.Code, rec.Body.String())
		}
	}
	if _, err := s.Store.GetPushDevice(context.Background(), "pd1"); err != nil {
		t.Fatalf("member deleted the owner's device: %v", err)
	}

	// Registering is a self-service action, and the row is stamped with the
	// member's account rather than becoming another operator-wide row.
	body := `{"install_id":"install-member","platform":"ios","token":"` + strings.Repeat("2b", 32) + `","environment":"sandbox"}`
	rec = member.do(http.MethodPost, "/api/push/devices", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("member register: %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	device, err := s.Store.GetPushDevice(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if device.OwnerUserID == "" {
		t.Fatalf("member registration has no owner: %+v", device)
	}
}

// The Bark / ntfy / Web Push endpoints are gone, not deprecated: a client that
// still calls them must be told they do not exist.
func TestLegacyPushEndpointsAreGone(t *testing.T) {
	s, token := newTestServer(t)
	// The production router serves the SPA for unknown pages. A retired API
	// path must still be a JSON 404, not index.html with a 200.
	s.Static = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<!doctype html>"))
	})
	h := s.Handler()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/push/config"},
		{http.MethodPost, "/api/push/subscribe"},
		{http.MethodDelete, "/api/push/subscribe"},
		{http.MethodPost, "/api/push/test"},
	} {
		rr := pushDeviceRequest(t, h, token, tc.method, tc.path, "{}")
		if rr.Code != http.StatusNotFound {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, rr.Code, rr.Body.String())
		}
		if strings.Contains(rr.Body.String(), "<!doctype html>") {
			t.Fatalf("%s %s fell through to the SPA", tc.method, tc.path)
		}
	}
}

// The SPA fallback is a NotFound handler, not a catch-all route: pages still
// fall through to index.html, but a wrong method on a real endpoint is 405 and
// a path under /api that matched nothing is a JSON 404.
func TestStaticFallbackKeepsTheAPIContract(t *testing.T) {
	s, token := newTestServer(t)
	s.Static = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<!doctype html>"))
	})
	h := s.Handler()

	rr := pushDeviceRequest(t, h, token, http.MethodGet, "/api/push/devices/test", "")
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("wrong method: %d %s", rr.Code, rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "<!doctype html>") {
		t.Fatal("a method error fell through to the SPA")
	}

	rr = pushDeviceRequest(t, h, token, http.MethodGet, "/inbox", "")
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "<!doctype html>") {
		t.Fatalf("console page: %d %s", rr.Code, rr.Body.String())
	}
}

// A registered device's last error is what the settings page shows when a phone
// stops ringing; it must survive a later success being recorded as a timestamp.
func TestPushDeviceTestRecordsFailure(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()
	body := `{"install_id":"install-0001","platform":"ios","token":"` + testAPNsToken + `","environment":"sandbox"}`
	rr := pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices", body)
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	s.APNs = &scriptedAPNs{result: apns.Result{Status: http.StatusServiceUnavailable, Reason: "ServiceUnavailable"}}
	rr = pushDeviceRequest(t, h, token, http.MethodPost, "/api/push/devices/test", `{"id":"`+created.ID+`"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("test: %d %s", rr.Code, rr.Body.String())
	}
	device, err := s.Store.GetPushDevice(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if device.LastError != "ServiceUnavailable" || device.LastOKAt != 0 {
		t.Fatalf("device=%+v", device)
	}
	if device.LastAttemptAt < time.Now().Add(-time.Minute).UnixMilli() {
		t.Fatalf("last attempt not recorded: %+v", device)
	}
}

// KIN-NOTIFY-001: a phone that registers while signed in must stop receiving
// when it signs out. The registration belongs to that login, and logging out
// deletes it — no app cooperation and no second request needed.
func TestSignOutDeletesThePhonesRegistration(t *testing.T) {
	s, master, code := newAuthTestServer(t)
	h := s.Handler()
	owner := &authClient{t: t, h: h, master: master}
	if rec := owner.post("/api/auth/bootstrap",
		`{"code":"`+code+`","email":"owner@example.com","password":"hunter2hunter2"}`); rec.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}

	// No master token here: the registration has to come through the cookie,
	// which is what makes it session-bound.
	phone := &authClient{t: t, h: h}
	if rec := phone.post("/api/auth/login",
		`{"email":"owner@example.com","password":"hunter2hunter2"}`); rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
	}
	body := `{"install_id":"install-phone","platform":"ios","token":"` + testAPNsToken +
		`","environment":"sandbox","name":"iPhone"}`
	if rec := phone.post("/api/push/devices", body); rec.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}

	devices, err := s.Store.ListPushDevices(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 {
		t.Fatalf("devices = %+v", devices)
	}
	if devices[0].OwnerUserID == "" || devices[0].OwnerSessionID == "" {
		t.Fatalf("registration is not bound to the login: %+v", devices[0])
	}
	sessionID := devices[0].OwnerSessionID
	if !s.Store.AuthSessionLive(context.Background(), sessionID) {
		t.Fatal("the session that registered the phone is not live")
	}

	if rec := phone.post("/api/auth/logout", ""); rec.Code != http.StatusOK {
		t.Fatalf("logout: %d %s", rec.Code, rec.Body.String())
	}
	devices, err = s.Store.ListPushDevices(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 0 {
		t.Fatalf("signing out left the phone registered: %+v", devices)
	}
	if s.Store.AuthSessionLive(context.Background(), sessionID) {
		t.Fatal("the signed-out session is still reported as live")
	}
}

// KIN-NOTIFY-001: a test send is still a send. A registration whose login ended
// must not ring, and the node deletes the dead row instead of leaving it in the
// list for another session to test again.
func TestTestPushDeviceRefusesARegistrationWhoseSessionEnded(t *testing.T) {
	s, master, code := newAuthTestServer(t)
	fake := &scriptedAPNs{result: apns.Result{OK: true}}
	s.APNs = fake
	h := s.Handler()
	owner := &authClient{t: t, h: h, master: master}
	if rec := owner.post("/api/auth/bootstrap",
		`{"code":"`+code+`","email":"owner@example.com","password":"hunter2hunter2"}`); rec.Code != http.StatusOK {
		t.Fatalf("claim: %d %s", rec.Code, rec.Body.String())
	}
	phone := &authClient{t: t, h: h}
	if rec := phone.post("/api/auth/login",
		`{"email":"owner@example.com","password":"hunter2hunter2"}`); rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
	}
	body := `{"install_id":"install-phone","platform":"ios","token":"` + testAPNsToken +
		`","environment":"sandbox","name":"iPhone"}`
	rec := phone.post("/api/push/devices", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.ID == "" {
		t.Fatalf("register response: %s", rec.Body.String())
	}
	devices, err := s.Store.ListPushDevices(context.Background())
	if err != nil || len(devices) != 1 {
		t.Fatalf("devices = %+v, %v", devices, err)
	}
	// End the login behind the store's back: the row a crash between the two
	// deletes, or a session that expired before the next prune, leaves behind.
	if _, err := s.Store.DB().ExecContext(context.Background(),
		`DELETE FROM auth_sessions WHERE id = ?`, devices[0].OwnerSessionID); err != nil {
		t.Fatal(err)
	}

	rec = owner.post("/api/push/devices/test", `{"id":"`+created.ID+`"}`)
	if rec.Code != http.StatusGone {
		t.Fatalf("test on a dead session: %d %s", rec.Code, rec.Body.String())
	}
	if tokens, _ := fake.sent(); len(tokens) != 0 {
		t.Fatalf("the dead registration was sent: %v", tokens)
	}
	if n, _ := s.Store.CountPushDevices(context.Background()); n != 0 {
		t.Fatalf("the dead registration stayed listed: %d", n)
	}
}
