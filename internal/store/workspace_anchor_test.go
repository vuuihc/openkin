package store

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/remote/worker"
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

// A path inside a checkout that names its way out of it is not a path inside
// it. The Hub cannot see the directory, so the only check available is on the
// text — and a stored ".." would be an identity for one workspace that resolves
// to a directory in another.
func TestWorkspacePathsCannotLeaveTheirCheckout(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchorTestDevice(t, s, "laptop")

	for _, relative := range []string{"..", "../elsewhere", "sub/../../out", `..\out`, "./../out"} {
		if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", []ReportedRoot{
			{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: relative},
		}, 1000); err == nil {
			t.Fatalf("a device reported relative path %q and the hub stored it", relative)
		}
	}
	// A path that steps up and back down again never left the checkout: it is the
	// directory it names, so it is normalized rather than refused.
	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", []ReportedRoot{
		{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: "internal/.."},
	}, 1000); err != nil {
		t.Fatal(err)
	}
	if anchor, _, ok, err := s.MatchDeviceRoot(ctx, "laptop", "/code/openkin", 2000); err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	} else if anchor.RelativePath != AnchorRepoRoot {
		t.Fatalf("relative path = %q", anchor.RelativePath)
	}

	// A path with a "." in it is inside the checkout and cleans to where it
	// names, so it is kept rather than refused.
	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", []ReportedRoot{
		{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: "./internal/./task"},
	}, 1000); err != nil {
		t.Fatal(err)
	}
	anchor, _, ok, err := s.MatchDeviceRoot(ctx, "laptop", "/code/openkin/internal/task", 2000)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if anchor.RelativePath != "internal/task" {
		t.Fatalf("relative path = %q", anchor.RelativePath)
	}
	if _, err := s.EnsureGitAnchor(ctx, "github.com/vuuihc/openkin", "../out", 3000); err == nil {
		t.Fatal("an anchor was created for a path outside the checkout")
	}
}

// A cwd typed with a ".." in it names a directory, and that is the directory
// the hub has to match: matching the text instead would anchor a path that
// starts with a root while pointing somewhere else entirely.
func TestTypedCwdIsMatchedAsTheDirectoryItNames(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchorTestDevice(t, s, "laptop")
	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", []ReportedRoot{
		{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: AnchorRepoRoot},
	}, 1000); err != nil {
		t.Fatal(err)
	}

	// Inside the checkout, written the long way round.
	anchor, checkout, ok, err := s.MatchDeviceRoot(ctx, "laptop", "/code/openkin/internal/../internal/task", 2000)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if anchor.RelativePath != "internal/task" || checkout != "/code/openkin" {
		t.Fatalf("anchor=%+v checkout=%q", anchor, checkout)
	}
	// Outside it, written to look like it is inside.
	if _, _, ok, err := s.MatchDeviceRoot(ctx, "laptop", "/code/openkin/../elsewhere", 2000); err != nil || ok {
		t.Fatalf("a path that walks out of the checkout matched a root: ok=%v err=%v", ok, err)
	}
}

// A device-path anchor is identified by the root row that names it, so a repeat
// hello has to find the anchor it wrote last time. Minting a new one would leave
// every task that points at the old id referring to an anchor nothing resolves —
// and a hello happens on every reconnect.
func TestADevicePathAnchorSurvivesARepeatHello(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchorTestDevice(t, s, "laptop")
	roots := []ReportedRoot{{Path: "/code/scratch"}}

	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", roots, 1000); err != nil {
		t.Fatal(err)
	}
	first, _, ok, err := s.MatchDeviceRoot(ctx, "laptop", "/code/scratch", 1000)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}

	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", roots, 2000); err != nil {
		t.Fatal(err)
	}
	second, _, ok, err := s.MatchDeviceRoot(ctx, "laptop", "/code/scratch", 2000)
	if err != nil || !ok {
		t.Fatalf("after a second hello: ok=%v err=%v", ok, err)
	}
	if second.ID != first.ID {
		t.Fatalf("the anchor changed identity across a hello: %s then %s", first.ID, second.ID)
	}
	// And the id a task was created with still resolves.
	if _, err := s.GetWorkspaceAnchor(ctx, first.ID); err != nil {
		t.Fatalf("the anchor a task points at is gone: %v", err)
	}
	// A directory the device stops reporting does go, along with its anchor.
	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", nil, 3000); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetWorkspaceAnchor(ctx, first.ID); !errors.Is(err, ErrAnchorNotFound) {
		t.Fatalf("a root the device no longer reports kept its anchor: %v", err)
	}
}

