package server

import (
	"bytes"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// fakeStartupClock advances a fixed step on every read. The trace must never
// be tested against wall-clock time: a slow CI machine would then turn a
// measurement helper into a flaky test.
type fakeStartupClock struct {
	t    time.Time
	step time.Duration
}

func (c *fakeStartupClock) now() time.Time {
	now := c.t
	c.t = c.t.Add(c.step)
	return now
}

func TestStartupTraceSilentByDefault(t *testing.T) {
	old, had := os.LookupEnv("KIN_STARTUP_TRACE")
	if err := os.Unsetenv("KIN_STARTUP_TRACE"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if had {
			_ = os.Setenv("KIN_STARTUP_TRACE", old)
			return
		}
		_ = os.Unsetenv("KIN_STARTUP_TRACE")
	})

	var out bytes.Buffer
	clock := &fakeStartupClock{t: time.Unix(0, 0), step: 10 * time.Millisecond}
	tr := startupTraceFromEnv(&out, clock.now)
	tr.mark("state-dir")
	tr.mark("store-open")
	tr.mark("ready")

	if out.Len() != 0 {
		t.Fatalf("trace wrote %q with KIN_STARTUP_TRACE unset, want silence", out.String())
	}
}

func TestStartupTraceEmitsOneLinePerPhaseInOrder(t *testing.T) {
	var out bytes.Buffer
	clock := &fakeStartupClock{t: time.Unix(0, 0), step: 10 * time.Millisecond}
	tr := newStartupTrace(true, &out, clock.now)

	// hub is deliberately absent: it is only marked by a daemon running as a
	// Hub, and an absent optional phase must not fail a boot or this test.
	phases := []string{
		"state-dir", "lock", "store-open", "device", "adopt", "agents",
		"engine-build", "engine-start", "browser", "listen", "ready",
	}
	for _, phase := range phases {
		tr.mark(phase)
	}

	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if len(lines) != len(phases) {
		t.Fatalf("lines = %d (%q), want %d", len(lines), out.String(), len(phases))
	}
	for i, phase := range phases {
		want := fmt.Sprintf("kin: startup %s 10ms total=%dms", phase, 10*(i+1))
		if lines[i] != want {
			t.Errorf("line %d = %q, want %q", i, lines[i], want)
		}
	}
}

func TestStartupTraceMarkIsIdempotentPerPhase(t *testing.T) {
	var out bytes.Buffer
	clock := &fakeStartupClock{t: time.Unix(0, 0), step: 10 * time.Millisecond}
	tr := newStartupTrace(true, &out, clock.now)

	tr.mark("store-open")
	tr.mark("store-open")
	tr.mark("device")

	want := "kin: startup store-open 10ms total=10ms\n" +
		"kin: startup device 10ms total=20ms\n"
	if got := out.String(); got != want {
		t.Fatalf("trace = %q, want %q (a repeated mark must not re-count time)", got, want)
	}
}
