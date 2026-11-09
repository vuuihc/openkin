//go:build !darwin && !linux

package server

// timestampStderr is a no-op where the descriptor splice is not implemented.
// The log is still complete, just without per-line timestamps; the platforms
// this daemon ships on (darwin, linux) use logtimestamp_unix.go.
func timestampStderr() {}
