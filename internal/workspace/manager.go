package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// Manager owns workspace probe/prepare operations under a Kin state directory.
type Manager struct {
	stateDir string
	gitPath  string
	git      gitRunner
	now      func() time.Time
}

// NewManager resolves git once and returns a Manager rooted at stateDir
// (typically ~/.kin). Worktrees live under stateDir/worktrees/<task-id>.
func NewManager(stateDir string) *Manager {
	stateDir = filepath.Clean(stateDir)
	if resolved, err := filepath.EvalSymlinks(stateDir); err == nil {
		stateDir = resolved
	} else if abs, err := filepath.Abs(stateDir); err == nil {
		stateDir = abs
		_ = os.MkdirAll(stateDir, 0o700)
		if resolved, err := filepath.EvalSymlinks(stateDir); err == nil {
			stateDir = resolved
		}
	}
	path, err := exec.LookPath("git")
	if err != nil {
		path = ""
	}
	return &Manager{
		stateDir: stateDir,
		gitPath:  path,
		git:      execGit{Path: path},
		now:      time.Now,
	}
}
