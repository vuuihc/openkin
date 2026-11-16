package github

import (
	"context"
	"fmt"
)

// ObserveHere answers one branch's pull request from this machine.
//
// It is the sequence the Hub runs for its own checkouts — the GitHub CLI first,
// because those are the user's own credentials and they see private
// repositories, then a credential-free read of the public API — with the Hub's
// accounting left behind. What an anonymous read spends here is spent against
// this machine's egress address, and it is the Hub that decides when to ask, so
// the cadence that keeps the Hub's own quota is the cadence that keeps this one.
//
// Nothing about the credential travels: what leaves is a question about a
// repository and a branch, and what comes back is the pull request.
func ObserveHere(ctx context.Context, repo Repo, branch string) (LookupResult, error) {
	var ghErr error
	if client, err := ResolveGH(); err == nil {
		res, err := lookup(ctx, ghReader{client: GHClient{Bin: client}}, repo, branch)
		if err == nil {
			return res, nil
		}
		ghErr = err
	} else {
		ghErr = err
	}

	res, anonErr := lookup(ctx, newHTTPReader(), repo, branch)
	if anonErr == nil {
		return res, nil
	}
	if ghErr != nil {
		return LookupResult{}, fmt.Errorf("%w: gh: %w; anonymous: %w", errBothFailed, ghErr, anonErr)
	}
	return LookupResult{}, fmt.Errorf("%w: anonymous: %w", errBothFailed, anonErr)
}
