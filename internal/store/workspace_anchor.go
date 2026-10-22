package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"
)

// Workspace anchors are the portable half of a task's working directory.
//
// A cwd is an address on one machine. Two machines usually hold a checkout of
// the same repository at the same path, which is why a path that looks right
// can point at the wrong copy — the failure mode M2.2 closed four doors on.
// An anchor replaces the address with an identity: which repository, and where
// inside it. Each device then says where that identity lives locally, and a
// dispatch asks the *executing* device's answer instead of trusting a string
// that was typed while looking at another machine.
const (
	// AnchorGitRemote is a checkout of a repository, identified by its origin
	// remote. It can resolve on any device that has a checkout of the same
	// repository.
	AnchorGitRemote = "git_remote"
	// AnchorDevicePath is a directory that is only itself. It resolves on the
	// device that declared it and nowhere else — which is the honest answer for
	// a directory that is not a repository, and the reason resolution on another
	// device fails instead of quietly using a same-named directory.
	AnchorDevicePath = "device_path"

	// AnchorRepoRoot is the relative path of a checkout itself.
	AnchorRepoRoot = "."

	// MaxAnchorRemoteURL and MaxAnchorPath bound what a device may report.
	MaxAnchorRemoteURL = 2048
	MaxAnchorPath      = 4096
)

// ErrAnchorNotFound means no such anchor.
var ErrAnchorNotFound = errors.New("workspace anchor not found")

// WorkspaceAnchor is one workspace identity.
type WorkspaceAnchor struct {
	ID           string
	ProjectID    string
	Kind         string
	RemoteURL    string
	RelativePath string
	CreatedAt    int64
	UpdatedAt    int64
}

// AnchorRoot is where one anchor lives on one device.
//
// AbsPath is the *checkout* root, not the workspace itself: the workspace is
// RelativePath inside it, so one checkout serves an anchor for the repository
// root and one for every subdirectory of it.
type AnchorRoot struct {
	AnchorID   string
	DeviceID   string
	AbsPath    string
	VerifiedAt *int64
}

// DeviceWorkspaceRoot is one root a device reported, with its anchor identity.
type DeviceWorkspaceRoot struct {
	AnchorID     string
	Kind         string
	RemoteURL    string
	RelativePath string
	AbsPath      string
	VerifiedAt   *int64
}

// ReportedRoot is one root as a device described it.
//
// RelativePath is the workspace inside the checkout (AnchorRepoRoot for the
// checkout itself); the device computes it, because the device is the only
// party that can see both paths.
type ReportedRoot struct {
	Path         string
	RemoteURL    string
	RelativePath string
}