// Two checkouts of one repository on one machine are two answers to "where does
// this repository live here". Neither is right, so the device keeps neither and
// the workspace stops resolving: a turn must not be handed a checkout the task
// never named.
func TestTwoCheckoutsOfOneRepositoryDoNotResolve(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchorTestDevice(t, s, "laptop")
	anchorTestDevice(t, s, "studio")
	if err := s.RecordDeviceWorkspaceRoots(ctx, "studio", []ReportedRoot{
		{Path: "/srv/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: AnchorRepoRoot},
	}, 1000); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", []ReportedRoot{
		{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: AnchorRepoRoot},
		{Path: "/code/openkin-worktree", RemoteURL: "github.com/vuuihc/openkin", RelativePath: AnchorRepoRoot},
	}, 1000); err != nil {
		t.Fatal(err)
	}

	anchor, err := s.EnsureGitAnchor(ctx, "github.com/vuuihc/openkin", "internal/task", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.ResolveAnchorPath(ctx, anchor, "laptop"); err != nil || ok {
		t.Fatalf("a second checkout did not stop the laptop resolving: ok=%v err=%v", ok, err)
	}
	// The machine with one checkout is unaffected: this is a refusal about one
	// device's answer, not about the repository.
	got, ok, err := s.ResolveAnchorPath(ctx, anchor, "studio")
	if err != nil || !ok {
		t.Fatalf("studio: ok=%v err=%v", ok, err)
	}
	if got != "/srv/openkin/internal/task" {
		t.Fatalf("studio path = %q", got)
	}
	devices, err := s.DevicesWithAnchor(ctx, anchor)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(devices, ",") != "studio" {
		t.Fatalf("devices = %v", devices)
	}
}

// The same checkout reported twice is one answer, not an ambiguity.
func TestTheSameCheckoutReportedTwiceStillResolves(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	anchorTestDevice(t, s, "laptop")
	if err := s.RecordDeviceWorkspaceRoots(ctx, "laptop", []ReportedRoot{
		{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: AnchorRepoRoot},
		{Path: "/code/openkin/", RemoteURL: "github.com/vuuihc/openkin", RelativePath: AnchorRepoRoot},
	}, 1000); err != nil {
		t.Fatal(err)
	}
	anchor, err := s.EnsureGitAnchor(ctx, "github.com/vuuihc/openkin", AnchorRepoRoot, 1000)
	if err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.ResolveAnchorPath(ctx, anchor, "laptop")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if got != "/code/openkin" {
		t.Fatalf("resolved = %q", got)
	}
}

// A device reaches the store only through the wire, so the two checks on what it
// may report have to agree in the direction that matters: whatever the wire
// accepts, the store must accept too. A rule the store has and the wire lacks is
// not a second opinion — it is a machine refused at the door for one bad root,
// after it has already said hello.
func TestTheWireNeverAcceptsWhatTheStoreRefuses(t *testing.T) {
	cases := []struct {
		remote   string
		relative string
	}{
		{remote: "github.com/vuuihc/openkin"},
		{remote: "gitlab.com/group/sub/repo", relative: "internal/task"},
		{remote: "", relative: "plain/dir"},
		{remote: "github.com/vuuihc/openkin", relative: "."},
		{remote: "github.com/vuuihc/openkin", relative: "./internal/./task"},
		{remote: "github.com/vuuihc/openkin", relative: `internal\task`},
		{remote: "github.com/vuuihc/openkin", relative: "internal/.."},
		{remote: "github.com/vuuihc/openkin?token=ghp_secret"},
		{remote: "github.com/vuuihc/openkin#main"},
		{remote: "https://github.com/vuuihc/openkin"},
		{remote: "git@github.com:vuuihc/openkin.git"},
		{remote: "/srv/repo"},
		{remote: "github.com/vuuihc/openkin/"},
		{remote: `github.com\vuuihc\openkin`},
		{remote: "github.com/vuuihc/openkin", relative: ".."},
		{remote: "github.com/vuuihc/openkin", relative: `..\etc`},
		{remote: "github.com/vuuihc/openkin", relative: "sub/../../out"},
	}
	for _, tc := range cases {
		root := worker.WorkspaceRoot{Path: "/code/openkin", RemoteURL: tc.remote, RelativePath: tc.relative}
		if err := root.Validate(); err != nil {
			// The wire refusing is fine: the store is never consulted.
			continue
		}
		if tc.remote != "" {
			if err := validateCanonicalRemote(tc.remote); err != nil {
				t.Errorf("the wire accepted remote %q and the store refuses it: %v", tc.remote, err)
			}
		}
		if _, err := cleanAnchorRel(tc.relative); err != nil {
			t.Errorf("the wire accepted relative path %q and the store refuses it: %v", tc.relative, err)
		}
	}
}
