package store

import (
	"context"
	"strings"
	"testing"
)

func anchorTestDevice(t *testing.T, s *Store, id string) {
	t.Helper()
	if err := s.RecordDeviceHello(context.Background(), id, Device{Label: id}, nil, 1000); err != nil {
		t.Fatal(err)
	}
}

// The point of anchors: a workspace recorded on one machine resolves on another
// machine that has the same repository checked out somewhere else.
func TestGitAnchorResolvesOnEveryDeviceThatHasTheRepository(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchorTestDevice(t, s, "laptop")
	anchorTestDevice(t, s, "studio")

	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", []ReportedRoot{
		{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: AnchorRepoRoot},
	}, 1000); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordDeviceWorkspaceRoots(ctx, "studio", []ReportedRoot{
		{Path: "/srv/checkouts/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: AnchorRepoRoot},
	}, 1000); err != nil {
		t.Fatal(err)
	}

	// A task in a subdirectory, created while looking at the laptop.
	sub, _, ok, err := s.MatchDeviceRoot(ctx, "laptop", "/code/openkin/internal/task", 2000)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("the laptop's own checkout did not match its subdirectory")
	}
	if sub.Kind != AnchorGitRemote || sub.RemoteURL != "github.com/vuuihc/openkin" ||
		sub.RelativePath != "internal/task" {
		t.Fatalf("anchor=%+v", sub)
	}

	// It resolves on the machine that made it, exactly...
	got, ok, err := s.ResolveAnchorPath(ctx, sub, "laptop")
	if err != nil || !ok {
		t.Fatalf("resolve on laptop: ok=%v err=%v", ok, err)
	}
	if got != "/code/openkin/internal/task" {
		t.Fatalf("laptop path=%q", got)
	}

	// ...and on a machine that never saw that subdirectory, through the checkout
	// it did report. This is the whole reason the table exists.
	got, ok, err = s.ResolveAnchorPath(ctx, sub, "studio")
	if err != nil || !ok {
		t.Fatalf("resolve on studio: ok=%v err=%v", ok, err)
	}
	if got != "/srv/checkouts/openkin/internal/task" {
		t.Fatalf("studio path=%q", got)
	}

	// A machine with no checkout of that repository cannot resolve it, and says
	// so rather than guessing.
	anchorTestDevice(t, s, "nas")
	if _, ok, err := s.ResolveAnchorPath(ctx, sub, "nas"); err != nil || ok {
		t.Fatalf("nas resolved a workspace it does not have: ok=%v err=%v", ok, err)
	}
	devices, err := s.DevicesWithAnchor(ctx, sub)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(devices, ",") != "laptop,studio" {
		t.Fatalf("devices=%v", devices)
	}
}

// A directory that is not a checkout is not portable: the same name on another
// machine is a different workspace, so it must not resolve there.
func TestDevicePathAnchorResolvesOnlyWhereItWasDeclared(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchorTestDevice(t, s, "laptop")
	anchorTestDevice(t, s, "studio")

	anchor, err := s.EnsureDeviceAnchor(ctx, "laptop", "/code/scratch", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if anchor.Kind != AnchorDevicePath {
		t.Fatalf("kind=%q", anchor.Kind)
	}
	// Idempotent: the same directory on the same device is one anchor.
	again, err := s.EnsureDeviceAnchor(ctx, "laptop", "/code/scratch", 1500)
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != anchor.ID {
		t.Fatalf("second call made a new anchor: %s vs %s", again.ID, anchor.ID)
	}

	got, ok, err := s.ResolveAnchorPath(ctx, anchor, "laptop")
	if err != nil || !ok || got != "/code/scratch" {
		t.Fatalf("laptop: got=%q ok=%v err=%v", got, ok, err)
	}
	if _, ok, err := s.ResolveAnchorPath(ctx, anchor, "studio"); err != nil || ok {
		t.Fatalf("studio resolved a directory it never declared: ok=%v err=%v", ok, err)
	}
}

// A hello is a snapshot. A machine that moved its checkouts must stop being
// handed work at the paths it used to have.
func TestRecordDeviceRootsReplacesTheSnapshot(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchorTestDevice(t, s, "laptop")

	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", []ReportedRoot{
		{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: AnchorRepoRoot},
		{Path: "/code/scratch"},
	}, 1000); err != nil {
		t.Fatal(err)
	}
	scratch, err := s.EnsureDeviceAnchor(ctx, "laptop", "/code/scratch", 1100)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.ResolveAnchorPath(ctx, scratch, "laptop"); err != nil || !ok {
		t.Fatalf("device path did not resolve before the move: ok=%v err=%v", ok, err)
	}

	// The machine reports again: the scratch directory is gone.
	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", []ReportedRoot{
		{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: AnchorRepoRoot},
	}, 2000); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.ResolveAnchorPath(ctx, scratch, "laptop"); err != nil || ok {
		t.Fatalf("a dropped root still resolves: ok=%v err=%v", ok, err)
	}
	// The anchor row for a dropped directory goes with it, so nothing can point
	// at a workspace that no machine has.
	if _, err := s.GetWorkspaceAnchor(ctx, scratch.ID); err == nil {
		t.Fatal("the orphaned device anchor survived")
	}
	// The repository anchor is shared identity, not this device's snapshot.
	anchor, err := s.EnsureGitAnchor(ctx, "github.com/vuuihc/openkin", AnchorRepoRoot, 2100)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.ResolveAnchorPath(ctx, anchor, "laptop"); err != nil || !ok {
		t.Fatalf("the repository checkout stopped resolving: ok=%v err=%v", ok, err)
	}
}

