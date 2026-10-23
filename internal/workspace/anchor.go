package workspace

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
)

// Anchors are the portable half of a working directory.
//
// A path is an address on one machine, and two machines usually hold a checkout
// of the same repository at the same path — which is why a path that looks
// right can be the wrong copy. An anchor says which repository a workspace
// belongs to and where inside it, so a machine that has never seen the original
// path can still say where the same workspace is *there*.
const (
	// AnchorGitRemote is a checkout of a repository. It resolves on any machine
	// with a checkout of the same origin remote.
	AnchorGitRemote = "git_remote"
	// AnchorDevicePath is a directory that is only itself: it resolves on the
	// machine that declared it and nowhere else.
	AnchorDevicePath = "device_path"
	// AnchorRepoRoot is the relative path of a checkout itself.
	AnchorRepoRoot = "."
)

// Anchor is one workspace identity. The kind values mirror the CHECK constraint
// on workspace_anchors; the store owns the persisted vocabulary, this package
// owns the derivation, and the engine maps between them.
type Anchor struct {
	Kind         string
	RemoteURL    string
	RelativePath string
}

// Portable reports whether an anchor can resolve on another machine.
func (a Anchor) Portable() bool {
	return a.Kind == AnchorGitRemote && a.RemoteURL != ""
}

// DeriveAnchor describes a directory on this machine.
//
// It returns the checkout root the directory belongs to, which is what a device
// reports upward: the machine that can see the filesystem is the only party
// that can say where a checkout starts. A directory that is not inside a
// repository with an origin remote is not an error — it is a device_path
// anchor, the honest answer for a workspace that exists on one machine only.
func (r AnchorResolver) DeriveAnchor(ctx context.Context, dir string) (Anchor, string, error) {
	abs, err := resolveAbsDir(dir)
	if err != nil {
		return Anchor{}, "", err
	}
	toplevel, err := r.toplevel(ctx, abs)
	if err != nil {
		return Anchor{Kind: AnchorDevicePath}, "", nil
	}
	remote, err := r.originRemote(ctx, abs)
	if err != nil {
		return Anchor{Kind: AnchorDevicePath}, toplevel, nil
	}
	relative, err := filepath.Rel(toplevel, abs)
	if err != nil {
		return Anchor{Kind: AnchorDevicePath}, toplevel, nil
	}
	return Anchor{
		Kind:         AnchorGitRemote,
		RemoteURL:    remote,
		RelativePath: filepath.ToSlash(relative),
	}, toplevel, nil
}

// AnchorResolver reads repository identity with the machine's own git.
type AnchorResolver struct {
	git gitRunner
}

// NewAnchorResolver resolves git once, the same way NewManager does.
func NewAnchorResolver() AnchorResolver {
	return AnchorResolver{git: execGit{Path: resolveGit()}}
}

func (r AnchorResolver) toplevel(ctx context.Context, dir string) (string, error) {
	out, err := r.git.Run(ctx, dir, nil, ControlStdoutLimit, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	toplevel := strings.TrimSpace(string(out))
	if toplevel == "" {
		return "", errors.New("git reported no repository root")
	}
	return toplevel, nil
}

func (r AnchorResolver) originRemote(ctx context.Context, dir string) (string, error) {
	out, err := r.git.Run(ctx, dir, nil, ControlStdoutLimit, "remote", "get-url", "origin")
	if err != nil {
		return "", err
	}
	return CanonicalRemote(string(out))
}

// CanonicalRemote reduces a git remote to the identity two machines can agree
// on, or reports that it cannot.
//
// The same repository is written many ways — `git@github.com:me/repo.git`,
// `https://github.com/me/repo`, `ssh://git@github.com:22/me/repo` — and all of
// them have to collapse to one string, or two machines holding the same
// checkout would never resolve each other's anchors. Two things are dropped on
// the way: the transport (scheme, user, default port) and any userinfo, because
// a remote URL is copied between machines through the Hub's database and a
// token embedded in one must not travel with it (ADR 0022 D7).
func CanonicalRemote(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("remote url is empty")
	}
	host, repoPath, err := splitRemote(raw)
	if err != nil {
		return "", err
	}
	repoPath = strings.Trim(strings.TrimSuffix(repoPath, "/"), "/")
	repoPath = strings.TrimSuffix(repoPath, ".git")
	repoPath = strings.Trim(repoPath, "/")
	if host == "" || repoPath == "" {
		return "", fmt.Errorf("remote url %q has no host or path", raw)
	}
	return strings.ToLower(host) + "/" + repoPath, nil
}

// splitRemote separates the host from the repository path.
//
// A remote with no scheme is scp-like (`git@host:owner/repo`); everything else
// goes through URL parsing, which is what knows about credentials and ports.
func splitRemote(raw string) (string, string, error) {
	if !strings.Contains(raw, "://") {
		host, repoPath, ok := strings.Cut(raw, ":")
		if !ok {
			return "", "", fmt.Errorf("remote url %q is not a git remote", raw)
		}
		host = stripUserInfo(host)
		if err := checkRemoteHost(host, raw); err != nil {
			return "", "", err
		}
		return host, repoPath, nil
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", "", fmt.Errorf("remote url %q: %w", raw, err)
	}
	host := parsed.Hostname()
	if err := checkRemoteHost(host, raw); err != nil {
		return "", "", err
	}
	if port := parsed.Port(); port != "" && port != defaultRemotePort(parsed.Scheme) {
		host = host + ":" + port
	}
	// Uniformize the local case does not arise: a local path is not a remote.
	return host, parsed.Path, nil
}

func stripUserInfo(authority string) string {
	if _, rest, ok := strings.Cut(authority, "@"); ok {
		return rest
	}
	return authority
}

// checkRemoteHost rejects what cannot be a remote host.
//
// A single-letter host is a Windows drive letter that reached here as
// `C:/some/path`, which is a directory, not a repository identity.
func checkRemoteHost(host, raw string) error {
	host = strings.TrimSpace(host)
	if host == "" {
		return fmt.Errorf("remote url %q has no host", raw)
	}
	if len(host) == 1 {
		return fmt.Errorf("remote url %q is not a git remote", raw)
	}
	if strings.ContainsAny(host, " \t\n\\") {
		return fmt.Errorf("remote url %q has an unusable host", raw)
	}
	return nil
}

// defaultRemotePort is the port a scheme means when it says nothing, so that
// ssh://host:22/o/r and git@host:o/r are one identity.
func defaultRemotePort(scheme string) string {
	switch strings.ToLower(scheme) {
	case "ssh":
		return "22"
	case "git":
		return "9418"
	case "http":
		return "80"
	case "https":
		return "443"
	default:
		return ""
	}
}
