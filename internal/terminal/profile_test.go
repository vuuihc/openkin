package terminal

import (
	"errors"
	"io/fs"
	"testing"
	"time"
)

type fakeFileInfo struct {
	name string
	mode fs.FileMode
}

func TestDetectProfilesFallsBackToKnownShellOrder(t *testing.T) {
	paths := map[string]string{
		"zsh":  "/usr/local/bin/zsh",
		"bash": "/bin/bash",
		"fish": "/opt/bin/fish",
	}
	profiles := detectProfiles(profileDeps{
		getenv: func(string) string { return "" },
		lookPath: func(name string) (string, error) {
			path, ok := paths[name]
			if !ok {
				return "", errors.New("not found")
			}
			return path, nil
		},
		stat: func(path string) (fs.FileInfo, error) {
			return fakeFileInfo{name: path, mode: 0o755}, nil
		},
	})

	if len(profiles) != 3 {
		t.Fatalf("DetectProfiles() returned %d profiles, want 3", len(profiles))
	}
	if profiles[0].ID != "zsh" || !profiles[0].Default {
		t.Fatalf("DetectProfiles()[0] = %+v, want default zsh", profiles[0])
	}
}

func (f fakeFileInfo) Name() string       { return f.name }
func (f fakeFileInfo) Size() int64        { return 0 }
func (f fakeFileInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeFileInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeFileInfo) Sys() any           { return nil }

func TestDetectProfilesUsesLoginShellAsDefault(t *testing.T) {
	profiles := detectProfiles(profileDeps{
		getenv: func(key string) string {
			if key == "SHELL" {
				return "/bin/zsh"
			}
			return ""
		},
		lookPath: func(string) (string, error) { return "", fs.ErrNotExist },
		stat: func(path string) (fs.FileInfo, error) {
			return fakeFileInfo{name: "zsh", mode: 0o755}, nil
		},
	})

	if len(profiles) != 1 {
		t.Fatalf("DetectProfiles() returned %d profiles, want 1", len(profiles))
	}
	if got := profiles[0]; got.ID != "zsh" || got.Executable != "/bin/zsh" || !got.Default {
		t.Fatalf("DetectProfiles()[0] = %+v, want default zsh profile", got)
	}
}

func TestDetectProfilesDeduplicatesResolvedPaths(t *testing.T) {
	profiles := detectProfiles(profileDeps{
		getenv: func(string) string { return "/bin/zsh" },
		lookPath: func(name string) (string, error) {
			if name == "zsh" {
				return "/bin/zsh", nil
			}
			return "", fs.ErrNotExist
		},
		stat: func(path string) (fs.FileInfo, error) {
			return fakeFileInfo{name: path, mode: 0o755}, nil
		},
	})

	if len(profiles) != 1 {
		t.Fatalf("DetectProfiles() returned %d profiles, want one deduplicated path", len(profiles))
	}
}

func TestDetectProfilesSkipsInvalidCandidates(t *testing.T) {
	tests := []struct {
		name string
		path string
		info fs.FileInfo
		err  error
	}{
		{name: "missing", path: "/bin/zsh", err: fs.ErrNotExist},
		{name: "relative", path: "bin/zsh", info: fakeFileInfo{name: "zsh", mode: 0o755}},
		{name: "directory", path: "/bin/zsh", info: fakeFileInfo{name: "zsh", mode: fs.ModeDir | 0o755}},
		{name: "not executable", path: "/bin/zsh", info: fakeFileInfo{name: "zsh", mode: 0o644}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			profiles := detectProfiles(profileDeps{
				getenv: func(string) string { return "" },
				lookPath: func(name string) (string, error) {
					if name == "zsh" {
						return tt.path, nil
					}
					return "", fs.ErrNotExist
				},
				stat: func(string) (fs.FileInfo, error) { return tt.info, tt.err },
			})
			if len(profiles) != 0 {
				t.Fatalf("DetectProfiles() = %+v, want no profiles", profiles)
			}
		})
	}
}

func TestDetectProfilesIncludesUnknownAbsoluteLoginShell(t *testing.T) {
	profiles := detectProfiles(profileDeps{
		getenv:   func(string) string { return "/opt/acme/bin/nu" },
		lookPath: func(string) (string, error) { return "", fs.ErrNotExist },
		stat: func(path string) (fs.FileInfo, error) {
			return fakeFileInfo{name: path, mode: 0o755}, nil
		},
	})

	if len(profiles) != 1 {
		t.Fatalf("DetectProfiles() returned %d profiles, want 1", len(profiles))
	}
	if got := profiles[0]; got.ID != "login" || got.Name != "nu" || len(got.Args) != 0 || !got.Default {
		t.Fatalf("DetectProfiles()[0] = %+v, want no-arg default login profile", got)
	}
}

func TestDetectProfilesHasOneDefaultAndStableSort(t *testing.T) {
	paths := map[string]string{
		"zsh":  "/shells/zsh",
		"bash": "/shells/bash",
		"fish": "/shells/fish",
	}
	profiles := detectProfiles(profileDeps{
		getenv:   func(string) string { return "/shells/fish" },
		lookPath: func(name string) (string, error) { return paths[name], nil },
		stat: func(path string) (fs.FileInfo, error) {
			return fakeFileInfo{name: path, mode: 0o755}, nil
		},
	})

	if got := []string{profiles[0].Name, profiles[1].Name, profiles[2].Name}; got[0] != "fish" || got[1] != "bash" || got[2] != "zsh" {
		t.Fatalf("profile order = %v, want [fish bash zsh]", got)
	}
	defaults := 0
	for _, profile := range profiles {
		if profile.Default {
			defaults++
		}
	}
	if defaults != 1 {
		t.Fatalf("default profile count = %d, want 1", defaults)
	}
}

func TestDetectProfilesResolvesIDCollisionsDeterministically(t *testing.T) {
	profiles := detectProfiles(profileDeps{
		getenv: func(string) string { return "/login/bash" },
		lookPath: func(name string) (string, error) {
			if name == "bash" {
				return "/path/bash", nil
			}
			return "", fs.ErrNotExist
		},
		stat: func(path string) (fs.FileInfo, error) {
			return fakeFileInfo{name: path, mode: 0o755}, nil
		},
	})

	if len(profiles) != 2 {
		t.Fatalf("DetectProfiles() returned %d profiles, want 2", len(profiles))
	}
	if profiles[0].ID != "bash" || profiles[1].ID != "bash-2" {
		t.Fatalf("profile IDs = [%q %q], want [bash bash-2]", profiles[0].ID, profiles[1].ID)
	}
}
