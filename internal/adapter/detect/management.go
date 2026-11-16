package detect

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ManagementInfo is best-effort install/auth/version metadata for the Agents tab.
// It is display-only and never used for dispatch / Registry decisions.
type ManagementInfo struct {
	ID          string `json:"id"`
	Version     string `json:"version,omitempty"`
	AuthStatus  string `json:"auth_status"` // signed_in | not_signed_in | unknown
	AuthDetail  string `json:"auth_detail,omitempty"`
	InstallCmd  string `json:"install_cmd,omitempty"`
	UpdateCmd   string `json:"update_cmd,omitempty"`
}

// VersionFlag is overridable in tests. Defaults to --version when unset per agent.
var VersionFlag = map[string]string{}

// RunVersion is overridable in tests (defaults to exec.CommandContext).
var RunVersion = defaultRunVersion

// installCmds / updateCmds are copyable package-manager hints for Catalog agents.
// Leave blank when there is no safe scriptable command.
var installCmds = map[string]string{
	"claude-code": "npm install -g @anthropic-ai/claude-code",
	"codex":       "npm install -g @openai/codex",
	"grok":        "npm install -g @xai/grok",
	"gemini-cli":  "npm install -g @google/gemini-cli",
	"qwen-code":   "npm install -g @qwen-code/qwen-code",
	"aider-desk":  "pip install aider-chat",
	"qoder":       "npm install -g @qoder/qodercli",
	"opencode":    "npm install -g opencode-ai",
	"pi":          "npm install -g @mariozechner/pi-coding-agent",
}

var updateCmds = map[string]string{
	"claude-code": "npm update -g @anthropic-ai/claude-code",
	"codex":       "npm update -g @openai/codex",
	"grok":        "npm update -g @xai/grok",
	"gemini-cli":  "npm update -g @google/gemini-cli",
	"qwen-code":   "npm update -g @qwen-code/qwen-code",
	"aider-desk":  "pip install -U aider-chat",
	"qoder":       "npm update -g @qoder/qodercli",
	"opencode":    "npm update -g opencode-ai",
	"pi":          "npm update -g @mariozechner/pi-coding-agent",
}

// authFiles lists known credential paths relative to $HOME (or absolute when
// prefixed with "$config/" → ConfigHome()). Empty / missing → auth status unknown.
var authFiles = map[string][]string{
	"claude-code": {".claude/.credentials.json", ".claude.json"},
	"codex":       {".codex/auth.json"},
	"grok":        {".grok/credentials.json", ".config/grok/credentials.json"},
	"gemini-cli":  {".gemini/oauth_creds.json", ".config/gemini/oauth_creds.json"},
	"qwen-code":   {".qwen/oauth_creds.json"},
	"opencode":    {".local/share/opencode/auth.json", ".config/opencode/auth.json"},
}

// CheckAuth stats configured credential paths for id.
// Returns "signed_in" | "not_signed_in" | "unknown".
func CheckAuth(id string) (status, detail string) {
	id = strings.TrimSpace(id)
	paths, ok := authFiles[id]
	if !ok || len(paths) == 0 {
		return "unknown", ""
	}
	home, _ := HomeDir()
	cfg := ConfigHome()
	var checked []string
	for _, rel := range paths {
		p := resolveAuthPath(rel, home, cfg)
		if p == "" {
			continue
		}
		checked = append(checked, p)
		st, err := os.Stat(p)
		if err == nil && st.Mode().IsRegular() && st.Size() > 0 {
			return "signed_in", p
		}
	}
	if len(checked) == 0 {
		return "unknown", ""
	}
	return "not_signed_in", strings.Join(checked, ", ")
}

func resolveAuthPath(rel, home, cfg string) string {
	rel = strings.TrimSpace(rel)
	if rel == "" {
		return ""
	}
	if strings.HasPrefix(rel, "$config/") {
		if cfg == "" {
			return ""
		}
		return filepath.Join(cfg, strings.TrimPrefix(rel, "$config/"))
	}
	if filepath.IsAbs(rel) {
		return rel
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, rel)
}

