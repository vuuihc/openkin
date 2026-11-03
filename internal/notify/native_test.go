// KIN-NOTIFY-001: native notifications — desktop fan-out and APNs delivery.
package notify

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/apns"
	"github.com/vuuihc/openkin/internal/store"
)

type fakeSettings struct {
	mu    sync.Mutex
	vals  map[string]string
	reads []string
}

func (f *fakeSettings) GetSetting(_ context.Context, key string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads = append(f.reads, key)
	if v, ok := f.vals[key]; ok {
		return v, nil
	}
	return "", store.ErrNotFound
}

type fakeDevices struct {
	mu      sync.Mutex
	devices []store.PushDevice
	marked  map[string]string
	deleted []string
}

func (f *fakeDevices) ListPushDevices(context.Context) ([]store.PushDevice, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]store.PushDevice, len(f.devices))
	copy(out, f.devices)
	return out, nil
}

func (f *fakeDevices) ListPushDevicesForOwner(ctx context.Context, ownerUserID string) ([]store.PushDevice, error) {
	all, err := f.ListPushDevices(ctx)
	if err != nil {
		return nil, err
	}
	out := all[:0]
	for _, d := range all {
		if d.OwnerUserID == "" || d.OwnerUserID == ownerUserID {
			out = append(out, d)
		}
	}
	return out, nil
}

func (f *fakeDevices) MarkPushDeviceResult(_ context.Context, id string, _ int64, errMsg string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.marked == nil {
		f.marked = map[string]string{}
	}
	f.marked[id] = errMsg
	return nil
}

func (f *fakeDevices) DeletePushDeviceByToken(_ context.Context, token string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, token)
	return nil
}

type fakeAPNs struct {
	configured bool
	results    map[string]apns.Result
	mu         sync.Mutex
	sent       []apns.Notification
	tokens     []string
}

func (f *fakeAPNs) Configured() bool { return f.configured }

func (f *fakeAPNs) Send(_ context.Context, token string, _ apns.Environment, n apns.Notification) apns.Result {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, n)
	f.tokens = append(f.tokens, token)
	if r, ok := f.results[token]; ok {
		return r
	}
	return apns.Result{OK: true}
}

type fakePublisher struct {
	mu     sync.Mutex
	events []Event
}

func (f *fakePublisher) PublishNotify(ev Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, ev)
}

func (f *fakePublisher) published() []Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Event(nil), f.events...)
}

func (f *fakeAPNs) sentNotifications() []apns.Notification {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]apns.Notification(nil), f.sent...)
}

func (f *fakeAPNs) sentTokens() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.tokens...)
}

// waitFor polls an asynchronous Send without assuming how the goroutines are
// scheduled.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("timed out waiting for delivery")
}

func TestDeliverFansOutToDesktopAndAPNs(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{{
		ID: "d1", InstallID: "i1", Platform: "ios", Token: "token-1", Environment: "sandbox",
	}}}
	pusher := &fakeAPNs{configured: true}
	pub := &fakePublisher{}
	s := &Sender{
		Store:   &fakeSettings{vals: map[string]string{}},
		Devices: devices,
		APNs:    pusher,
		Events:  pub,
	}
	results := s.Deliver(context.Background(), Payload{
		Title: "Fix the login bug", Body: "Approval needed", URL: "/inbox?focus=a1",
		Kind: "approval", ID: "a1", TaskID: "t1",
	})
	if len(results) != 1 || !results[0].OK || results[0].Channel != "apns" || results[0].Device != "d1" {
		t.Fatalf("results = %+v", results)
	}
	if len(pub.events) != 1 {
		t.Fatalf("desktop events = %d", len(pub.events))
	}
	ev := pub.events[0]
	if ev.Kind != "approval" || ev.ID != "a1" || ev.URL != "/inbox?focus=a1" || ev.TaskID != "t1" {
		t.Fatalf("event = %+v", ev)
	}
	if len(pusher.sent) != 1 || pusher.tokens[0] != "token-1" {
		t.Fatalf("apns sends = %+v / %v", pusher.sent, pusher.tokens)
	}
	got := pusher.sent[0]
	if got.Kind != "approval" || got.ID != "a1" || got.URL != "/inbox?focus=a1" {
		t.Fatalf("apns notification = %+v", got)
	}
	if devices.marked["d1"] != "" {
		t.Fatalf("success was recorded as an error: %q", devices.marked["d1"])
	}
}

