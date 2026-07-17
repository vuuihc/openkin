package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/adapter"
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
