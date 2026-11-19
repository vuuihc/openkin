// R-notify-raw-ids: the four notifications a person has to act on — approval,
// question, quota, worker offline — read as sentences, not as a machine id.
//
// The finished-task banner was fixed first (#391). These four carried the same
// defect: "Task 3f9a1c2b needs approval", "Worker 09ab12cd is offline", and a
// quota body that repeated, lowercased, the reason already in the title. The
// reader has never seen an 8-char id; the identity they need is the task title,
// the question header or the worker label, and that stays in the title.
//
// The ids are not removed from the event. Dedupe, grouping and deep links read
// them from Payload.ID/TaskID, so the contract test below pins every one of
// those fields at its current value.
package notify

import (
	"context"
	"strings"
	"testing"
	"unicode"

	"github.com/vuuihc/openkin/internal/store"
)

// normalizedCopy lowercases and drops everything that is not a letter or digit,
// so "Approval needed" and "approval, needed." compare equal. The point is to
// catch a body that is the title said twice, not to police punctuation.
func normalizedCopy(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// copyEvent runs one notification sender and returns what the desktop channel
// published. Every sender under test sends exactly one event.
func copyEvent(t *testing.T, send func(*Sender)) Event {
	t.Helper()
	pub := &fakePublisher{}
	s := &Sender{BaseURLOverride: "https://kin.example.com", Events: pub}
	send(s)
	waitFor(t, func() bool { return len(pub.published()) == 1 })
	return pub.published()[0]
}

// The actionable banners name the work in the title and ask for the action in
// the body. No id — full or truncated — reaches either line, and the body is
// always its own sentence.
func TestActionableNotificationBodiesCarryNoRawID(t *testing.T) {
	cases := []struct {
		name string
		send func(*Sender)
		// ids that used to be printed, or that the event carries and the copy
		// must not print. Long ids exercise shortID's 8-char truncation.
		ids []string
	}{
		{
			name: "approval",
			send: func(s *Sender) {
				s.NotifyApproval(context.Background(), "appr-1", "task-9f2c1a4d", "Fix the login bug")
			},
			ids: []string{"appr-1", "task-9f2c1a4d"},
		},
		{
			name: "approval without a task",
			send: func(s *Sender) {
				s.NotifyApproval(context.Background(), "appr-1", "", "")
			},
			ids: []string{"appr-1"},
		},
		{
			name: "question",
			send: func(s *Sender) {
				s.NotifyUserQuestion(context.Background(), "ques-1", "task-9f2c1a4d", "Which database?")
			},
			ids: []string{"ques-1", "task-9f2c1a4d"},
		},
		{
			name: "question without a task",
			send: func(s *Sender) {
				s.NotifyUserQuestion(context.Background(), "ques-1", "", "")
			},
			ids: []string{"ques-1"},
		},
		{
			name: "quota",
			send: func(s *Sender) {
				s.NotifyQuota(context.Background(), "task-9f2c1a4d", "Fix the login bug", "waiting", 0)
			},
			ids: []string{"task-9f2c1a4d"},
		},
		{
			name: "quota without a task title",
			send: func(s *Sender) {
				s.NotifyQuota(context.Background(), "task-9f2c1a4d", "", "blocked", 0)
			},
			ids: []string{"task-9f2c1a4d"},
		},
		{
			name: "worker offline",
			send: func(s *Sender) {
				s.NotifyWorkerOffline(context.Background(), "wrkr-9f2c1a4d", "task-1", "Build box")
			},
			ids: []string{"wrkr-9f2c1a4d", "task-1"},
		},
		{
			name: "worker offline without a task",
			send: func(s *Sender) {
				s.NotifyWorkerOffline(context.Background(), "wrkr-9f2c1a4d", "", "")
			},
			ids: []string{"wrkr-9f2c1a4d"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := copyEvent(t, tc.send)
			combined := ev.Title + " " + ev.Body
			for _, id := range tc.ids {
				if strings.Contains(combined, id) {
					t.Fatalf("copy repeats the raw id %q: %q / %q", id, ev.Title, ev.Body)
				}
				if short := shortID(id); short != id && strings.Contains(combined, short) {
					t.Fatalf("copy repeats the truncated id %q: %q / %q", short, ev.Title, ev.Body)
				}
			}
			if strings.TrimSpace(ev.Body) == "" {
				t.Fatalf("body is empty: title %q", ev.Title)
			}
			if ev.Title != "" && normalizedCopy(ev.Body) == normalizedCopy(ev.Title) {
				t.Fatalf("body only repeats the title: %q", ev.Title)
			}
		})
	}
}

// Waiting, resumed and blocked are three different moments in a person's day.
// One "quota ok" sentence reused for a block would hide the only one of the
// three that needs a decision, so the three bodies must stay distinct and the
// two non-blocked states must not borrow failure words.
func TestActionableNotificationStatesStayDistinct(t *testing.T) {
	pub := &fakePublisher{}
	s := &Sender{BaseURLOverride: "https://kin.example.com", Events: pub}
	for _, status := range []string{"waiting", "resumed", "blocked"} {
		s.NotifyQuota(context.Background(), "task-1", "Fix the login bug", status, 0)
	}
	waitFor(t, func() bool { return len(pub.published()) == 3 })

	bodies := map[string]string{}
	for _, ev := range pub.published() {
		bodies[ev.Status] = ev.Body
	}
	for _, status := range []string{"waiting", "resumed", "blocked"} {
		if strings.TrimSpace(bodies[status]) == "" {
			t.Fatalf("%s: empty body", status)
		}
	}
	if bodies["waiting"] == bodies["resumed"] || bodies["waiting"] == bodies["blocked"] || bodies["resumed"] == bodies["blocked"] {
		t.Fatalf("quota states read the same: %v", bodies)
	}
	for _, status := range []string{"waiting", "resumed"} {
		lower := strings.ToLower(bodies[status])
		for _, word := range []string{"failed", "canceled", "cancelled", "blocked", "error"} {
			if strings.Contains(lower, word) {
				t.Fatalf("%s body carries the severity word %q: %q", status, word, bodies[status])
			}
		}
	}

	// "open" and "continued" are the same two states under their older names;
	// the copy must not fork by spelling.
	aliases := map[string]string{"open": "waiting", "continued": "resumed"}
	for alias, canonical := range aliases {
		ev := copyEvent(t, func(s *Sender) {
			s.NotifyQuota(context.Background(), "task-1", "Fix the login bug", alias, 0)
		})
		if ev.Body != bodies[canonical] {
			t.Fatalf("%s body = %q, want the %s copy %q", alias, ev.Body, canonical, bodies[canonical])
		}
	}
}

// The copy is what changes here. Everything a client dedupes, groups and routes
// by keeps the exact value it had: the ids, the thread, the collapse id, the
// quota status enum and the deep link.
func TestActionableNotificationsKeepTheirIdentityFields(t *testing.T) {
	const base = "https://kin.example.com"
	cases := []struct {
		name       string
		send       func(*Sender)
		wantEvent  Event
		wantThread string
		wantCollap string
	}{
		{
			name: "approval",
			send: func(s *Sender) {
				s.NotifyApproval(context.Background(), "appr-1", "task-1", "Fix the login bug")
			},
			wantEvent:  Event{Kind: "approval", ID: "appr-1", TaskID: "task-1", URL: base + "/tasks/task-1?focus=appr-1"},
			wantThread: "task-1", wantCollap: "approval:appr-1",
		},
		{
			name: "question",
			send: func(s *Sender) {
				s.NotifyUserQuestion(context.Background(), "ques-1", "task-1", "Which database?")
			},
			wantEvent:  Event{Kind: "question", ID: "ques-1", TaskID: "task-1", URL: base + "/tasks/task-1?focus=ques-1"},
			wantThread: "task-1", wantCollap: "question:ques-1",
		},
		{
			name: "quota waiting",
			send: func(s *Sender) {
				s.NotifyQuota(context.Background(), "task-1", "Fix the login bug", "waiting", 0)
			},
			wantEvent:  Event{Kind: "quota", ID: "task-1", TaskID: "task-1", Status: "waiting", URL: base + "/tasks/task-1"},
			wantThread: "task-1", wantCollap: "quota:task-1",
		},
		{
			name: "quota resumed",
			send: func(s *Sender) {
				s.NotifyQuota(context.Background(), "task-1", "Fix the login bug", "resumed", 0)
			},
			wantEvent:  Event{Kind: "quota", ID: "task-1", TaskID: "task-1", Status: "resumed", URL: base + "/tasks/task-1"},
			wantThread: "task-1", wantCollap: "quota:task-1",
		},
		{
			name: "worker offline with a task",
			send: func(s *Sender) {
				s.NotifyWorkerOffline(context.Background(), "wrkr-1", "task-1", "Build box")
			},
			wantEvent:  Event{Kind: "worker", ID: "wrkr-1", TaskID: "task-1", Status: "offline", URL: base + "/tasks/task-1"},
			wantThread: "wrkr-1", wantCollap: "worker:wrkr-1",
		},
		{
			name: "worker offline without a task",
			send: func(s *Sender) {
				s.NotifyWorkerOffline(context.Background(), "wrkr-1", "", "")
			},
			wantEvent:  Event{Kind: "worker", ID: "wrkr-1", Status: "offline", URL: base + "/settings"},
			wantThread: "wrkr-1", wantCollap: "worker:wrkr-1",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pub := &fakePublisher{}
			pusher := &fakeAPNs{configured: true}
			devices := &fakeDevices{devices: []store.PushDevice{{
				ID: "d1", InstallID: "i1", Token: "token-1", Environment: "sandbox",
			}}}
			s := &Sender{
				Store: &fakeSettings{}, BaseURLOverride: base,
				Devices: devices, APNs: pusher, Events: pub,
			}
			tc.send(s)
			waitFor(t, func() bool {
				return len(pub.published()) == 1 && len(pusher.sentNotifications()) == 1
			})

			ev := pub.published()[0]
			if ev.Kind != tc.wantEvent.Kind || ev.ID != tc.wantEvent.ID ||
				ev.TaskID != tc.wantEvent.TaskID || ev.Status != tc.wantEvent.Status ||
				ev.URL != tc.wantEvent.URL {
				t.Fatalf("event identity = %+v, want %+v", ev, tc.wantEvent)
			}

			n := pusher.sentNotifications()[0]
			if n.Kind != tc.wantEvent.Kind || n.ID != tc.wantEvent.ID || n.URL != tc.wantEvent.URL {
				t.Fatalf("apns identity = %+v", n)
			}
			if n.ThreadID != tc.wantThread || n.CollapseID != tc.wantCollap {
				t.Fatalf("grouping = thread %q collapse %q, want %q / %q", n.ThreadID, n.CollapseID, tc.wantThread, tc.wantCollap)
			}
		})
	}
}