func TestDeliverWithoutAPNsStillReachesDesktop(t *testing.T) {
	pub := &fakePublisher{}
	s := &Sender{Store: &fakeSettings{}, Events: pub}
	results := s.Deliver(context.Background(), Payload{Title: "t", Kind: "task", ID: "x"})
	if results != nil {
		t.Fatalf("results = %+v, want none", results)
	}
	if len(pub.events) != 1 || pub.events[0].Kind != "task" {
		t.Fatalf("events = %+v", pub.events)
	}
}

func TestDeliverExpiredTokenRemovesTheDevice(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{{
		ID: "d1", InstallID: "i1", Platform: "ios", Token: "dead", Environment: "production",
	}}}
	pusher := &fakeAPNs{
		configured: true,
		results:    map[string]apns.Result{"dead": {Expired: true, Reason: "Unregistered", Status: 410}},
	}
	s := &Sender{Store: &fakeSettings{}, Devices: devices, APNs: pusher}
	results := s.Deliver(context.Background(), Payload{Title: "t", Kind: "task", ID: "x"})
	if len(results) != 1 || results[0].OK || results[0].Error != "Unregistered" {
		t.Fatalf("results = %+v", results)
	}
	if len(devices.deleted) != 1 || devices.deleted[0] != "dead" {
		t.Fatalf("deleted = %v", devices.deleted)
	}
	if devices.marked["d1"] != "Unregistered" {
		t.Fatalf("marked = %v", devices.marked)
	}
}

func TestDeliverNeverReadsLegacyChannelSettings(t *testing.T) {
	settings := &fakeSettings{vals: map[string]string{
		"notify.bark_url":   "https://api.day.app/example",
		"notify.ntfy_topic": "example-topic",
		"ui.base_url":       "https://kin.example.com",
	}}
	s := &Sender{Store: settings, Events: &fakePublisher{}}
	_ = s.Deliver(context.Background(), Payload{Title: "t", Kind: "task", ID: "x"})
	_ = s.DeepLink(context.Background(), "/inbox")
	for _, key := range settings.reads {
		if key != KeyBaseURL {
			t.Fatalf("read legacy setting %q", key)
		}
	}
}

func TestDeepLink(t *testing.T) {
	s := &Sender{BaseURLOverride: "https://kin.example.com/"}
	if got := s.DeepLink(context.Background(), "/inbox"); got != "https://kin.example.com/inbox" {
		t.Fatalf("deep link = %q", got)
	}
	if got := s.DeepLink(context.Background(), "inbox"); got != "https://kin.example.com/inbox" {
		t.Fatalf("deep link without slash = %q", got)
	}
}

func TestApprovalNamesTheApproval(t *testing.T) {
	s := &Sender{BaseURLOverride: "https://kin.example.com"}
	if got := s.inboxFocusLink(context.Background(), "a1"); got != "https://kin.example.com/inbox?focus=a1" {
		t.Fatalf("link = %q", got)
	}
	if got := s.inboxFocusLink(context.Background(), ""); got != "https://kin.example.com/inbox" {
		t.Fatalf("empty link = %q", got)
	}
}