// EnsureGitAnchor returns the anchor for a repository-relative workspace,
// creating it on first use. Identity is (remote, relative path): two tasks in
// the same subdirectory of the same repository share one anchor, which is what
// makes "which devices can run this" a single lookup.
func (s *Store) EnsureGitAnchor(ctx context.Context, remoteURL, relativePath string, now int64) (WorkspaceAnchor, error) {
	remoteURL = strings.TrimSpace(remoteURL)
	if remoteURL == "" {
		return WorkspaceAnchor{}, errors.New("anchor remote url is required")
	}
	if err := validateCanonicalRemote(remoteURL); err != nil {
		return WorkspaceAnchor{}, err
	}
	relativePath, err := cleanAnchorRel(relativePath)
	if err != nil {
		return WorkspaceAnchor{}, err
	}
	now = anchorNow(now)

	existing, err := scanAnchor(s.db.QueryRowContext(ctx, anchorSelect+`
		WHERE kind = ? AND remote_url = ? AND relative_path = ?`,
		AnchorGitRemote, remoteURL, relativePath))
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return WorkspaceAnchor{}, fmt.Errorf("find workspace anchor: %w", err)
	}
	anchor := WorkspaceAnchor{
		ID:           ulid.Make().String(),
		Kind:         AnchorGitRemote,
		RemoteURL:    remoteURL,
		RelativePath: relativePath,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO workspace_anchors (id, project_id, kind, remote_url, relative_path, created_at, updated_at)
		VALUES (?, NULL, ?, ?, ?, ?, ?)`,
		anchor.ID, anchor.Kind, anchor.RemoteURL, anchor.RelativePath, anchor.CreatedAt, anchor.UpdatedAt,
	); err != nil {
		return WorkspaceAnchor{}, fmt.Errorf("insert workspace anchor: %w", err)
	}
	return anchor, nil
}

// EnsureDeviceAnchor returns the anchor for one directory on one device,
// creating it on first use, and records that device's root for it.
//
// A device-path anchor has no identity of its own: two devices pointing at the
// same directory name are not the same workspace, so the pair (device, path)
// found through the root row is what identifies it.
func (s *Store) EnsureDeviceAnchor(ctx context.Context, deviceID, absPath string, now int64) (WorkspaceAnchor, error) {
	deviceID = strings.TrimSpace(deviceID)
	absPath = strings.TrimSpace(absPath)
	if deviceID == "" || absPath == "" {
		return WorkspaceAnchor{}, errors.New("anchor device and path are required")
	}
	now = anchorNow(now)

	anchor, err := scanAnchor(s.db.QueryRowContext(ctx, anchorSelect+`
		WHERE kind = ? AND id IN (
			SELECT anchor_id FROM workspace_anchor_roots WHERE device_id = ? AND abs_path = ?
		)`, AnchorDevicePath, deviceID, absPath))
	if err == nil {
		return anchor, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return WorkspaceAnchor{}, fmt.Errorf("find device anchor: %w", err)
	}

	anchor = WorkspaceAnchor{
		ID:        ulid.Make().String(),
		Kind:      AnchorDevicePath,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO workspace_anchors (id, project_id, kind, remote_url, relative_path, created_at, updated_at)
		VALUES (?, NULL, ?, '', '', ?, ?)`,
		anchor.ID, anchor.Kind, anchor.CreatedAt, anchor.UpdatedAt,
	); err != nil {
		return WorkspaceAnchor{}, fmt.Errorf("insert device anchor: %w", err)
	}
	if err := s.SetAnchorRoot(ctx, anchor.ID, deviceID, absPath, now); err != nil {
		return WorkspaceAnchor{}, err
	}
	return anchor, nil
}