func TestAnchorPrefixMatchingIsBySegment(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchorTestDevice(t, s, "laptop")
	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", []ReportedRoot{
		{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: "sub"},
	}, 1000); err != nil {
		t.Fatal(err)
	}

	// "subway" is not inside "sub".
	other, err := s.EnsureGitAnchor(ctx, "github.com/vuuihc/openkin", "subway", 1100)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.ResolveAnchorPath(ctx, other, "laptop"); err != nil || ok {
		t.Fatalf("a sibling directory resolved through a prefix: ok=%v err=%v", ok, err)
	}
	// A descendant is.
	inside, err := s.EnsureGitAnchor(ctx, "github.com/vuuihc/openkin", "sub/dir", 1100)
	if err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.ResolveAnchorPath(ctx, inside, "laptop")
	if err != nil || !ok || got != "/code/openkin/sub/dir" {
		t.Fatalf("descendant: got=%q ok=%v err=%v", got, ok, err)
	}
}

func TestEnsureGitAnchorIsIdempotentAndNormalized(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	first, err := s.EnsureGitAnchor(ctx, "github.com/vuuihc/openkin", "./internal/task/", 1000)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.EnsureGitAnchor(ctx, "github.com/vuuihc/openkin", "internal/task", 2000)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID {
		t.Fatalf("same workspace made two anchors: %s vs %s", first.ID, second.ID)
	}
	if second.RelativePath != "internal/task" {
		t.Fatalf("relative=%q", second.RelativePath)
	}
	if root, err := s.EnsureGitAnchor(ctx, "github.com/vuuihc/openkin", "", 2000); err != nil {
		t.Fatal(err)
	} else if root.RelativePath != AnchorRepoRoot {
		t.Fatalf("root relative=%q", root.RelativePath)
	}
}

// Anchors travel through the Hub's database to every machine, so a remote URL
// that still carries a credential must never be stored (ADR 0022 D7).
func TestEnsureGitAnchorRefusesANonCanonicalRemote(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	for _, remote := range []string{
		"https://x-access-token:ghp_secret@github.com/vuuihc/openkin",
		"git@github.com:vuuihc/openkin.git",
		"ssh://git@github.com:22/vuuihc/openkin",
		"github.com/vuuihc/openkin/",
	} {
		if _, err := s.EnsureGitAnchor(ctx, remote, AnchorRepoRoot, 1000); err == nil {
			t.Fatalf("EnsureGitAnchor(%q) accepted a non-canonical remote", remote)
		}
	}
	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", []ReportedRoot{
		{Path: "/code/openkin", RemoteURL: "https://token@github.com/vuuihc/openkin"},
	}, 1000); err == nil {
		t.Fatal("RecordDeviceWorkspaceRoots accepted a remote with a credential")
	}
}

// A task's anchor is part of the row, so it survives a read the same way the
// executing device does.
func TestTaskRowCarriesTheWorkspaceAnchor(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchor, err := s.EnsureGitAnchor(ctx, "github.com/vuuihc/openkin", "internal/task", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.InsertTask(ctx, Task{
		ID: "task-1", Title: "t", Agent: "claude-code", Cwd: "/code/openkin/internal/task",
		Prompt: "p", Status: "queued", CreatedAt: 1000,
		ExecutingDeviceID: "laptop", WorkspaceAnchorID: anchor.ID,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetTask(ctx, "task-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkspaceAnchorID != anchor.ID {
		t.Fatalf("anchor=%q want %q", got.WorkspaceAnchorID, anchor.ID)
	}
	if got.ExecutingDeviceID != "laptop" {
		t.Fatalf("device=%q", got.ExecutingDeviceID)
	}
}
