package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// The device registry is what the Hub knows about the machines that have
// introduced themselves to it: rows in `devices`, and one `device_agents` row
// per agent runtime each of them reported.
//
// It is durable on purpose. The in-memory lease registry (ADR 0020) answers
// "is anything connected right now"; this answers "which machine has the agent
// I need", which has to survive a Hub restart — otherwise every dispatch
// decision would depend on the order machines happened to reconnect in.

// Device is one machine known to the Hub.
type Device struct {
	ID           string
	OwnerUserID  string
	Label        string
	Platform     string
	Arch         string
	Role         string
	KinVersion   string
	Capabilities string
	Reachability string
	LastSeenAt   *int64
	CreatedAt    int64
	RevokedAt    *int64
}

// DeviceAgent is one agent runtime on one device, as that device reported it.
type DeviceAgent struct {
	DeviceID     string
	AgentID      string
	Installed    bool
	Available    bool
	Version      string
	Reason       string
	DefaultModel string
	Models       []string
	IsDefault    bool
	UpdatedAt    int64
}

// Reachability values for devices.reachability.
const (
	ReachabilityUnknown = "unknown"
	ReachabilityOnline  = "online"
	ReachabilityOffline = "offline"
)

var ErrDeviceNotFound = errors.New("device not found")

// RecordDeviceHello writes what a Node said about itself: the device row and
// its whole agent inventory, replacing whatever the previous hello claimed.
//
// The agent list is replaced rather than merged because it is a snapshot of one
// machine's state, not a log. An agent uninstalled between two hellos must
// disappear, and merging would leave it advertised forever.
func (s *Store) RecordDeviceHello(ctx context.Context, deviceID string, device Device, agents []DeviceAgent, now int64) error {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return errors.New("device id is required")
	}
	if now <= 0 {
		now = time.Now().UnixMilli()
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("record device hello: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// The credential is the device; a hello can only ever describe a device
	// that is already paired, so the row exists by the time we get here.
	// Upserting anyway keeps a deleted-but-still-paired device from wedging.
	//
	// role belongs to the update, not only the insert: pairing writes every
	// device as a client, and a machine only becomes a node by saying hello.
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO devices (id, label, platform, arch, role, kin_version, capabilities,
		                     reachability, last_seen_at, created_at)
		VALUES (?, ?, ?, ?, 'node', ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			label        = excluded.label,
			platform     = excluded.platform,
			arch         = excluded.arch,
			role         = excluded.role,
			kin_version  = excluded.kin_version,
			capabilities = excluded.capabilities,
			reachability = excluded.reachability,
			last_seen_at = excluded.last_seen_at`,
		deviceID, device.Label, device.Platform, device.Arch,
		device.KinVersion, device.Capabilities,
		ReachabilityOnline, now, now,
	); err != nil {
		return fmt.Errorf("record device hello: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM device_agents WHERE device_id = ?`, deviceID); err != nil {
		return fmt.Errorf("record device hello: clear agents: %w", err)
	}
	for _, agent := range agents {
		agentID := strings.TrimSpace(agent.AgentID)
		if agentID == "" {
			return errors.New("device agent id is required")
		}
		models, err := json.Marshal(agent.Models)
		if err != nil {
			return fmt.Errorf("record device hello: encode models: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO device_agents (device_id, agent_id, installed, available, version,
			                           reason, default_model, models, is_default, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			deviceID, agentID, boolInt(agent.Installed), boolInt(agent.Available),
			agent.Version, agent.Reason, agent.DefaultModel, string(models),
			boolInt(agent.IsDefault), now,
		); err != nil {
			return fmt.Errorf("record device hello: insert agent %s: %w", agentID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("record device hello: %w", err)
	}
	return nil
}

// TouchDevice records that a device is alive without rewriting its inventory.
func (s *Store) TouchDevice(ctx context.Context, deviceID string, now int64) error {
	if now <= 0 {
		now = time.Now().UnixMilli()
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE devices SET last_seen_at = ?, reachability = ?
		WHERE id = ?`, now, ReachabilityOnline, strings.TrimSpace(deviceID))
	if err != nil {
		return fmt.Errorf("touch device: %w", err)
	}
	return nil
}

// SetDeviceReachability marks a device online or offline. Presence is not an
// error when the device is gone: it may have been revoked mid-connection.
func (s *Store) SetDeviceReachability(ctx context.Context, deviceID, reachability string) error {
	if _, err := s.db.ExecContext(ctx, `
		UPDATE devices SET reachability = ? WHERE id = ?`,
		reachability, strings.TrimSpace(deviceID),
	); err != nil {
		return fmt.Errorf("set device reachability: %w", err)
	}
	return nil
}

// GetDevice returns one device, or ErrDeviceNotFound.
func (s *Store) GetDevice(ctx context.Context, id string) (Device, error) {
	device, err := scanDevice(s.db.QueryRowContext(ctx, deviceSelect+` WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return Device{}, ErrDeviceNotFound
	}
	if err != nil {
		return Device{}, fmt.Errorf("get device: %w", err)
	}
	return device, nil
}

// ListDevices returns every paired device, newest first, with whatever the
// device has told the Hub about itself.
//
// The credential table is the outer side of the join on purpose: a device is
// "known" because it was paired, and a device that has never connected still
// belongs in the list. Its registry row is either the one written at pairing
// time or nothing at all, which reads as "never seen".
func (s *Store) ListDevices(ctx context.Context) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT c.id, COALESCE(d.owner_user_id, ''), COALESCE(NULLIF(d.label, ''), c.label),
		       COALESCE(d.platform, ''), COALESCE(d.arch, ''), COALESCE(d.role, ''),
		       COALESCE(d.kin_version, ''), COALESCE(d.capabilities, '{}'),
		       COALESCE(d.reachability, ?), COALESCE(d.last_seen_at, c.last_used_at),
		       c.created_at, COALESCE(d.revoked_at, c.revoked_at)
		FROM device_credentials c
		LEFT JOIN devices d ON d.id = c.id
		ORDER BY c.created_at DESC`, ReachabilityUnknown)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	defer rows.Close()

	var devices []Device
	for rows.Next() {
		device, err := scanDevice(rows)
		if err != nil {
			return nil, fmt.Errorf("list devices: %w", err)
		}
		devices = append(devices, device)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	return devices, nil
}

// ListDeviceAgents returns one device's agent inventory, in a stable order.
func (s *Store) ListDeviceAgents(ctx context.Context, deviceID string) ([]DeviceAgent, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT device_id, agent_id, installed, available, version, reason,
		       default_model, models, is_default, updated_at
		FROM device_agents WHERE device_id = ? ORDER BY agent_id`, strings.TrimSpace(deviceID))
	if err != nil {
		return nil, fmt.Errorf("list device agents: %w", err)
	}
	defer rows.Close()

	var agents []DeviceAgent
	for rows.Next() {
		var (
			agent                           DeviceAgent
			models                          string
			installed, available, isDefault int
		)
		if err := rows.Scan(&agent.DeviceID, &agent.AgentID, &installed, &available,
			&agent.Version, &agent.Reason, &agent.DefaultModel, &models, &isDefault,
			&agent.UpdatedAt); err != nil {
			return nil, fmt.Errorf("list device agents: %w", err)
		}
		agent.Installed = installed != 0
		agent.Available = available != 0
		agent.IsDefault = isDefault != 0
		if models != "" {
			if err := json.Unmarshal([]byte(models), &agent.Models); err != nil {
				return nil, fmt.Errorf("list device agents: decode models for %s: %w", agent.AgentID, err)
			}
		}
		agents = append(agents, agent)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list device agents: %w", err)
	}
	return agents, nil
}

const deviceSelect = `
	SELECT id, COALESCE(owner_user_id, ''), label, platform, arch, role, kin_version,
	       capabilities, reachability, last_seen_at, created_at, revoked_at
	FROM devices`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanDevice(row rowScanner) (Device, error) {
	var (
		device    Device
		lastSeen  sql.NullInt64
		revokedAt sql.NullInt64
	)
	if err := row.Scan(&device.ID, &device.OwnerUserID, &device.Label, &device.Platform,
		&device.Arch, &device.Role, &device.KinVersion, &device.Capabilities,
		&device.Reachability, &lastSeen, &device.CreatedAt, &revokedAt); err != nil {
		return Device{}, err
	}
	if lastSeen.Valid {
		device.LastSeenAt = &lastSeen.Int64
	}
	if revokedAt.Valid {
		device.RevokedAt = &revokedAt.Int64
	}
	return device, nil
}
