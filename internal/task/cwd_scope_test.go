package task

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/openkin/internal/store"
)

// cwdScopeFixture is a machine with an owner, a member, and one registered
// project, which is the smallest arrangement the rule has anything to say about.
type cwdScopeFixture struct {
	e        *Engine
	st       *store.Store
	ownerID  string
	memberID string
	project  string // the registered project root, a real directory
	home     string // the holder's home: a real directory that is not a project
}

func newCwdScopeFixture(t *testing.T) cwdScopeFixture {
	t.Helper()
	e, st := testEngine(t, 1, &fakeAdapter{})
	f := cwdScopeFixture{e: e, st: st}
	// Two directories that both exist, so the only thing separating them is
	// whether the holder registered one.
	base := t.TempDir()
	f.project = filepath.Join(base, "project")
	f.home = filepath.Join(base, "home")
	for _, dir := range []string{f.project, f.home} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	f.ownerID = f.addUser(t, "owner@example.com", store.RoleOwner)
	f.memberID = f.addUser(t, "member@example.com", store.RoleMember)
	if err := st.InsertProject(context.Background(), store.Project{
		ID: ulid.Make().String(), Name: "the project", Mode: store.ProjectModeShip, Status: "active",
		OnePagerRel: "ONEPAGER.md",
	}, []string{f.project}); err != nil {
		t.Fatalf("register the project: %v", err)
	}
	return f
}

func (f cwdScopeFixture) addUser(t *testing.T, email, role string) string {
	t.Helper()
	id := ulid.Make().String()
	err := f.st.CreateUserWithIdentity(context.Background(),
		store.User{ID: id, Email: email, Role: role, CreatedAt: store.NowMilli(), EmailSource: store.ProviderPassword},
		store.UserIdentity{
			ID: ulid.Make().String(), UserID: id, Provider: store.ProviderPassword,
			Subject: email, Label: "password", CreatedAt: store.NowMilli(),
		})
	if err != nil {
		t.Fatalf("create the %s account: %v", role, err)
	}
	return id
}

// create asks the engine for a task and returns the error, which is the whole
// subject here: whether the directory was accepted.
func (f cwdScopeFixture) create(t *testing.T, cwd, ownerUserID, device string) error {
	t.Helper()
	_, err := f.e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: cwd, Prompt: "hi",
		OwnerUserID: ownerUserID, ExecutingDeviceID: device,
	})
	return err
}

// S2's acceptance criterion, at the layer that decides it: the holder's own
// directory is not somewhere a member may start work, and a registered project
// is. Both halves are asserted together, because a refusal that also refuses the
// registered project is a broken picker rather than a boundary.
func TestAMemberMayOnlyStartWorkInARegisteredProject(t *testing.T) {
	f := newCwdScopeFixture(t)

	err := f.create(t, f.home, f.memberID, "")
	if err == nil {
		t.Fatal("a member started a task in the holder's directory; there is no bound on where a member may run an agent")
	}
	if !strings.Contains(err.Error(), "project") {
		t.Fatalf("the refusal does not say what would fix it: %v", err)
	}
	// The registered project, and a directory inside it: a project root is where
	// checkouts live, so containment is the rule rather than equality.
	inside := filepath.Join(f.project, "checkout")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for _, cwd := range []string{f.project, inside} {
		if err := f.create(t, cwd, f.memberID, ""); err != nil {
			t.Fatalf("a member was refused a registered project %s: %v", cwd, err)
		}
	}
}

// The other three callers, none of which is a guest: each has to keep working
// exactly as before. A guard that confines the owner, or a paired phone, or a
// daemon with no accounts at all, breaks the product to close a hole.
func TestTheCwdBoundDoesNotApplyToWhoeverHoldsTheMachine(t *testing.T) {
	f := newCwdScopeFixture(t)

	cases := []struct {
		name        string
		ownerUserID string
		why         string
	}{
		{"the owner account", f.ownerID,
			"the owner registered the projects, so they may work outside them"},
		{"no account at all", "",
			"a standalone daemon has no second person to defend against, and unowned tasks belong to its holder"},
		{"a refused account id", "01JZZZZZZZZZZZZZZZZZZZZZZZ",
			"an id that resolves to no row must fail closed, not open"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := f.create(t, f.home, tc.ownerUserID, "")
			switch tc.name {
			case "a refused account id":
				if err == nil {
					t.Fatalf("an unresolvable account was treated as holding the machine")
				}
			default:
				if err != nil {
					t.Fatalf("%s, but the task was refused: %v (%s)", tc.why, err, tc.name)
				}
			}
		})
	}
}

// The phone is the control arm this rule most easily breaks. A paired device
// authenticates as a device principal, which carries no UserID, so its tasks
// have no owner account — and a device was paired by the holder, so it acts for
// them. If that ever changes, this is the test that says so.
func TestAPairedDeviceIsNotConfinedByTheProjectList(t *testing.T) {
	f := newCwdScopeFixture(t)
	if err := f.create(t, f.home, "", ""); err != nil {
		t.Fatalf("a device-created task was confined: %v", err)
	}
}

