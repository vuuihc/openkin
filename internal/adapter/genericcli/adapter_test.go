package genericcli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/adapter/detect"
)

func TestBuildArgsPromptAndFlags(t *testing.T) {
	inv := detect.Invocation{
		Mode:             "json",
		Args:             []string{"--prompt", "{{prompt}}", "--output-format", "json"},
		ModelFlag:        "-m",
		AutoConfirmFlags: []string{"--yolo"},
	}
	spec := adapter.TaskSpec{
		Prompt:         "hello world",
		Model:          "flash",
		PermissionMode: adapter.PermissionYOLO,
	}
	args := buildArgs(inv, spec, adapter.PermissionYOLO)
	joined := strings.Join(args, "\x00")
	if !strings.Contains(joined, "hello world") {
		t.Fatalf("prompt missing: %v", args)
	}
	// Prompt must be its own argv element, not shell-joined.
	found := false
	for _, a := range args {
		if a == "hello world" {
			found = true
		}
	}
	if !found {
		t.Fatalf("prompt not standalone argv: %v", args)
	}
	if !containsPair(args, "-m", "flash") {
		t.Fatalf("model flag missing: %v", args)
	}
	if !contains(args, "--yolo") {
		t.Fatalf("yolo flag missing: %v", args)
	}
}

func TestBuildArgsNoAutoConfirmOnDefault(t *testing.T) {
	// buildArgs is only called after Start rejects default, but still must not
	// attach flags when perm is default if ever called.
	inv := detect.Invocation{
		Args:             []string{"-p", "{{prompt}}"},
		AutoConfirmFlags: []string{"--yolo"},
	}
	args := buildArgs(inv, adapter.TaskSpec{Prompt: "x"}, adapter.PermissionDefault)
	if contains(args, "--yolo") {
		t.Fatalf("default must not auto-confirm: %v", args)
	}
}

func TestStartRejectsDefaultPermission(t *testing.T) {
	ad := &Adapter{
		ID:   "gemini-cli",
		Inv:  detect.Invocation{Mode: "json", Args: []string{"--prompt", "{{prompt}}"}},
		Bins: []string{"true"},
		LookPath: func(file string) (string, error) {
			return "/bin/true", nil
		},
	}
	_, err := ad.Start(context.Background(), adapter.TaskSpec{
		Prompt:         "hi",
		PermissionMode: adapter.PermissionDefault,
	})
	if err == nil {
		t.Fatal("expected error for default permission")
	}
	if !strings.Contains(err.Error(), "accept_edits") {
		t.Fatalf("error=%v", err)
	}
}

func TestJSONModeMessageAndResult(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("script fixtures use sh")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-agent")
	// Emit a single JSON object (gemini-cli style).
	body := "#!/bin/sh\n" +
		`echo '{"text":"hello from fake","usage":{"input_tokens":3,"output_tokens":5},"session_id":"s1"}'` + "\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	ad := &Adapter{
		ID:  "gemini-cli",
		Inv: detect.Invocation{Mode: "json", Args: []string{"{{prompt}}"}},
		LookPath: func(file string) (string, error) {
			return script, nil
		},
		Bins: []string{"fake-agent"},
	}
	h, err := ad.Start(context.Background(), adapter.TaskSpec{
		Prompt:         "ping",
		PermissionMode: adapter.PermissionYOLO,
		Cwd:            dir,
	})
	if err != nil {
		t.Fatal(err)
	}
	var types []string
	var sawMessage, sawUsage, sawResult bool
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev, ok := <-h.Events():
			if !ok {
				goto done
			}
			types = append(types, ev.Type)
			switch ev.Type {
			case "message":
				sawMessage = true
				var m map[string]any
				_ = json.Unmarshal(ev.Payload, &m)
			case "usage":
				sawUsage = true
			case "result":
				sawResult = true
			case "task_started":
				// session
			}
		case <-deadline:
			t.Fatalf("timeout; events=%v", types)
		}
	}
done:
	if !sawMessage {
		t.Fatalf("missing message; events=%v", types)
	}
	if !sawUsage {
		t.Fatalf("missing usage; events=%v", types)
	}
	// result may come from explicit is_error or exit fallback
	if !sawResult {
		t.Fatalf("missing result; events=%v", types)
	}
}

func TestJSONModeNDJSON(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("script fixtures use sh")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-ndjson")
	body := "#!/bin/sh\n" +
		`echo '{"text":"line1"}'` + "\n" +
		`echo '{"text":"line2","is_error":false}'` + "\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	ad := &Adapter{
		ID:       "opencode",
		Inv:      detect.Invocation{Mode: "json", Args: []string{"{{prompt}}"}},
		LookPath: func(string) (string, error) { return script, nil },
		Bins:     []string{"fake-ndjson"},
	}
	h, err := ad.Start(context.Background(), adapter.TaskSpec{
		Prompt:         "x",
		PermissionMode: adapter.PermissionAcceptEdits,
	})
	if err != nil {
		t.Fatal(err)
	}
	var messages int
	for range h.Events() {
		// drain
		messages++
	}
	if messages == 0 {
		t.Fatal("no events")
	}
}

func TestTextModeMessage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("pty fixtures")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-text")
	body := "#!/bin/sh\necho hello-text\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	ad := &Adapter{
		ID:       "aider-desk",
		Inv:      detect.Invocation{Mode: "text", Args: []string{"{{prompt}}"}},
		LookPath: func(string) (string, error) { return script, nil },
		Bins:     []string{"fake-text"},
		Coalesce: 20 * time.Millisecond,
	}
	h, err := ad.Start(context.Background(), adapter.TaskSpec{
		Prompt:         "hi",
		PermissionMode: adapter.PermissionYOLO,
	})
	if err != nil {
		t.Fatal(err)
	}
	var sawMessage, sawResult bool
	var msgText string
	for ev := range h.Events() {
		switch ev.Type {
		case "message":
			sawMessage = true
			var m struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			}
			_ = json.Unmarshal(ev.Payload, &m)
			if len(m.Content) > 0 {
				msgText = m.Content[0].Text
			}
		case "result":
			sawResult = true
		}
	}
	if !sawMessage || !strings.Contains(msgText, "hello-text") {
		t.Fatalf("message=%q saw=%v", msgText, sawMessage)
	}
	if !sawResult {
		t.Fatal("missing result")
	}
}

func TestEmitJSONLineContentArray(t *testing.T) {
	ch := make(chan adapter.Event, 8)
	var em, er bool
	line := []byte(`{"content":[{"type":"text","text":"abc"}],"usage":{"input_tokens":1,"output_tokens":2}}`)
	if !emitJSONLine(ch, "x", line, &em, &er) {
		t.Fatal("expected json")
	}
	close(ch)
	var types []string
	for ev := range ch {
		types = append(types, ev.Type)
	}
	if !em {
		t.Fatalf("events=%v", types)
	}
}

func contains(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func containsPair(args []string, k, v string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == k && args[i+1] == v {
			return true
		}
	}
	return false
}
