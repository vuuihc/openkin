// Package daemonlock keeps one kin daemon on a state directory.
//
// A state directory holds a SQLite database whose invariants assume a single
// writer: the daemon runs periodic loops over it (pull-request reconcile,
// worker lease reaping, approval expiry) that are not safe to duplicate across
// processes, and it keeps in-memory buses, flags, and relay state that a second
// process would not share. Two daemons on one directory do not fail loudly —
// they both start, both open the database, and each serves half the system (a
// node started with --lan binds the wildcard while a desktop-spawned daemon
// binds 127.0.0.1, so both can listen on one port), so a console can quietly
// watch a daemon the phone never talks to. The desktop shell's daemon-rival.ts
// exists to paper over exactly that window.
//
// The lock is an exclusive flock on <state dir>/daemon.lock, taken before the
// database is opened. The kernel releases flock when the process exits or is
// killed, so a crashed daemon never leaves a stale lock behind. The file is
// deliberately not removed on release: unlinking a lock file that another
// process may be about to open lets two processes lock different inodes with
// the same name, which is the bug this package exists to prevent. A state
// directory on a filesystem that cannot lock (some network mounts) fails to
// start with the flock error; SQLite on such a mount was already unsafe.
package daemonlock

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// FileName is the lock file inside a state directory.
const FileName = "daemon.lock"

// ErrHeld reports that another live process already owns the state directory.
// Callers that turn errors into process exit codes match it with errors.Is.
var ErrHeld = errors.New("another kin daemon is using this state directory")

// HeldError describes who holds the state directory. PID is diagnostic only —
// the lock itself is the source of truth — and is 0 when the holder had not
// written it yet or the file was left by a process that never took the lock.
type HeldError struct {
	StateDir string
	PID      int
}

func (e *HeldError) Error() string {
	holder := "another kin daemon"
	if e.PID > 0 {
		holder = fmt.Sprintf("another kin daemon (pid %d)", e.PID)
	}
	// Keep the environment variable name in step with remote.StateDirEnv; it is
	// spelled out here so this package stays free of daemon dependencies.
	return fmt.Sprintf(
		"%s is already using %s; stop it first, or set KIN_STATE_DIR to a separate directory",
		holder, e.StateDir,
	)
}

// Unwrap makes errors.Is(err, ErrHeld) true for a held lock.
func (e *HeldError) Unwrap() error { return ErrHeld }

// Lock is an acquired state-directory lock. Close releases it; the process
// exiting releases it too.
type Lock struct {
	file *os.File
	path string
}

// Acquire takes the exclusive lock for stateDir, which must already exist.
// It fails with an error wrapping ErrHeld when another live process holds it.
func Acquire(stateDir string) (*Lock, error) {
	path := filepath.Join(stateDir, FileName)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		// Read the holder while the file is still open. The read does not need
		// the lock: the content is the holder's pid, written after it acquired.
		pid := readPID(file)
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, &HeldError{StateDir: stateDir, PID: pid}
		}
		return nil, fmt.Errorf("lock %s: %w", path, err)
	}
	// The pid is a courtesy for the next process's error message; failing to
	// record it must not fail a daemon that already owns the directory.
	_ = writePID(file)
	return &Lock{file: file, path: path}, nil
}

// Close releases the lock and leaves the file in place (see the package
// comment). It is safe to call once.
func (l *Lock) Close() error {
	if l == nil || l.file == nil {
		return nil
	}
	err := syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
	closeErr := l.file.Close()
	l.file = nil
	if err != nil {
		return fmt.Errorf("unlock %s: %w", l.path, err)
	}
	return closeErr
}

// readPID returns the pid written by the holder, or 0 when it is missing or
// unreadable.
func readPID(file *os.File) int {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return 0
	}
	b, err := io.ReadAll(io.LimitReader(file, 32))
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

func writePID(file *os.File) error {
	if err := file.Truncate(0); err != nil {
		return err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	_, err := fmt.Fprintf(file, "%d\n", os.Getpid())
	return err
}
