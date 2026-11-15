// Package hub is where code that only a Hub runs lives.
//
// ADR 0025 gives the Hub an artifact of its own: `cmd/kin-hub` builds the Hub
// alone, while `cmd/kin` keeps standalone and Node. Code on this side of the
// line is not reachable from a Node, and a Node must not import it. The rules
// are enforced by the tests in boundary_test.go rather than by this comment.
//
// The protocol a Hub speaks with a Node is deliberately not here. It is a
// specification both sides share and it lives in internal/remote/worker, which
// must stay a leaf.
package hub
