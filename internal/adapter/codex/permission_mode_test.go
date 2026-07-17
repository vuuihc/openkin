package codex

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
	bin := filepath.Join(dir, "fake-codex")
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" > " + logPath + "\n" +
		"cat <<'EOF'\n" +
		`{"type":"thread.started","thread_id":"th1"}` + "\n" +
		`{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}` + "\n" +
		"EOF\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		mode string
		want string
	}{
		{adapter.PermissionYOLO, "--dangerously-bypass-approvals-and-sandbox"},
		{adapter.PermissionAcceptEdits, "--sandbox"},
		{adapter.PermissionDefault, ""},
	}
	for _, tc := range cases {
		t.Run(tc.mode, func(t *testing.T) {
			_ = os.Remove(logPath)
			ad := &Adapter{Binary: bin}
			h, err := ad.Start(context.Background(), adapter.TaskSpec{
				ID: "t1", Agent: "codex", Cwd: dir, Prompt: "hi",
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
			if tc.want != "" && !strings.Contains(args, tc.want) {
				t.Fatalf("mode=%s missing %q in %s", tc.mode, tc.want, args)
			}
			if tc.mode == adapter.PermissionDefault {
				if strings.Contains(args, "--dangerously-bypass") || strings.Contains(args, "--sandbox") {
					t.Fatalf("default should not pass bypass/sandbox flags: %s", args)
				}
			}
			if tc.mode == adapter.PermissionAcceptEdits && !strings.Contains(args, "workspace-write") {
				t.Fatalf("accept_edits should pass workspace-write: %s", args)
			}
		})
	}
}
