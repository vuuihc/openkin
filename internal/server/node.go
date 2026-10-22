package server

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"github.com/vuuihc/openkin/internal/adapter/detect"
	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// NodeFlags are CLI options for `kin node`.
type NodeFlags struct {
	// HubURL is the Hub to connect to, e.g. https://kin.example.com.
	HubURL string
	// Token is the device credential. Empty means read it from the state dir.
	Token string
	// Label names this machine in the Hub's device list.
	Label string
	// Roots are the directories this machine is willing to work in. They are
	// reported to the Hub so a client can pick a machine that has the checkout;
	// no file is ever read for this.
	Roots []string
}

// NodeTokenFile is where `kin node` looks for its device credential when the
// token is not passed on the command line.
func NodeTokenFile(stateDir string) string {
	return filepath.Join(stateDir, "node-token")
}

// RunNode connects this machine to a Hub and keeps it connected.
//
// A Node is deliberately not a daemon: it serves no HTTP, owns no database, and
// makes no decisions about tasks. It reports what it can run, waits to be given
// work, and runs it with the agents installed here — which is also why nothing
// about this machine's credentials (provider keys, agent logins) is ever part
// of what it reports.
func RunNode(version string, flags NodeFlags) error {
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	hubURL := strings.TrimSpace(flags.HubURL)
	if hubURL == "" {
		return fmt.Errorf("--hub is required (the Hub to connect to, e.g. https://kin.example.com)")
	}
	token, err := resolveNodeToken(stateDir, flags.Token)
	if err != nil {
		return err
	}

	hello := buildNodeHello(version, flags)
	if err := hello.Validate(); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	fmt.Fprintf(os.Stderr, "kin: node %s → %s (%d agents, %s/%s)\n",
		hello.Label, hubURL, len(hello.Agents), hello.Platform, hello.Arch)
	return node.Run(ctx, node.ClientConfig{
		HubURL: hubURL,
		Token:  token,
		Hello:  hello,
		Warn: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "kin: warning: "+format+"\n", args...)
		},
	})
}

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

// buildNodeHello is what this machine tells the Hub about itself. Agent
// discovery runs here, on the machine that has the agents, because that is the
// only place the answer exists.
func buildNodeHello(version string, flags NodeFlags) worker.Hello {
	label := strings.TrimSpace(flags.Label)
	if label == "" {
		label, _ = os.Hostname()
	}
	roots := make([]string, 0, len(flags.Roots))
	for _, root := range flags.Roots {
		if trimmed := strings.TrimSpace(root); trimmed != "" {
			roots = append(roots, trimmed)
		}
	}
	return worker.Hello{
		Version:        worker.ProtocolVersion,
		WorkerID:       nodeIdentity(),
		Label:          label,
		Platform:       runtime.GOOS,
		Arch:           runtime.GOARCH,
		KinVersion:     version,
		Agents:         detectNodeAgents(),
		WorkspaceRoots: roots,
		MaxConcurrent:  nodeMaxConcurrent(),
	}
}

// detectNodeAgents reports every catalogued agent and whether it can run here.
// Unavailable agents are reported too, with the reason: a client choosing where
// to run something needs to know that this machine was considered and why it
// said no, not just that it is missing.
func detectNodeAgents() []worker.Agent {
	infos := detect.Scan("")
	agents := make([]worker.Agent, 0, len(infos))
	for _, info := range infos {
		agents = append(agents, worker.Agent{
			ID:        info.ID,
			Installed: info.Installed,
			Available: info.Available,
			Version:   "",
			Reason:    info.Reason,
			IsDefault: info.Default,
		})
	}
	return agents
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

func nodeMaxConcurrent() int {
	return 4
}
