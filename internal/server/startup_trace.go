package server

import (
	"fmt"
	"io"
	"os"
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

func startupTraceFromEnv(w io.Writer, now func() time.Time) *startupTrace {
	return newStartupTrace(os.Getenv("KIN_STARTUP_TRACE") == "1", w, now)
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
