package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// Manager owns workspace probe/prepare operations under a Kin state directory.
type Manager struct {
	stateDir string
	gitPath  string
	git      gitRunner
	now      func() time.Time

	generationLocks [64]sync.Mutex
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

// LockGeneration serializes filesystem edits and lifecycle operations for one
// workspace root. Callers must invoke the returned unlock function.
func (m *Manager) LockGeneration(meta Metadata) func() {
	if m == nil {
		return func() {}
	}
	key := filepath.Clean(meta.Root)
	hash := uint32(2166136261)
	for i := 0; i < len(key); i++ {
		hash ^= uint32(key[i])
		hash *= 16777619
	}
	lock := &m.generationLocks[hash%uint32(len(m.generationLocks))]
	lock.Lock()
	return lock.Unlock
}
