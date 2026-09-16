package store

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

var excludedExportTables = map[string]bool{
	"device_credentials": true,
	"pairing_sessions":   true,
	"sqlite_sequence":    true,
}

// ExportDirectory writes a consistent, secret-free database snapshot as JSONL
// files below dir. Files are copied by the caller so the store remains
// independent of daemon layout.
func (s *Store) ExportDirectory(ctx context.Context, dir string) error {
	if s == nil || s.db == nil {
		return errors.New("store is closed")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create export directory: %w", err)
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return fmt.Errorf("begin export snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, `
		SELECT name FROM sqlite_master
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		return fmt.Errorf("list export tables: %w", err)
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			_ = rows.Close()
			return err
		}
		if !excludedExportTables[name] {
			tables = append(tables, name)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, table := range tables {
		if table == "settings" {
			if err := exportSettings(ctx, tx, filepath.Join(dir, "settings.json")); err != nil {
				return err
			}
			continue
		}
		if err := exportTable(ctx, tx, table, filepath.Join(dir, table+".jsonl")); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit export snapshot: %w", err)
	}
	return nil
}

func exportSettings(ctx context.Context, tx *sql.Tx, path string) error {
	rows, err := tx.QueryContext(ctx, `SELECT key, value FROM settings ORDER BY key`)
	if err != nil {
		return fmt.Errorf("read settings export: %w", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return err
		}
		if secretSettingKey(key) {
			continue
		}
		out[key] = value
	}
	if err := rows.Err(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o600)
}

func secretSettingKey(key string) bool {
	key = strings.ToLower(key)
	return strings.Contains(key, "token") ||
		strings.Contains(key, "secret") ||
		strings.Contains(key, "password") ||
		strings.Contains(key, "api_key") ||
		key == "providers"
}

func exportTable(ctx context.Context, tx *sql.Tx, table, path string) error {
	if strings.ContainsAny(table, `"' ;`) {
		return fmt.Errorf("unsafe export table name %q", table)
	}
	rows, err := tx.QueryContext(ctx, `SELECT * FROM "`+table+`"`)
	if err != nil {
		return fmt.Errorf("read %s export: %w", table, err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create %s export: %w", table, err)
	}
	defer file.Close()
	writer := bufio.NewWriter(file)
	for rows.Next() {
		values := make([]any, len(columns))
		dest := make([]any, len(columns))
		for i := range values {
			dest[i] = &values[i]
		}
		if err := rows.Scan(dest...); err != nil {
			return err
		}
		record := make(map[string]any, len(columns))
		for i, value := range values {
			if bytes, ok := value.([]byte); ok {
				value = string(bytes)
			}
			record[columns[i]] = value
		}
		data, err := json.Marshal(record)
		if err != nil {
			return err
		}
		if _, err := writer.Write(append(data, '\n')); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	return file.Sync()
}

// CopyOwnedTree copies regular files below root while rejecting symlinks and
// paths that escape the root. It is used by the CLI export boundary.
func CopyOwnedTree(root, destination string, maxBytes int64) error {
	if strings.TrimSpace(root) == "" {
		return nil
	}
	info, err := os.Stat(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("export root is not a directory: %s", root)
	}
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(root, path)
		if err != nil || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
			return fmt.Errorf("export path escapes root")
		}
		target := filepath.Join(destination, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing symlink in export: %s", rel)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Size() > maxBytes {
			return fmt.Errorf("export file exceeds limit: %s", rel)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		src, err := os.Open(path)
		if err != nil {
			return err
		}
		defer src.Close()
		dst, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(dst, io.LimitReader(src, maxBytes+1))
		closeErr := dst.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}
