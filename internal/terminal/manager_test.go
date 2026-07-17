package terminal

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestManager(t *testing.T) *Manager {
	t.Helper()
	manager := NewManager([]Profile{{
		ID:         "sh",
		Name:       "sh",
		Executable: "/bin/sh",
	}})
	t.Cleanup(func() {
		if err := manager.Close(); err != nil {
			t.Errorf("Manager.Close() error = %v", err)
		}
	})
	return manager
}

func TestManagerCreateRejectsInvalidRequests(t *testing.T) {
	tests := []struct {
		name string
		req  func(t *testing.T) CreateRequest
		want error
	}{
		{
			name: "unknown profile",
			req: func(t *testing.T) CreateRequest {
				return CreateRequest{ProfileID: "missing", Cwd: t.TempDir(), Cols: 80, Rows: 24}
			},
			want: ErrProfile,
		},
		{
			name: "missing cwd",
			req: func(t *testing.T) CreateRequest {
				return CreateRequest{ProfileID: "sh", Cwd: filepath.Join(t.TempDir(), "missing"), Cols: 80, Rows: 24}
			},
			want: ErrCwd,
		},
		{
			name: "file cwd",
			req: func(t *testing.T) CreateRequest {
				path := filepath.Join(t.TempDir(), "file")
				if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
					t.Fatal(err)
				}
				return CreateRequest{ProfileID: "sh", Cwd: path, Cols: 80, Rows: 24}
			},
			want: ErrCwd,
		},
		{
			name: "small columns",
			req: func(t *testing.T) CreateRequest {
				return CreateRequest{ProfileID: "sh", Cwd: t.TempDir(), Cols: 1, Rows: 24}
			},
			want: ErrSize,
		},
		{
			name: "large columns",
			req: func(t *testing.T) CreateRequest {
				return CreateRequest{ProfileID: "sh", Cwd: t.TempDir(), Cols: 501, Rows: 24}
			},
			want: ErrSize,
		},
		{
			name: "zero rows",
			req: func(t *testing.T) CreateRequest {
				return CreateRequest{ProfileID: "sh", Cwd: t.TempDir(), Cols: 80, Rows: 0}
			},
			want: ErrSize,
		},
		{
			name: "large rows",
			req: func(t *testing.T) CreateRequest {
				return CreateRequest{ProfileID: "sh", Cwd: t.TempDir(), Cols: 80, Rows: 201}
			},
			want: ErrSize,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manager := newTestManager(t)
			if _, err := manager.Create(tt.req(t)); !errors.Is(err, tt.want) {
				t.Fatalf("Create() error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestManagerCreateStartsInRequestedCwd(t *testing.T) {
	manager := newTestManager(t)
	cwd := t.TempDir()
	info, err := manager.Create(CreateRequest{ProfileID: "sh", Cwd: cwd, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	attachment, err := manager.Attach(info.ID)
	if err != nil {
		t.Fatalf("Attach() error = %v", err)
	}
	defer attachment.Detach()

	if err := manager.Write(info.ID, []byte("pwd\nexit\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	output := waitForOutput(t, attachment, []byte(cwd))
	if !strings.Contains(string(output), cwd) {
		t.Fatalf("terminal output %q does not contain cwd %q", output, cwd)
	}
}

func TestSessionWriteAndExit(t *testing.T) {
	manager := newTestManager(t)
	info, err := manager.Create(CreateRequest{ProfileID: "sh", Cwd: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	attachment, err := manager.Attach(info.ID)
	if err != nil {
		t.Fatalf("Attach() error = %v", err)
	}
	defer attachment.Detach()

	if err := manager.Write(info.ID, []byte("printf 'KIN_PTY_OK\\n'\nexit\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	waitForOutput(t, attachment, []byte("KIN_PTY_OK"))
	if code := waitForExit(t, attachment); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}

	listed := manager.List()
	if len(listed) != 1 || listed[0].Status != "exited" || listed[0].ExitCode == nil || *listed[0].ExitCode != 0 {
		t.Fatalf("List() = %+v, want exited session with code 0", listed)
	}
}

func TestSessionResizeChangesTTYSize(t *testing.T) {
	manager := newTestManager(t)
	info, err := manager.Create(CreateRequest{ProfileID: "sh", Cwd: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	attachment, err := manager.Attach(info.ID)
	if err != nil {
		t.Fatalf("Attach() error = %v", err)
	}
	defer attachment.Detach()

	if err := manager.Resize(info.ID, 101, 37); err != nil {
		t.Fatalf("Resize() error = %v", err)
	}
	if err := manager.Write(info.ID, []byte("stty size\nexit\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	waitForOutput(t, attachment, []byte("37 101"))
}

func TestSessionAttachReplaysOutputProducedBeforeAttachment(t *testing.T) {
	manager := newTestManager(t)
	info, err := manager.Create(CreateRequest{ProfileID: "sh", Cwd: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := manager.Write(info.ID, []byte("printf 'BEFORE_ATTACH\\n'\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		attachment, attachErr := manager.Attach(info.ID)
		if attachErr != nil {
			t.Fatalf("Attach() error = %v", attachErr)
		}
		if bytes.Contains(attachment.Replay, []byte("BEFORE_ATTACH")) {
			attachment.Detach()
			break
		}
		attachment.Detach()
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for pre-attachment output in replay")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := manager.Write(info.ID, []byte("exit\n")); err != nil {
		t.Fatalf("Write(exit) error = %v", err)
	}
}

func TestSessionAttachIsExclusiveAndDetachAllowsReattach(t *testing.T) {
	manager := newTestManager(t)
	info, err := manager.Create(CreateRequest{ProfileID: "sh", Cwd: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	first, err := manager.Attach(info.ID)
	if err != nil {
		t.Fatalf("first Attach() error = %v", err)
	}
	if _, err := manager.Attach(info.ID); !errors.Is(err, ErrAttached) {
		t.Fatalf("second Attach() error = %v, want %v", err, ErrAttached)
	}
	first.Detach()
	second, err := manager.Attach(info.ID)
	if err != nil {
		t.Fatalf("Attach() after detach error = %v", err)
	}
	second.Detach()
}

func TestSessionSlowSubscriberIsEvictedWithoutBlockingPTY(t *testing.T) {
	manager := newTestManager(t)
	info, err := manager.Create(CreateRequest{ProfileID: "sh", Cwd: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	first, err := manager.Attach(info.ID)
	if err != nil {
		t.Fatalf("Attach() error = %v", err)
	}
	defer first.Detach()

	command := "yes 012345678901234567890123456789 | head -c 4194304; printf '\\nSLOW_DONE\\n'; exit\n"
	if err := manager.Write(info.ID, []byte(command)); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	waitForSessionStatus(t, manager, info.ID, "exited")

	second, err := manager.Attach(info.ID)
	if err != nil {
		t.Fatalf("Attach() after slow subscriber error = %v", err)
	}
	defer second.Detach()
	if !bytes.Contains(second.Replay, []byte("SLOW_DONE")) {
		t.Fatalf("replay does not contain completion marker; replay length = %d", len(second.Replay))
	}
	if len(second.Replay) > ReplayBytes {
		t.Fatalf("replay length = %d, want at most %d", len(second.Replay), ReplayBytes)
	}
}

func TestManagerCreateEnforcesSessionLimit(t *testing.T) {
	manager := newTestManager(t)
	cwd := t.TempDir()
	for i := 0; i < MaxSessions; i++ {
		if _, err := manager.Create(CreateRequest{ProfileID: "sh", Cwd: cwd, Cols: 80, Rows: 24}); err != nil {
			t.Fatalf("Create() session %d error = %v", i+1, err)
		}
	}
	if _, err := manager.Create(CreateRequest{ProfileID: "sh", Cwd: cwd, Cols: 80, Rows: 24}); !errors.Is(err, ErrSessionLimit) {
		t.Fatalf("Create() over limit error = %v, want %v", err, ErrSessionLimit)
	}
}

func TestManagerRemoveStopsSessionAndDoesNotReuseID(t *testing.T) {
	manager := newTestManager(t)
	cwd := t.TempDir()
	first, err := manager.Create(CreateRequest{ProfileID: "sh", Cwd: cwd, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := manager.Write(first.ID, []byte("trap 'exit 0' TERM; while :; do sleep 1; done\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	if err := manager.Remove(first.ID); err != nil {
		t.Fatalf("Remove() error = %v", err)
	}
	if sessions := manager.List(); len(sessions) != 0 {
		t.Fatalf("List() after Remove = %+v, want empty", sessions)
	}
	if err := manager.Remove(first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second Remove() error = %v, want %v", err, ErrNotFound)
	}
	second, err := manager.Create(CreateRequest{ProfileID: "sh", Cwd: cwd, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("second Create() error = %v", err)
	}
	if first.ID == second.ID {
		t.Fatalf("removed session ID %q was reused", first.ID)
	}
}

func TestManagerCloseTerminatesSessionsAndRejectsCreate(t *testing.T) {
	manager := newTestManager(t)
	cwd := t.TempDir()
	for i := 0; i < 2; i++ {
		if _, err := manager.Create(CreateRequest{ProfileID: "sh", Cwd: cwd, Cols: 80, Rows: 24}); err != nil {
			t.Fatalf("Create() error = %v", err)
		}
	}
	if err := manager.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if err := manager.Close(); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}
	if _, err := manager.Create(CreateRequest{ProfileID: "sh", Cwd: cwd, Cols: 80, Rows: 24}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Create() after Close error = %v, want %v", err, ErrClosed)
	}
}

func TestManagerCopiesProfiles(t *testing.T) {
	args := []string{"-l"}
	input := []Profile{{ID: "sh", Name: "sh", Executable: "/bin/sh", Args: args, Default: true}}
	manager := NewManager(input)
	t.Cleanup(func() { _ = manager.Close() })
	input[0].Name = "mutated"
	args[0] = "mutated"

	first := manager.Profiles()
	first[0].Name = "caller mutation"
	first[0].Args[0] = "caller mutation"
	second := manager.Profiles()
	if second[0].Name != "sh" || len(second[0].Args) != 1 || second[0].Args[0] != "-l" {
		t.Fatalf("Profiles() = %+v, want immutable copied profile", second)
	}
}

func TestSessionEnvironmentReplacesTerminalKeys(t *testing.T) {
	environ := terminalEnvironment([]string{
		"PATH=/bin",
		"TERM=old",
		"TERM=duplicate",
		"COLORTERM=old",
		"TERM_PROGRAM=old",
	})
	want := map[string]string{
		"TERM":         "xterm-256color",
		"COLORTERM":    "truecolor",
		"TERM_PROGRAM": "Kin",
	}
	counts := make(map[string]int)
	for _, entry := range environ {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if expected, tracked := want[key]; tracked {
			counts[key]++
			if value != expected {
				t.Fatalf("%s value = %q, want %q", key, value, expected)
			}
		}
	}
	for key := range want {
		if counts[key] != 1 {
			t.Fatalf("%s count = %d, want 1", key, counts[key])
		}
	}
}

func waitForSessionStatus(t *testing.T, manager *Manager, id, status string) SessionInfo {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, info := range manager.List() {
			if info.ID == id && info.Status == status {
				return info
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for session %s status %q; sessions = %+v", id, status, manager.List())
	return SessionInfo{}
}

func waitForOutput(t *testing.T, attachment *Attachment, marker []byte) []byte {
	t.Helper()
	buffer := bytes.NewBuffer(append([]byte(nil), attachment.Replay...))
	if bytes.Contains(buffer.Bytes(), marker) {
		return buffer.Bytes()
	}
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case chunk, ok := <-attachment.Output:
			if !ok {
				t.Fatalf("output closed before marker %q; got %q", marker, buffer.Bytes())
			}
			buffer.Write(chunk)
			if bytes.Contains(buffer.Bytes(), marker) {
				return buffer.Bytes()
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for marker %q; got %q", marker, buffer.Bytes())
		}
	}
}

func waitForExit(t *testing.T, attachment *Attachment) int {
	t.Helper()
	select {
	case code, ok := <-attachment.Exit:
		if !ok {
			t.Fatal("exit channel closed before exit code")
		}
		return code
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for terminal exit")
		return 0
	}
}