func TestSendPublishesEvenWithNoStore(t *testing.T) {
	got := make(chan Event, 1)
	s := &Sender{Events: publisherFunc(func(ev Event) { got <- ev })}
	s.Send(context.Background(), Payload{Title: "t", Kind: "task", ID: "x"})
	select {
	case ev := <-got:
		if ev.Kind != "task" || ev.ID != "x" {
			t.Fatalf("event = %+v", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Send never published the desktop event")
	}
}

type publisherFunc func(Event)

func (f publisherFunc) PublishNotify(ev Event) { f(ev) }

func TestDeliverReportsAListFailure(t *testing.T) {
	devices := &failingDevices{}
	s := &Sender{Store: &fakeSettings{}, Devices: devices, APNs: &fakeAPNs{configured: true}}
	if results := s.Deliver(context.Background(), Payload{Kind: "task", ID: "x"}); results != nil {
		t.Fatalf("results = %+v", results)
	}
	if !strings.Contains(devices.err.Error(), "database") {
		t.Fatalf("unexpected error: %v", devices.err)
	}
}

type failingDevices struct{ err error }

func (f *failingDevices) ListPushDevices(context.Context) ([]store.PushDevice, error) {
	f.err = errors.New("database is locked")
	return nil, f.err
}
func (f *failingDevices) ListPushDevicesForOwner(context.Context, string) ([]store.PushDevice, error) {
	f.err = errors.New("database is locked")
	return nil, f.err
}
func (f *failingDevices) MarkPushDeviceResult(context.Context, string, int64, string) error {
	return nil
}
func (f *failingDevices) DeletePushDeviceByToken(context.Context, string) error { return nil }

// A member's phone hears about the member's work, not the owner's. A row with
// no owner is the operator's own: it receives every event that names no other
// account. A deliberate broadcast (the test notification) reaches everyone.
func TestDeliverAPNsScopesToTheOwner(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{
		{ID: "owner", InstallID: "i-owner", Token: "token-owner", Environment: "sandbox", OwnerUserID: "user-owner"},
		{ID: "member", InstallID: "i-member", Token: "token-member", Environment: "sandbox", OwnerUserID: "user-member"},
		{ID: "shared", InstallID: "i-shared", Token: "token-shared", Environment: "sandbox"},
	}}
	pusher := &fakeAPNs{configured: true}
	s := &Sender{Store: &fakeSettings{}, Devices: devices, APNs: pusher}
	results := s.DeliverAPNs(context.Background(), Payload{Kind: "task", ID: "t1", OwnerUserID: "user-member"})
	if len(results) != 2 {
		t.Fatalf("results = %+v", results)
	}
	got := map[string]bool{}
	for _, token := range pusher.sentTokens() {
		got[token] = true
	}
	if len(got) != 2 || !got["token-member"] || !got["token-shared"] {
		t.Fatalf("tokens = %v, want the member's phone and the operator-wide one", pusher.sentTokens())
	}

	// An unowned event is the operator's own work: it reaches the
	// operator-wide row and must not ring the member's phone. The old empty
	// owner meant "everyone", which leaked task titles across accounts.
	pusher.mu.Lock()
	pusher.tokens = nil
	pusher.mu.Unlock()
	results = s.DeliverAPNs(context.Background(), Payload{Kind: "task", ID: "t2"})
	if len(results) != 1 {
		t.Fatalf("unowned results = %+v", results)
	}
	if tokens := pusher.sentTokens(); len(tokens) != 1 || tokens[0] != "token-shared" {
		t.Fatalf("unowned tokens = %v, want only the operator-wide row", tokens)
	}
}

// KIN-NOTIFY-001: routine, eval, and CLI-created work has no task owner. Such
// an event is the operator's own work, so it must reach the phone registered
// through the operator's login (that row carries the account, not an empty
// owner) as well as an ownerless master-token row, without reaching a member.
func TestDeliverAPNsUnownedEventsReachTheOperatorAccount(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{
		{ID: "operator", InstallID: "i-op", Token: "token-op", Environment: "sandbox", OwnerUserID: "user-op"},
		{ID: "ownerless", InstallID: "i-none", Token: "token-none", Environment: "sandbox"},
		{ID: "member", InstallID: "i-member", Token: "token-member", Environment: "sandbox", OwnerUserID: "user-member"},
	}}
	pusher := &fakeAPNs{configured: true}
	s := &Sender{Store: &fakeSettings{}, Devices: devices, APNs: pusher,
		OwnerAccount: func(context.Context) (string, error) { return "user-op", nil },
	}

	results := s.DeliverAPNs(context.Background(), Payload{Kind: "routine", ID: "r1"})
	if len(results) != 2 {
		t.Fatalf("results = %+v", results)
	}
	got := map[string]bool{}
	for _, token := range pusher.sentTokens() {
		got[token] = true
	}
	if len(got) != 2 || !got["token-op"] || !got["token-none"] {
		t.Fatalf("tokens = %v, want the operator's phone and the ownerless row", pusher.sentTokens())
	}
	if got["token-member"] {
		t.Fatal("an unowned routine event reached a member's phone")
	}
}

