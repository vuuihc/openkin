package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// The Node role. A machine that works for a Hub is still a daemon: it keeps its
// own store, its own agents and its own logins, and it also runs the turns that
// Hub dispatches here. That is why this is a flag on `kin serve` and not a
// separate command — a second process would mean two things spawning agents
// against one ~/.kin.
//
// What crosses the wire is what to run, never what to run it with: provider
// keys and agent logins stay on the machine that owns them (ADR 0022 D7).

// NodeTokenFile is where a Node looks for its device credential when the token
// is not passed on the command line.
func NodeTokenFile(stateDir string) string {
	return filepath.Join(stateDir, "node-token")
}

// resolveNodeToken finds the device credential: the flag, then the environment,
// then the state dir. The file is what makes a Node restartable without keeping
// a credential in a shell history or a unit file.
func resolveNodeToken(stateDir, flagToken string) (string, error) {
	if token := strings.TrimSpace(flagToken); token != "" {
		return token, nil
	}
	if token := strings.TrimSpace(os.Getenv("KIN_NODE_TOKEN")); token != "" {
		return token, nil
	}
	path := NodeTokenFile(stateDir)
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("no device token: pass --token, set KIN_NODE_TOKEN, or write %s "+
			"(run `kin hub node-token` on the Hub to get one)", path)
	}
	token := strings.TrimSpace(string(data))
	if token == "" {
		return "", fmt.Errorf("device token file %s is empty", path)
	}
	return token, nil
}

// buildNodeHello is what this machine tells the Hub about itself.
//
// The agents come from the registry, not from a probe: the Hub is choosing
// where to send work, and the honest answer is the same list this daemon would
// run a turn with.
func buildNodeHello(ctx context.Context, version string, roots []string, reg *agent.Registry) worker.Hello {
	label, _ := os.Hostname()
	return worker.Hello{
		Version:        worker.ProtocolVersion,
		WorkerID:       nodeIdentity(),
		Label:          label,
		Platform:       runtime.GOOS,
		Arch:           runtime.GOARCH,
		KinVersion:     version,
		Agents:         nodeAgents(reg),
		WorkspaceRoots: nodeWorkspaceRoots(ctx, roots),
		MaxConcurrent:  nodeMaxConcurrent(),
	}
}

// nodeWorkspaceRoots describes this machine's roots as workspaces rather than
// as paths.
//
// A path is an address here; what the Hub needs is the identity of the work, so
// it can tell whether another machine has the same repository and where. Only
// this machine can answer that, which is why the derivation happens here and
// the answer travels: the Hub never sees this filesystem.
func nodeWorkspaceRoots(ctx context.Context, roots []string) []worker.WorkspaceRoot {
	resolver := workspace.NewAnchorResolver()
	out := make([]worker.WorkspaceRoot, 0, len(roots))
	seen := make(map[string]bool, len(roots))
	add := func(root worker.WorkspaceRoot) {
		key := root.Path + "\x00" + root.RemoteURL + "\x00" + root.RelativePath
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, root)
	}
	for _, root := range roots {
		anchor, checkout, err := resolver.DeriveAnchor(ctx, root)
		if err != nil {
			// A root that is not there yet is still a place this machine intends
			// to work: report it as itself, and the dispatch check will refuse it
			// until it exists.
			add(worker.WorkspaceRoot{Path: absoluteNodePath(root)})
			continue
		}
		if !anchor.Portable() {
			add(worker.WorkspaceRoot{Path: absoluteNodePath(root)})
			continue
		}
		add(worker.WorkspaceRoot{
			Path:         checkout,
			RemoteURL:    anchor.RemoteURL,
			RelativePath: anchor.RelativePath,
		})
	}
	return out
}

func absoluteNodePath(path string) string {
	if abs, err := filepath.Abs(strings.TrimSpace(path)); err == nil {
		return abs
	}
	return filepath.Clean(strings.TrimSpace(path))
}

