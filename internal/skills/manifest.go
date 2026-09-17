package skills

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	maxManifestBytes    = 256 * 1024
	maxInstructionBytes = 128 * 1024
)

var (
	nameRE    = regexp.MustCompile(`^[a-z][a-z0-9-]{1,63}$`)
	versionRE = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$`)
)

var allowedPermissions = map[string]bool{
	"read_files":    true,
	"write_files":   true,
	"run_commands":  true,
	"network":       true,
	"browser":       true,
	"secrets":       true,
	"send_messages": true,
}

// LoadPackage reads and validates one directory containing SKILL.md.
func LoadPackage(root string, scope Scope) (Manifest, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return Manifest{}, fmt.Errorf("resolve skill root: %w", err)
	}
	info, err := os.Stat(root)
	if err != nil {
		return Manifest{}, fmt.Errorf("stat skill root: %w", err)
	}
	if !info.IsDir() {
		return Manifest{}, fmt.Errorf("%w: skill root is not a directory", ErrInvalidManifest)
	}
	path := filepath.Join(root, "SKILL.md")
	data, err := os.ReadFile(path)
	if err != nil {
		return Manifest{}, fmt.Errorf("read SKILL.md: %w", err)
	}
	if len(data) > maxManifestBytes {
		return Manifest{}, fmt.Errorf("%w: SKILL.md exceeds %d bytes", ErrUnsafePackage, maxManifestBytes)
	}
	manifest, err := parseSkillMarkdown(string(data))
	if err != nil {
		return Manifest{}, fmt.Errorf("%w: %w", ErrInvalidManifest, err)
	}
	manifest.Root = root
	manifest.Scope = scope
	manifest.Source = root
	manifest.LoadedAt = time.Now().UTC()
	if err := validatePackage(manifest); err != nil {
		return Manifest{}, err
	}
	if err := validatePackageTree(root); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func parseSkillMarkdown(raw string) (Manifest, error) {
	var m Manifest
	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	if len(lines) < 3 || strings.TrimSpace(lines[0]) != "---" {
		return m, errors.New("SKILL.md must start with YAML-style front matter")
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		return m, errors.New("front matter is not terminated")
	}
	values := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(strings.Join(lines[1:end], "\n")))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			return m, fmt.Errorf("invalid front matter line %q", line)
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if key == "" || value == "" {
			return m, fmt.Errorf("empty metadata field in %q", line)
		}
		values[key] = value
	}
	if err := scanner.Err(); err != nil {
		return m, err
	}
	m.Name = values["name"]
	m.Version = values["version"]
	m.Description = values["description"]
	m.SupportedAgents = splitList(values["supported_agents"])
	m.Permissions = splitList(values["permissions"])
	m.NetworkDomains = splitList(values["network_domains"])
	instructions := strings.TrimSpace(strings.Join(lines[end+1:], "\n"))
	if len(instructions) > maxInstructionBytes {
		return m, fmt.Errorf("instructions exceed %d bytes", maxInstructionBytes)
	}
	m.Instructions = instructions
	return m, nil
}

func splitList(value string) []string {
	value = strings.TrimSpace(value)
	value = strings.Trim(value, "[]")
	parts := strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == ';' })
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.Trim(strings.TrimSpace(part), `"'`)
		if part != "" {
			out = append(out, part)
		}
	}
	sort.Strings(out)
	return out
}

func validatePackage(m Manifest) error {
	if !nameRE.MatchString(m.Name) {
		return fmt.Errorf("%w: name must match %s", ErrInvalidManifest, nameRE.String())
	}
	if !versionRE.MatchString(m.Version) {
		return fmt.Errorf("%w: version must be semantic x.y.z", ErrInvalidManifest)
	}
	if m.Instructions == "" {
		return fmt.Errorf("%w: instructions are required", ErrInvalidManifest)
	}
	seen := map[string]bool{}
	for _, permission := range m.Permissions {
		if !allowedPermissions[permission] {
			return fmt.Errorf("%w: permission %q is not allowed", ErrInvalidManifest, permission)
		}
		if seen[permission] {
			return fmt.Errorf("%w: duplicate permission %q", ErrInvalidManifest, permission)
		}
		seen[permission] = true
	}
	for _, domain := range m.NetworkDomains {
		if !validDomain(domain) {
			return fmt.Errorf("%w: invalid network domain %q", ErrInvalidManifest, domain)
		}
	}
	if len(m.NetworkDomains) > 0 && !seen["network"] {
		return fmt.Errorf("%w: network_domains requires network permission", ErrInvalidManifest)
	}
	return nil
}

func validDomain(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsAny(raw, "/?#") {
		return false
	}
	u, err := url.Parse("https://" + raw)
	if err != nil || u.Host != raw || u.Hostname() == "" {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if net.ParseIP(host) != nil {
		return false
	}
	return strings.Contains(host, ".") && !strings.Contains(host, "..")
}

func validatePackageTree(root string) error {
	return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
			return fmt.Errorf("%w: path escapes package", ErrUnsafePackage)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := filepath.EvalSymlinks(path)
			if err != nil {
				return fmt.Errorf("%w: resolve symlink: %v", ErrUnsafePackage, err)
			}
			if !within(root, target) {
				return fmt.Errorf("%w: symlink %q escapes package", ErrUnsafePackage, rel)
			}
		}
		if info.Mode().Perm()&0o002 != 0 {
			return fmt.Errorf("%w: world-writable file %q", ErrUnsafePackage, rel)
		}
		return nil
	})
}

func within(root, path string) bool {
	root, _ = filepath.Abs(root)
	path, _ = filepath.Abs(path)
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
