package server

import (
	"errors"
	"testing"

	"github.com/vuuihc/kin/internal/api"
	"github.com/vuuihc/kin/internal/terminal"
)

func TestTerminalManagerInjectionAndCleanupUseSameInstance(t *testing.T) {
	manager := newTerminalManager(func() []terminal.Profile {
		return []terminal.Profile{{ID: "sh", Name: "sh", Executable: "/bin/sh"}}
	})
	server := &api.Server{Terminals: manager}
	if server.Terminals != manager {
		t.Fatal("API server did not receive constructed terminal manager")
	}
	if err := manager.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	_, err := server.Terminals.Create(terminal.CreateRequest{
		ProfileID: "sh", Cwd: t.TempDir(), Cols: 80, Rows: 24,
	})
	if !errors.Is(err, terminal.ErrClosed) {
		t.Fatalf("Create() after cleanup error = %v, want %v", err, terminal.ErrClosed)
	}
}
