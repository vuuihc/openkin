package github

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"strings"

	"github.com/vuuihc/openkin/internal/workspace"
)

// host is the only forge this package talks to. GitHub Enterprise would arrive
// as a different host in the same canonical remote, and is deliberately not
// accepted rather than half-supported: the credential rules differ.
const host = "github.com"

// Repo identifies a repository on github.com.
type Repo struct {
	Owner string
	Name  string
}

func (r Repo) String() string { return r.Owner + "/" + r.Name }

// Canonical is the key form: lowercase host/owner/name, no scheme, no userinfo,
// no .git — the shape workspace.CanonicalRemote produces.
//
// The folding is done here rather than assumed of the remote, because
// CanonicalRemote lowercases the host and nothing else: a remote written
// `git@github.com:Owner/Repo.git` canonicalizes to `github.com/Owner/Repo`.
// GitHub treats owner and name case-insensitively, so without folding here one
// repository reached through two spellings would occupy two rows, get two
// branches' worth of polling, and never share an answer.
func (r Repo) Canonical() string {
	return host + "/" + strings.ToLower(r.Owner) + "/" + strings.ToLower(r.Name)
}

// WebURL is the page a person would open.
func (r Repo) WebURL() string { return "https://" + host + "/" + r.String() }

// ParseCanonical reads the canonical remote form produced by
// workspace.CanonicalRemote — host/owner/name, lowercase, no scheme, no
// userinfo, no .git. Anything that is not a two-segment github.com path is
// rejected rather than guessed at.
func ParseCanonical(canonical string) (Repo, bool) {
	hostPart, rest, ok := strings.Cut(strings.TrimSpace(canonical), "/")
	if !ok || !strings.EqualFold(hostPart, host) {
		return Repo{}, false
	}
	owner, name, ok := strings.Cut(rest, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return Repo{}, false
	}
	return Repo{Owner: owner, Name: name}, true
}

// RepoForDir derives the GitHub repository a directory belongs to.
//
// It reuses the anchor resolver rather than running git again: the remote is
// already canonicalized there, including the removal of any embedded userinfo,
// so a token in a remote URL cannot travel any further through this path
// (ADR 0022 D7).
//
// A directory that is not a checkout, or whose origin is not on github.com, is
// not an error — it is simply not a GitHub project, and ok is false. Neither is
// a directory that no longer exists: a workspace whose source checkout has been
// moved or deleted has no repository to read, which is the same answer as having
// one that is not on GitHub. Reporting that as a failure would turn a deleted
// folder into a broken panel.
func RepoForDir(ctx context.Context, resolver workspace.AnchorResolver, dir string) (Repo, bool, error) {
	if strings.TrimSpace(dir) == "" {
		return Repo{}, false, nil
	}
	anchor, _, err := resolver.DeriveAnchor(ctx, dir)
	if errors.Is(err, fs.ErrNotExist) {
		return Repo{}, false, nil
	}
	if err != nil {
		return Repo{}, false, fmt.Errorf("derive anchor for %s: %w", dir, err)
	}
	if !anchor.Portable() {
		return Repo{}, false, nil
	}
	repo, ok := ParseCanonical(anchor.RemoteURL)
	return repo, ok, nil
}