// GetWorkspaceAnchor returns one anchor by id.
func (s *Store) GetWorkspaceAnchor(ctx context.Context, id string) (WorkspaceAnchor, error) {
	anchor, err := scanAnchor(s.db.QueryRowContext(ctx, anchorSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceAnchor{}, ErrAnchorNotFound
	}
	if err != nil {
		return WorkspaceAnchor{}, fmt.Errorf("get workspace anchor: %w", err)
	}
	return anchor, nil
}

// SetAnchorRoot records where one anchor lives on one device.
func (s *Store) SetAnchorRoot(ctx context.Context, anchorID, deviceID, absPath string, now int64) error {
	anchorID = strings.TrimSpace(anchorID)
	deviceID = strings.TrimSpace(deviceID)
	absPath = strings.TrimSpace(absPath)
	if anchorID == "" || deviceID == "" || absPath == "" {
		return errors.New("anchor root needs an anchor, a device and a path")
	}
	now = anchorNow(now)
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO workspace_anchor_roots (anchor_id, device_id, abs_path, verified_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(anchor_id, device_id) DO UPDATE SET
			abs_path    = excluded.abs_path,
			verified_at = excluded.verified_at`,
		anchorID, deviceID, absPath, now,
	); err != nil {
		return fmt.Errorf("set anchor root: %w", err)
	}
	return nil
}

// ResolveAnchorPath answers where an anchor lives on a device.
//
// The distinction it draws is the point of the whole table: ok=false is "this
// machine cannot resolve this workspace", which callers must report rather than
// paper over. There is no fallback to the path the task was created with — that
// path belongs to another machine.
//
// A device resolves a repository anchor through the checkouts it reported. Every
// repository root row holds the *checkout* path (never a subdirectory of it), so
// the answer is always the anchor's path inside the chosen checkout. The row is
// chosen by longest matching prefix: a device that declared `sub` can resolve
// `sub/dir` but not a sibling, because a sibling is outside what that machine
// said it works in.
func (s *Store) ResolveAnchorPath(ctx context.Context, anchor WorkspaceAnchor, deviceID string) (string, bool, error) {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return "", false, nil
	}
	if anchor.Kind == AnchorDevicePath {
		var absPath string
		err := s.db.QueryRowContext(ctx, `
			SELECT abs_path FROM workspace_anchor_roots
			WHERE anchor_id = ? AND device_id = ?`, anchor.ID, deviceID).Scan(&absPath)
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, nil
		}
		if err != nil {
			return "", false, fmt.Errorf("resolve device anchor: %w", err)
		}
		return absPath, true, nil
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT a.relative_path, r.abs_path
		FROM workspace_anchor_roots r
		JOIN workspace_anchors a ON a.id = r.anchor_id
		WHERE r.device_id = ? AND a.kind = ? AND a.remote_url = ?`,
		deviceID, AnchorGitRemote, anchor.RemoteURL)
	if err != nil {
		return "", false, fmt.Errorf("resolve anchor roots: %w", err)
	}
	defer rows.Close()

	bestRoot, bestPrefix := "", ""
	for rows.Next() {
		var relative, absPath string
		if err := rows.Scan(&relative, &absPath); err != nil {
			return "", false, fmt.Errorf("resolve anchor roots: %w", err)
		}
		relative, err = cleanAnchorRel(relative)
		if err != nil {
			return "", false, err
		}
		if !anchorPathHasPrefix(anchor.RelativePath, relative) {
			continue
		}
		if len(relative) > len(bestPrefix) {
			bestRoot, bestPrefix = absPath, relative
		}
	}
	if err := rows.Err(); err != nil {
		return "", false, fmt.Errorf("resolve anchor roots: %w", err)
	}
	if bestRoot == "" {
		return "", false, nil
	}
	resolved, err := joinNodePath(bestRoot, anchor.RelativePath)
	if err != nil {
		return "", false, err
	}
	return resolved, true, nil
}

// DevicesWithAnchor names the devices that can resolve an anchor. It is what
// turns "this machine does not have that workspace" into an answer the user can
// act on, so it answers with the label a device is known by and falls back to
// its id only when it has none: nobody can look up an id.
func (s *Store) DevicesWithAnchor(ctx context.Context, anchor WorkspaceAnchor) ([]string, error) {
	query := `
		SELECT DISTINCT COALESCE(NULLIF(TRIM(d.label), ''), r.device_id)
		FROM workspace_anchor_roots r
		JOIN workspace_anchors a ON a.id = r.anchor_id
		LEFT JOIN devices d ON d.id = r.device_id
		WHERE a.kind = ? AND a.remote_url = ?
		ORDER BY 1`
	args := []any{AnchorGitRemote, anchor.RemoteURL}
	if anchor.Kind == AnchorDevicePath {
		query = `
			SELECT DISTINCT COALESCE(NULLIF(TRIM(d.label), ''), r.device_id)
			FROM workspace_anchor_roots r
			LEFT JOIN devices d ON d.id = r.device_id
			WHERE r.anchor_id = ?
			ORDER BY 1`
		args = []any{anchor.ID}
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list anchor devices: %w", err)
	}
	defer rows.Close()

	var devices []string
	for rows.Next() {
		var deviceID string
		if err := rows.Scan(&deviceID); err != nil {
			return nil, fmt.Errorf("list anchor devices: %w", err)
		}
		devices = append(devices, deviceID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list anchor devices: %w", err)
	}
	return devices, nil
}

// ListDeviceWorkspaceRoots returns the roots one device reported, longest path
// first so a caller matching a directory finds the most specific root.
func (s *Store) ListDeviceWorkspaceRoots(ctx context.Context, deviceID string) ([]DeviceWorkspaceRoot, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.anchor_id, a.kind, a.remote_url, a.relative_path, r.abs_path, r.verified_at
		FROM workspace_anchor_roots r
		JOIN workspace_anchors a ON a.id = r.anchor_id
		WHERE r.device_id = ?
		ORDER BY LENGTH(r.abs_path) DESC, r.abs_path`, strings.TrimSpace(deviceID))
	if err != nil {
		return nil, fmt.Errorf("list device roots: %w", err)
	}
	defer rows.Close()

	var roots []DeviceWorkspaceRoot
	for rows.Next() {
		var (
			root       DeviceWorkspaceRoot
			verifiedAt sql.NullInt64
		)
		if err := rows.Scan(&root.AnchorID, &root.Kind, &root.RemoteURL, &root.RelativePath,
			&root.AbsPath, &verifiedAt); err != nil {
			return nil, fmt.Errorf("list device roots: %w", err)
		}
		if verifiedAt.Valid {
			root.VerifiedAt = &verifiedAt.Int64
		}
		roots = append(roots, root)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list device roots: %w", err)
	}
	return roots, nil
}

// RecordDeviceWorkspaceRoots replaces what a device says it works in.
//
// Replacement, not merge, for the same reason the agent inventory is replaced:
// a hello is a snapshot of one machine's state. A root this device no longer
// reports must stop resolving, or a machine that moved its checkouts would keep
// being handed work at paths that are no longer there. Device-path anchors that
// lose their last root are dropped with them; repository anchors are shared
// identity and stay.
func (s *Store) RecordDeviceWorkspaceRoots(ctx context.Context, deviceID string, roots []ReportedRoot, now int64) error {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return errors.New("device id is required")
	}
	now = anchorNow(now)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("record device roots: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// What this device already has, so a repeat hello reuses the anchor it wrote
	// last time. It matters for device paths: a device-path anchor is identified
	// by its root row, so minting a new one on every hello would orphan every
	// task pointing at the old id and leave the row a task names unresolvable.
	existing, err := devicePathAnchors(ctx, tx, deviceID)
	if err != nil {
		return err
	}

	keep := make(map[string]bool, len(roots))
	// claimed is where this hello says each anchor lives, and it is what makes
	// two checkouts of one repository visible. A device that reports two of them
	// has two answers to "where is this repository here" and the Hub cannot pick
	// between them: either choice would hand a turn a checkout the task never
	// named. Such an anchor keeps no root on this device, and resolution fails
	// loudly instead — the alternative is running in the wrong copy, silently.
	claimed := make(map[string]string, len(roots))
	for _, reported := range roots {
		absPath := cleanNodePath(reported.Path)
		remoteURL := strings.TrimSpace(reported.RemoteURL)
		if absPath == "" {
			continue
		}
		if len(absPath) > MaxAnchorPath {
			return fmt.Errorf("device root path exceeds %d bytes", MaxAnchorPath)
		}
		relative := ""
		kind := AnchorDevicePath
		if remoteURL != "" {
			if err := validateCanonicalRemote(remoteURL); err != nil {
				return err
			}
			kind = AnchorGitRemote
			if relative, err = cleanAnchorRel(reported.RelativePath); err != nil {
				return err
			}
		}

		anchorID, err := ensureAnchorTx(ctx, tx, kind, remoteURL, relative, existing, absPath, now)
		if err != nil {
			return err
		}
		if prev, seen := claimed[anchorID]; seen && !sameNodePath(prev, absPath) {
			delete(keep, anchorID)
			continue
		}
		claimed[anchorID] = absPath
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workspace_anchor_roots (anchor_id, device_id, abs_path, verified_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(anchor_id, device_id) DO UPDATE SET
				abs_path    = excluded.abs_path,
				verified_at = excluded.verified_at`,
			anchorID, deviceID, absPath, now,
		); err != nil {
			return fmt.Errorf("record device roots: %w", err)
		}
		keep[anchorID] = true
	}

	// Drop what this device no longer reports. The NOT IN list is built from
	// bound parameters, so an empty report simply clears the device.
	args := []any{deviceID}
	clause := ""
	if len(keep) > 0 {
		ids := make([]string, 0, len(keep))
		for id := range keep {
			ids = append(ids, id)
		}
		clause = ` AND anchor_id NOT IN (` + placeholders(len(ids)) + `)`
		for _, id := range ids {
			args = append(args, id)
		}
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM workspace_anchor_roots WHERE device_id = ?`+clause, args...); err != nil {
		return fmt.Errorf("record device roots: drop stale: %w", err)
	}
	// A device-path anchor exists only to hang a root on: with no roots left it
	// is a row nothing can resolve, so it goes too.
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM workspace_anchors
		WHERE kind = ? AND NOT EXISTS (
			SELECT 1 FROM workspace_anchor_roots r WHERE r.anchor_id = workspace_anchors.id
		)`, AnchorDevicePath); err != nil {
		return fmt.Errorf("record device roots: drop orphan anchors: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("record device roots: %w", err)
	}
	return nil
}

// MatchDeviceRoot finds the root of a device that contains a directory, most
// specific first, and returns the anchor for that directory plus the checkout
// path it belongs to.
//
// It is how a path typed by someone looking at one machine becomes an anchor on
// the Hub: the device already told us where its checkouts are. A device-path
// root matches only itself — a directory that is not a repository is not a
// parent of anything portable.
func (s *Store) MatchDeviceRoot(ctx context.Context, deviceID, dir string, now int64) (WorkspaceAnchor, string, bool, error) {
	// The typed path is normalized the same way the reported roots are, so a cwd
	// written with a ".." in it is matched as the directory it names rather than
	// as text that happens to start with a root.
	dir = cleanNodePath(dir)
	if dir == "" {
		return WorkspaceAnchor{}, "", false, nil
	}
	roots, err := s.ListDeviceWorkspaceRoots(ctx, deviceID)
	if err != nil {
		return WorkspaceAnchor{}, "", false, err
	}
	for _, root := range roots {
		if root.Kind == AnchorDevicePath {
			if sameNodePath(root.AbsPath, dir) {
				anchor, err := s.GetWorkspaceAnchor(ctx, root.AnchorID)
				if err != nil {
					return WorkspaceAnchor{}, "", false, err
				}
				return anchor, root.AbsPath, true, nil
			}
			continue
		}
		if !nodePathContains(root.AbsPath, dir) {
			continue
		}
		// The anchor is the directory's place in the *checkout*, which is what a
		// root row's abs_path holds. The row's own relative path is the workspace
		// it was created for, and it is not part of this answer: adding it would
		// count the same path twice for a device whose root is a subdirectory of
		// its checkout, and name a directory that is not there.
		relative, err := cleanAnchorRel(relativeNodePath(root.AbsPath, dir))
		if err != nil {
			return WorkspaceAnchor{}, "", false, err
		}
		anchor, err := s.EnsureGitAnchor(ctx, root.RemoteURL, relative, now)
		if err != nil {
			return WorkspaceAnchor{}, "", false, err
		}
		if err := s.SetAnchorRoot(ctx, anchor.ID, deviceID, root.AbsPath, now); err != nil {
			return WorkspaceAnchor{}, "", false, err
		}
		return anchor, root.AbsPath, true, nil
	}
	return WorkspaceAnchor{}, "", false, nil
}

// devicePathAnchors returns the device-path anchors one device already holds a
// root for, keyed by the root path as it will be compared.
func devicePathAnchors(ctx context.Context, tx *sql.Tx, deviceID string) (map[string]string, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT r.anchor_id, r.abs_path
		FROM workspace_anchor_roots r
		JOIN workspace_anchors a ON a.id = r.anchor_id
		WHERE r.device_id = ? AND a.kind = ?`, deviceID, AnchorDevicePath)
	if err != nil {
		return nil, fmt.Errorf("find device anchors: %w", err)
	}
	defer rows.Close()

	out := make(map[string]string)
	for rows.Next() {
		var anchorID, absPath string
		if err := rows.Scan(&anchorID, &absPath); err != nil {
			return nil, fmt.Errorf("find device anchors: %w", err)
		}
		out[cleanNodePath(absPath)] = anchorID
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("find device anchors: %w", err)
	}
	return out, nil
}

// ensureAnchorTx is EnsureGitAnchor for a caller already inside a transaction.
//
// A repository anchor is shared identity and is deduped by (remote, path). A
// device-path anchor has no identity beyond its root row, so the caller passes
// what this device already holds (existing) and the path being reported: an
// anchor that already names this directory on this device is reused, and only a
// genuinely new directory gets a new one.
func ensureAnchorTx(ctx context.Context, tx *sql.Tx, kind, remoteURL, relativePath string, existing map[string]string, absPath string, now int64) (string, error) {
	if kind == AnchorDevicePath {
		if id, ok := existing[cleanNodePath(absPath)]; ok {
			return id, nil
		}
		id := ulid.Make().String()
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workspace_anchors (id, project_id, kind, remote_url, relative_path, created_at, updated_at)
			VALUES (?, NULL, ?, '', '', ?, ?)`, id, AnchorDevicePath, now, now); err != nil {
			return "", fmt.Errorf("insert device anchor: %w", err)
		}
		return id, nil
	}
	var id string
	err := tx.QueryRowContext(ctx, `
		SELECT id FROM workspace_anchors WHERE kind = ? AND remote_url = ? AND relative_path = ?`,
		AnchorGitRemote, remoteURL, relativePath).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("find workspace anchor: %w", err)
	}
	id = ulid.Make().String()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workspace_anchors (id, project_id, kind, remote_url, relative_path, created_at, updated_at)
		VALUES (?, NULL, ?, ?, ?, ?, ?)`,
		id, AnchorGitRemote, remoteURL, relativePath, now, now); err != nil {
		return "", fmt.Errorf("insert workspace anchor: %w", err)
	}
	return id, nil
}

const anchorSelect = `
	SELECT id, COALESCE(project_id, ''), kind, remote_url, relative_path, created_at, updated_at
	FROM workspace_anchors`

func scanAnchor(row rowScanner) (WorkspaceAnchor, error) {
	var anchor WorkspaceAnchor
	if err := row.Scan(&anchor.ID, &anchor.ProjectID, &anchor.Kind, &anchor.RemoteURL,
		&anchor.RelativePath, &anchor.CreatedAt, &anchor.UpdatedAt); err != nil {
		return WorkspaceAnchor{}, err
	}
	return anchor, nil
}

func anchorNow(now int64) int64 {
	if now <= 0 {
		return time.Now().UnixMilli()
	}
	return now
}

// validateCanonicalRemote rejects a remote that is not already canonical.
//
// Anchors are shared between machines through the Hub's database, so a remote
// URL is the one string that must never carry a credential: a token embedded in
// an https remote would be copied into every device's view of the workspace
// (ADR 0022 D7). Normalization happens on the machine that reads the git config
// (internal/workspace.CanonicalRemote); this is the check that it did.
func validateCanonicalRemote(remote string) error {
	if len(remote) > MaxAnchorRemoteURL {
		return fmt.Errorf("anchor remote url exceeds %d bytes", MaxAnchorRemoteURL)
	}
	if strings.ContainsAny(remote, "@\\ \t\n") || strings.Contains(remote, "://") {
		return fmt.Errorf("anchor remote url %q is not canonical", remote)
	}
	if strings.HasPrefix(remote, "/") || strings.HasSuffix(remote, "/") {
		return fmt.Errorf("anchor remote url %q is not canonical", remote)
	}
	return nil
}

// cleanAnchorRel normalizes a workspace path inside a checkout, and refuses one
// that leaves it.
//
// Slashes, not filepath separators: an anchor travels between machines, and its
// relative path has to mean the same thing on all of them. A ".." segment is a
// refusal rather than something to resolve: the Hub cannot see the directory it
// names, so a path that walks out of the checkout would be stored as an identity
// for one workspace while pointing a turn at a directory in another.
func cleanAnchorRel(relative string) (string, error) {
	relative = strings.TrimSpace(strings.ReplaceAll(relative, "\\", "/"))
	relative = strings.Trim(relative, "/")
	if relative == "" || relative == "." {
		return AnchorRepoRoot, nil
	}
	cleaned := path.Clean(relative)
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("workspace path %q leaves its checkout", relative)
	}
	return cleaned, nil
}

// anchorPathHasPrefix reports whether rel is rel-or-below prefix of target, by
// path segments: "sub" is a prefix of "sub/dir" but never of "subway".
//
// A path that will not clean cannot be a prefix of anything, and the answer for
// it is no: this decides whether a workspace resolves, and the safe direction for
// that question is to refuse.
func anchorPathHasPrefix(target, prefix string) bool {
	target, err := cleanAnchorRel(target)
	if err != nil {
		return false
	}
	if prefix, err = cleanAnchorRel(prefix); err != nil {
		return false
	}
	if prefix == AnchorRepoRoot {
		return true
	}
	return target == prefix || strings.HasPrefix(target, prefix+"/")
}

// cleanNodePath normalizes a path on another machine for textual comparison.
//
// These paths belong to a filesystem the Hub cannot see, so it cannot resolve
// them — but they can still be normalized as text: backslashes become slashes,
// "." segments go, and ".." pops the segment in front of it. A ".." that would
// climb above the start of the path stays where it is, and that is what makes
// every containment check below answer no: no declared root is reachable by
// walking up out of it.
func cleanNodePath(p string) string {
	p = strings.ReplaceAll(strings.TrimSpace(p), `\`, "/")
	rooted := strings.HasPrefix(p, "/")
	segments := make([]string, 0, 8)
	for _, segment := range strings.Split(p, "/") {
		switch segment {
		case "", ".":
		case "..":
			if n := len(segments); n > 0 && segments[n-1] != ".." {
				segments = segments[:n-1]
			} else {
				segments = append(segments, "..")
			}
		default:
			segments = append(segments, segment)
		}
	}
	cleaned := strings.Join(segments, "/")
	if rooted && !strings.HasPrefix(cleaned, "..") {
		cleaned = "/" + cleaned
	}
	return cleaned
}

// sameNodePath compares two paths as the machine that owns them wrote them.
func sameNodePath(a, b string) bool {
	a, b = cleanNodePath(a), cleanNodePath(b)
	return a != "" && a == b
}

// nodePathContains reports whether dir is at or below root.
//
// The comparison is textual on purpose: these are paths on another machine, and
// the Hub cannot resolve, stat or symlink-check them. The device enforces the
// boundary for real (node.Executor.allowedCwd); this only decides whether an
// anchor can be derived. Both sides are normalized the same way first, so a
// directory named with a ".." in it is compared as the directory it names.
func nodePathContains(root, dir string) bool {
	root, dir = cleanNodePath(root), cleanNodePath(dir)
	if root == "" || dir == "" {
		return false
	}
	if root == dir {
		return true
	}
	return strings.HasPrefix(dir, root+"/")
}

// relativeNodePath returns dir relative to root, in slash form. Both are
// already normalized, and root is a prefix of dir.
func relativeNodePath(root, dir string) string {
	root, dir = cleanNodePath(root), cleanNodePath(dir)
	if root == dir {
		return AnchorRepoRoot
	}
	return strings.TrimPrefix(strings.TrimPrefix(dir, root), "/")
}

// joinNodePath appends a workspace-relative path to a path on another machine.
//
// The separator follows the base path, because the result is handed back to the
// device that owns it: a Windows checkout gets backslashes, everything else
// gets slashes.
func joinNodePath(absPath, relative string) (string, error) {
	absPath = strings.TrimRight(strings.TrimSpace(absPath), "/\\")
	relative, err := cleanAnchorRel(relative)
	if err != nil {
		return "", err
	}
	if relative == AnchorRepoRoot {
		return absPath, nil
	}
	sep := "/"
	if strings.Contains(absPath, `\`) && !strings.Contains(absPath, "/") {
		sep = `\`
		relative = strings.ReplaceAll(relative, "/", `\`)
	}
	return absPath + sep + relative, nil
}