// CheckVersion runs `<binary> <flag>` with a short timeout and returns the
// first non-empty trimmed output line (stdout, else stderr).
func CheckVersion(ctx context.Context, binary, flag string) (string, error) {
	binary = strings.TrimSpace(binary)
	if binary == "" {
		return "", os.ErrNotExist
	}
	if flag == "" {
		flag = "--version"
	}
	if ctx == nil {
		ctx = context.Background()
	}
	// Bound runaway probes even if the caller forgets a deadline.
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
	}
	return RunVersion(ctx, binary, flag)
}

func defaultRunVersion(ctx context.Context, binary, flag string) (string, error) {
	cmd := exec.CommandContext(ctx, binary, flag)
	cmd.Stdin = nil
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	line := firstLine(stdout.String())
	if line == "" {
		line = firstLine(stderr.String())
	}
	if line == "" && err != nil {
		return "", err
	}
	return line, nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

func versionFlagFor(id string) string {
	if f, ok := VersionFlag[id]; ok && f != "" {
		return f
	}
	return "--version"
}

// ScanManagement builds management rows for the given agents.
// Installed agents get version + auth probes; others only install/update cmds.
func ScanManagement(agents []Info) []ManagementInfo {
	out := make([]ManagementInfo, 0, len(agents))
	for _, a := range agents {
		row := ManagementInfo{
			ID:         a.ID,
			InstallCmd: installCmds[a.ID],
			UpdateCmd:  updateCmds[a.ID],
			AuthStatus: "unknown",
		}
		if a.Installed {
			status, detail := CheckAuth(a.ID)
			row.AuthStatus = status
			row.AuthDetail = detail
			if a.Binary != "" {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				ver, err := CheckVersion(ctx, a.Binary, versionFlagFor(a.ID))
				cancel()
				if err == nil && ver != "" {
					row.Version = ver
				}
			}
		} else {
			// Still report auth when we know the paths (user may have creds
			// without the binary on PATH, e.g. after uninstall).
			status, detail := CheckAuth(a.ID)
			row.AuthStatus = status
			row.AuthDetail = detail
		}
		out = append(out, row)
	}
	return out
}

// ManagementCache is a short-lived cache for management probes (subprocess-heavy).
type ManagementCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	at      time.Time
	key     string
	results []ManagementInfo
}

// NewManagementCache returns a management probe cache (default 30s TTL).
func NewManagementCache(ttl time.Duration) *ManagementCache {
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &ManagementCache{ttl: ttl}
}

// Get returns cached or fresh management rows for agents.
// key should identify the agent set (e.g. joined ids + installed flags).
func (c *ManagementCache) Get(key string, agents []Info) []ManagementInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.results != nil && c.key == key && time.Since(c.at) < c.ttl {
		return cloneManagement(c.results)
	}
	c.results = ScanManagement(agents)
	c.key = key
	c.at = time.Now()
	return cloneManagement(c.results)
}

// Invalidate drops the cache so the next Get re-probes.
func (c *ManagementCache) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.results = nil
	c.key = ""
	c.at = time.Time{}
}

func cloneManagement(in []ManagementInfo) []ManagementInfo {
	out := make([]ManagementInfo, len(in))
	copy(out, in)
	return out
}

// ManagementCacheKey builds a stable cache key from agent install state.
func ManagementCacheKey(agents []Info) string {
	var b strings.Builder
	for i, a := range agents {
		if i > 0 {
			b.WriteByte('|')
		}
		b.WriteString(a.ID)
		b.WriteByte(':')
		if a.Installed {
			b.WriteByte('1')
		} else {
			b.WriteByte('0')
		}
		b.WriteByte(':')
		b.WriteString(a.Binary)
	}
	return b.String()
}