// A standalone node has no operator account; the fallback must stay empty and
// keep matching only the ownerless rows it always did.
func TestDeliverAPNsUnownedEventsWithoutAnOwnerAccountReachOnlyOwnerless(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{
		{ID: "ownerless", InstallID: "i-none", Token: "token-none", Environment: "sandbox"},
		{ID: "member", InstallID: "i-member", Token: "token-member", Environment: "sandbox", OwnerUserID: "user-member"},
	}}
	pusher := &fakeAPNs{configured: true}
	s := &Sender{Store: &fakeSettings{}, Devices: devices, APNs: pusher}

	if results := s.DeliverAPNs(context.Background(), Payload{Kind: "routine", ID: "r1"}); len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	if tokens := pusher.sentTokens(); len(tokens) != 1 || tokens[0] != "token-none" {
		t.Fatalf("tokens = %v, want only the ownerless row", tokens)
	}
}

// If the operator account cannot be resolved, the fallback must fail toward the
// ownerless rows, never toward everyone: a transient registry error can cost
// the operator a notification, but it must not ring a member's phone.
func TestDeliverAPNsUnownedEventsSurviveAnOwnerLookupFailure(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{
		{ID: "operator", InstallID: "i-op", Token: "token-op", Environment: "sandbox", OwnerUserID: "user-op"},
		{ID: "ownerless", InstallID: "i-none", Token: "token-none", Environment: "sandbox"},
		{ID: "member", InstallID: "i-member", Token: "token-member", Environment: "sandbox", OwnerUserID: "user-member"},
	}}
	cases := []struct {
		name  string
		owner func(context.Context) (string, error)
	}{
		{"the registry read fails", func(context.Context) (string, error) {
			return "", errors.New("database is locked")
		}},
		{"the node has no operator account", func(context.Context) (string, error) { return "", nil }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pusher := &fakeAPNs{configured: true}
			s := &Sender{Store: &fakeSettings{}, Devices: devices, APNs: pusher, OwnerAccount: tc.owner}
			if results := s.DeliverAPNs(context.Background(), Payload{Kind: "routine", ID: "r1"}); len(results) != 1 {
				t.Fatalf("results = %+v", results)
			}
			if tokens := pusher.sentTokens(); len(tokens) != 1 || tokens[0] != "token-none" {
				t.Fatalf("tokens = %v, want only the ownerless row", tokens)
			}
		})
	}
}

// The test notification is the one send that is deliberately node-wide: it is
// the operator checking that every phone on this node can ring, not work owned
// by an account.
func TestDeliverAPNsBroadcastReachesEveryPhone(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{
		{ID: "owner", InstallID: "i-owner", Token: "token-owner", Environment: "sandbox", OwnerUserID: "user-owner"},
		{ID: "member", InstallID: "i-member", Token: "token-member", Environment: "sandbox", OwnerUserID: "user-member"},
		{ID: "shared", InstallID: "i-shared", Token: "token-shared", Environment: "sandbox"},
	}}
	pusher := &fakeAPNs{configured: true}
	s := &Sender{Store: &fakeSettings{}, Devices: devices, APNs: pusher}

	results := s.DeliverAPNs(context.Background(), Payload{Kind: "test", ID: "test", Broadcast: true})
	if len(results) != 3 {
		t.Fatalf("results = %+v", results)
	}
	got := map[string]bool{}
	for _, token := range pusher.sentTokens() {
		got[token] = true
	}
	if len(got) != 3 || !got["token-owner"] || !got["token-member"] || !got["token-shared"] {
		t.Fatalf("tokens = %v, want every registered phone", pusher.sentTokens())
	}
}

