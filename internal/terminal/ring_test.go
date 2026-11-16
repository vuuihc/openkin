package terminal

import (
	"bytes"
	"testing"
)

func TestByteRing(t *testing.T) {
	t.Run("empty snapshot", func(t *testing.T) {
		ring := newByteRing(8)
		if got := ring.Snapshot(); len(got) != 0 {
			t.Fatalf("Snapshot() = %q, want empty", got)
		}
	})

	t.Run("append below capacity", func(t *testing.T) {
		ring := newByteRing(8)
		ring.Append([]byte("abc"))
		if got := ring.Snapshot(); !bytes.Equal(got, []byte("abc")) {
			t.Fatalf("Snapshot() = %q, want abc", got)
		}
	})

	t.Run("append across capacity", func(t *testing.T) {
		ring := newByteRing(8)
		ring.Append([]byte("abcde"))
		ring.Append([]byte("fghij"))
		if got := ring.Snapshot(); !bytes.Equal(got, []byte("cdefghij")) {
			t.Fatalf("Snapshot() = %q, want cdefghij", got)
		}
	})

	t.Run("single append larger than capacity", func(t *testing.T) {
		ring := newByteRing(8)
		ring.Append([]byte("0123456789"))
		if got := ring.Snapshot(); !bytes.Equal(got, []byte("23456789")) {
			t.Fatalf("Snapshot() = %q, want 23456789", got)
		}
	})

	t.Run("snapshot is isolated", func(t *testing.T) {
		ring := newByteRing(8)
		ring.Append([]byte("abc"))
		first := ring.Snapshot()
		first[0] = 'z'
		if got := ring.Snapshot(); !bytes.Equal(got, []byte("abc")) {
			t.Fatalf("Snapshot() = %q after caller mutation, want abc", got)
		}
	})
}
