package store

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// RestoreDirectory is the write half of ExportDirectory (G17): it reads the
// JSONL snapshot the export wrote and replaces this database's user data with
// it, inside one transaction, so a half-restored database cannot exist.
//
// The excluded tables are skipped by design. An export carries no credentials
// — that is what makes carrying one safe — so a restore cannot reconstruct
// logins: sessions, one-time tokens, and identity secrets simply do not exist
// in the file. Devices re-pair, browsers sign in again through the account's
// normal paths, and the owner's email travels in `users`, so claiming a
// restored Hub needs nothing but a sign-in link (`kin hub login-link`).
//
// Restore-time data is untrusted input like any other: table and column names
// come from this package's own snapshot format but every value is bound, and
// rows that no longer match the live schema are an error rather than a silent
// partial restore — the schema only ever moves forward, so an export written
// by a newer build is refused up front by the version check in the caller.
func (s *Store) RestoreDirectory(ctx context.Context, dir string) error {
	if s == nil || s.db == nil {
		return errors.New("store is closed")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read restore directory: %w", err)
	}
	var tables []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		table := strings.TrimSuffix(name, ".jsonl")
		if excludedExportTables[table] {
			// The export never writes these; one appearing means the package
			// was tampered with or assembled by hand. Refuse, do not skip.
			return fmt.Errorf("restore archive carries excluded table %q", table)
		}
		tables = append(tables, table)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin restore: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Snapshot tables declare foreign keys to each other (users ← devices ←
	// tasks ← messages…), and enforcement is on, so rows must land in
	// dependency order. The order is read from the live schema rather than
	// written down here: a table added later joins the sort instead of
	// breaking every future restore.
	ordered, err := orderRestoreTables(ctx, tx, tables)
	if err != nil {
		return err
	}

	// "Replace" means replace: rows the live database gained since the backup
	// would otherwise collide with restored keys (or worse, survive as ghosts
	// the accounts they belong to no longer explain). The deletes run in
	// reverse dependency order inside the same transaction, so the snapshot
	// and nothing else is what remains.
	for i := len(ordered) - 1; i >= 0; i-- {
		if _, err := tx.ExecContext(ctx, `DELETE FROM "`+ordered[i]+`"`); err != nil {
			return fmt.Errorf("clear %s for restore: %w", ordered[i], err)
		}
	}
	for _, table := range ordered {
		if table == "settings" {
			// settings.json is the export's one JSON file, not JSONL; it is
			// restored last, after the rows that reference it could exist.
			continue
		}
		if err := restoreTable(ctx, tx, table, filepath.Join(dir, table+".jsonl")); err != nil {
			return err
		}
	}
	settingsPath := filepath.Join(dir, "settings.json")
	if _, err := os.Stat(settingsPath); err == nil {
		if err := restoreSettings(ctx, tx, settingsPath); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read settings export: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit restore: %w", err)
	}
	return nil
}

// orderRestoreTables topologically sorts the snapshot tables over the live
// schema's foreign keys, so every row lands after the rows it references.
// Only tables present in the snapshot are returned; a dependency outside the
// snapshot is not a constraint, because the export and restore always carry
// the same set.
func orderRestoreTables(ctx context.Context, tx *sql.Tx, tables []string) ([]string, error) {
	set := make(map[string]bool, len(tables))
	for _, t := range tables {
		set[t] = true
	}
	refs := make(map[string][]string, len(tables))
	for _, table := range tables {
		rows, err := tx.QueryContext(ctx, `PRAGMA foreign_key_list("`+table+`")`)
		if err != nil {
			return nil, fmt.Errorf("read foreign keys of %s: %w", table, err)
		}
		for rows.Next() {
			var id, seq int
			var refTable, from, to string
			var onUpdate, onDelete, match string
			if err := rows.Scan(&id, &seq, &refTable, &from, &to, &onUpdate, &onDelete, &match); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan foreign keys of %s: %w", table, err)
			}
			if set[refTable] && refTable != table {
				refs[table] = append(refs[table], refTable)
			}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("list foreign keys of %s: %w", table, err)
		}
		_ = rows.Close()
	}

	// Depth-first post-order: dependencies first, then the table. Alphabetical
	// tie-break keeps the order stable across runs.
	visited := make(map[string]int, len(tables))
	var ordered []string
	var visit func(table string) error
	visit = func(table string) error {
		switch visited[table] {
		case 2:
			return nil
		case 1:
			return fmt.Errorf("restore tables form a cycle at %s", table)
		}
		visited[table] = 1
		deps := append([]string(nil), refs[table]...)
		sort.Strings(deps)
		for _, dep := range deps {
			if err := visit(dep); err != nil {
				return err
			}
		}
		visited[table] = 2
		ordered = append(ordered, table)
		return nil
	}
	sorted := append([]string(nil), tables...)
	sort.Strings(sorted)
	for _, table := range sorted {
		if err := visit(table); err != nil {
			return nil, err
		}
	}
	return ordered, nil
}

func restoreTable(ctx context.Context, tx *sql.Tx, table, path string) error {
	if !safeRestoreName(table) {
		return fmt.Errorf("unsafe restore table name %q", table)
	}
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s restore: %w", table, err)
	}
	defer file.Close()

	var columns []string
	var insert *sql.Stmt
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			return fmt.Errorf("decode %s restore row: %w", table, err)
		}
		if columns == nil {
			columns = make([]string, 0, len(record))
			for column := range record {
				if !safeRestoreName(column) {
					return fmt.Errorf("unsafe restore column name %q in %s", column, table)
				}
				columns = append(columns, column)
			}
			sort.Slice(columns, func(i, j int) bool { return columns[i] < columns[j] })
			insert, err = tx.PrepareContext(ctx,
				`INSERT INTO "`+table+`" (`+quotedColumnList(columns)+`) VALUES (`+placeholders(len(columns))+`)`)
			if err != nil {
				return fmt.Errorf("prepare %s restore: %w", table, err)
			}
			defer insert.Close()
		}
		args := make([]any, len(columns))
		for i, column := range columns {
			value, ok := record[column]
			if !ok {
				return fmt.Errorf("restore %s: row is missing column %q", table, column)
			}
			args[i] = value
		}
		if _, err := insert.ExecContext(ctx, args...); err != nil {
			return fmt.Errorf("restore %s row: %w", table, err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read %s restore: %w", table, err)
	}
	return nil
}

func restoreSettings(ctx context.Context, tx *sql.Tx, path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read settings restore: %w", err)
	}
	var out map[string]string
	if err := json.Unmarshal(data, &out); err != nil {
		return fmt.Errorf("decode settings restore: %w", err)
	}
	for key, value := range out {
		if secretSettingKey(key) {
			continue
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO settings (key, value) VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value); err != nil {
			return fmt.Errorf("restore setting %s: %w", key, err)
		}
	}
	return nil
}

// safeRestoreName is the identifier allowlist for names that reach SQL. A
// snapshot's table and column names are written by this package, but the file
// being restored is untrusted input at the moment it is read.
func safeRestoreName(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
		default:
			return false
		}
	}
	return true
}

func quotedColumnList(columns []string) string {
	parts := make([]string, len(columns))
	for i, c := range columns {
		parts[i] = `"` + c + `"`
	}
	return strings.Join(parts, ", ")
}