// nodeAgents reports every registered agent and whether it can run here.
//
// Unavailable agents are reported too, with the reason: a client choosing where
// to run something needs to know this machine was considered and why it said
// no, not just that the agent is missing.
//
// Model lists are left out until a Hub has to choose a model for a machine it
// cannot see; a dispatch names the model, and the device runs it or says why it
// cannot.
func nodeAgents(reg *agent.Registry) []worker.Agent {
	if reg == nil {
		return nil
	}
	infos := reg.List(context.Background(), "")
	out := make([]worker.Agent, 0, len(infos))
	for _, info := range infos {
		out = append(out, worker.Agent{
			ID:        info.ID,
			Installed: info.Installed,
			Available: info.Available,
			Reason:    info.Reason,
		})
	}
	return out
}

// nodeRoots is the set of directories this machine will run dispatched work in.
//
// It is the machine's own projects plus anything the operator adds by hand. The
// Hub cannot widen it: a dispatch naming a path outside these is refused here,
// by the machine that owns the filesystem.
func nodeRoots(ctx context.Context, st *store.Store, extra []string) []string {
	seen := make(map[string]bool)
	roots := make([]string, 0, len(extra)+4)
	add := func(path string) {
		trimmed := strings.TrimSpace(path)
		if trimmed == "" {
			return
		}
		abs, err := filepath.Abs(trimmed)
		if err != nil {
			abs = filepath.Clean(trimmed)
		}
		if seen[abs] {
			return
		}
		seen[abs] = true
		roots = append(roots, abs)
	}
	if st != nil {
		if projectRoots, err := st.ProjectRoots(ctx); err == nil {
			for _, root := range projectRoots {
				add(root)
			}
		}
	}
	for _, root := range extra {
		add(root)
	}
	return roots
}

// nodeIdentity is the id this Node presents. The Hub keys the device on the
// credential, not on this, so it only has to be stable and readable in logs.
func nodeIdentity() string {
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		return "kin-node"
	}
	return host
}

// agentRunners answers "can this machine run that agent" from the daemon's own
// registry, which is the same registry a local turn would use.
type agentRunners struct{ reg *agent.Registry }

func (a agentRunners) Runnable(ctx context.Context, agentID string) (adapter.Adapter, error) {
	if a.reg == nil {
		return nil, errors.New("this daemon has no agent registry")
	}
	registration, err := a.reg.GetRunnable(ctx, agentID)
	if err != nil {
		return nil, err
	}
	if registration.Runner == nil {
		return nil, fmt.Errorf("agent %s cannot run here", agentID)
	}
	return registration.Runner, nil
}

// nodeMaxConcurrent is how many turns this machine will run for its Hub at
// once. It is deliberately not the daemon's own limit: work arriving from
// elsewhere must not crowd out what this machine is doing for itself.
func nodeMaxConcurrent() int {
	return 4
}

// runNode keeps this daemon connected to its Hub as a Node.
//
// It returns when ctx ends. Losing the Hub is not fatal: the daemon keeps
// serving this machine's own console while it retries.
func runNode(ctx context.Context, version string, flags ServeFlags, st *store.Store, reg *agent.Registry, executor *node.Executor) error {
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	token, err := resolveNodeToken(stateDir, flags.NodeToken)
	if err != nil {
		return err
	}

	roots := nodeRoots(ctx, st, flags.NodeRoots)
	executor.Roots = roots
	hello := buildNodeHello(ctx, version, roots, reg)
	if err := hello.Validate(); err != nil {
		return fmt.Errorf("cannot describe this machine to the hub: %w", err)
	}

	warn := func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "kin: node: "+format+"\n", args...)
	}
	fmt.Fprintf(os.Stderr, "kin: node %s → %s (%d agents, %d roots)\n",
		hello.Label, flags.HubURL, len(hello.Agents), len(roots))
	if len(roots) == 0 {
		fmt.Fprintln(os.Stderr, "kin: node: no project roots on this machine, so dispatched work will be refused; "+
			"add a project in the console or pass --root")
	}
	for _, root := range executor.UnresolvedRoots() {
		warn("root %s is not a directory this machine can reach; work in it will be refused", root)
	}

	return node.Run(ctx, node.ClientConfig{
		HubURL:  flags.HubURL,
		Token:   token,
		Hello:   hello,
		OnFrame: executor.Handle,
		OnReady: executor.SetSender,
		Warn:    warn,
	})
}
