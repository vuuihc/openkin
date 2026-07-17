package terminal

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	DefaultCols = 80
	DefaultRows = 24
)

type Profile struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Executable string   `json:"executable"`
	Args       []string `json:"-"`
	Default    bool     `json:"default"`
}

type profileDeps struct {
	getenv   func(string) string
	lookPath func(string) (string, error)
	stat     func(string) (fs.FileInfo, error)
}

func DetectProfiles() []Profile {
	return detectProfiles(profileDeps{
		getenv:   os.Getenv,
		lookPath: exec.LookPath,
		stat:     os.Stat,
	})
}

func detectProfiles(deps profileDeps) []Profile {
	loginShell := deps.getenv("SHELL")
	if filepath.IsAbs(loginShell) {
		loginShell = filepath.Clean(loginShell)
	} else {
		loginShell = ""
	}

	paths := make([]string, 0, 4)
	if loginShell != "" {
		paths = append(paths, loginShell)
	}
	for _, name := range []string{"zsh", "bash", "fish"} {
		path, err := deps.lookPath(name)
		if err == nil {
			paths = append(paths, path)
		}
	}

	profiles := make([]Profile, 0, len(paths))
	seenPaths := make(map[string]struct{}, len(paths))
	for _, discoveredPath := range paths {
		if !filepath.IsAbs(discoveredPath) {
			continue
		}
		path := filepath.Clean(discoveredPath)
		if _, exists := seenPaths[path]; exists {
			continue
		}
		info, err := deps.stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		seenPaths[path] = struct{}{}

		name := strings.TrimSpace(strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)))
		id := knownProfileID(name)
		args := []string(nil)
		if id != "login" {
			args = []string{"-l"}
		}
		profiles = append(profiles, Profile{
			ID:         id,
			Name:       name,
			Executable: path,
			Args:       args,
			Default:    path == loginShell,
		})
	}

	if len(profiles) == 0 {
		return []Profile{}
	}
	if loginShell == "" || !hasDefaultProfile(profiles) {
		profiles[0].Default = true
	}
	sort.SliceStable(profiles, func(i, j int) bool {
		if profiles[i].Default != profiles[j].Default {
			return profiles[i].Default
		}
		return strings.ToLower(profiles[i].Name) < strings.ToLower(profiles[j].Name)
	})
	resolveProfileIDCollisions(profiles)
	return profiles
}

func resolveProfileIDCollisions(profiles []Profile) {
	counts := make(map[string]int, len(profiles))
	for i := range profiles {
		base := profiles[i].ID
		counts[base]++
		if counts[base] > 1 {
			profiles[i].ID = base + "-" + strconv.Itoa(counts[base])
		}
	}
}

func hasDefaultProfile(profiles []Profile) bool {
	for _, profile := range profiles {
		if profile.Default {
			return true
		}
	}
	return false
}

func knownProfileID(name string) string {
	switch strings.ToLower(name) {
	case "zsh", "bash", "fish":
		return strings.ToLower(name)
	default:
		return "login"
	}
}

func DefaultProfileID(profiles []Profile) string {
	for _, profile := range profiles {
		if profile.Default {
			return profile.ID
		}
	}
	return ""
}
