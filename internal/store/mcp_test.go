package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestMCPMigration020Upgrade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kin.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB().Exec(`
		DROP TABLE mcp_audit_calls;
		DROP TABLE mcp_idempotency;
		PRAGMA user_version = 19;
	`); err != nil {
		_ = st.Close()
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	st, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	var version int
	if err := st.DB().QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != schemaVersion {
		t.Fatalf("version=%d want %d", version, schemaVersion)
	}
	if err := st.RecordMCPAuditCall(context.Background(), MCPAuditCall{
		ID: "mcp-audit-migration", OccurredAt: 1, Method: "ping",
	}); err != nil {
		t.Fatal(err)
	}
}

func TestMCPTaskOriginCanBeReservedBeforeTaskCreation(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	origin := MCPTaskOrigin{
		TaskID: "reserved-before-create", PrincipalKind: "master", PrincipalID: "master",
		ClientID: "client", SessionID: "session", CreatedAt: NowMilli(),
	}
	if err := st.RecordMCPTaskOrigin(context.Background(), origin); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetMCPTaskOrigin(context.Background(), origin.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if got.TaskID != origin.TaskID {
		t.Fatalf("origin=%+v", got)
	}
}
