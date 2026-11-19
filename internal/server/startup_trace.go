package server

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"time"
)

// startupTrace writes one line per boot phase when KIN_STARTUP_TRACE=1:
//
//	kin: startup store-open 412ms total=418ms
//
// It exists so "startup is slow" can be answered with numbers from outside the
// process — which phase, and how much of the total — without a debugger or a
// profiler attached. It measures; it never changes the boot.
//
// A launcher that knows when it spawned the process exports that instant as
// KIN_STARTUP_ORIGIN_MS (epoch milliseconds). The trace then covers exec, dyld,
// runtime init and flag parsing — the span before this package is entered —
// instead of starting the clock at its own construction. An implausible value
// is ignored rather than trusted: a stale variable left in a shell must not
// invent minutes of process time or a negative first phase.
//
// The env-unset case is silent by construction: no line, no map, and mark is a
// single nil-safe branch, so normal daemon stderr is unchanged.
type startupTrace struct {
	enabled bool
	w       io.Writer
	now     func() time.Time
	start   time.Time
	last    time.Time
	seen    map[string]bool
}

// startupOriginEnv names the epoch-ms instant at which the launcher started
// this process. It is read once, at trace construction.
const startupOriginEnv = "KIN_STARTUP_ORIGIN_MS"

// startupOriginMaxAge bounds how old an exported origin may be. A value older
// than this is not this process's start — it is a leftover in the environment
// — and using it would report a process phase of minutes.
const startupOriginMaxAge = 10 * time.Minute

func startupTraceFromEnv(w io.Writer, now func() time.Time) *startupTrace {
	enabled := os.Getenv("KIN_STARTUP_TRACE") == "1"
	origin, ok := time.Time{}, false
	if enabled {
		origin, ok = startupOriginFromEnv(now)
	}
	t := newStartupTrace(enabled, w, now)
	if ok {
		t.start = origin
		t.last = origin
	}
	return t
}

// startupOriginFromEnv reads the launcher's origin. It accepts only a value
// that is not in the future and not older than startupOriginMaxAge; anything
// else (missing, unparseable, future, stale) reports false and leaves the
// trace's own construction time as the start.
func startupOriginFromEnv(now func() time.Time) (time.Time, bool) {
	raw := os.Getenv(startupOriginEnv)
	if raw == "" {
		return time.Time{}, false
	}
	ms, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	origin := time.UnixMilli(ms)
	age := now().Sub(origin)
	if age < 0 || age > startupOriginMaxAge {
		return time.Time{}, false
	}
	return origin, true
}

func newStartupTrace(enabled bool, w io.Writer, now func() time.Time) *startupTrace {
	t := &startupTrace{enabled: enabled}
	if !enabled {
		return t
	}
	t.w = w
	t.now = now
	t.start = now()
	t.last = t.start
	t.seen = make(map[string]bool)
	return t
}

// mark records the end of a boot phase. The first mark for a phase wins: a
// retry later in boot (a second engine start after a restart inside one
// process) must not attribute the same span twice.
func (t *startupTrace) mark(phase string) {
	if t == nil || !t.enabled || t.seen[phase] {
		return
	}
	t.seen[phase] = true
	at := t.now()
	delta := at.Sub(t.last)
	t.last = at
	fmt.Fprintf(t.w, "kin: startup %s %dms total=%dms\n", phase, delta.Milliseconds(), at.Sub(t.start).Milliseconds())
}
