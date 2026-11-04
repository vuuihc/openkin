package server

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// fileSHA256 is the digest the manifest stores; it matches the export
// package's own hashing so one verifier serves both.
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

// RunHubBackup implements `kin hub backup --output PATH.zip` (G17).
//
// The archive is the database snapshot ExportDirectory writes — session text,
// projects, accounts, settings, minus every credential — plus the artifacts
// and project trees. It is written 0600 and verified by reading the manifest
// back before the command reports success: a backup that cannot be opened is
// worse than none, because it looks like safety.
//
// The daemon does not have to be stopped. The snapshot is a read transaction,
// so it is consistent with some moment while the Hub keeps serving; the
// operator runs this on the machine, the same place `kin hub init` runs.
func RunHubBackup(output string) error {
	output = strings.TrimSpace(output)
	if output == "" {
		return fmt.Errorf("pass --output PATH.zip (where the backup is written)")
	}
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(stateDir, "kin.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	tmp, err := os.MkdirTemp("", "kin-backup-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	ctx := context.Background()
	if err := st.ExportDirectory(ctx, tmp); err != nil {
		return fmt.Errorf("snapshot database: %w", err)
	}
	if err := store.CopyOwnedTree(filepath.Join(stateDir, "artifacts"), filepath.Join(tmp, "artifacts"), backupFileLimit); err != nil {
		return fmt.Errorf("copy artifacts: %w", err)
	}
	if err := store.CopyOwnedTree(filepath.Join(stateDir, "projects"), filepath.Join(tmp, "projects"), backupFileLimit); err != nil {
		return fmt.Errorf("copy projects: %w", err)
	}
	if err := writeBackupManifest(tmp); err != nil {
		return err
	}

	if err := zipDirectory(tmp, output); err != nil {
		return fmt.Errorf("write archive: %w", err)
	}
	// Refuse to call it done before the archive opens and its manifest checks
	// out. Nothing here prints a secret: the manifest lists names and hashes.
	if err := verifyBackup(output); err != nil {
		return fmt.Errorf("the archive just written does not verify: %w", err)
	}
	info, err := os.Stat(output)
	if err != nil {
		return err
	}
	fmt.Printf("backup written: %s (%d bytes)\n", output, info.Size())
	fmt.Println("The archive carries no credentials: sessions, one-time sign-in tokens, and")
	fmt.Println("identity secrets are excluded by design. After a restore, sign in again with")
	fmt.Println("`kin hub login-link` or the provider you configured.")
	return nil
}

// RunHubRestore implements `kin hub restore --input PATH.zip --yes`.
//
// It replaces this machine's user data with the archive's. The `--yes` flag is
// the confirmation: there is no undo below this point short of a fresh backup.
// The restore deliberately runs against a closed database and reopens nothing
// — a running daemon holds the old snapshot in memory, so the operator stops
// the Hub first; the message says so rather than silently racing it.
func RunHubRestore(input string, yes bool) error {
	input = strings.TrimSpace(input)
	if input == "" {
		return fmt.Errorf("pass --input PATH.zip (the backup to restore)")
	}
	if !yes {
		return fmt.Errorf("restore replaces this machine's data. Pass --yes to go ahead")
	}
	stateDir, err := remote.StateDir()
	if err != nil {
		return err
	}
	dbPath := filepath.Join(stateDir, "kin.db")

	tmp, err := os.MkdirTemp("", "kin-restore-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if err := unzipDirectory(input, tmp); err != nil {
		return fmt.Errorf("open archive: %w", err)
	}
	if err := verifyRestoredTree(tmp); err != nil {
		return fmt.Errorf("archive does not verify: %w", err)
	}

	// The database this process is about to replace must not be open behind
	// the restore's back. Opening, restoring, and closing in one command is
	// the whole of the safety here; a running Hub has to be stopped first.
	st, err := store.Open(dbPath)
	if err != nil {
		return err
	}
	defer st.Close()

	ctx := context.Background()
	if err := st.RestoreDirectory(ctx, tmp); err != nil {
		return fmt.Errorf("restore database: %w", err)
	}
	// Artifacts and project files: replaced wholesale, so a file deleted since
	// the backup does not survive as a ghost.
	for _, name := range []string{"artifacts", "projects"} {
		src := filepath.Join(tmp, name)
		if _, err := os.Stat(src); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		dst := filepath.Join(stateDir, name)
		if err := os.RemoveAll(dst); err != nil {
			return fmt.Errorf("clear %s: %w", name, err)
		}
		if err := store.CopyOwnedTree(src, dst, backupFileLimit); err != nil {
			return fmt.Errorf("restore %s: %w", name, err)
		}
	}

	fmt.Printf("restored from %s\n", input)
	fmt.Println("Sessions and one-time tokens were never in the archive, so every device is")
	fmt.Println("signed out. Mint a fresh sign-in link with `kin hub login-link --email ADDRESS`.")
	fmt.Println("Start the Hub again to serve the restored data.")
	return nil
}

const backupFileLimit = 64 << 20

// backupManifest is written into the archive and checked on restore. Files
// maps each member's slash path to its SHA-256; the restore refuses a member
// that is missing, extra, or altered.
type backupManifest struct {
	Version   int               `json:"version"`
	CreatedAt int64             `json:"created_at"`
	Files     map[string]string `json:"files"`
}

func writeBackupManifest(tmp string) error {
	manifest := backupManifest{Version: 1, CreatedAt: time.Now().UnixMilli(), Files: map[string]string{}}
	err := filepath.Walk(tmp, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() {
			return walkErr
		}
		rel, err := filepath.Rel(tmp, path)
		if err != nil {
			return err
		}
		if rel == "manifest.json" {
			return nil
		}
		sum, err := fileSHA256(path)
		if err != nil {
			return err
		}
		manifest.Files[filepath.ToSlash(rel)] = sum
		return nil
	})
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(tmp, "manifest.json"), append(data, '\n'), 0o600)
}

