// Package eval provides a small, deterministic evaluation harness on top of
// ordinary Kin tasks. Suites are file-backed so they can be reviewed and
// versioned with the repository.
package eval

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Suite is the persisted JSON representation of an evaluation suite.
type Suite struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Cases   []Case `json:"cases"`
}

// Case is one prompt and deterministic expectation.
type Case struct {
	ID             string          `json:"id"`
	Prompt         string          `json:"prompt"`
	Cwd            string          `json:"cwd"`
	Agent          string          `json:"agent,omitempty"`
	PermissionMode string          `json:"permission_mode,omitempty"`
	ProjectID      string          `json:"project_id,omitempty"`
	Dispatch       json.RawMessage `json:"dispatch,omitempty"`
	Expect         Expectation     `json:"expect"`
}

// Expectation is deliberately limited to signals that do not require an LLM
// judge. Empty status means succeeded.
type Expectation struct {
	Status       string   `json:"status,omitempty"`
	TextContains []string `json:"text_contains,omitempty"`
	MinTurns     int      `json:"min_turns,omitempty"`
	MaxTurns     int      `json:"max_turns,omitempty"`
	EventType    string   `json:"event_type,omitempty"`
}

// LoadSuite loads <root>/<name>/suite.json, or <root>/<name>.json.
func LoadSuite(root, name string) (Suite, error) {
	name = strings.TrimSpace(name)
	if name == "" || filepath.IsAbs(name) || name == "." || name == ".." ||
		strings.Contains(name, string(filepath.Separator)+".."+string(filepath.Separator)) {
		return Suite{}, fmt.Errorf("invalid suite name")
	}
	if root == "" {
		return Suite{}, fmt.Errorf("eval suites directory is not configured")
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return Suite{}, fmt.Errorf("resolve suites directory: %w", err)
	}
	candidates := []string{
		filepath.Join(rootAbs, name, "suite.json"),
		filepath.Join(rootAbs, name+".json"),
	}
	var data []byte
	var selected string
	for _, candidate := range candidates {
		if !within(rootAbs, candidate) {
			return Suite{}, fmt.Errorf("suite path escapes directory")
		}
		data, err = os.ReadFile(candidate)
		if err == nil {
			selected = candidate
			break
		}
		if !os.IsNotExist(err) {
			return Suite{}, fmt.Errorf("read suite %q: %w", name, err)
		}
	}
	if selected == "" {
		return Suite{}, fmt.Errorf("suite %q not found", name)
	}
	var suite Suite
	if err := json.Unmarshal(data, &suite); err != nil {
		return Suite{}, fmt.Errorf("parse suite %q: %w", selected, err)
	}
	if suite.Name == "" {
		suite.Name = name
	}
	if suite.Version == "" {
		suite.Version = "unversioned"
	}
	if err := suite.Validate(); err != nil {
		return Suite{}, err
	}
	return suite, nil
}

// ListSuites returns suite names from <root>/<name>/suite.json and
// <root>/<name>.json. It never follows paths outside root.
func ListSuites(root string) ([]string, error) {
	if strings.TrimSpace(root) == "" {
		return []string{}, nil
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, fmt.Errorf("list eval suites: %w", err)
	}
	seen := make(map[string]struct{})
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() {
			if _, err := os.Stat(filepath.Join(root, name, "suite.json")); err == nil {
				seen[name] = struct{}{}
			}
			continue
		}
		if strings.HasSuffix(name, ".json") {
			seen[strings.TrimSuffix(name, ".json")] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out, nil
}

// Validate checks the bounded fixture shape before any tasks are created.
func (s Suite) Validate() error {
	if strings.TrimSpace(s.Name) == "" {
		return fmt.Errorf("suite name is required")
	}
	if strings.TrimSpace(s.Version) == "" {
		return fmt.Errorf("suite version is required")
	}
	if len(s.Cases) == 0 || len(s.Cases) > 1000 {
		return fmt.Errorf("suite cases must contain 1..1000 cases")
	}
	seen := make(map[string]struct{}, len(s.Cases))
	for i, c := range s.Cases {
		if strings.TrimSpace(c.ID) == "" {
			return fmt.Errorf("suite case %d id is required", i)
		}
		if _, ok := seen[c.ID]; ok {
			return fmt.Errorf("suite case %q is duplicated", c.ID)
		}
		seen[c.ID] = struct{}{}
		if strings.TrimSpace(c.Prompt) == "" || strings.TrimSpace(c.Cwd) == "" {
			return fmt.Errorf("suite case %q requires cwd and prompt", c.ID)
		}
		if c.Expect.MinTurns < 0 || c.Expect.MaxTurns < 0 ||
			(c.Expect.MaxTurns > 0 && c.Expect.MinTurns > c.Expect.MaxTurns) {
			return fmt.Errorf("suite case %q has invalid turn bounds", c.ID)
		}
	}
	return nil
}

func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
