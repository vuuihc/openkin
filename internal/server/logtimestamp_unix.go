//go:build darwin || linux

package server

import (
	"bytes"
	"io"
	"os"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// timestampStderr redirects the process's file descriptor 2 through a writer
// that prefixes every line with the time it was written.
//
// The daemon's log is launchd's file, and until now the disconnect story read
// as an undated wall of "EOF / connected / cancel" lines: reconstructing one
// morning's outages meant inferring time from neighbouring events. Every
// diagnostic line the daemon writes flows through fd 2, so splicing there
// timestamps all of them — existing call sites, future ones, and library code
// alike — without threading a logger through the codebase.
//
// A pipe replaces the descriptor: writers keep writing to what they believe
// is stderr, a reader goroutine stamps complete lines into the original file.
// It is installed once; later calls are no-ops, which keeps repeated startups
// (and tests) from wiring pipes in series.
func timestampStderr() {
	timestampOnce.Do(func() {
		// The write target must be the original descriptor, saved *before* the
		// splice: after Dup2 replaces fd 2 with the pipe, os.Stderr names the
		// pipe itself, and writing the timestamped lines back there would feed
		// the stamper its own output — an echo loop that fills the pipe and
		// blocks every writer on the only goroutine that could drain it.
		origFD, err := syscall.Dup(2)
		if err != nil {
			return
		}
		// CLOEXEC, so the agents this daemon spawns do not inherit the log
		// file: a child holding the write end pins the old inode after a
		// rotation and keeps the collector waiting for an EOF that never comes.
		syscall.CloseOnExec(origFD)
		target := os.NewFile(uintptr(origFD), "stderr") // dup'ed, so closing fd 2 later leaves it open
		r, w, err := os.Pipe()
		if err != nil {
			_ = target.Close()
			return
		}
		go func() {
			buf := make([]byte, 32*1024)
			var carry []byte
			for {
				n, err := r.Read(buf)
				if n > 0 {
					carry = appendTimestamp(carry, buf[:n], target)
				}
				if err != nil {
					if len(carry) > 0 {
						_, _ = target.Write(carry)
					}
					return
				}
			}
		}()
		if err := unix.Dup2(int(w.Fd()), 2); err != nil {
			// Without the splice the log is still complete, just not
			// timestamped; closing the pipe end takes the goroutine with it.
			_ = w.Close()
			_ = r.Close()
			_ = target.Close()
			return
		}
		// The descriptor now holds its own reference to the pipe; this one
		// would keep the write end alive even if everything else closed it.
		_ = w.Close()
	})
}

var timestampOnce sync.Once

// appendTimestamp writes chunk to dst with a timestamp at the start of every
// complete line it contains, and returns the trailing partial line to carry
// into the next chunk. Blank lines pass through without a stamp so banners and
// spacing keep their shape.
func appendTimestamp(carry, chunk []byte, dst io.Writer) []byte {
	buf := append(carry, chunk...)
	for len(buf) > 0 {
		idx := bytes.IndexByte(buf, '\n')
		if idx < 0 {
			return buf
		}
		line := buf[:idx+1]
		buf = buf[idx+1:]
		if len(bytes.TrimSpace(line)) == 0 {
			_, _ = dst.Write(line)
			continue
		}
		_, _ = dst.Write([]byte(time.Now().Format("2006-01-02 15:04:05.000 ")))
		_, _ = dst.Write(line)
	}
	return nil
}

// timestampWriter is the same line-stamping rule as a Writer, for callers (and
// tests) that hold an io.Writer rather than a descriptor.
type timestampWriter struct {
	w  io.Writer
	mu sync.Mutex
	c  []byte // the partial line carried from the last Write
}

func newTimestampWriter(w io.Writer) *timestampWriter {
	return &timestampWriter{w: w}
}

func (t *timestampWriter) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	// The whole of p counts as written once it is handed over, including a
	// partial trailing line: io.Writer semantics keep callers honest.
	n := len(p)
	t.c = appendTimestamp(t.c, p, t.w)
	return n, nil
}
