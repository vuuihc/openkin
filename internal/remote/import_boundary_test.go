package remote_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestTailscaleImportBoundary enforces spec §7.1: tailscale.com/* imports are
// allowed only under internal/remote/tsnet/.
//
// Wired into CI via `go test ./...` (see .github/workflows/ci.yml).
func TestTailscaleImportBoundary(t *testing.T) {
	// Walk from module root (two levels up from this package when tests run
	// with the module as cwd — use go.mod discovery).
	root, err := findModuleRoot()
	if err != nil {
		t.Fatalf("module root: %v", err)
	}

	// Match import paths that start with tailscale.com
	importRe := regexp.MustCompile(`^\s*"(tailscale\.com[^"]*)"`)
	// Also multi-line import blocks handled by scanning each line.

	var violations []string
	err = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			base := info.Name()
			// Skip vendor, node_modules, .git, UI, web dist, testdata.
			switch base {
			case ".git", "node_modules", "vendor", "web", "ui", "testdata":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		// Allowed: anything under internal/remote/tsnet/
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(rel, "internal/remote/tsnet/") {
			return nil
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		inImport := false
		for i, line := range strings.Split(string(data), "\n") {
			trim := strings.TrimSpace(line)
			if strings.HasPrefix(trim, "import (") {
				inImport = true
				continue
			}
			if inImport && trim == ")" {
				inImport = false
				continue
			}
			// Single-line import "…"
			if strings.HasPrefix(trim, "import ") {
				if m := importRe.FindStringSubmatch(trim); m != nil {
					violations = append(violations, formatViolation(rel, i+1, m[1]))
				}
				// import ( on same scan handled above
				if strings.Contains(trim, `import "tailscale.com`) {
					// covered by regex if quoted properly
				}
				continue
			}
			if inImport {
				if m := importRe.FindStringSubmatch(line); m != nil {
					violations = append(violations, formatViolation(rel, i+1, m[1]))
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(violations) > 0 {
		t.Fatalf("tailscale.com import boundary violated (only internal/remote/tsnet/ may import it):\n  %s",
			strings.Join(violations, "\n  "))
	}
}

func formatViolation(rel string, line int, imp string) string {
	return rel + ":" + itoa(line) + `: import "` + imp + `"`
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [16]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func findModuleRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	dir := wd
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", os.ErrNotExist
		}
		dir = parent
	}
}
