package notify

// KIN-NOTIFY-001: the banner for a finished task reads as a person wrote it.
// The owner's report was 「task xxxid is completed，可读性差」: a raw id and a
// machine token in the one line they see without opening the app.

import (
	"context"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
)

// terminalEvent delivers one terminal notification and returns what the
// desktop channel received.
func terminalEvent(t *testing.T, taskID, taskTitle, status string) Event {
	t.Helper()
	pub := &fakePublisher{}
	s := &Sender{BaseURLOverride: "https://kin.example.com", Events: pub}
	s.NotifyTaskTerminal(context.Background(), taskID, taskTitle, status)
	waitFor(t, func() bool { return len(pub.published()) == 1 })
	return pub.published()[0]
}

// A finished task shows its own title, and the body names the state in the
// words the console already uses. The three endings must stay distinguishable:
// an "all done" template that also covers a failure would be worse than the
// enum it replaced.
func TestNotifyTaskTerminalReadsAsHumanCopy(t *testing.T) {
	cases := []struct {
		status string
		human  string
	}{
		{"succeeded", "Completed"},
		{"failed", "Failed"},
		{"canceled", "Canceled"},
	}
	bodies := map[string]string{}
	for _, tc := range cases {
		titled := terminalEvent(t, "task-1", "Morning planning", tc.status)
		if titled.Title != "Morning planning" {
			t.Fatalf("%s: title = %q, want the task's own title", tc.status, titled.Title)
		}
		if titled.Body == "" || titled.Body == titled.Title {
			t.Fatalf("%s: body = %q, want a state word beside the title", tc.status, titled.Body)
		}
		if !strings.Contains(strings.ToLower(titled.Body), strings.ToLower(tc.human)) {
			t.Fatalf("%s: body = %q, want it to say %q", tc.status, titled.Body, tc.human)
		}
		if strings.Contains(strings.ToLower(titled.Title+" "+titled.Body), "task-1") {
			t.Fatalf("%s: copy repeats the raw task id: %q / %q", tc.status, titled.Title, titled.Body)
		}
		// The raw enum must not be printed. This compares the literal token a
		// leak would carry: `failed` and `canceled` are also the English words
		// the console shows (capitalized), so they are exempt from a
		// case-insensitive match. `succeeded` has a distinct human word and must
		// be gone in any casing.
		combined := titled.Title + " " + titled.Body
		if strings.Contains(combined, tc.status) {
			t.Fatalf("%s leaked as a machine token: %q / %q", tc.status, titled.Title, titled.Body)
		}
		if tc.status == "succeeded" && strings.Contains(strings.ToLower(combined), tc.status) {
			t.Fatalf("%s leaked in another casing: %q / %q", tc.status, titled.Title, titled.Body)
		}

		// A task that never got a title still gets an identifiable banner, but
		// the state is spelled the same human way.
		untitled := terminalEvent(t, "task-1", "", tc.status)
		if !strings.Contains(untitled.Title, shortID("task-1")) {
			t.Fatalf("%s: untitled banner lost its id fallback: %q", tc.status, untitled.Title)
		}
		if untitled.Body != titled.Body {
			t.Fatalf("%s: body depends on the title: %q vs %q", tc.status, untitled.Body, titled.Body)
		}
		if strings.Contains(untitled.Title+" "+untitled.Body, tc.status) {
			t.Fatalf("%s leaked as a machine token: %q / %q", tc.status, untitled.Title, untitled.Body)
		}
		bodies[tc.status] = titled.Body
	}
	if bodies["succeeded"] == bodies["failed"] || bodies["succeeded"] == bodies["canceled"] || bodies["failed"] == bodies["canceled"] {
		t.Fatalf("terminal states read the same: %v", bodies)
	}
}

// The copy is what changes here. Everything a client dedupes, groups and
// routes by keeps the exact values it had: Status stays the enum even though
// it is never printed, because the desktop dedupe key includes it.
func TestNotifyTaskTerminalKeepsEventContract(t *testing.T) {
	devices := &fakeDevices{devices: []store.PushDevice{{
		ID: "d1", InstallID: "i1", Token: "token-1", Environment: "sandbox",
	}}}
	pusher := &fakeAPNs{configured: true}
	pub := &fakePublisher{}
	s := &Sender{
		Store: &fakeSettings{}, BaseURLOverride: "https://kin.example.com",
		Devices: devices, APNs: pusher, Events: pub,
	}
	s.NotifyTaskTerminal(context.Background(), "task-1", "Morning planning", "failed")
	waitFor(t, func() bool {
		return len(pub.published()) == 1 && len(pusher.sentNotifications()) == 1
	})

	ev := pub.published()[0]
	if ev.Kind != "task" || ev.ID != "task-1" || ev.TaskID != "task-1" {
		t.Fatalf("desktop event identity = %+v", ev)
	}
	if ev.Status != "failed" {
		t.Fatalf("status = %q, want the exact enum", ev.Status)
	}
	if ev.URL != "https://kin.example.com/tasks/task-1" {
		t.Fatalf("url = %q", ev.URL)
	}

	n := pusher.sentNotifications()[0]
	if n.Kind != "task" || n.ID != "task-1" {
		t.Fatalf("apns identity = %+v", n)
	}
	if n.ThreadID != "task-1" || n.CollapseID != "task:task-1" {
		t.Fatalf("grouping = thread %q collapse %q", n.ThreadID, n.CollapseID)
	}
}
