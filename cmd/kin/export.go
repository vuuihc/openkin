package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

type exportManifest struct {
	Version   int               `json:"version"`
	CreatedAt int64             `json:"created_at"`
	Files     map[string]string `json:"files"`
}

func runExport(args []string) error {
	if len(args) != 2 || args[0] != "--output" || strings.TrimSpace(args[1]) == "" {
		return fmt.Errorf("usage: kin export --output <path.zip>")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	stateDir := filepath.Join(home, ".kin")
	st, err := store.Open(filepath.Join(stateDir, "kin.db"))
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer st.Close()

	tmp, err := os.MkdirTemp("", "kin-export-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if err := st.ExportDirectory(nilContext{}, tmp); err != nil {
		return err
	}
	if err := store.CopyOwnedTree(filepath.Join(stateDir, "artifacts"), filepath.Join(tmp, "artifacts"), 64<<20); err != nil {
		return fmt.Errorf("copy artifacts: %w", err)
	}
	if err := store.CopyOwnedTree(filepath.Join(stateDir, "projects"), filepath.Join(tmp, "projects"), 64<<20); err != nil {
		return fmt.Errorf("copy projects: %w", err)
	}

	manifest := exportManifest{Version: 1, CreatedAt: time.Now().UnixMilli(), Files: map[string]string{}}
	if err := filepath.Walk(tmp, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() {
			return walkErr
		}
		rel, err := filepath.Rel(tmp, path)
		if err != nil {
			return err
		}
		sum, err := fileSHA256(path)
		if err != nil {
			return err
		}
		manifest.Files[filepath.ToSlash(rel)] = sum
		return nil
	}); err != nil {
		return err
	}
	manifestData, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(tmp, "manifest.json"), append(manifestData, '\n'), 0o600); err != nil {
		return err
	}
	return zipDirectory(tmp, args[1])
}

// nilContext is sufficient for the bounded local export; Store accepts a
// context so callers can add cancellation without changing the file format.
type nilContext struct{}

func (nilContext) Deadline() (time.Time, bool) { return time.Time{}, false }
func (nilContext) Done() <-chan struct{}       { return nil }
func (nilContext) Err() error                  { return nil }
func (nilContext) Value(any) any               { return nil }

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func zipDirectory(root, output string) error {
	if err := os.MkdirAll(filepath.Dir(output), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(output, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	archive := zip.NewWriter(file)
	err = filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() {
			return walkErr
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		entry, err := archive.Create(filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		src, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(entry, src)
		closeErr := src.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
	if closeErr := archive.Close(); err == nil {
		err = closeErr
	}
	return err
}
