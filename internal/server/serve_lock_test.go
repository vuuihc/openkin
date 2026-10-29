package server

import (
	"errors"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/daemonlock"
	"github.com/vuuihc/openkin/internal/remote"
)

// A second daemon on one state directory used to start and serve beside the
// first: both open the database, each keeps its own bus, and the console can
// end up watching the one the phone never talks to. `kin serve` now refuses
// before it touches anything.
func TestServeWithRefusesWhenAnotherDaemonOwnsTheStateDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(remote.StateDirEnv, dir)

	holder, err := daemonlock.Acquire(dir)
	if err != nil {
		t.Fatalf("hold the state dir: %v", err)
	}
	defer holder.Close()

	// Occupy the port the daemon would bind. If the lock ever stops refusing,
	// the daemon fails to listen instead of starting and blocking until the
	// package timeout — a test for a refusal must not be able to run a daemon.
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	port := occupied.Addr().(*net.TCPAddr).Port

	done := make(chan error, 1)
	go func() { done <- ServeWith("test", ServeFlags{Port: port}) }()

	var serveErr error
	select {
	case serveErr = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("ServeWith is still running: the daemon started despite the held lock")
	}

	if !errors.Is(serveErr, daemonlock.ErrHeld) {
		t.Fatalf("ServeWith error = %v, want ErrHeld", serveErr)
	}
	var held *daemonlock.HeldError
	if !errors.As(serveErr, &held) {
		t.Fatalf("ServeWith error = %T, want *daemonlock.HeldError", serveErr)
	}
	if held.StateDir != dir {
		t.Errorf("HeldError.StateDir = %q, want %q", held.StateDir, dir)
	}

	// The refusal is only useful if it happens before the store: a daemon that
	// opened the database and then gave up could still have started a loop,
	// run a migration, or left a token behind.
	for _, name := range []string{"kin.db", "token"} {
		_, statErr := os.Stat(filepath.Join(dir, name))
		if !errors.Is(statErr, fs.ErrNotExist) {
			t.Errorf("%s exists after a refused start (stat error %v)", name, statErr)
		}
	}
}

// The lock is only an invariant if it is released on every way out of
// ServeWith. This drives the one path that acquires it and then returns — a
// listener that cannot bind — and asks for the lock afterwards.
func TestServeWithReleasesTheLockWhenItStops(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(remote.StateDirEnv, dir)

	// A port something else already listens on: ServeWith takes the lock,
	// fails at the loopback transport, and returns its error.
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	port := occupied.Addr().(*net.TCPAddr).Port
	t.Setenv("KIN_PORT", strconv.Itoa(port))

	done := make(chan error, 1)
	go func() { done <- ServeWith("test", ServeFlags{Port: port}) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("ServeWith reported success while its port was taken")
		}
	case <-time.After(60 * time.Second):
		t.Fatal("ServeWith did not return after failing to listen")
	}

	lock, err := daemonlock.Acquire(dir)
	if err != nil {
		t.Fatalf("the state dir was not released when ServeWith returned: %v", err)
	}
	if err := lock.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}
