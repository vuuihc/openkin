package store

import (
	"context"
	"testing"
)

// A cwd is an address on one machine. A task that ran somewhere else must not
// seed this machine's suggestions: the same repository is usually checked out
// at the same path on both, so the suggestion looks right and quietly starts
// work in the wrong checkout.
func TestRecentCwdsSkipsDirectoriesFromOtherMachines(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	for _, task := range []struct {
		id        string
		cwd       string
		device    string
		createdAt int64
	}{
		{id: "here-old", cwd: "/code/old", createdAt: 1000},
		{id: "there", cwd: "/srv/theirs", device: "studio", createdAt: 4000},
		{id: "here-new", cwd: "/code/new", createdAt: 3000},
	} {
		var device any
		if task.device != "" {
			device = task.device
		}
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO tasks (id, title, agent, cwd, prompt, status, created_at, executing_device_id)
			VALUES (?, 'title', 'claude-code', ?, 'prompt', 'succeeded', ?, ?)`,
			task.id, task.cwd, task.createdAt, device); err != nil {
			t.Fatal(err)
		}
	}

	got, err := s.RecentCwds(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/code/new", "/code/old"}
	if len(got) != len(want) {
		t.Fatalf("recent cwds = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("recent cwds = %v, want %v", got, want)
		}
	}
}
