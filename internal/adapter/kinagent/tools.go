package kinagent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/vuuihc/openkin/internal/connectors"
	"github.com/vuuihc/openkin/internal/provider"
)

const (
	// maxToolOutBytes is a hard safety cap on raw tool stdout before UI/archive
	// and before digest. The model path never sees this full blob (ToolDigest).
	maxToolOutBytes      = 80_000
	maxEditableFileBytes = 8 << 20
	bashTimeout          = 120 * time.Second
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
	Search         SessionSearcher
	Connectors     connectors.Host
	ConnectorTools map[string]connectorInvocation
}

type workspacePathLock struct {
	token chan struct{}
	refs  int
}

var workspaceFileLocks = struct {
	sync.Mutex
	byPath map[string]*workspacePathLock
}{
	byPath: make(map[string]*workspacePathLock),
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
		provider.FunctionTool("edit_file",
			"Make a localized edit to an existing UTF-8 text file. Copy old_string exactly from read_file. By default old_string must occur exactly once; set replace_all only when every occurrence should change.",
			map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path": map[string]any{
						"type":        "string",
						"description": "File path relative to cwd or absolute under cwd",
					},
					"old_string": map[string]any{
						"type":        "string",
						"description": "Exact existing text to replace; include enough surrounding context for a unique match",
					},
					"new_string": map[string]any{
						"type":        "string",
						"description": "Replacement text; may be empty to delete old_string",
					},
					"replace_all": map[string]any{
						"type":        "boolean",
						"description": "Replace every exact match instead of requiring one unique match",
					},
				},
				"required": []string{"path", "old_string", "new_string"},
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
	if _, ok := e.ConnectorTools[name]; ok {
		return e.runConnectorTool(ctx, name, args)
	}
	switch name {
	case "bash":
		cmd, _ := args["command"].(string)
		return e.bash(ctx, cmd)
	case "read_file":
		path, _ := args["path"].(string)
		return e.readFile(path)
	case "write_file":
		path, err := requiredStringToolArg(args, "path", false)
		if err != nil {
			return "", err
		}
		content, err := requiredStringToolArg(args, "content", true)
		if err != nil {
			return "", err
		}
		return e.writeFileContext(ctx, path, content)
	case "edit_file":
		path, err := requiredStringToolArg(args, "path", false)
		if err != nil {
			return "", err
		}
		oldString, err := requiredStringToolArg(args, "old_string", true)
		if err != nil {
			return "", err
		}
		newString, err := requiredStringToolArg(args, "new_string", true)
		if err != nil {
			return "", err
		}
		replaceAll := false
		if raw, ok := args["replace_all"]; ok {
			var valid bool
			replaceAll, valid = raw.(bool)
			if !valid {
				return "", fmt.Errorf("replace_all must be a boolean")
			}
		}
		return e.editFileContext(ctx, path, oldString, newString, replaceAll)
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

func requiredStringToolArg(args map[string]any, name string, allowEmpty bool) (string, error) {
	raw, ok := args[name]
	if !ok {
		return "", fmt.Errorf("%s is required", name)
	}
	value, ok := raw.(string)
	if !ok {
		return "", fmt.Errorf("%s must be a string", name)
	}
	if !allowEmpty && strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
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

// blockedTaskSpawnCommand rejects shell that creates top-level Kin tasks/sessions.
// Multi-agent work must use @mentions so the engine orchestrates inside this task.
func blockedTaskSpawnCommand(command string) string {
	c := strings.ToLower(command)
	compact := strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\t', '\n', '\r', '\\', '"', '\'':
			return -1
		default:
			return r
		}
	}, c)

	if strings.Contains(compact, "post") && strings.Contains(compact, "/api/tasks") {
		return "blocked: do not create top-level Kin tasks/sessions via the API. " +
			"Parallel work stays in this chat via @agent mentions (e.g. @kin A @kin B). " +
			"Ask the user to re-send with @mentions, or do the work yourself."
	}
	if strings.Contains(c, "kin ") && (strings.Contains(c, " task create") || strings.Contains(c, " tasks create") || strings.Contains(c, " create-task")) {
		return "blocked: do not spawn Kin tasks via CLI. Use @agent mentions in this chat for parallel work."
	}
	return ""
}

