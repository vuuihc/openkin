package server

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	hello := buildNodeHello("9.9.9", NodeFlags{Label: "  ", Roots: []string{" /code/a ", "", "/code/b"}})
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
	// Agent discovery runs here, and every catalogued agent is reported whether
	// or not it can run: a Hub choosing a machine needs the reasons too.
	if len(hello.Agents) == 0 {
		t.Fatal("hello reports no agents at all")
	}
	for _, agent := range hello.Agents {
		if agent.ID == "" {
			t.Fatalf("agent with no id: %+v", agent)
		}
		if !agent.Available && agent.Reason == "" {
			t.Fatalf("agent %s is unavailable with no reason", agent.ID)
		}
	}
	if err := hello.Validate(); err != nil {
		t.Fatalf("the hello this machine builds does not validate: %v", err)
	}
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
