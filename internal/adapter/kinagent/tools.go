package kinagent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/vuuihc/kin/internal/provider"
)

const (
	// maxToolOutBytes is a hard safety cap on raw tool stdout before UI/archive
	// and before digest. The model path never sees this full blob (ToolDigest).
	maxToolOutBytes = 80_000
	bashTimeout     = 120 * time.Second
)

// SessionSearcher looks up archived events for the session_search tool (ADR 0002 P2).
type SessionSearcher interface {
	Search(ctx context.Context, taskID, query string, limit int) (string, error)
}

// toolEnv is the sandboxed workspace for tool execution.
type toolEnv struct {
	// Root is the absolute resolved cwd (task working directory).
	Root string
	// TaskID scopes session_search when set.
	TaskID string
	// Search optional archive retrieval.
	Search SessionSearcher
}

func newToolEnv(cwd string) (*toolEnv, error) {
	if strings.TrimSpace(cwd) == "" {
		cwd, _ = os.Getwd()
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}
	root, err := filepath.EvalSymlinks(abs)
	if err != nil {
		// Fallback if path does not exist yet
		root = abs
	}
	fi, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("cwd %q: %w", root, err)
	}
	if !fi.IsDir() {
		return nil, fmt.Errorf("cwd %q is not a directory", root)
	}
	return &toolEnv{Root: root}, nil
}

// resolvePath maps a user path into Root. Relative paths join Root; absolute
// paths must stay under Root.
func (e *toolEnv) resolvePath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return e.Root, nil
	}
	var abs string
	if filepath.IsAbs(p) {
		abs = filepath.Clean(p)
	} else {
		abs = filepath.Clean(filepath.Join(e.Root, p))
	}
	// EvalSymlinks when exists so we cannot escape via symlink.
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	root := e.Root
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	sep := string(os.PathSeparator)
	if abs != root && !strings.HasPrefix(abs, root+sep) {
		return "", fmt.Errorf("path %q escapes workspace %q", p, e.Root)
	}
	return abs, nil
}

func agentTools(withSearch bool) []provider.ToolDef {
	tools := []provider.ToolDef{
		provider.FunctionTool("bash",
			"Run a shell command in the task working directory. Prefer non-interactive commands. Output is truncated if very large.",
			map[string]any{
				"type": "object",
				"properties": map[string]any{
					"command": map[string]any{
						"type":        "string",
						"description": "Shell command to run (bash -lc)",
					},
				},
				"required": []string{"command"},
			},
		),
		provider.FunctionTool("read_file",
			"Read a UTF-8 text file under the workspace. Paths may be relative to cwd.",
			map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path": map[string]any{"type": "string", "description": "File path relative to cwd or absolute under cwd"},
				},
				"required": []string{"path"},
			},
		),
		provider.FunctionTool("write_file",
			"Create or overwrite a UTF-8 text file under the workspace.",
			map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":    map[string]any{"type": "string"},
					"content": map[string]any{"type": "string"},
				},
				"required": []string{"path", "content"},
			},
		),
		provider.FunctionTool("list_dir",
			"List files and directories under a path (non-recursive).",
			map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path": map[string]any{
						"type":        "string",
						"description": "Directory path relative to cwd (default .)",
					},
				},
			},
		),
		provider.FunctionTool("glob",
			"Find files matching a glob under the workspace (e.g. **/*.go). Max 200 hits.",
			map[string]any{
				"type": "object",
				"properties": map[string]any{
					"pattern": map[string]any{"type": "string"},
				},
				"required": []string{"pattern"},
			},
		),
	}
	if withSearch {
		tools = append(tools, provider.FunctionTool("session_search",
			"Search this task's archived events (full tool outputs, prior messages) by keyword. Use when digests omitted detail you need.",
			map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{
						"type":        "string",
						"description": "Keyword or phrase to find in the event archive",
					},
					"limit": map[string]any{
						"type":        "integer",
						"description": "Max hits (default 10, max 50)",
					},
				},
				"required": []string{"query"},
			},
		))
	}
	return tools
}

func (e *toolEnv) runTool(ctx context.Context, name, argsJSON string) (string, error) {
	var args map[string]any
	if strings.TrimSpace(argsJSON) != "" {
		if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
			return "", fmt.Errorf("invalid tool arguments JSON: %w", err)
		}
	}
	if args == nil {
		args = map[string]any{}
	}
	switch name {
	case "bash":
		cmd, _ := args["command"].(string)
		return e.bash(ctx, cmd)
	case "read_file":
		path, _ := args["path"].(string)
		return e.readFile(path)
	case "write_file":
		path, _ := args["path"].(string)
		content, _ := args["content"].(string)
		return e.writeFile(path, content)
	case "list_dir":
		path, _ := args["path"].(string)
		if path == "" {
			path = "."
		}
		return e.listDir(path)
	case "glob":
		pat, _ := args["pattern"].(string)
		return e.glob(pat)
	case "session_search":
		q, _ := args["query"].(string)
		limit := 10
		switch v := args["limit"].(type) {
		case float64:
			limit = int(v)
		case int:
			limit = v
		}
		return e.sessionSearch(ctx, q, limit)
	default:
		return "", fmt.Errorf("unknown tool %q", name)
	}
}

