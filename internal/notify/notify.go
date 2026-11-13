// Package notify turns agent events into the notifications a person actually
// receives.
//
// There is exactly one delivery model: the node fans an event out to macOS
// (through the desktop shell's WebSocket) and to every registered iPhone
// (through APNs). Bark, ntfy and Web Push were removed with KIN-NOTIFY-001;
// there is no second channel and no compatibility switch, so the only thing
// this package has to decide is what the event says and where it points.
package notify

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/apns"
	"github.com/vuuihc/openkin/internal/store"
)

// KeyBaseURL is the origin the console is reached at. It is only used to build
// absolute links for clients that need one (APNs payloads carry the path; the
// desktop opens it in the same window).
const KeyBaseURL = "ui.base_url"

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
	// Kind is the kind of event: approval, question, task, quota, routine,
	// worker. ID names the thing the event is about.
	Kind string
	ID   string
	// TaskID is the task the event belongs to, when there is one. The bus uses
	// it to attribute the message to the account that owns the work.
	TaskID string
	// ThreadID groups notifications about the same conversation on iOS.
	ThreadID string
	// CollapseID names the one thing this banner is about. Two approvals in
	// one conversation share a ThreadID but not a CollapseID: grouping is not
	// replacing, and the second approval must not silently eat the first.
	CollapseID string
	// OwnerUserID is the account this event is for. Empty is the operator's
	// own work: it reaches ownerless rows and rows owned by the operator, not
	// every account on the node. APNs delivery uses it so a member's phone does
	// not ring for someone else's task; the desktop bus uses it to keep a
	// scoped stream from dropping a taskless event.
	OwnerUserID string
	// Broadcast overrides owner scoping and reaches every registration. Only a
	// deliberate node-wide send (the test notification) sets it; task and
	// approval events must stay scoped.
	Broadcast bool
	// Status distinguishes successive states of one target (quota waiting,
	// resumed, blocked). The desktop dedupe key includes it so the second
	// state is not mistaken for a rebroadcast of the first.
	Status string
}

// RoutineEvent is a routine report or disabled alert as the Node knows it,
// before a destination link is built. A Node forwards it to its Hub so the Hub
// can fan the alert out to the phones it registered; the Hub builds the link
// from the authenticated device, never from anything the Node asserted.
type RoutineEvent struct {
	// Event is "report" or "disabled".
	Event string
	// RoutineID names the routine (disabled alerts).
	RoutineID string
	// TaskID names the run that produced a report.
	TaskID string
	Title  string
	Body   string
}

