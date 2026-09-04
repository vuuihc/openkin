package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/adapter/adaptertest"
)

func TestParseLineGolden(t *testing.T) {
	dir := filepath.Join("testdata")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".input") {
			continue
		}
		base := strings.TrimSuffix(name, ".input")
		t.Run(base, func(t *testing.T) {
			inBytes, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			wantPath := filepath.Join(dir, base+".golden")
			wantBytes, err := os.ReadFile(wantPath)
			if err != nil {
				t.Fatalf("read golden: %v", err)
			}

			type goldenEv struct {
				Type    string `json:"type"`
				Payload any    `json:"payload"`
			}
			var got []goldenEv
			var canonical []adapter.Event
			for _, line := range strings.Split(string(inBytes), "\n") {
				line = strings.TrimRight(line, "\r")
				if line == "" {
					continue
				}
				parsed := ParseLine(line)
				canonical = append(canonical, parsed...)
				for _, ev := range parsed {
					var payload any
					if err := json.Unmarshal(ev.Payload, &payload); err != nil {
						t.Fatalf("payload: %v", err)
					}
					got = append(got, goldenEv{Type: ev.Type, Payload: payload})
				}
			}
			adaptertest.AssertEvents(t, canonical)
			gotJSON, err := json.MarshalIndent(got, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			gotJSON = append(gotJSON, '\n')

			if string(gotJSON) != string(wantBytes) {
				t.Errorf("mismatch for %s\n=== got ===\n%s\n=== want ===\n%s",
					base, gotJSON, wantBytes)
				_ = os.WriteFile(filepath.Join(dir, base+".got"), gotJSON, 0o644)
			}
		})
	}
}

func TestParseLineNeverPanics(t *testing.T) {
	inputs := []string{
		"",
		"not json",
		`{}`,
		`{"type":123}`,
		`{"type":"unknown_xyz","foo":true}`,
		`{"type":"item.completed"}`,
		`{"type":"turn.failed","error":null}`,
		`{"type":"error","message":"Reconnecting... 1/5"}`,
	}
	for _, in := range inputs {
		_ = ParseLine(in)
	}
}

func TestParseLineIgnoresDeprecatedCodexHooksNotice(t *testing.T) {
	line := `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"[features].codex_hooks is deprecated. Use [features].hooks instead."}}`
	if got := ParseLine(line); len(got) != 0 {
		t.Fatalf("deprecated compatibility notice should not become a task error: %#v", got)
	}
}
