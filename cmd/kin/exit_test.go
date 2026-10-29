package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/daemonlock"
)

func TestDaemonExitCode(t *testing.T) {
	// The literal is the contract with `kin supervise`, launchd and the desktop
	// shell (desktop/src/sidecar.ts). Changing it in Go alone would leave every
	// parent reading the old value as an ordinary crash.
	if stateDirBusyExit != 75 {
		t.Fatalf("stateDirBusyExit = %d, want EX_TEMPFAIL 75", stateDirBusyExit)
	}
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"held lock", daemonlock.ErrHeld, stateDirBusyExit},
		{"wrapped held lock", fmt.Errorf("serve: %w", &daemonlock.HeldError{StateDir: "/tmp/state", PID: 42}), stateDirBusyExit},
		{"busy supervisor", fmt.Errorf("supervise: %w", errStateDirBusy), stateDirBusyExit},
		{"anything else", errors.New("boom"), 1},
		{"nil", nil, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := daemonExitCode(tc.err); got != tc.want {
				t.Errorf("daemonExitCode(%v) = %d, want %d", tc.err, got, tc.want)
			}
		})
	}
}

func TestExitsWith(t *testing.T) {
	if err := exitStatus(t, stateDirBusyExit); !exitsWith(err, stateDirBusyExit) {
		t.Errorf("exitsWith(%v, %d) = false", err, stateDirBusyExit)
	}
	// A crash must not be mistaken for the busy refusal: the supervisor would
	// stop restarting a daemon that only needed a restart.
	if err := exitStatus(t, 1); exitsWith(err, stateDirBusyExit) {
		t.Errorf("exitsWith(%v, %d) = true", err, stateDirBusyExit)
	}
	if exitsWith(nil, stateDirBusyExit) {
		t.Error("exitsWith(nil) = true")
	}
}

// The exit status is a promise to a process this one does not control —
// `kin supervise`, launchd, the desktop shell — and no in-process test can make
// that call. So the wiring is pinned by shape: each daemon subcommand reports
// the mapped status (and nothing else does), and the supervisor recognizes the
// refusal before it decides to restart.
func TestDaemonCommandsReportTheBusyExit(t *testing.T) {
	main := readSource(t, "main.go")
	for name, block := range map[string]string{
		"serve":     sliceBetween(t, main, `case "serve":`, `case "supervise":`),
		"supervise": sliceBetween(t, main, `case "supervise":`, `case "token":`),
	} {
		if !strings.Contains(block, "os.Exit(daemonExitCode(err))") {
			t.Errorf("the %s case does not report the daemon exit code", name)
		}
	}
	// Exactly the two daemon commands: mapping another command's error would
	// report a state-directory refusal that never happened.
	if got := strings.Count(main, "os.Exit(daemonExitCode(err))"); got != 2 {
		t.Errorf("main.go reports the daemon exit code %d times, want 2", got)
	}

	supervise := readSource(t, "supervise.go")
	busy := strings.Index(supervise, "if exitsWith(err, stateDirBusyExit) {")
	if busy < 0 {
		t.Fatal("supervise.go does not check for the busy exit")
	}
	if strings.Contains(supervise, "!exitsWith(err, stateDirBusyExit)") {
		t.Error("the busy check is negated")
	}
	// LastIndex: the start-failure branch has its own restart-limit check
	// earlier in the file; the one that matters is in the child-exit branch.
	restart := strings.LastIndex(supervise, "if attempt == maxSuperviseRestarts")
	if restart < 0 || busy > restart {
		t.Errorf("the busy check at %d is not before the restart decision at %d", busy, restart)
	}
}

// sliceBetween returns src[from:to] and fails when either marker is missing or
// out of order, so a moved case cannot silently widen a check.
func sliceBetween(t *testing.T, src, from, to string) string {
	t.Helper()
	start := strings.Index(src, from)
	if start < 0 {
		t.Fatalf("%q not found", from)
	}
	end := strings.Index(src[start:], to)
	if end < 0 {
		t.Fatalf("%q not found after %q", to, from)
	}
	return src[start : start+end]
}

func readSource(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// exitStatus runs a process that exits with code and returns the error
// exec.Cmd.Wait reports for it.
func exitStatus(t *testing.T, code int) error {
	t.Helper()
	err := exec.Command("sh", "-c", "exit "+strconv.Itoa(code)).Run()
	if err == nil {
		t.Fatalf("sh -c 'exit %d' reported success", code)
	}
	return err
}
