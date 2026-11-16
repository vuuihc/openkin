// Package secret provides a narrow credential store boundary.
package secret

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Store stores provider credentials by opaque reference.
type Store interface {
	Get(ref string) (string, error)
	Put(ref, value string) error
	Delete(ref string) error
}

// FileStore is the Linux/headless fallback. Its directory and files are
// owner-only; macOS production builds can replace this boundary with Keychain.
type FileStore struct {
	dir string
	mu  sync.Mutex
}

// NewFileStore creates a mode-0700 credential directory.
func NewFileStore(dir string) (*FileStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create secret directory: %w", err)
	}
	return &FileStore{dir: dir}, nil
}

// NewDefaultStore selects the platform credential backend.
func NewDefaultStore(dir string) (Store, error) {
	return newPlatformStore(dir)
}

func (s *FileStore) path(ref string) (string, error) {
	if !validReference(ref) {
		return "", errors.New("invalid secret reference")
	}
	return filepath.Join(s.dir, ref), nil
}

func validReference(ref string) bool {
	return ref != "" && filepath.Base(ref) == ref && filepath.Ext(ref) == ""
}

// Get reads a credential without exposing its path to callers.
func (s *FileStore) Get(ref string) (string, error) {
	path, err := s.path(ref)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// Put atomically writes a credential with mode 0600.
func (s *FileStore) Put(ref, value string) error {
	path, err := s.path(ref)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(value), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Delete removes a credential reference.
func (s *FileStore) Delete(ref string) error {
	path, err := s.path(ref)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// NewReference returns an opaque provider secret reference.
func NewReference() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "secret-" + hex.EncodeToString(raw), nil
}