// `kin notify apns` writes credentials from another process. A sender that
// snapshotted them at startup would stay silently unconfigured until restart,
// so delivery has to ask again every time.
func TestDeliverAPNsReadsCredentialsAtDeliveryTime(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{{
		ID: "d1", InstallID: "i1", Token: "token-1", Environment: "sandbox",
	}}}
	live := &fakeAPNs{configured: true}
	calls := 0
	s := &Sender{Store: &fakeSettings{}, Devices: devices, APNsFor: func(context.Context) (APNsSender, error) {
		calls++
		return live, nil
	}}
	results := s.DeliverAPNs(context.Background(), Payload{Kind: "task", ID: "t1"})
	if calls != 1 || len(results) != 1 || !results[0].OK {
		t.Fatalf("calls=%d results=%+v", calls, results)
	}
	if len(live.sentNotifications()) != 1 {
		t.Fatalf("live client sent %d", len(live.sentNotifications()))
	}

	// A configuration that cannot be read is the normal "not set up yet"
	// state; it must not panic or report a failed device.
	s.APNsFor = func(context.Context) (APNsSender, error) {
		return nil, errors.New("not configured")
	}
	if results := s.DeliverAPNs(context.Background(), Payload{Kind: "task", ID: "t1"}); results != nil {
		t.Fatalf("results = %+v", results)
	}
}

// Waiting → resumed is one slot in Notification Center, but two distinct
// events: the desktop dedupe key includes the status, and the collapse id does
// not, because the second state must replace the banner it supersedes.
func TestQuotaStatesKeepOneBannerSlotButDistinctEvents(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{{
		ID: "d1", InstallID: "i1", Token: "token-1", Environment: "sandbox",
	}}}
	pusher := &fakeAPNs{configured: true}
	pub := &fakePublisher{}
	s := &Sender{Store: &fakeSettings{}, Devices: devices, APNs: pusher, Events: pub}
	s.NotifyQuota(context.Background(), "t1", "Fix login", "waiting", 0)
	s.NotifyQuota(context.Background(), "t1", "Fix login", "resumed", 0)
	waitFor(t, func() bool {
		return len(pusher.sentNotifications()) == 2 && len(pub.published()) == 2
	})
	for _, n := range pusher.sentNotifications() {
		if n.ThreadID != "t1" || n.CollapseID != "quota:t1" {
			t.Fatalf("grouping = thread %q collapse %q", n.ThreadID, n.CollapseID)
		}
	}
	statuses := map[string]bool{}
	for _, ev := range pub.published() {
		if ev.Status == "" {
			t.Fatalf("event lost its status: %+v", ev)
		}
		statuses[ev.Status] = true
	}
	if !statuses["waiting"] || !statuses["resumed"] {
		t.Fatalf("statuses = %v", statuses)
	}
}

// An approval and a question in one conversation group together on iOS, but
// neither may collapse the other's banner: grouping is not replacing.
func TestApprovalAndQuestionShareTheTaskGroupWithoutReplacingEachOther(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{{
		ID: "d1", InstallID: "i1", Token: "token-1", Environment: "sandbox",
	}}}
	pusher := &fakeAPNs{configured: true}
	s := &Sender{Store: &fakeSettings{}, Devices: devices, APNs: pusher}
	s.NotifyApproval(context.Background(), "a1", "t1", "")
	s.NotifyUserQuestion(context.Background(), "q1", "t1", "")
	waitFor(t, func() bool { return len(pusher.sentNotifications()) == 2 })
	byID := map[string]apns.Notification{}
	for _, n := range pusher.sentNotifications() {
		byID[n.ID] = n
	}
	approval, question := byID["a1"], byID["q1"]
	if approval.ThreadID != "t1" || question.ThreadID != "t1" {
		t.Fatalf("thread = %q / %q, want the task for both", approval.ThreadID, question.ThreadID)
	}
	if approval.CollapseID != "approval:a1" || question.CollapseID != "question:q1" {
		t.Fatalf("collapse = %q / %q", approval.CollapseID, question.CollapseID)
	}
}

