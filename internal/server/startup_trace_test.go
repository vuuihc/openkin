package server

import (
	"bytes"
	"fmt"
	"os"
	"strconv"
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

// fixedStartupClock reports one instant. Tests move it by hand so the
// assertion is about the trace's arithmetic, not the machine's speed.
type fixedStartupClock struct{ t time.Time }

func (c *fixedStartupClock) now() time.Time { return c.t }

// clearStartupOriginEnv removes the launcher-provided origin and restores the
// caller's value afterwards, so a developer shell that exports it cannot change
// what a test measures.
func clearStartupOriginEnv(t *testing.T) {
	t.Helper()
	old, had := os.LookupEnv("KIN_STARTUP_ORIGIN_MS")
	if err := os.Unsetenv("KIN_STARTUP_ORIGIN_MS"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if had {
			_ = os.Setenv("KIN_STARTUP_ORIGIN_MS", old)
			return
		}
		_ = os.Unsetenv("KIN_STARTUP_ORIGIN_MS")
	})
}

func TestStartupTraceOriginEnvAccountsForTimeBeforeFirstMark(t *testing.T) {
	t.Setenv("KIN_STARTUP_TRACE", "1")
	origin := time.Unix(1_700_000_000, 0)
	t.Setenv("KIN_STARTUP_ORIGIN_MS", strconv.FormatInt(origin.UnixMilli(), 10))

	clock := &fixedStartupClock{t: origin.Add(120 * time.Millisecond)}
	var out bytes.Buffer
	tr := startupTraceFromEnv(&out, clock.now)
	tr.mark("process")
	tr.mark("state-dir")

	// The launcher's origin is 120ms before ServeWith: the process mark must
	// carry that gap, and every later total must be measured from it too.
	want := "kin: startup process 120ms total=120ms\n" +
		"kin: startup state-dir 0ms total=120ms\n"
	if got := out.String(); got != want {
		t.Fatalf("trace = %q, want %q", got, want)
	}
}

func TestStartupTraceRejectsImplausibleOrigin(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	cases := []struct {
		name   string
		origin string
	}{
		{"future", strconv.FormatInt(now.Add(5*time.Second).UnixMilli(), 10)},
		{"stale", strconv.FormatInt(now.Add(-11*time.Minute).UnixMilli(), 10)},
		{"unparseable", "not-a-timestamp"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("KIN_STARTUP_TRACE", "1")
			t.Setenv("KIN_STARTUP_ORIGIN_MS", tc.origin)

			clock := &fixedStartupClock{t: now}
			var out bytes.Buffer
			tr := startupTraceFromEnv(&out, clock.now)
			tr.mark("process")

			// A rejected origin must fall back to the trace's own start: no
			// negative phase and no invented minutes of process time.
			want := "kin: startup process 0ms total=0ms\n"
			if got := out.String(); got != want {
				t.Fatalf("trace = %q, want %q", got, want)
			}
		})
	}
}

func TestStartupTraceOriginUnsetKeepsCurrentBehaviour(t *testing.T) {
	t.Setenv("KIN_STARTUP_TRACE", "1")
	clearStartupOriginEnv(t)

	var out bytes.Buffer
	clock := &fakeStartupClock{t: time.Unix(0, 0), step: 10 * time.Millisecond}
	tr := startupTraceFromEnv(&out, clock.now)
	tr.mark("process")
	tr.mark("state-dir")

	// Identical to the pre-origin trace: the clock starts at the trace, so the
	// first mark reports one step and totals accumulate from there.
	want := "kin: startup process 10ms total=10ms\n" +
		"kin: startup state-dir 10ms total=20ms\n"
	if got := out.String(); got != want {
		t.Fatalf("trace = %q, want %q", got, want)
	}
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
