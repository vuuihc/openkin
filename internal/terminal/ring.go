package terminal

type byteRing struct {
	buf      []byte
	capacity int
}

func newByteRing(capacity int) *byteRing {
	if capacity < 0 {
		capacity = 0
	}
	return &byteRing{capacity: capacity}
}

func (r *byteRing) Append(p []byte) {
	if r.capacity == 0 || len(p) == 0 {
		return
	}
	if len(p) >= r.capacity {
		r.buf = append(r.buf[:0], p[len(p)-r.capacity:]...)
		return
	}
	overflow := len(r.buf) + len(p) - r.capacity
	if overflow > 0 {
		copy(r.buf, r.buf[overflow:])
		r.buf = r.buf[:len(r.buf)-overflow]
	}
	r.buf = append(r.buf, p...)
}

func (r *byteRing) Snapshot() []byte {
	return append([]byte(nil), r.buf...)
}
