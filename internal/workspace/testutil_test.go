package workspace

import (
	"path/filepath"
	"testing"
)

func samePath(t *testing.T, a, b string) bool {
	t.Helper()
	ra, err := filepath.EvalSymlinks(filepath.Clean(a))
	if err != nil {
		ra = filepath.Clean(a)
	}
	rb, err := filepath.EvalSymlinks(filepath.Clean(b))
	if err != nil {
		rb = filepath.Clean(b)
	}
	return ra == rb
}
