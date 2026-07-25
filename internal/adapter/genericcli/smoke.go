package genericcli

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/adapter/detect"
)

// SmokeTimeout is the per-agent headless probe budget.
const SmokeTimeout = 15 * time.Second

// SmokePrompt is a minimal non-destructive prompt for launch-line checks.
const SmokePrompt = "Reply with exactly: ok"

// SmokeResult is the outcome of one headless launch probe.
type SmokeResult struct {
	OK     bool
	Detail string
}

// Smoke runs a short headless launch against binary using inv’s argv template.
// It uses an empty temp cwd and yolo permission so AutoConfirm flags/env apply.
// Success requires the process to exit 0 before the timeout.
func Smoke(ctx context.Context, inv detect.Invocation, binary string) SmokeResult {
	binary = strings.TrimSpace(binary)
	if binary == "" {
		return SmokeResult{OK: false, Detail: "no binary"}
	}
	if _, err := os.Stat(binary); err != nil {
		return SmokeResult{OK: false, Detail: "binary not accessible: " + err.Error()}
	}

	cwd, err := os.MkdirTemp("", "kin-agent-smoke-*")
	if err != nil {
		return SmokeResult{OK: false, Detail: "temp cwd: " + err.Error()}
	}
	defer func() { _ = os.RemoveAll(cwd) }()

	spec := adapter.TaskSpec{
		Prompt:         SmokePrompt,
		Cwd:            cwd,
		PermissionMode: adapter.PermissionYOLO,
	}
	args := buildArgs(inv, spec, adapter.PermissionYOLO)

	runCtx, cancel := context.WithTimeout(ctx, SmokeTimeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, binary, args...)
	cmd.Dir = cwd
	cmd.Env = os.Environ()
	for k, v := range inv.AutoConfirmEnv {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()
	if runCtx.Err() == context.DeadlineExceeded {
		return SmokeResult{OK: false, Detail: fmt.Sprintf("timeout after %s", SmokeTimeout)}
	}
	if err != nil {
		detail := strings.TrimSpace(firstLine(stderr.String()))
		if detail == "" {
			detail = strings.TrimSpace(firstLine(stdout.String()))
		}
		if detail == "" {
			detail = err.Error()
		}
		if len(detail) > 240 {
			detail = detail[:240] + "…"
		}
		return SmokeResult{OK: false, Detail: detail}
	}
	return SmokeResult{OK: true, Detail: "exit 0"}
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}
