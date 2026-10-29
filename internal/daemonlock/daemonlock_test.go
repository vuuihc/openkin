package daemonlock

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote"
)

// holdEnv turns a re-executed test binary into a lock holder, so the tests can
// check the property that only exists across processes: a second process is
// refused, and the kernel frees the lock when the holder dies.
const holdEnv = "DAEMONLOCK_TEST_HOLD_DIR"

func TestMain(m *testing.M) {
	if dir := os.Getenv(holdEnv); dir != "" {
		lock, err := Acquire(dir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "helper: %v\n", err)
			os.Exit(3)
		}
		// Announce only after the lock is held, so the parent never races the
		// acquisition. The cap keeps a stray helper from living forever if the
		// parent dies before killing it.
		fmt.Printf("pid=%d\n", os.Getpid())
		time.Sleep(60 * time.Second)
		_ = lock.Close()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestAcquireReleasesOnClose(t *testing.T) {
	dir := t.TempDir()

	first, err := Acquire(dir)
	if err != nil {
		t.Fatalf("first Acquire: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// The file stays behind on purpose; a stale file must not block the next
	// daemon. Removing it on release is the inode race the package documents.
	if _, err := os.Stat(filepath.Join(dir, FileName)); err != nil {
		t.Fatalf("lock file removed on release: %v", err)
	}

	second, err := Acquire(dir)
	if err != nil {
		t.Fatalf("Acquire after release: %v", err)
	}
	if err := second.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestStalePIDFileFromDeadDaemonDoesNotBlock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	// What a daemon killed with SIGKILL leaves behind: a pid nobody holds.
	if err := os.WriteFile(path, []byte("999999\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	lock, err := Acquire(dir)
	if err != nil {
		t.Fatalf("stale lock file blocked a new daemon: %v", err)
	}
	defer lock.Close()

	got := readPIDFile(t, path)
	if got != os.Getpid() {
		t.Errorf("lock file pid = %d, want the new holder %d", got, os.Getpid())
	}
}

func TestAnotherProcessIsRefusedAndNamed(t *testing.T) {
	dir := t.TempDir()
	holder, stop := startHolder(t, dir)
	defer stop()

	_, err := Acquire(dir)
	if !errors.Is(err, ErrHeld) {
		t.Fatalf("Acquire error = %v, want ErrHeld", err)
	}
	var held *HeldError
	if !errors.As(err, &held) {
		t.Fatalf("Acquire error = %T, want *HeldError", err)
	}
	if held.PID != holder {
		t.Errorf("HeldError.PID = %d, want the holder %d", held.PID, holder)
	}
	// The message is what a person sees after `kin serve`; it has to name both
	// the directory and the process to stop.
	if !strings.Contains(err.Error(), dir) {
		t.Errorf("message %q does not name the state dir", err)
	}
	if !strings.Contains(err.Error(), strconv.Itoa(holder)) {
		t.Errorf("message %q does not name the holder pid", err)
	}
}

func TestLockIsFreedWhenTheHolderDies(t *testing.T) {
	dir := t.TempDir()
	holder, stop := startHolder(t, dir)

	if _, err := Acquire(dir); !errors.Is(err, ErrHeld) {
		t.Fatalf("Acquire while held = %v, want ErrHeld", err)
	}

	// SIGKILL: no deferred Close, no cleanup. flock must still be released.
	if err := killHolder(holder); err != nil {
		t.Fatalf("kill holder: %v", err)
	}
	stop()

	deadline := time.Now().Add(5 * time.Second)
	for {
		lock, err := Acquire(dir)
		if err == nil {
			_ = lock.Close()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("lock still held after the holder was killed: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func startHolder(t *testing.T, dir string) (pid int, stop func()) {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), holdEnv+"="+dir)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stopped := false
	stop = func() {
		if stopped {
			return
		}
		stopped = true
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}
	t.Cleanup(stop)

	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		stop()
		t.Fatalf("lock holder did not announce itself: %v (stderr: %s)", err, stderr.String())
	}
	raw := strings.TrimPrefix(strings.TrimSpace(line), "pid=")
	pid, err = strconv.Atoi(raw)
	if err != nil || pid <= 0 {
		stop()
		t.Fatalf("lock holder announced %q, want pid=<number>", line)
	}
	return pid, stop
}

func killHolder(pid int) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Kill()
}

func readPIDFile(t *testing.T, path string) int {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		t.Fatalf("lock file content %q is not a pid: %v", b, err)
	}
	return pid
}

func TestHeldMessageNamesTheStateDirEnv(t *testing.T) {
	// The message tells a person how to run a second instance; it must name the
	// variable the daemon actually reads, not a stale spelling.
	err := &HeldError{StateDir: "/tmp/state", PID: 1}
	if !strings.Contains(err.Error(), remote.StateDirEnv) {
		t.Errorf("message %q does not name %s", err, remote.StateDirEnv)
	}
}
