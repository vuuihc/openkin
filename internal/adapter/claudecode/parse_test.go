package claudecode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
			for _, line := range strings.Split(string(inBytes), "\n") {
				line = strings.TrimRight(line, "\r")
				if line == "" {
					continue
				}
				for _, ev := range ParseLine(line) {
					var payload any
					if err := json.Unmarshal(ev.Payload, &payload); err != nil {
						t.Fatalf("payload: %v", err)
					}
					// Drop raw field for stable goldens (full line echo).
					if m, ok := payload.(map[string]any); ok {
						delete(m, "raw")
						payload = m
					}
					got = append(got, goldenEv{Type: ev.Type, Payload: payload})
				}
			}
			gotJSON, err := json.MarshalIndent(got, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			gotJSON = append(gotJSON, '\n')

			if string(gotJSON) != string(wantBytes) {
				t.Errorf("mismatch for %s\n=== got ===\n%s\n=== want ===\n%s",
					base, gotJSON, wantBytes)
				// Write .got for easy update when intentional.
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
		`{"type":"assistant"}`,
		`{"type":"stream_event","event":null}`,
	}
	for _, in := range inputs {
		_ = ParseLine(in)
	}
}
