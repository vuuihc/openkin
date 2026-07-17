package grok

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
	bin := filepath.Join(dir, "fake-grok")
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" > " + logPath + "\n" +
		"cat <<'EOF'\n" +
		`{"type":"text","data":"ok"}` + "\n" +
		`{"type":"end","stopReason":"stop","sessionId":"g1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}` + "\n" +
		"EOF\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	for _, mode := range []string{adapter.PermissionYOLO, adapter.PermissionAcceptEdits, adapter.PermissionDefault} {
		t.Run(mode, func(t *testing.T) {
			_ = os.Remove(logPath)
			ad := &Adapter{Binary: bin}
			h, err := ad.Start(context.Background(), adapter.TaskSpec{
				ID: "t1", Agent: "grok", Cwd: dir, Prompt: "hi",
				PermissionMode: mode,
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
			has := strings.Contains(args, "--always-approve")
			if mode == adapter.PermissionDefault && has {
				t.Fatalf("default must not pass --always-approve: %s", args)
			}
			if mode != adapter.PermissionDefault && !has {
				t.Fatalf("%s must pass --always-approve: %s", mode, args)
			}
		})
	}
}