func (e *toolEnv) bash(ctx context.Context, command string) (string, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return "", fmt.Errorf("command is required")
	}
	if reason := blockedTaskSpawnCommand(command); reason != "" {
		return "", fmt.Errorf("%s", reason)
	}
	cctx, cancel := context.WithTimeout(ctx, bashTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "bash", "-lc", command)
	cmd.Dir = e.Root
	cmd.Env = append(os.Environ(), "PWD="+e.Root)
	// Run bash in its own process group so that on timeout/cancel we can kill
	// the whole tree, not just the bash leader. A command like `ssh` (or any
	// grandchild that inherits our stdout/stderr pipe) would otherwise keep the
	// pipe open after bash is killed, so the copy goroutines in cmd.Wait never
	// see EOF and cmd.Run blocks forever — freezing the session even though the
	// context timeout already fired.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			// Negative pid => signal the entire process group.
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	// Backstop: if a grandchild still holds the output pipe open after the kill,
	// force the pipes closed so cmd.Run returns instead of hanging.
	cmd.WaitDelay = 5 * time.Second
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
	return e.writeFileContext(context.Background(), path, content)
}

func (e *toolEnv) writeFileContext(ctx context.Context, path, content string) (string, error) {
	abs, err := e.resolvePath(path)
	if err != nil {
		return "", err
	}
	unlock, err := lockWorkspaceFile(ctx, abs)
	if err != nil {
		return "", err
	}
	defer unlock()

	rel, err := filepath.Rel(e.Root, abs)
	if err != nil {
		return "", err
	}
	root, err := os.OpenRoot(e.Root)
	if err != nil {
		return "", err
	}
	defer root.Close()
	if err := root.MkdirAll(filepath.Dir(rel), 0o755); err != nil {
		return "", err
	}
	file, err := root.OpenFile(rel, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if err := flockWithContext(ctx, file); err != nil {
		return "", err
	}
	defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := overwriteOpenFile(file, []byte(content)); err != nil {
		return "", err
	}
	return fmt.Sprintf("wrote %d bytes to %s", len(content), relDisplay(e.Root, abs)), nil
}

func (e *toolEnv) editFile(path, oldString, newString string, replaceAll bool) (string, error) {
	return e.editFileContext(context.Background(), path, oldString, newString, replaceAll)
}

func (e *toolEnv) editFileContext(ctx context.Context, path, oldString, newString string, replaceAll bool) (string, error) {
	if oldString == "" {
		return "", fmt.Errorf("old_string is required; use write_file to create or replace a whole file")
	}
	if oldString == newString {
		return "", fmt.Errorf("old_string and new_string must differ")
	}
	abs, err := e.resolvePath(path)
	if err != nil {
		return "", err
	}
	unlock, err := lockWorkspaceFile(ctx, abs)
	if err != nil {
		return "", err
	}
	defer unlock()

	rel, err := filepath.Rel(e.Root, abs)
	if err != nil {
		return "", err
	}
	root, err := os.OpenRoot(e.Root)
	if err != nil {
		return "", err
	}
	defer root.Close()

	file, err := root.OpenFile(rel, os.O_RDWR, 0)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if err := flockWithContext(ctx, file); err != nil {
		return "", err
	}
	defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	if err := ctx.Err(); err != nil {
		return "", err
	}
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("path %q is not a regular file", path)
	}
	if info.Size() > maxEditableFileBytes {
		return "", fmt.Errorf("file is too large to edit safely: %d bytes (max %d)", info.Size(), maxEditableFileBytes)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxEditableFileBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > maxEditableFileBytes {
		return "", fmt.Errorf("file is too large to edit safely: more than %d bytes", maxEditableFileBytes)
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return "", fmt.Errorf("file appears binary")
	}
	if !utf8.Valid(data) {
		return "", fmt.Errorf("file is not valid UTF-8")
	}

	body := string(data)
	matches := strings.Count(body, oldString)
	if matches == 0 {
		return "", fmt.Errorf("old_string not found in %s; re-read the file and copy the exact text", relDisplay(e.Root, abs))
	}
	if matches > 1 && !replaceAll {
		return "", fmt.Errorf("old_string matches %d locations in %s; include more surrounding context or set replace_all", matches, relDisplay(e.Root, abs))
	}
	replacements := 1
	if replaceAll {
		replacements = matches
	}
	if len(newString) > len(oldString) {
		growth := len(newString) - len(oldString)
		if growth > (maxEditableFileBytes-len(data))/replacements {
			return "", fmt.Errorf("edit result is too large (max %d bytes)", maxEditableFileBytes)
		}
	}
	limit := 1
	if replaceAll {
		limit = -1
	}
	updated := strings.Replace(body, oldString, newString, limit)
	if len(updated) > maxEditableFileBytes {
		return "", fmt.Errorf("edit result is too large: %d bytes (max %d)", len(updated), maxEditableFileBytes)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := writeOpenFile(root, rel, file, data, []byte(updated), info); err != nil {
		return "", err
	}

	replaced := replacements
	unit := "occurrence"
	if replaced != 1 {
		unit = "occurrences"
	}
	return fmt.Sprintf("edited %s: replaced %d %s", relDisplay(e.Root, abs), replaced, unit), nil
}

func flockWithContext(ctx context.Context, file *os.File) error {
	const retryDelay = 25 * time.Millisecond
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
				return ctxErr
			}
			return nil
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
			return err
		}
		timer := time.NewTimer(retryDelay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func writeOpenFile(root *os.Root, path string, file *os.File, original, updated []byte, info os.FileInfo) error {
	currentInfo, err := root.Stat(path)
	if err != nil {
		return err
	}
	if !os.SameFile(info, currentInfo) ||
		currentInfo.Size() != info.Size() ||
		!currentInfo.ModTime().Equal(info.ModTime()) {
		return fmt.Errorf("file changed while editing %s; re-read and retry", path)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	current, err := io.ReadAll(io.LimitReader(file, maxEditableFileBytes+1))
	if err != nil {
		return err
	}
	if !bytes.Equal(current, original) {
		return fmt.Errorf("file changed while editing %s; re-read and retry", path)
	}
	if err := overwriteOpenFile(file, updated); err != nil {
		if rollbackErr := overwriteOpenFile(file, original); rollbackErr != nil {
			return fmt.Errorf("edit failed: %v; rollback failed: %v; file may be modified", err, rollbackErr)
		}
		return err
	}
	after, err := root.Stat(path)
	if err != nil {
		return rollbackOpenFile(file, original, err)
	}
	if !os.SameFile(info, after) {
		return rollbackOpenFile(
			file,
			original,
			fmt.Errorf("file path changed while editing %s; current path was not overwritten", path),
		)
	}
	return nil
}

func rollbackOpenFile(file *os.File, original []byte, cause error) error {
	if rollbackErr := overwriteOpenFile(file, original); rollbackErr != nil {
		return fmt.Errorf("%v; rollback failed: %v; file may be modified", cause, rollbackErr)
	}
	return cause
}

func overwriteOpenFile(file *os.File, data []byte) error {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	written, err := file.Write(data)
	if err != nil {
		return err
	}
	if written != len(data) {
		return io.ErrShortWrite
	}
	if err := file.Truncate(int64(len(data))); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	return nil
}

func lockWorkspaceFile(ctx context.Context, path string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	workspaceFileLocks.Lock()
	entry := workspaceFileLocks.byPath[path]
	if entry == nil {
		entry = &workspacePathLock{token: make(chan struct{}, 1)}
		entry.token <- struct{}{}
		workspaceFileLocks.byPath[path] = entry
	}
	entry.refs++
	workspaceFileLocks.Unlock()

	select {
	case <-ctx.Done():
		releaseWorkspaceFileLock(path, entry)
		return nil, ctx.Err()
	case <-entry.token:
	}
	if err := ctx.Err(); err != nil {
		entry.token <- struct{}{}
		releaseWorkspaceFileLock(path, entry)
		return nil, err
	}
	return func() {
		entry.token <- struct{}{}
		releaseWorkspaceFileLock(path, entry)
	}, nil
}

func releaseWorkspaceFileLock(path string, entry *workspacePathLock) {
	workspaceFileLocks.Lock()
	defer workspaceFileLocks.Unlock()
	entry.refs--
	if entry.refs == 0 {
		if current := workspaceFileLocks.byPath[path]; current == entry {
			delete(workspaceFileLocks.byPath, path)
		}
	}
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