// A task dispatched to another machine names a path there, and that machine
// enforces its own roots. Judging it by this machine's projects would refuse a
// directory that is valid where the work actually runs, so the holder's
// dispatch is left to the receiving machine.
func TestTheHoldersDispatchIsJudgedByTheMachineThatRunsIt(t *testing.T) {
	f := newCwdScopeFixture(t)
	if err := f.create(t, f.home, f.ownerID, "node-somewhere-else"); err != nil {
		t.Fatalf("the holder's dispatch was judged by this machine's projects: %v", err)
	}
}

// The other half, and the reason the exemption is not simply "a remote device
// skips the check": the guard is a bound on *this* machine's directories, so a
// request that leaves for another machine leaves the bound behind, and the
// receiving machine's roots are not this machine's projects — they are its own
// projects plus its checkout root plus whatever it was started with. A member
// cannot enumerate machines (that list is holderOnly), so naming one is not a
// choice the product offers them, and accepting it would let a member who
// learned an id choose which list their directory is judged by.
//
// The cwd used here is the *registered project*, deliberately: the refusal has
// to be about naming a machine, not about the directory, or this test would
// pass for the same reason the bound does.
func TestAMemberCannotSendWorkToAnotherMachine(t *testing.T) {
	f := newCwdScopeFixture(t)
	err := f.create(t, f.project, f.memberID, "node-somewhere-else")
	if err == nil {
		t.Fatal("a member sent work to another machine; the cwd bound does not follow it there")
	}
	if !strings.Contains(err.Error(), "holds this machine") {
		t.Fatalf("the refusal does not say who may do this: %v", err)
	}
	// And with no machine named, that same directory is still fine — otherwise
	// this test would be passing on a broken fixture.
	if err := f.create(t, f.project, f.memberID, ""); err != nil {
		t.Fatalf("a member was refused a registered project: %v", err)
	}
}

// Naming this machine is not naming another one, and the two answers to "is this
// device me" are built from one identity: internal/server gives the API its
// DesktopID and the engine its self device from the same value. If those ever
// disagreed, a member naming the Hub they are already talking to would leave the
// bound behind and run right here. So the id that means "here" is asserted to be
// bound exactly like a request that named nothing.
func TestAMemberNamingThisMachineIsStillBound(t *testing.T) {
	f := newCwdScopeFixture(t)
	f.e.SetRemoteRunner("desktop-self", nil)

	err := f.create(t, f.home, f.memberID, "desktop-self")
	if err == nil {
		t.Fatal("a member naming this machine skipped the cwd bound")
	}
	if !strings.Contains(err.Error(), "project") {
		t.Fatalf("the refusal is not the project bound: %v", err)
	}
	// The holder is not confined by naming their own machine, so the refusal
	// above is about the account and not about the field being set at all.
	if err := f.create(t, f.home, f.ownerID, "desktop-self"); err != nil {
		t.Fatalf("the holder was confined by naming their own machine: %v", err)
	}
}

// A project root is a directory, and the check is containment by path segment.
// Two spellings that a string prefix test gets wrong, both of which would hand a
// member a directory the holder never registered.
func TestTheCwdBoundIsNotAStringPrefix(t *testing.T) {
	f := newCwdScopeFixture(t)

	// A sibling of the project whose name begins with it.
	sibling := f.project + "2"
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := f.create(t, sibling, f.memberID, ""); err == nil {
		t.Fatalf("%s was accepted as inside %s; the check is comparing strings", sibling, f.project)
	}
	// A ".." that leaves the project without changing its prefix.
	escape := filepath.Join(f.project, "..", filepath.Base(f.home))
	if err := f.create(t, escape, f.memberID, ""); err == nil {
		t.Fatalf("%s was accepted; a path is being compared as written rather than as it resolves", escape)
	}
}

// A symlink inside a registered project that points out of it is how a checkout
// carries work past the boundary while every prefix check still says yes.
func TestASymlinkOutOfAProjectIsRefused(t *testing.T) {
	f := newCwdScopeFixture(t)
	link := filepath.Join(f.project, "escape")
	if err := os.Symlink(f.home, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if err := f.create(t, link, f.memberID, ""); err == nil {
		t.Fatal("a symlink out of the project was accepted as inside it")
	}
	if err := f.create(t, filepath.Join(link, "sub"), f.memberID, ""); err == nil {
		t.Fatal("a path reached through a symlink out of the project was accepted")
	}
}

// No projects registered is not "anywhere". The direction matters: read the
// other way, a member on a Hub the holder has not curated yet could start work
// anywhere on the disk.
func TestAMemberIsRefusedWhenNoProjectIsRegistered(t *testing.T) {
	e, st := testEngine(t, 1, &fakeAdapter{})
	id := ulid.Make().String()
	if err := st.CreateUserWithIdentity(context.Background(),
		store.User{ID: id, Email: "member@example.com", Role: store.RoleMember, CreatedAt: store.NowMilli()},
		store.UserIdentity{
			ID: ulid.Make().String(), UserID: id, Provider: store.ProviderPassword,
			Subject: "member@example.com", Label: "password", CreatedAt: store.NowMilli(),
		}); err != nil {
		t.Fatalf("create the member: %v", err)
	}
	dir := t.TempDir()
	_, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: dir, Prompt: "hi", OwnerUserID: id,
	})
	if err == nil {
		t.Fatal("with no projects registered a member started work anywhere on the disk")
	}
}
