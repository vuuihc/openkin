package skills

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// Manager discovers and validates Skills from deterministic local roots.
type Manager struct {
	cfg Config
}

func NewManager(cfg Config) *Manager { return &Manager{cfg: cfg} }

// List returns the effective Skill set. Higher-precedence scopes replace lower
// scopes by name; directory order is sorted for deterministic task prompts.
func (m *Manager) List(ctx context.Context, projectRoot, agent string) ([]Manifest, error) {
	if m == nil {
		return nil, fmt.Errorf("skill manager is nil")
	}
	roots := []struct {
		path  string
		scope Scope
	}{
		{m.cfg.BundledDir, ScopeBundled},
		{m.cfg.UserDir, ScopeUser},
		{projectSkillDir(projectRoot, m.cfg.ProjectDir), ScopeProject},
	}
	effective := map[string]Manifest{}
	for _, root := range roots {
		if strings.TrimSpace(root.path) == "" {
			continue
		}
		entries, err := os.ReadDir(root.path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("list %s skills: %w", root.scope, err)
		}
		names := make([]string, 0, len(entries))
		byName := make(map[string]string, len(entries))
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			names = append(names, entry.Name())
			byName[entry.Name()] = filepath.Join(root.path, entry.Name())
		}
		sort.Strings(names)
		for _, name := range names {
			skill, err := LoadPackage(byName[name], root.scope)
			if err != nil {
				return nil, fmt.Errorf("load %s skill %q: %w", root.scope, name, err)
			}
			if !supportsAgent(skill, agent) {
				continue
			}
			effective[skill.Name] = skill
		}
	}
	out := make([]Manifest, 0, len(effective))
	for _, skill := range effective {
		out = append(out, skill)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Context builds the bounded instructions and audit references for a task.
func (m *Manager) Context(ctx context.Context, projectRoot, agent string) (Context, error) {
	skills, err := m.List(ctx, projectRoot, agent)
	if err != nil {
		return Context{}, err
	}
	var b strings.Builder
	refs := make([]Reference, 0, len(skills))
	for _, skill := range skills {
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		fmt.Fprintf(&b, "## Skill %s@%s\n%s", skill.Name, skill.Version, skill.Instructions)
		refs = append(refs, Reference{
			Name: skill.Name, Version: skill.Version, Scope: skill.Scope, Source: skill.Source,
		})
	}
	return Context{Instructions: b.String(), References: refs}, nil
}

// Import copies a local Skill, downloads a single SKILL.md URL, or clones a
// Git repository into Dest. Remote import is always explicit and never part of
// automatic discovery.
func (m *Manager) Import(ctx context.Context, req ImportRequest) (Manifest, error) {
	source := strings.TrimSpace(req.Source)
	dest := strings.TrimSpace(req.Dest)
	if source == "" || dest == "" {
		return Manifest{}, fmt.Errorf("skill import source and destination are required")
	}
	if err := ensureEmptyOrMissingDir(dest); err != nil {
		return Manifest{}, err
	}
	switch {
	case strings.HasPrefix(source, "git+https://") || strings.HasPrefix(source, "https://") && strings.HasSuffix(source, ".git"):
		gitSource := strings.TrimPrefix(source, "git+")
		if err := validateImportURL(gitSource); err != nil {
			return Manifest{}, err
		}
		ip, port, err := resolveImportHost(ctx, gitSource)
		if err != nil {
			return Manifest{}, err
		}
		return m.importGit(ctx, gitSource, dest, ip, port)
	case strings.HasPrefix(source, "https://"):
		return m.importURL(ctx, source, dest)
	case strings.HasPrefix(source, "http://"):
		return Manifest{}, fmt.Errorf("%w: Skill imports require HTTPS", ErrUnsupported)
	default:
		info, err := os.Stat(source)
		if err != nil {
			return Manifest{}, fmt.Errorf("stat import source: %w", err)
		}
		if !info.IsDir() {
			return Manifest{}, fmt.Errorf("%w: local import must be a directory", ErrUnsupported)
		}
		if err := copyPackage(source, dest); err != nil {
			return Manifest{}, err
		}
		return LoadPackage(dest, ScopeProject)
	}
}

func (m *Manager) importURL(ctx context.Context, source, dest string) (Manifest, error) {
	if err := validateImportURL(source); err != nil {
		return Manifest{}, err
	}
	if err := validateImportHost(ctx, source); err != nil {
		return Manifest{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return Manifest{}, fmt.Errorf("create Skill request: %w", err)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = safeSkillDialContext
	transport.Proxy = nil
	client := &http.Client{Transport: transport}
	client.CheckRedirect = func(next *http.Request, _ []*http.Request) error {
		return validateImportURL(next.URL.String())
	}
	resp, err := client.Do(req)
	if err != nil {
		return Manifest{}, fmt.Errorf("download Skill: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Manifest{}, fmt.Errorf("download Skill: unexpected status %s", resp.Status)
	}
	data, err := ioReadBounded(resp.Body, maxManifestBytes)
	if err != nil {
		return Manifest{}, err
	}
	if err := os.MkdirAll(dest, 0o700); err != nil {
		return Manifest{}, fmt.Errorf("create import directory: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dest, "SKILL.md"), data, 0o600); err != nil {
		return Manifest{}, fmt.Errorf("write imported SKILL.md: %w", err)
	}
	return LoadPackage(dest, ScopeProject)
}

func (m *Manager) importGit(ctx context.Context, source, dest, resolvedIP, port string) (Manifest, error) {
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return Manifest{}, fmt.Errorf("create git import parent: %w", err)
	}
	parsed, _ := url.Parse(source)
	curlResolve := parsed.Hostname() + ":" + port + ":" + resolvedIP
	cmd := exec.CommandContext(ctx, "git", "-c", "http.proxy=", "-c", "https.proxy=",
		"-c", "http.followRedirects=false", "-c", "http.curloptResolve="+curlResolve,
		"clone", "--depth", "1", "--", source, dest)
	cmd.Env = append(withoutProxyEnv(os.Environ()),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		return Manifest{}, fmt.Errorf("clone Skill repository: %s", strings.TrimSpace(string(output)))
	}
	return LoadPackage(dest, ScopeProject)
}

func validateImportURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
		return fmt.Errorf("%w: Skill import URL must be public HTTPS", ErrUnsupported)
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return fmt.Errorf("%w: Skill import URL targets localhost", ErrUnsafePackage)
	}
	if ip := net.ParseIP(host); ip != nil && !isPublicSkillIP(ip) {
		return fmt.Errorf("%w: Skill import URL targets a private address", ErrUnsafePackage)
	}
	return nil
}

func validateImportHost(ctx context.Context, raw string) error {
	_, _, err := resolveImportHost(ctx, raw)
	return err
}

func resolveImportHost(ctx context.Context, raw string) (string, string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" {
		return "", "", fmt.Errorf("%w: invalid Skill import URL", ErrUnsupported)
	}
	port := parsed.Port()
	if port == "" {
		port = "443"
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, parsed.Hostname())
	if err != nil {
		return "", "", fmt.Errorf("%w: resolve Skill import host: %v", ErrUnsafePackage, err)
	}
	for _, resolved := range ips {
		if isPublicSkillIP(resolved.IP) {
			return resolved.IP.String(), port, nil
		}
	}
	return "", "", fmt.Errorf("%w: Skill import host resolves only to private addresses", ErrUnsafePackage)
}

func withoutProxyEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToLower(key) {
		case "http_proxy", "https_proxy", "all_proxy", "no_proxy":
			continue
		default:
			out = append(out, entry)
		}
	}
	return out
}

func safeSkillDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{}
	for _, resolved := range ips {
		if !isPublicSkillIP(resolved.IP) {
			continue
		}
		if conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(resolved.IP.String(), port)); dialErr == nil {
			return conn, nil
		}
	}
	return nil, fmt.Errorf("%w: Skill import host resolves only to private addresses", ErrUnsafePackage)
}

func isPublicSkillIP(ip net.IP) bool {
	return !ip.IsLoopback() &&
		!ip.IsPrivate() &&
		!ip.IsLinkLocalUnicast() &&
		!ip.IsLinkLocalMulticast() &&
		!ip.IsUnspecified() &&
		!ip.IsMulticast()
}

func ensureEmptyOrMissingDir(path string) error {
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("stat import destination: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("import destination is not a directory")
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return fmt.Errorf("inspect import destination: %w", err)
	}
	if len(entries) > 0 {
		return fmt.Errorf("import destination must be empty")
	}
	return nil
}

func projectSkillDir(projectRoot, configured string) string {
	if strings.TrimSpace(projectRoot) != "" {
		root, err := filepath.Abs(projectRoot)
		if err == nil {
			if info, statErr := os.Stat(root); statErr == nil && !info.IsDir() {
				root = filepath.Dir(root)
			}
			for {
				candidate := filepath.Join(root, ".kin", "skills")
				if _, statErr := os.Stat(candidate); statErr == nil {
					return candidate
				}
				if _, statErr := os.Stat(filepath.Join(root, ".git")); statErr == nil {
					return candidate
				}
				parent := filepath.Dir(root)
				if parent == root {
					break
				}
				root = parent
			}
		}
		return filepath.Join(projectRoot, ".kin", "skills")
	}
	return configured
}

func supportsAgent(skill Manifest, agent string) bool {
	if len(skill.SupportedAgents) == 0 || strings.TrimSpace(agent) == "" {
		return true
	}
	for _, supported := range skill.SupportedAgents {
		if strings.EqualFold(strings.TrimSpace(supported), strings.TrimSpace(agent)) {
			return true
		}
	}
	return false
}