func (e *toolEnv) sessionSearch(ctx context.Context, query string, limit int) (string, error) {
	if e.Search == nil {
		return "", fmt.Errorf("session_search not available")
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return "", fmt.Errorf("query is required")
	}
	if limit <= 0 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}
	return e.Search.Search(ctx, e.TaskID, query, limit)
}

func (e *toolEnv) bash(ctx context.Context, command string) (string, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return "", fmt.Errorf("command is required")
	}
	cctx, cancel := context.WithTimeout(ctx, bashTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "bash", "-lc", command)
	cmd.Dir = e.Root
	cmd.Env = append(os.Environ(), "PWD="+e.Root)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	out := stdout.String()
	if stderr.Len() > 0 {
		if out != "" {
			out += "\n"
		}
		out += "--- stderr ---\n" + stderr.String()
	}
	out = truncateBytes(out, maxToolOutBytes)
	if err != nil {
		if cctx.Err() != nil {
			return out, fmt.Errorf("bash timeout or canceled: %w", err)
		}
		return out, fmt.Errorf("exit error: %w", err)
	}
	if out == "" {
		out = "(no output)"
	}
	return out, nil
}

func (e *toolEnv) readFile(path string) (string, error) {
	abs, err := e.resolvePath(path)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return "", err
	}
	// Reject obvious binaries
	if bytes.IndexByte(data, 0) >= 0 {
		return "", fmt.Errorf("file appears binary")
	}
	return truncateBytes(string(data), maxToolOutBytes), nil
}

func (e *toolEnv) writeFile(path, content string) (string, error) {
	abs, err := e.resolvePath(path)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		return "", err
	}
	return fmt.Sprintf("wrote %d bytes to %s", len(content), relDisplay(e.Root, abs)), nil
}

func (e *toolEnv) listDir(path string) (string, error) {
	abs, err := e.resolvePath(path)
	if err != nil {
		return "", err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	n := 0
	for _, ent := range entries {
		if n >= 500 {
			b.WriteString("… (truncated)\n")
			break
		}
		name := ent.Name()
		if ent.IsDir() {
			name += "/"
		}
		b.WriteString(name)
		b.WriteByte('\n')
		n++
	}
	if b.Len() == 0 {
		return "(empty)", nil
	}
	return b.String(), nil
}

func (e *toolEnv) glob(pattern string) (string, error) {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return "", fmt.Errorf("pattern is required")
	}
	// filepath.Glob is not recursive for **; walk when ** present.
	var matches []string
	if strings.Contains(pattern, "**") {
		// Simple ** support: walk and match with path.Match on slash paths
		suffix := strings.TrimPrefix(pattern, "**/")
		if suffix == pattern {
			suffix = strings.ReplaceAll(pattern, "**/", "")
		}
		_ = filepath.WalkDir(e.Root, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			rel, err := filepath.Rel(e.Root, path)
			if err != nil {
				return nil
			}
			rel = filepath.ToSlash(rel)
			ok, _ := filepath.Match(suffix, filepath.Base(rel))
			if !ok {
				ok, _ = pathMatch(suffix, rel)
			}
			if ok {
				matches = append(matches, rel)
			}
			if len(matches) >= 200 {
				return filepath.SkipAll
			}
			return nil
		})
	} else {
		// Relative to root
		full := pattern
		if !filepath.IsAbs(pattern) {
			full = filepath.Join(e.Root, pattern)
		}
		found, err := filepath.Glob(full)
		if err != nil {
			return "", err
		}
		for _, f := range found {
			rel, err := filepath.Rel(e.Root, f)
			if err != nil {
				continue
			}
			// ensure under root
			if _, err := e.resolvePath(rel); err != nil {
				continue
			}
			matches = append(matches, filepath.ToSlash(rel))
			if len(matches) >= 200 {
				break
			}
		}
	}
	if len(matches) == 0 {
		return "(no matches)", nil
	}
	return strings.Join(matches, "\n"), nil
}

func pathMatch(pattern, name string) (bool, error) {
	// filepath.Match does not treat / specially for **; use Match on full rel path.
	return filepath.Match(pattern, name)
}

func relDisplay(root, abs string) string {
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return abs
	}
	return filepath.ToSlash(rel)
}

// truncateUTF8 returns a valid-UTF-8 prefix of s of at most maxBytes, plus
// suffix when truncation happens. Cuts never land mid-rune (avoids U+FFFD
// replacement when the result is later json.Marshal'd into the event log).
func truncateUTF8(s string, maxBytes int, suffix string) string {
	if maxBytes <= 0 {
		if len(s) == 0 {
			return ""
		}
		return suffix
	}
	if len(s) <= maxBytes {
		return s
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	if cut == 0 {
		// First rune alone exceeds the budget; drop content rather than emit invalid UTF-8.
		return suffix
	}
	return s[:cut] + suffix
}

func truncateBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// Recompute omitted byte count after backing up to a rune boundary.
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	if cut == 0 {
		return fmt.Sprintf("… truncated %d bytes", len(s))
	}
	return s[:cut] + fmt.Sprintf("\n… truncated %d bytes", len(s)-cut)
}
