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
func buildNodeHello(ctx context.Context, version string, roots []string, reg *agent.Registry, allowYOLO bool, defaultAgent string) worker.Hello {
	label, _ := os.Hostname()
	return worker.Hello{
		Version:        worker.ProtocolVersion,
		WorkerID:       nodeIdentity(),
		Label:          label,
		Platform:       runtime.GOOS,
		Arch:           runtime.GOARCH,
		KinVersion:     version,
		Agents:         nodeAgents(reg, allowYOLO, defaultAgent),
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

// nodeAgents reports every registered agent, whether it can run here, and what
// a console needs in order to offer it without guessing.
//
// Unavailable agents are reported too, with the reason: a client choosing where
// to run something needs to know this machine was considered and why it said
// no, not just that the agent is missing.
//
// The permission modes are the ones this node will actually accept for a
// dispatched turn. A mode whose adapter bypasses approvals is absent unless the
// node runs with --allow-yolo, because the executor refuses those turns — and an
// agent that bypasses approvals in *every* mode is unavailable here for the same
// reason. Sending the modes rather than the flag is what lets the console offer
// a choice that will not be refused.
//
// The default is the machine's own configured default (`agent.default`), not
// just the first available entry in registry order. The console and the phone
// have to agree on what "no @mention" means, and the Hub only knows what this
// frame says — reading the preference anywhere else would leave the two views
// disagreeing about the same machine.
func nodeAgents(reg *agent.Registry, allowYOLO bool, defaultAgent string) []worker.Agent {
	if reg == nil {
		return nil
	}
	infos := reg.List(context.Background(), defaultAgent)
	out := make([]worker.Agent, 0, len(infos))
	defaulted := false
	for _, info := range infos {
		modes := nodePermissionModes(reg, info.ID, allowYOLO)
		available, reason := info.Available, info.Reason
		if available && len(modes) == 0 {
			available = false
			reason = "this machine does not run dispatched turns with approvals bypassed; " +
				"start it with --allow-yolo to permit that"
		}
		models := make([]string, 0, len(info.Models))
		for _, model := range info.Models {
			if strings.TrimSpace(model.ID) != "" {
				models = append(models, model.ID)
			}
		}
		// The Hub's hello validator rejects an agent carrying more models than
		// this, and a refused hello means the machine never appears at all —
		// silently, because the node only logs the refusal and retries. A large
		// gateway catalog is exactly the case this build is for, so the cap
		// belongs here rather than in the Hub. Clamping is version-safe;
		// raising the protocol bound would only move the refusal to an older
		// Hub. The catalog is in the CLI's own order, so the head is what a
		// person sees first.
		if len(models) > worker.MaxModels {
			models = models[:worker.MaxModels]
		}
		entry := worker.Agent{
			ID:              info.ID,
			Name:            info.Name,
			Kind:            string(info.Kind),
			Family:          agent.Family(info.ID),
			Transport:       agent.Transport(info.ID, info.Kind),
			Installed:       info.Installed,
			Available:       available,
			Reason:          reason,
			Models:          models,
			PermissionModes: modes,
		}
		// One default per machine. `List` resolves the configured preference
		// through the registry, so an unavailable preference has already fallen
		// back to priority order; the mode filter above can still remove an
		// agent this machine will not run unattended, and the fallback below
		// then picks the first one it will.
		if info.Default && available {
			entry.IsDefault = true
			defaulted = true
		}
		out = append(out, entry)
	}
	if !defaulted {
		for i := range out {
			if !out[i].Available {
				continue
			}
			// Registry.Default also requires a runner; an entry that only
			// reports availability would be announced as a default the
			// dispatcher then refuses.
			if registration, ok := reg.Get(out[i].ID); !ok || registration.Runner == nil {
				continue
			}
			out[i].IsDefault = true
			break
		}
	}
	return out
}

// agentPermissionModes is the ladder an agent actually has.
//
// The console used to offer all three modes for every agent, which made two
// different lies possible: an agent with one on/off flag was shown a graded
// "auto-edit" choice that does exactly what yolo does, and an agent that never
// asks was shown a choice at all. The question is asked of the adapter —
// `AutoApprovesAll` is the one place that knows what a mode *does* rather than
// what it is called:
//
//   - never asks, whatever the mode: one entry, and no choice to make;
//   - accept-edits already bypasses approval: no graded rung between asking and
//     not asking, so the ladder is ask / bypass;
//   - otherwise: ask / auto-edit / bypass.
//
// The node then removes the modes it would refuse to run (see
// nodePermissionModes), and the Hub offers that filtered list per machine.
func agentPermissionModes(reg *agent.Registry, id string) []string {
	registration, ok := reg.Get(id)
	if !ok {
		return nil
	}
	if adapter.AutoApprovesAll(registration.Runner, adapter.PermissionDefault) {
		// No approval channel at all: every mode is the same run.
		return []string{adapter.PermissionDefault}
	}
	out := []string{adapter.PermissionDefault}
	if !adapter.AutoApprovesAll(registration.Runner, adapter.PermissionAcceptEdits) {
		out = append(out, adapter.PermissionAcceptEdits)
	}
	return append(out, adapter.PermissionYOLO)
}

// nodePermissionModes mirrors the executor's refusal rule exactly: a mode is
// offered only when it does not bypass approvals, or when this machine was
// explicitly allowed to bypass them.
func nodePermissionModes(reg *agent.Registry, id string, allowYOLO bool) []string {
	registration, ok := reg.Get(id)
	if !ok {
		return nil
	}
	modes := agentPermissionModes(reg, id)
	out := make([]string, 0, len(modes))
	for _, mode := range modes {
		if adapter.AutoApprovesAll(registration.Runner, mode) && !allowYOLO {
			continue
		}
		out = append(out, mode)
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

// resolveCheckoutRoot reads where this machine keeps the repositories it fetches
// for a console that cannot reach them itself.
//
// The default sits under the state directory because that is the one directory
// this daemon is already entitled to write in. It is a directory of clones and
// nothing else — every path under it is derived from a repository's canonical
// name — so it is somewhere the boundary can be widened to without widening it
// to anything a person keeps by hand.
//
// Turning it off is not a narrower version of the same thing: a machine that
// fetches nothing is a machine whose console can only pick from what is already
// on it, which for a phone is the difference between starting a session and
// browsing one.
func resolveCheckoutRoot(stateDir, declared string) (string, error) {
	declared = strings.TrimSpace(declared)
	if strings.EqualFold(declared, "off") {
		return "", nil
	}
	if declared == "" {
		return filepath.Join(stateDir, "checkouts"), nil
	}
	abs, err := filepath.Abs(declared)
	if err != nil {
		return "", fmt.Errorf("--checkout-root %s: %w", declared, err)
	}
	return abs, nil
}

// ensureCheckoutRoot makes the checkout directory exist before this machine
// announces it.
//
// What the hello advertises is what a console offers: those roots are the list a
// phone picks from, and the first of them is the example the working-directory
// field shows. A root announced before it is there is therefore not a harmless
// placeholder — it is a suggestion that answers "there is no such directory on
// this machine" the moment someone takes it, which on a freshly paired machine
// is the phone's first action. Fetching creates this directory anyway (see
// workspace.Checkouts.ready); this only moves that act to the moment the machine
// starts claiming it works there.
//
// The other roots cannot be treated this way. A project or a --root can name a
// volume that is not mounted yet, and creating a directory there would invent a
// project rather than report one; those keep the unresolved-root warning.
//
// An empty root is a machine that fetches nothing, and nothing here is fatal: a
// checkout root this machine cannot reach is a reason to refuse fetches, not a
// reason to refuse to serve.
func ensureCheckoutRoot(root string) error {
	if strings.TrimSpace(root) == "" {
		return nil
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return fmt.Errorf("cannot use %s as the checkout directory: %w", root, err)
	}
	return nil
}

// workRoots answers where this machine works: the checkout root, the projects it
// holds, and anything the operator added by hand.
//
// Resolving the checkout root and making it real are one step because they are
// one claim. The list returned here is what the hello advertises and what a
// console offers, so a directory in it that this machine cannot answer about is
// a promise made at startup, and the caller has no way to tell that the two
// halves have to happen in this order.
//
// One failure is deliberately not one of those: a checkout root that cannot be
// created is warned about and announced anyway. The usual reason it cannot be
// created is a volume that is not mounted yet, and a path that will exist is a
// path work may go to — so the machine still offers it and the refusal belongs
// to whoever tries to use it before the volume is there, which is the executor
// (UnresolvedRoots reports the same directory for exactly that). What this
// function will not do is announce a root that merely has not been made yet on a
// machine that *could* make it: that is the ordinary case, and it is the phone's
// first suggestion.
func workRoots(ctx context.Context, st *store.Store, stateDir string, flags ServeFlags) (string, []string, error) {
	checkoutRoot, err := resolveCheckoutRoot(stateDir, flags.CheckoutRoot)
	if err != nil {
		return "", nil, err
	}
	if err := ensureCheckoutRoot(checkoutRoot); err != nil {
		// Not fatal: the machine still serves. UnresolvedRoots reports the same
		// directory again for the role that has to refuse work in it.
		warnToStderr("%v", err)
	}
	return checkoutRoot, nodeRoots(ctx, st, append([]string{checkoutRoot}, flags.NodeRoots...)), nil
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
func runNode(ctx context.Context, version string, flags ServeFlags, st *store.Store, reg *agent.Registry, executor *node.Executor, approvals *node.ApprovalRelay, responder *node.Responder, refresh <-chan struct{}) error {
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	token, err := resolveNodeToken(stateDir, flags.NodeToken)
	if err != nil {
		return err
	}

	warn := func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "kin: node: "+format+"\n", args...)
	}

	// The directories come from the executor rather than from a second reading
	// of the configuration: what this machine tells its Hub it works in is what
	// it will accept work in, and what it answers questions about. Three
	// readings of the same setting is three chances for them to differ.
	roots := executor.Roots
	// The hello is rebuilt for every dial, and a settings change can ask for
	// one, so a default chosen in the console reaches the Hub without a restart.
	// It reads the same key the local console reads, which is what keeps the
	// two views of "default" identical rather than merely similar.
	hello := func() worker.Hello {
		defaultAgent := ""
		if v, err := st.GetSetting(ctx, "agent.default"); err != nil {
			// A missing key means "no preference", which is a normal state.
			// Anything else is a store problem worth saying out loud.
			if !errors.Is(err, store.ErrNotFound) && ctx.Err() == nil {
				warn("read agent.default: %v", err)
			}
		} else {
			defaultAgent = strings.TrimSpace(v)
		}
		return buildNodeHello(ctx, version, roots, reg, flags.AllowYOLO, defaultAgent)
	}
	first := hello()
	if err := first.Validate(); err != nil {
		return fmt.Errorf("cannot describe this machine to the hub: %w", err)
	}

	// Attachments are fetched, not pushed: this machine dialled out, so it is
	// the one that can reach the Hub's upload route. The credential is the same
	// device token this connection authenticates with, and the files land in
	// this machine's own state directory — the one place the daemon is already
	// entitled to write.
	attachments, err := node.NewAttachmentFetcher(flags.HubURL, token, filepath.Join(stateDir, "attachments"))
	if err != nil {
		return fmt.Errorf("cannot fetch attachments from the hub: %w", err)
	}
	attachments.Warn = warn
	executor.Attachments = attachments

	fmt.Fprintf(os.Stderr, "kin: node %s → %s (%d agents, %d roots)\n",
		first.Label, flags.HubURL, len(first.Agents), len(roots))
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
		Refresh: refresh,
		// Three kinds of frame come down this channel and they belong to
		// different halves of this machine: a question the Hub is answering for
		// an agent here, a question about this machine itself, and everything
		// else, which is work.
		OnFrame: func(frameCtx context.Context, frame worker.Frame) error {
			switch frame.Kind {
			case "approval.status", "approval.decision":
				return approvals.Handle(frameCtx, frame)
			case "query":
				return responder.Handle(frameCtx, frame)
			default:
				// A turn outlives the connection that dispatched it: the daemon's
				// lifetime, not the socket's, is what stops the agent. A dropped
				// control channel is a network event, and the turn holds its
				// frames until the reconnect (see node.Executor.send).
				return executor.Handle(ctx, frame)
			}
		},
		// The write path, and the moment it is taken away. All three halves need
		// it: the executor to report a turn, the relay to ask a question, and the
		// responder to answer one. Clearing it is what tells a blocked agent its
		// question died with the connection rather than waiting on a socket that
		// is gone.
		OnReady: func(send node.WriteFunc) {
			executor.SetSender(send)
			approvals.SetSender(send)
			responder.SetSender(send)
		},
		Warn: warn,
	})
}
