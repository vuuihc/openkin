package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// captureStdout runs f with os.Stdout redirected, and returns what it printed.
// `kin hub node-token` exists to print one line an operator has to copy, so the
// printed text is part of the behaviour, not incidental logging.
func captureStdout(t *testing.T, f func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, r)
		done <- buf.String()
	}()
	f()
	os.Stdout = old
	_ = w.Close()
	return <-done
}

func TestRunHubNodeTokenIssuesAUsableCredential(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(remote.StateDirEnv, dir)

	out := captureStdout(t, func() {
		if err := RunHubNodeToken("studio", "kin.example.com"); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(out, "--hub https://kin.example.com") {
		t.Fatalf("printed command has no hub url:\n%s", out)
	}
	token := tokenFromCommand(t, out)

	// The printed token is the only copy. It has to authenticate as the device
	// that was just created, and the device has to be registered: minting a
	// credential nobody can see in the device list would be a dead end.
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	credential, err := st.AuthenticateDevice(context.Background(), remote.HashToken(token), 1000)
	if err != nil {
		t.Fatalf("the printed token does not authenticate: %v", err)
	}
	if !strings.HasPrefix(credential.ID, "node-") {
		t.Fatalf("device id = %q, want a node- prefix", credential.ID)
	}
	device, err := st.GetDevice(context.Background(), credential.ID)
	if err != nil {
		t.Fatalf("minting a token did not register the device: %v", err)
	}
	if device.Label != "studio" {
		t.Fatalf("device label = %q", device.Label)
	}
	if device.Reachability != store.ReachabilityUnknown {
		t.Fatalf("a device that has never connected reads %q", device.Reachability)
	}
}

func TestRunHubNodeTokenWithoutADomain(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(remote.StateDirEnv, dir)

	out := captureStdout(t, func() {
		if err := RunHubNodeToken("", ""); err != nil {
			t.Fatal(err)
		}
	})
	// No domain means a placeholder and a LAN hint, not a broken command.
	if !strings.Contains(out, "--hub https://") || !strings.Contains(out, ":7777") {
		t.Fatalf("printed command has no usable hint:\n%s", out)
	}
	if !strings.Contains(out, "(node)") {
		t.Fatalf("an unlabelled device was not named:\n%s", out)
	}
}

func TestHubOrigin(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{in: "kin.example.com", want: "https://kin.example.com"},
		{in: "https://kin.example.com", want: "https://kin.example.com"},
		{in: "http://kin.example.com", want: "https://kin.example.com"},
		{in: "  kin.example.com  ", want: "https://kin.example.com"},
	}
	for _, tc := range cases {
		if got := hubOrigin(tc.in); got != tc.want {
			t.Errorf("hubOrigin(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	// Without a domain the fallback names this machine rather than pretending to
	// know the public URL.
	if got := hubOrigin(""); !strings.HasPrefix(got, "https://") {
		t.Errorf("hubOrigin(\"\") = %q", got)
	}
}

func TestResolveNodeToken(t *testing.T) {
	dir := t.TempDir()

	if _, err := resolveNodeToken(dir, "  "); err == nil {
		t.Fatal("resolved a token with no flag, no env and no file")
	}

	t.Setenv("KIN_NODE_TOKEN", "from-env")
	if got, err := resolveNodeToken(dir, ""); err != nil || got != "from-env" {
		t.Fatalf("env token = %q, %v", got, err)
	}
	if got, err := resolveNodeToken(dir, "from-flag"); err != nil || got != "from-flag" {
		t.Fatalf("flag token = %q, %v", got, err)
	}

	// The file is what makes a long-running node restartable without keeping the
	// token in a shell history or a unit file.
	t.Setenv("KIN_NODE_TOKEN", "")
	if err := os.WriteFile(NodeTokenFile(dir), []byte("from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := resolveNodeToken(dir, ""); err != nil || got != "from-file" {
		t.Fatalf("file token = %q, %v", got, err)
	}
	if err := os.WriteFile(NodeTokenFile(dir), []byte("\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveNodeToken(dir, ""); err == nil {
		t.Fatal("an empty token file was accepted")
	}
}

func TestBuildNodeHelloReportsThisMachine(t *testing.T) {
	// The registry is the node's own answer to "what can I run", so a machine
	// only offers what it would actually start a turn with.
	reg := agent.MustRegistry(agent.Entry{
		ID: "claude-code", Name: "Claude Code", Priority: 20,
		Caps:   []agent.Capability{agent.CapabilityRun},
		Runner: stubRunner{},
		Status: func(context.Context) agent.Status {
			return agent.Status{Installed: true, Available: true}
		},
	})
	hello := buildNodeHello("9.9.9", []string{"/code/a", "/code/b"}, reg)
	if hello.Label == "" {
		t.Fatal("a node with no label did not fall back to the hostname")
	}
	if hello.Version == 0 || hello.KinVersion != "9.9.9" {
		t.Fatalf("hello = %+v", hello)
	}
	if hello.Platform == "" || hello.Arch == "" {
		t.Fatalf("hello does not say what this machine is: %+v", hello)
	}
	if len(hello.WorkspaceRoots) != 2 || hello.WorkspaceRoots[0] != "/code/a" {
		t.Fatalf("roots = %v", hello.WorkspaceRoots)
	}
	if hello.MaxConcurrent <= 0 {
		t.Fatalf("max_concurrent = %d", hello.MaxConcurrent)
	}
	if len(hello.Agents) != 1 || hello.Agents[0].ID != "claude-code" || !hello.Agents[0].Available {
		t.Fatalf("agents = %+v", hello.Agents)
	}
	if err := hello.Validate(); err != nil {
		t.Fatalf("the hello this machine builds does not validate: %v", err)
	}
}

// TestNodeRootsComeFromThisMachinesProjects pins where the boundary is drawn: a
// machine works in the directories it already has projects for, plus whatever
// the operator adds, and nothing else.
func TestNodeRootsComeFromThisMachinesProjects(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(remote.StateDirEnv, dir)
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	ctx := context.Background()
	home := t.TempDir()
	if err := st.InsertProject(ctx, store.Project{ID: "p1", Name: "one", Mode: store.ProjectModeShip, OnePagerRel: "onepager.md", CreatedAt: 1}, []string{home}); err != nil {
		t.Fatal(err)
	}

	roots := nodeRoots(ctx, st, []string{home, "/extra"})
	if len(roots) != 2 {
		t.Fatalf("roots = %v, want the project root and the extra one, deduplicated", roots)
	}
	for _, root := range roots {
		if !filepath.IsAbs(root) {
			t.Fatalf("root %q is not absolute", root)
		}
	}
	// No store and no extras is no roots: an empty declaration must not read as
	// "anywhere".
	if got := nodeRoots(ctx, nil, nil); len(got) != 0 {
		t.Fatalf("roots with nothing declared = %v", got)
	}
}

func TestParseNodeServeFlags(t *testing.T) {
	for _, tc := range []struct {
		name  string
		args  []string
		roots []string
		yolo  bool
	}{
		{name: "no node flags", args: []string{"--port", "7777"}},
		{
			name:  "a repeated root",
			args:  []string{"--hub", "https://hub.example.com", "--root", "/a", "--root", "/b"},
			roots: []string{"/a", "/b"},
		},
		{
			name:  "comma separated roots",
			args:  []string{"--hub", "https://hub.example.com", "--root", "/a,/b"},
			roots: []string{"/a", "/b"},
		},
		{
			name:  "root paths are left as typed",
			args:  []string{"--hub", "https://hub.example.com", "--root", "/a b/c"},
			roots: []string{"/a b/c"},
		},
		{
			name: "the permission ceiling is opt-in",
			args: []string{"--hub", "https://hub.example.com", "--allow-yolo"},
			yolo: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			flags, err := ParseServeFlags(tc.args)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(flags.NodeRoots, "|") != strings.Join(tc.roots, "|") {
				t.Fatalf("roots = %v, want %v", flags.NodeRoots, tc.roots)
			}
			if flags.AllowYOLO != tc.yolo {
				t.Fatalf("allow-yolo = %v, want %v", flags.AllowYOLO, tc.yolo)
			}
		})
	}

	// A Hub does not work for another Hub, and two Hubs pointing at each other
	// is a configuration nobody means to write.
	if _, err := ParseServeFlags([]string{"--role", "hub", "--domain", "kin.example.com", "--hub", "https://other.example.com"}); err == nil {
		t.Fatal("--role hub with --hub was accepted")
	}
}

// stubRunner satisfies agent.Entry without running anything.
type stubRunner struct{}

func (stubRunner) Start(context.Context, adapter.TaskSpec) (adapter.RunHandle, error) {
	return nil, errors.New("stub runner")
}

// tokenFromCommand pulls the --token value out of the printed command line.
func tokenFromCommand(t *testing.T, out string) string {
	t.Helper()
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		for i, field := range fields {
			if field == "--token" && i+1 < len(fields) {
				return fields[i+1]
			}
		}
	}
	t.Fatalf("no --token in the printed command:\n%s", out)
	return ""
}
