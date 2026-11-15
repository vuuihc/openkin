//go:build darwin || linux

package server

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// stampShape is what a timestamped line starts with: the shape, not the year —
// a literal "2026-" here would turn the whole suite red on 2027-01-01.
var stampShape = regexp.MustCompile(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} `)

// stampCount counts completed stamps in a log, robust to the year changing.
func stampCount(s string) int {
	return strings.Count(s, time.Now().Format("2006-"))
}

// TestTimestampWriterPrefixesEveryLine checks the property the disconnect
// post-mortem needed: every diagnostic line, from any call site, arrives with a
// timestamp a person can put on a timeline.
func TestTimestampWriterPrefixesEveryLine(t *testing.T) {
	var out bytes.Buffer
	w := newTimestampWriter(&out)
	fmt.Fprintf(w, "kin: node: connected\nkin: warning: eof\n")
	got := out.String()
	lines := strings.Split(strings.TrimSuffix(got, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines = %d (%q), want 2", len(lines), got)
	}
	for _, line := range lines {
		if !stampShape.MatchString(line) {
			t.Errorf("line %q has no timestamp prefix", line)
		}
	}
}

// TestTimestampWriterCarriesPartialLines pins the streaming rule: a write that
// ends mid-line is not stamped, and the line is stamped once, when it completes
// in a later write — a write split at any boundary must produce the same log.
func TestTimestampWriterCarriesPartialLines(t *testing.T) {
	var out bytes.Buffer
	w := newTimestampWriter(&out)
	w.Write([]byte("kin: node: conn"))
	w.Write([]byte("ected\n"))
	w.Write([]byte("\n")) // blank lines keep their shape, unstamped
	w.Write([]byte("kin: node: done\n"))
	got := out.String()
	// The partial line is stamped once, when it completes — the stamp sits at
	// the head of the completed line, not where the first write began.
	if !strings.Contains(got, " kin: node: connected\n") {
		t.Fatalf("got %q, want the completed line whole", got)
	}
	if stampCount(got) != 2 {
		t.Fatalf("got %q, want exactly 2 stamps", got)
	}
}

// TestTimestampWriterKeepsConcurrentWritesWhole keeps the stamper honest under
// the goroutines the daemon really has: two writers racing through one Write
// path must not interleave into a line that starts mid-sentence.
func TestTimestampWriterKeepsConcurrentWritesWhole(t *testing.T) {
	var out lockedBuffer
	w := newTimestampWriter(&out)
	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				fmt.Fprintf(w, "goroutine %d line %d\n", g, i)
			}
		}(g)
	}
	wg.Wait()
	for _, line := range strings.Split(strings.TrimSuffix(out.buf.String(), "\n"), "\n") {
		if !stampShape.MatchString(line) {
			t.Fatalf("unstamped or interleaved line: %q", line)
		}
	}
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

// TestTimestampStderrSplicesTheRealDescriptor is the end-to-end proof of the
// production path: a child process calls timestampStderr (the same function
// ServeWith installs), writes plain lines to fd 2, and the parent reads the
// log file launchd-style redirection points at. This is the test that would
// have caught the first splice: it wrote the stamped lines back into the pipe
// it had just installed, an echo loop that fills the pipe and blocks every
// stderr writer on the only goroutine that could drain it — the child here
// deadlocks, its log stays empty, and the test fails.
func TestTimestampStderrSplicesTheRealDescriptor(t *testing.T) {
	if os.Getenv("KIN_TIMESTAMP_CHILD") != "" {
		timestampStderr()
		// Through the *descriptor*, not os.Stderr: the whole point is that
		// existing call sites — warnToStderr, fmt.Fprintf(os.Stderr, ...) —
		// keep working unmodified.
		fmt.Fprintf(os.Stderr, "kin: node: connected\n")
		fmt.Fprintf(os.Stderr, "partial that")
		fmt.Fprintf(os.Stderr, " completes\n")
		// Close the pipe write end and wait for the stamper to drain. A sleep
		// here raced: on a loaded CI runner the log was still empty after 20ms
		// (run 43694877337, same SHA later green on the pull_request workflow).
		flushTimestampStderr()
		// fd 2 must stay writable after the flush: a later diagnostic (panic,
		// race report) writes to it. Closing the descriptor outright made this
		// an EBADF the parent could not see. The line goes to /dev/null, so
		// the log must not gain it.
		if _, err := fmt.Fprintf(os.Stderr, "kin: after flush\n"); err != nil {
			os.Exit(3)
		}
		return
	}

	logPath := t.TempDir() + "/node.log"
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	// CommandContext, not Run: a child that wedges (the failure mode this
	// test exists to catch) must be killed by a timeout, not hold the parent
	// to the package deadline and leave an orphan behind.
	runCtx, cancelRun := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelRun()
	cmd := exec.CommandContext(runCtx, os.Args[0], "-test.run", "^"+t.Name()+"$")
	cmd.Env = append(os.Environ(), "KIN_TIMESTAMP_CHILD=1")
	cmd.Stderr = logFile
	cmd.Stdout = nil
	if err := cmd.Run(); err != nil {
		t.Fatalf("child: %v", err)
	}
	logFile.Close()
	got, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(got)
	if strings.Contains(text, "partial that completes\n2026") {
		t.Fatalf("stamp landed mid-line: %q", text)
	}
	if !strings.Contains(text, time.Now().Format("2006-")) {
		t.Fatalf("no timestamp reached the log: %q", text)
	}
	if !strings.Contains(text, "kin: node: connected") {
		t.Fatalf("the plain lines never arrived: %q", text)
	}
	// Exactly two stamps for two complete lines, in order.
	gotStamps := stampCount(text)
	if gotStamps != 2 {
		t.Fatalf("%d stamps, want 2: %q", gotStamps, text)
	}
	if strings.Index(text, "kin: node: connected") > strings.Index(text, "partial that completes") {
		t.Fatalf("lines out of order: %q", text)
	}
	// The child wrote once more after the flush. It must not reach the log:
	// the descriptor now points at /dev/null, not the file launchd opened.
	if strings.Contains(text, "kin: after flush") {
		t.Fatalf("post-flush stderr reached the log: %q", text)
	}
}
