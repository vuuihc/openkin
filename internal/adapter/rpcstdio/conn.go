// Package rpcstdio is the plumbing an adapter needs to speak
// newline-delimited JSON-RPC 2.0 to a subprocess over stdin and stdout.
//
// It is deliberately small. What is shared is the part where a mistake is
// invisible until it is a production bug: one writer holding one lock (two
// goroutines interleaving half a line each produce a message neither side can
// parse), and the table that matches a response back to the method that asked
// for it.
//
// The read loop is not here. Each adapter's loop is a switch over the messages
// its own protocol defines, and droid's and ACP's disagree about the envelope
// itself — droid carries `type`, `factoryApiVersion` and `factoryProtocolVersion`
// at the top level, ACP carries none of them and allows numeric ids. Sharing
// the loop would mean parameterizing the envelope, which is more machinery than
// the twenty lines it saves.
package rpcstdio

import (
	"bufio"
	"io"
	"strconv"
	"sync"
)

const (
	// maxLineBytes bounds one message. Agent protocols send whole tool results
	// and whole file contents in a single line, so the default 64KB scanner
	// buffer is not enough; this is the same ceiling the adapter package reads
	// subprocess output with elsewhere.
	maxLineBytes = 16 * 1024 * 1024
	// initialLineBytes is the starting buffer. It grows to maxLineBytes as
	// needed.
	initialLineBytes = 64 * 1024
)

// Conn is one bidirectional JSON-RPC conversation with a subprocess.
//
// It is safe for concurrent use: several goroutines may be answering reverse
// requests while the read loop is answering responses.
type Conn struct {
	w      io.Writer
	prefix string

	mu      sync.Mutex
	nextID  int
	pending map[string]string
}

// NewConn returns a Conn writing to w. Request ids are prefix + counter, so
// ids from Kin are recognizable in a transcript next to ids the agent chose.
func NewConn(w io.Writer, prefix string) *Conn {
	return &Conn{w: w, prefix: prefix, pending: make(map[string]string)}
}

// Write sends one already-encoded message, adding the newline that frames it.
//
// The lock is held across the whole write, so a caller may encode and send
// without coordinating with anyone else.
func (c *Conn) Write(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err := c.w.Write(append(data, '\n'))
	return err
}

// RequestID allocates the next id and records the method it is asking for, so
// the response can be routed.
//
// The id is tracked before the request is written — the caller does that next,
// under no lock — because a response can only arrive for a request that is
// already on the wire.
func (c *Conn) RequestID(method string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	id := c.prefix + strconv.Itoa(c.nextID)
	c.pending[id] = method
	return id
}

// Forget drops a request that never made it onto the wire, so a later response
// with that id is treated as unanswerable rather than as this method's.
func (c *Conn) Forget(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.pending, id)
}

// Take returns the method id was asking for and forgets it. An empty result
// means nothing here asked, which is how an adapter tells a late, duplicated or
// foreign response from one it is waiting for.
func (c *Conn) Take(id string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	method := c.pending[id]
	delete(c.pending, id)
	return method
}

// Scanner returns a line scanner sized for the messages these protocols carry.
func Scanner(r io.Reader) *bufio.Scanner {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, initialLineBytes), maxLineBytes)
	return scanner
}