// Routine and worker events have no task to look up. Without an explicit
// owner their bus message is unowned, and a scoped stream drops the one
// announcement those events exist to deliver.
func TestTasklessEventsNameTheOperator(t *testing.T) {
	pub := &fakePublisher{}
	s := &Sender{Store: &fakeSettings{}, Events: pub,
		OwnerOf: func(taskID string) string {
			if taskID == "t1" {
				return "user-task"
			}
			return ""
		},
		OwnerAccount: func(context.Context) (string, error) { return "user-owner", nil },
	}
	s.NotifyWorkerOffline(context.Background(), "w1", "t1", "")
	s.NotifyWorkerOffline(context.Background(), "w2", "", "")
	s.NotifyRoutineFailure(context.Background(), "r1", "", "")
	waitFor(t, func() bool { return len(pub.published()) == 3 })
	owners := map[string]string{}
	for _, ev := range pub.published() {
		owners[ev.ID] = ev.OwnerUserID
	}
	if owners["w1"] != "user-task" || owners["w2"] != "user-owner" || owners["r1"] != "user-owner" {
		t.Fatalf("owners = %v", owners)
	}
}

// `kin notify test` on a Mac asks for the desktop channel only. Publishing
// must therefore be callable without also ringing every paired phone.
func TestPublishDoesNotRingPhones(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{{
		ID: "d1", InstallID: "i1", Token: "token-1", Environment: "sandbox",
	}}}
	pusher := &fakeAPNs{configured: true}
	pub := &fakePublisher{}
	s := &Sender{Store: &fakeSettings{}, Devices: devices, APNs: pusher, Events: pub}
	if !s.Publish(Payload{Title: "t", Kind: "test", ID: "x"}) {
		t.Fatal("Publish reported no desktop channel")
	}
	if len(pub.published()) != 1 {
		t.Fatalf("events = %+v", pub.published())
	}
	if len(pusher.sentNotifications()) != 0 {
		t.Fatalf("Publish also sent APNs: %+v", pusher.sentNotifications())
	}
}

// KIN-NOTIFY-001: a registration made from a browser login stops ringing when
// that login ends, even though the account still exists and the row may still
// be in the table. An operator-wide or paired-device row has no session and is
// unaffected.
func TestDeliverAPNsSkipsARegistrationWhoseSessionEnded(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{
		{ID: "signed-out", InstallID: "i-out", Token: "token-out", Environment: "sandbox", OwnerUserID: "user-1", OwnerSessionID: "session-out"},
		{ID: "live", InstallID: "i-live", Token: "token-live", Environment: "sandbox", OwnerUserID: "user-1", OwnerSessionID: "session-live"},
		{ID: "paired", InstallID: "i-paired", Token: "token-paired", Environment: "sandbox", OwnerUserID: "user-1"},
	}}
	pusher := &fakeAPNs{configured: true}
	s := &Sender{Store: &fakeSettings{}, Devices: devices, APNs: pusher,
		SessionLive: func(_ context.Context, sessionID string) bool { return sessionID == "session-live" },
	}
	results := s.DeliverAPNs(context.Background(), Payload{Kind: "task", ID: "t1", OwnerUserID: "user-1"})
	if len(results) != 2 {
		t.Fatalf("results = %+v, want the live and paired rows only", results)
	}
	got := map[string]bool{}
	for _, token := range pusher.sentTokens() {
		got[token] = true
	}
	if len(got) != 2 || !got["token-live"] || !got["token-paired"] {
		t.Fatalf("tokens = %v, want the live and paired rows only", pusher.sentTokens())
	}
	if got["token-out"] {
		t.Fatal("a signed-out phone still received the notification")
	}
}

// A sender with no liveness checker cannot vouch for a session-bound row, so
// it must skip it. Sending anyway is the failure this guard exists to prevent.
func TestDeliverAPNsWithoutASessionCheckerSkipsBoundRows(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{
		{ID: "bound", InstallID: "i-bound", Token: "token-bound", Environment: "sandbox", OwnerSessionID: "session-1"},
		{ID: "paired", InstallID: "i-paired", Token: "token-paired", Environment: "sandbox"},
	}}
	pusher := &fakeAPNs{configured: true}
	s := &Sender{Store: &fakeSettings{}, Devices: devices, APNs: pusher}
	if results := s.DeliverAPNs(context.Background(), Payload{Kind: "task", ID: "t1"}); len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	if tokens := pusher.sentTokens(); len(tokens) != 1 || tokens[0] != "token-paired" {
		t.Fatalf("tokens = %v, want only the unbound row", tokens)
	}
}
