package main

import (
	"runtime"
	"syscall"
)

// peakRSSBytes reports the process's maximum resident set size. Getrusage
// counts bytes on Darwin and kilobytes on Linux; normalise to bytes.
func peakRSSBytes() int64 {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return 0
	}
	if runtime.GOOS == "darwin" {
		return int64(usage.Maxrss)
	}
	return int64(usage.Maxrss) * 1024
}
