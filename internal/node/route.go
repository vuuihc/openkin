package node

import (
	"context"
	"fmt"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// FrameRouter hands one frame from a machine to whichever table asked for it.
type FrameRouter func(ctx context.Context, sender Sender, frame worker.Frame) error

// RouteFrame builds the router for frames that arrive on a Node connection.
//
// Everything a machine sends up arrives on one socket and belongs to one of
// three halves of the Hub: a turn it is running (Turns), a permission question
// it is blocked on (Approvals), or the answer to a question the Hub asked
// (Queries). The switch is here, beside all three, rather than in the
// composition root: the day a fourth arrives, the compiler points at one place
// instead of at whichever caller forgot to route it.
//
// A nil table means this Hub has no such half — a daemon that does not run
// turns, an embedder that only asks questions — and the frame is refused with a
// sentence rather than sent to a nil receiver.
func RouteFrame(turns *Turns, approvals *Approvals, queries *Queries) FrameRouter {
	return func(ctx context.Context, sender Sender, frame worker.Frame) error {
		switch frame.Kind {
		case "approval.request":
			if approvals == nil {
				return fmt.Errorf("this hub has no approvals to handle %q", frame.Kind)
			}
			return approvals.Route(ctx, sender, frame)
		case "query.result":
			if queries == nil {
				return fmt.Errorf("this hub asked no questions, so %q is not an answer", frame.Kind)
			}
			return queries.Route(ctx, sender, frame)
		default:
			if turns == nil {
				return fmt.Errorf("this hub runs no turns, so %q is not about one", frame.Kind)
			}
			return turns.RouteFrame(ctx, sender, frame)
		}
	}
}