// verifyBackup opens the finished archive and checks its manifest, so a
// backup command that ended with a truncated file reports failure instead of
// printing success over an unusable archive.
func verifyBackup(archive string) error {
	tmp, err := os.MkdirTemp("", "kin-verify-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if err := unzipDirectory(archive, tmp); err != nil {
		return err
	}
	return verifyRestoredTree(tmp)
}

func verifyRestoredTree(dir string) error {
	data, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	var manifest backupManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return fmt.Errorf("decode manifest: %w", err)
	}
	if manifest.Version != 1 {
		return fmt.Errorf("manifest version %d is not one this build understands", manifest.Version)
	}
	seen := map[string]bool{}
	err = filepath.Walk(dir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() {
			return walkErr
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		if rel == "manifest.json" {
			return nil
		}
		key := filepath.ToSlash(rel)
		seen[key] = true
		want, ok := manifest.Files[key]
		if !ok {
			return fmt.Errorf("archive carries %s, which the manifest does not list", key)
		}
		sum, err := fileSHA256(path)
		if err != nil {
			return err
		}
		if sum != want {
			return fmt.Errorf("%s does not match its manifest hash", key)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for key := range manifest.Files {
		if !seen[key] {
			return fmt.Errorf("manifest lists %s, which is not in the archive", key)
		}
	}
	return nil
}

func unzipDirectory(archive, destination string) error {
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer reader.Close()

	for _, entry := range reader.File {
		name := entry.Name
		// Zip-slip: an archive is untrusted input, and a member whose path
		// climbs out of the destination is an overwrite, not a restore.
		clean := filepath.Clean("/" + filepath.ToSlash(name))
		target := filepath.Join(destination, filepath.FromSlash(clean))
		if !strings.HasPrefix(target, filepath.Clean(destination)+string(os.PathSeparator)) {
			return fmt.Errorf("archive member %q escapes the restore directory", name)
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		src, err := entry.Open()
		if err != nil {
			return err
		}
		dst, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			src.Close()
			return err
		}
		_, copyErr := io.Copy(dst, io.LimitReader(src, backupFileLimit+1))
		closeErr := dst.Close()
		srcCloseErr := src.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if srcCloseErr != nil {
			return srcCloseErr
		}
	}
	return nil
}