// Event is the structured payload the desktop shell receives. It is also the
// payload APNs carries, minus the platform envelope.
type Event struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	URL    string `json:"url"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	TaskID string `json:"task_id,omitempty"`
	Status string `json:"status,omitempty"`
	// OwnerUserID scopes the bus message. It is never part of the payload a
	// client sees: the bus copies it into the message envelope.
	OwnerUserID string `json:"-"`
}

// Publisher is the desktop channel: the node's event bus. Implemented by an
// adapter in the daemon so this package does not depend on the task engine.
type Publisher interface {
	PublishNotify(ev Event)
}

// DeviceStore is the native device registry. The concrete store implements it.
type DeviceStore interface {
	ListPushDevices(ctx context.Context) ([]store.PushDevice, error)
	ListPushDevicesForOwner(ctx context.Context, ownerUserID string) ([]store.PushDevice, error)
	MarkPushDeviceResult(ctx context.Context, id string, at int64, errMsg string) error
	DeletePushDeviceByToken(ctx context.Context, token string) error
}

// APNsSender delivers one alert to one device token.
type APNsSender interface {
	Configured() bool
	Send(ctx context.Context, token string, env apns.Environment, n apns.Notification) apns.Result
}

// ChannelResult is the outcome of delivering to one device.
type ChannelResult struct {
	Channel string `json:"channel"`
	OK      bool   `json:"ok"`
	// Device is the registry row this result belongs to.
	Device string `json:"device,omitempty"`
	// Status is a short success token (e.g. "ok") when OK is true.
	Status string `json:"status,omitempty"`
	// Error is set when OK is false.
	Error string `json:"error,omitempty"`
}

// Sender posts notifications to the desktop shell and to registered iPhones.
type Sender struct {
	Store SettingsReader
	// BaseURLOverride skips the store for ui.base_url (tests).
	BaseURLOverride string
	// Devices and APNs are the native channel. Both are nil when the daemon
	// has no registry or no credentials; the desktop channel still works.
	Devices DeviceStore
	APNs    APNsSender
	// APNsFor loads the credentials from settings at delivery time. It is how
	// `kin notify apns` takes effect on a running node: the credentials are
	// written by another process, so a snapshot taken at startup would leave
	// the daemon silently unconfigured until the next restart. Nil keeps the
	// static APNs field (tests and callers that already hold a client).
	APNsFor func(ctx context.Context) (APNsSender, error)
	// Events is the desktop channel. Nil disables it.
	Events Publisher
	// SessionLive reports whether the browser login a registration is bound to
	// still exists. A registration made from a session stops receiving when
	// that session ends, even if the account signed in again elsewhere. Nil
	// means no session can be vouched for, so bound rows are skipped: sending
	// to a signed-out phone is the worse failure.
	SessionLive func(ctx context.Context, sessionID string) bool
	// OwnerOf reports the account that owns a task, so an event can be scoped
	// to the person whose work it is about.
	OwnerOf func(taskID string) string
	// OwnerAccount reports the node's operator account. Routine and worker
	// events have no task to look up; the operator is who they are for.
	OwnerAccount func(ctx context.Context) (string, error)
	// RoutineForward, when set, hands routine events to a bridge that carries
	// them to the Hub over the control channel. It is how a Node's routine
	// report rings phones that are registered with the Hub rather than with the
	// Node. Nil keeps the standalone behavior: local desktop banner and the
	// Node's own APNs registrations, if any.
	RoutineForward func(ctx context.Context, event RoutineEvent)
	// Now is overridable in tests.
	Now func() time.Time
}

func (s *Sender) now() time.Time {
	if s != nil && s.Now != nil {
		return s.Now()
	}
	return time.Now()
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

// inboxFocusLink points at the inbox, naming the one item the push is about.
//
// Approvals and questions both land on the same page, and the id is the whole
// difference between "something needs you" and "this one needs you": the inbox
// draws the card it names with a ring, scrolls to it, and says so when the id is
// no longer there. An empty id falls back to the page itself — `?focus=` with
// nothing after it is a link that claims to name an item and names nothing, and
// a plain inbox is the honest thing to send when there is no item to name.
func (s *Sender) inboxFocusLink(ctx context.Context, id string) string {
	if id == "" {
		return s.DeepLink(ctx, "/inbox")
	}
	return s.DeepLink(ctx, "/inbox?focus="+url.QueryEscape(id))
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
	link := s.inboxFocusLink(ctx, approvalID)
	s.Send(ctx, Payload{
		Title: title, Body: body, URL: link,
		Kind: "approval", ID: approvalID, TaskID: taskID,
		ThreadID: threadFor(taskID, approvalID), CollapseID: "approval:" + approvalID,
		OwnerUserID: s.taskOwner(taskID),
	})
}

// NotifyUserQuestion sends an input-required notification.
func (s *Sender) NotifyUserQuestion(ctx context.Context, questionID, taskID, title string) {
	if title == "" {
		title = "Input needed"
	}
	body := "A task needs your answer"
	if taskID != "" {
		body = fmt.Sprintf("Task %s needs your answer", shortID(taskID))
	}
	link := s.inboxFocusLink(ctx, questionID)
	s.Send(ctx, Payload{
		Title: title, Body: body, URL: link,
		Kind: "question", ID: questionID, TaskID: taskID,
		ThreadID: threadFor(taskID, questionID), CollapseID: "question:" + questionID,
		OwnerUserID: s.taskOwner(taskID),
	})
}

// NotifyQuota sends a quota wait/resume/block update.
func (s *Sender) NotifyQuota(ctx context.Context, taskID, taskTitle, status string, resetAt int64) {
	title := "Provider quota"
	switch status {
	case "open", "waiting":
		title = "Waiting for provider quota"
	case "continued", "resumed":
		title = "Provider quota available"
	case "blocked":
		title = "Provider quota wait blocked"
	}
	body := "A task is waiting for a provider quota window"
	if taskID != "" {
		body = fmt.Sprintf("Task %s: %s", shortID(taskID), strings.ToLower(title))
	}
	if taskTitle != "" {
		title = taskTitle + " — " + title
	}
	link := s.DeepLink(ctx, "/tasks/"+url.PathEscape(taskID))
	s.Send(ctx, Payload{
		Title: title, Body: body, URL: link,
		Kind: "quota", ID: taskID, TaskID: taskID,
		// The status is part of what this notification says, so it is part of
		// the identity the desktop dedupes by. The banner itself keeps a stable
		// collapse id: waiting → resumed is one slot in Notification Center,
		// not two.
		ThreadID: taskID, CollapseID: "quota:" + taskID, Status: status,
		OwnerUserID: s.taskOwner(taskID),
	})
	if resetAt > 0 {
		// Keep resetAt in the event/API contract; notification providers do not
		// need a second timestamp header and should remain concise.
	}
}

// NotifyWorkerOffline sends a worker-loss notification. The worker is
// user-owned; this message never implies a cloud fallback or data upload.
func (s *Sender) NotifyWorkerOffline(ctx context.Context, workerID, taskID, label string) {
	title := "Worker offline"
	if label != "" {
		title = label + " — worker offline"
	}
	body := "A remote worker lost its lease"
	if workerID != "" {
		body = fmt.Sprintf("Worker %s is offline", shortID(workerID))
	}
	link := s.DeepLink(ctx, "/tasks/"+url.PathEscape(taskID))
	if taskID == "" {
		link = s.DeepLink(ctx, "/settings")
	}
	owner := s.taskOwner(taskID)
	if owner == "" {
		owner = s.ownerAccount(ctx)
	}
	s.Send(ctx, Payload{
		Title: title, Body: body, URL: link,
		Kind: "worker", ID: workerID, TaskID: taskID,
		ThreadID: workerID, CollapseID: "worker:" + workerID, Status: "offline",
		OwnerUserID: owner,
	})
}

// NotifyTaskTerminal sends a notification when a task reaches a terminal status.
func (s *Sender) NotifyTaskTerminal(ctx context.Context, taskID, taskTitle, status string) {
	title := "Task " + status
	if taskTitle != "" {
		title = taskTitle + " — " + status
	}
	body := fmt.Sprintf("Task %s is %s", shortID(taskID), status)
	link := s.DeepLink(ctx, "/tasks/"+url.PathEscape(taskID))
	s.Send(ctx, Payload{
		Title: title, Body: body, URL: link,
		Kind: "task", ID: taskID, TaskID: taskID,
		ThreadID: taskID, CollapseID: "task:" + taskID, Status: status,
		OwnerUserID: s.taskOwner(taskID),
	})
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
	s.Send(ctx, Payload{
		Title: title, Body: body, URL: link,
		Kind: "routine", ID: taskID, TaskID: taskID,
		ThreadID: threadFor(taskID, taskID), CollapseID: "routine:" + taskID,
		Status: "report", OwnerUserID: s.taskOwner(taskID),
	})
	if s.RoutineForward != nil {
		s.RoutineForward(ctx, RoutineEvent{Event: "report", TaskID: taskID, Title: title, Body: body})
	}
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
	s.Send(ctx, Payload{
		Title: title, Body: body, URL: link,
		Kind: "routine", ID: routineID, ThreadID: routineID,
		CollapseID: "routine:" + routineID, Status: "disabled",
		// A routine has no task to take an owner from. It is the operator's
		// node-wide alert, and naming them keeps a member-scoped desktop
		// stream from dropping it.
		OwnerUserID: s.ownerAccount(ctx),
	})
	if s.RoutineForward != nil {
		s.RoutineForward(ctx, RoutineEvent{Event: "disabled", RoutineID: routineID, Title: title, Body: body})
	}
}

// Send publishes the event and delivers it in the background.
func (s *Sender) Send(ctx context.Context, p Payload) {
	if s == nil {
		return
	}
	// Detach from request cancellation; keep a short deadline.
	go func() {
		cctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = s.Deliver(cctx, p)
	}()
}

// Publish sends the event to the desktop channel. It reports whether there was
// one; a node with no bus still has iPhones to reach.
func (s *Sender) Publish(p Payload) bool {
	if s == nil {
		return false
	}
	s.publish(p)
	return s.Events != nil
}

// Deliver publishes the desktop event, then sends to every registered iPhone.
// It is synchronous so callers that want the result (tests, `kin notify test`)
// can have it. The returned results belong to the APNs channel only; the
// desktop publish is reported by Publish.
//
// APNs is best-effort and never the only truth: a device that is offline
// receives nothing, and the inbox still holds the item. A failed send is
// recorded on the device row so the settings page can say why this phone did
// not ring.
func (s *Sender) Deliver(ctx context.Context, p Payload) []ChannelResult {
	if s == nil {
		return nil
	}
	s.publish(p)
	return s.DeliverAPNs(ctx, p)
}

// DeliverAPNs sends one payload to the phones that should receive it, without
// touching the desktop channel. `kin notify test` uses the split to offer a
// Mac-only test that does not ring every phone.
func (s *Sender) DeliverAPNs(ctx context.Context, p Payload) []ChannelResult {
	if s == nil || s.Store == nil || s.Devices == nil {
		return nil
	}
	sender := s.resolveAPNs(ctx)
	if sender == nil || !sender.Configured() {
		return nil
	}
	// A test notification is the one deliberate broadcast; everything else is
	// scoped to the account whose work it is about. Routine, eval, and
	// CLI-created tasks have no owner by design, and a phone registered through
	// the operator's login carries that account rather than an empty one, so an
	// unowned event is resolved to the operator before it is scoped. Without
	// that fallback the operator's own phone never rings for a routine report.
	var devices []store.PushDevice
	var err error
	if p.Broadcast {
		devices, err = s.Devices.ListPushDevices(ctx)
	} else {
		owner := p.OwnerUserID
		if owner == "" {
			owner = s.ownerAccount(ctx)
		}
		devices, err = s.Devices.ListPushDevicesForOwner(ctx, owner)
	}
	if err != nil {
		log.Printf("notify: list devices: %v", err)
		return nil
	}
	devices = s.liveDevices(ctx, devices)
	if len(devices) == 0 {
		// No registrations: the channel is simply not configured, and an empty
		// result would read as a channel that failed.
		return nil
	}
	out := make([]ChannelResult, len(devices))
	var wg sync.WaitGroup
	for i, d := range devices {
		wg.Add(1)
		go func(i int, d store.PushDevice) {
			defer wg.Done()
			res := sender.Send(ctx, d.Token, apns.Environment(d.Environment), apns.Notification{
				Title: p.Title, Body: p.Body, URL: p.URL, Kind: p.Kind, ID: p.ID,
				ThreadID: threadID(p), CollapseID: collapseID(p),
			})
			at := s.now().UnixMilli()
			if res.OK {
				log.Printf("notify: apns ok device=%s", d.ID)
				_ = s.Devices.MarkPushDeviceResult(ctx, d.ID, at, "")
				out[i] = ChannelResult{Channel: "apns", Device: d.ID, OK: true, Status: "ok"}
				return
			}
			log.Printf("notify: apns failed device=%s: %s", d.ID, res.Reason)
			_ = s.Devices.MarkPushDeviceResult(ctx, d.ID, at, res.Reason)
			// A token Apple will never accept again is not a transient failure:
			// leaving the row behind would make every later send fail too.
			if res.Expired {
				_ = s.Devices.DeletePushDeviceByToken(ctx, d.Token)
			}
			out[i] = ChannelResult{Channel: "apns", Device: d.ID, OK: false, Error: res.Reason}
		}(i, d)
	}
	wg.Wait()
	return out
}

// liveDevices drops registrations whose browser session has ended. A
// registration with no session is an operator-wide or paired-device row, whose
// lifetime is governed by its credential instead and is delivered as before.
//
// The liveness check is skipped when no checker is wired, which answers false:
// a bound row with nobody able to confirm its session is not sent a
// notification carrying someone's task title.
//
// The answer is a point in time. A logout that commits between the check and
// the network send can still let that one request land; closing the window
// would mean holding a database transaction across an HTTP/2 call. One
// in-flight notification per session is the accepted bound.
func (s *Sender) liveDevices(ctx context.Context, devices []store.PushDevice) []store.PushDevice {
	out := devices[:0]
	for _, d := range devices {
		if d.OwnerSessionID == "" {
			out = append(out, d)
			continue
		}
		if s.SessionLive == nil || !s.SessionLive(ctx, d.OwnerSessionID) {
			log.Printf("notify: skipping device=%s: its session has ended", d.ID)
			continue
		}
		out = append(out, d)
	}
	return out
}

func (s *Sender) publish(p Payload) {
	if s.Events == nil {
		return
	}
	s.Events.PublishNotify(Event{
		Kind: p.Kind, ID: p.ID, URL: p.URL, Title: p.Title, Body: p.Body,
		TaskID: p.TaskID, Status: p.Status, OwnerUserID: p.OwnerUserID,
	})
}

// resolveAPNs prefers the live credentials in settings over the client the
// daemon built at startup. A missing or unreadable configuration is the normal
// "not set up yet" state, not an error worth surfacing on every event.
func (s *Sender) resolveAPNs(ctx context.Context) APNsSender {
	if s.APNsFor != nil {
		client, err := s.APNsFor(ctx)
		if err != nil || client == nil {
			return nil
		}
		return client
	}
	return s.APNs
}

func (s *Sender) taskOwner(taskID string) string {
	if s == nil || s.OwnerOf == nil || taskID == "" {
		return ""
	}
	return s.OwnerOf(taskID)
}

func (s *Sender) ownerAccount(ctx context.Context) string {
	if s == nil || s.OwnerAccount == nil {
		return ""
	}
	owner, err := s.OwnerAccount(ctx)
	if err != nil {
		// Falling back to ownerless is safe but silent: the operator's own
		// phone stops ringing for routine reports until the registry recovers.
		log.Printf("notify: resolve owner account: %v", err)
		return ""
	}
	return owner
}

func threadID(p Payload) string {
	if p.ThreadID != "" {
		return p.ThreadID
	}
	return p.ID
}

func collapseID(p Payload) string {
	if p.CollapseID != "" {
		return p.CollapseID
	}
	if p.Kind == "" || p.ID == "" {
		return ""
	}
	return p.Kind + ":" + p.ID
}

// threadFor groups by the conversation when there is one, and by the item
// otherwise. An approval and the task's completion belong to the same group;
// two approvals in that group stay two separate banners.
func threadFor(taskID, itemID string) string {
	if taskID != "" {
		return taskID
	}
	return itemID
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

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// APNs caps a payload at 4 KiB, enforced on the fully serialized body at the
// apns.Client boundary rather than by pre-truncating strings here. The desktop
// channel keeps the full text; APNs clips only what it must to fit.
