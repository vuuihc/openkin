package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/adapter"
)

func TestPermissionModeFlags(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script fake agent")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "args.log")
	bin := filepath.Join(dir, "fake-claude")
	// Log argv then emit a minimal successful stream-json result.
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" > " + logPath + "\n" +
		"cat <<'EOF'\n" +
		`{"type":"system","subtype":"init","session_id":"s1"}` + "\n" +
		`{"type":"result","subtype":"success","is_error":false,"session_id":"s1","total_cost_usd":0.0,"usage":{"input_tokens":1,"output_tokens":1}}` + "\n" +
		"EOF\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		mode string
		want []string
		deny []string
	}{
		{
			mode: adapter.PermissionYOLO,
			want: []string{"--dangerously-skip-permissions", "--permission-mode", "bypassPermissions"},
			deny: []string{"--mcp-config", "mcp__kin__approve"},
		},
		{
			mode: adapter.PermissionAcceptEdits,
			// No daemon → acceptEdits only (no MCP in this unit test).
			want: []string{"--permission-mode", "acceptEdits"},
			deny: []string{"--dangerously-skip-permissions"},
		},
		{
			mode: adapter.PermissionDefault,
			deny: []string{"--dangerously-skip-permissions", "bypassPermissions", "acceptEdits"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.mode, func(t *testing.T) {
			_ = os.Remove(logPath)
			ad := &Adapter{Binary: bin}
			h, err := ad.Start(context.Background(), adapter.TaskSpec{
				ID: "t1", Agent: "claude-code", Cwd: dir, Prompt: "hi",
				PermissionMode: tc.mode,
			})
			if err != nil {
				t.Fatal(err)
			}
			for range h.Events() {
			}
			data, err := os.ReadFile(logPath)
			if err != nil {
				t.Fatal(err)
			}
			args := string(data)
			for _, w := range tc.want {
				if !strings.Contains(args, w) {
					t.Fatalf("mode=%s args missing %q\n%s", tc.mode, w, args)
				}
			}
			for _, d := range tc.deny {
				if strings.Contains(args, d) {
					t.Fatalf("mode=%s args should not contain %q\n%s", tc.mode, d, args)
				}
			}
		})
	}
}

// A yolo turn promises no approval cards, but its read-only plan/review worker
// still ran with --permission-prompt-tool: plan mode's ExitPlanMode arrived as
// a tool_use card every round. The read-only boundary must stay identical —
// only the bridge that turns ExitPlanMode into a card goes away. Every other
// mode keeps it so a person can still approve the plan.
func TestReadOnlyApprovalBridgeSkipsYolo(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script fake agent")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "args.log")
	bin := filepath.Join(dir, "fake-claude")
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" > " + logPath + "\n" +
		"cat <<'EOF'\n" +
		`{"type":"system","subtype":"init","session_id":"s1"}` + "\n" +
		`{"type":"result","subtype":"success","is_error":false,"session_id":"s1","total_cost_usd":0.0,"usage":{"input_tokens":1,"output_tokens":1}}` + "\n" +
		"EOF\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		mode       string
		wantBridge bool
	}{
		{mode: adapter.PermissionYOLO, wantBridge: false},
		{mode: adapter.PermissionDefault, wantBridge: true},
		{mode: adapter.PermissionAcceptEdits, wantBridge: true},
	}

	for _, tc := range cases {
		t.Run(tc.mode, func(t *testing.T) {
			_ = os.Remove(logPath)
			ad := &Adapter{
				Binary:    bin,
				KinBinary: "/tmp/kin",
				DaemonURL: "http://127.0.0.1:1",
				Token:     "token",
			}
			h, err := ad.Start(context.Background(), adapter.TaskSpec{
				ID: "t1", Agent: "claude-code", Cwd: dir, Prompt: "hi",
				PermissionMode: tc.mode,
				RunMeta: adapter.RunMetadata{
					WorkspaceAccess: adapter.AccessSourceReadOnly,
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			for range h.Events() {
			}
			data, err := os.ReadFile(logPath)
			if err != nil {
				t.Fatal(err)
			}
			args := string(data)

			// The read-only boundary is the same in every mode.
			for _, want := range []string{
				"--permission-mode plan",
				"Read,Glob,Grep,mcp__kin__request_workspace,mcp__kin__ask_user_question",
				"Bash,Edit,Write,NotebookEdit,Agent",
				"--mcp-config",
			} {
				if !strings.Contains(args, want) {
					t.Fatalf("mode=%s read-only args missing %q\n%s", tc.mode, want, args)
				}
			}
			for _, deny := range []string{"--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions"} {
				if strings.Contains(args, deny) {
					t.Fatalf("mode=%s read-only args must not contain %q\n%s", tc.mode, deny, args)
				}
			}

			hasBridge := strings.Contains(args, "--permission-prompt-tool")
			if hasBridge != tc.wantBridge {
				t.Fatalf("mode=%s bridge=%v want %v\n%s", tc.mode, hasBridge, tc.wantBridge, args)
			}
			if hasBridge && !strings.Contains(args, "mcp__kin__approve") {
				t.Fatalf("mode=%s bridge present without approve tool\n%s", tc.mode, args)
			}
		})
	}
}
