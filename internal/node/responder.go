package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/vuuihc/openkin/internal/github"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/workspace"
)

// ObserveFunc reads one branch's pull request for whoever asks about it.
// github.ObserveHere is the one a real machine uses; see Responder.Observe.
type ObserveFunc func(ctx context.Context, repo github.Repo, branch string) (github.LookupResult, error)

// Responder answers questions the Hub asks about this machine.
//
// The console on a phone picks a machine, and everything picked after that — a
// working directory, a repository, a branch — lives on the machine, which the
// Hub cannot read. So the Hub asks down the channel the machine already dialled
// in on, and this answers, in this machine's own words (see worker.Query).
//
// The vocabulary is a closed table, and every question is checked against the
// directories this machine agreed to work in — the same rule the Executor
// applies before it runs a turn, read from the same place (see rootSet). A Hub
// is another party and cannot be trusted to bound itself: it may be running on
// somebody else's NAS, and the only party that knows where this machine's
// boundary is, is this machine.
type Responder struct {
	// Roots is the directories this machine works in, as `kin` was configured.
	// No roots means nowhere: an empty declaration must not read as "anywhere".
	Roots []string
	// CheckoutRoot is where this machine keeps the repositories it fetches for
	// a console that cannot reach them itself. Empty means it does not fetch any,
	// and the two repo questions are refused.
	//
	// It is expected to be one of Roots — the daemon adds it to the machine's
	// declaration, because a checkout is only useful as a working directory, and
	// a working directory outside the roots is one the Executor refuses. That is
	// enforced rather than assumed: see repoPrepare.
	CheckoutRoot string
	// Workspace reads checkouts on this machine: the branches a directory has,
	// and switching between them. Nil means the two git questions are refused —
	// a machine with no git has no answers about branches.
	Workspace *workspace.Manager
	// Observe reads one branch's pull request from this machine. Nil means it is
	// read the way a person sitting at this machine would read it: its own GitHub
	// CLI first, because those are the credentials that see private
	// repositories, then a credential-free read of the public API.
	//
	// It is a field because what a machine can see is decided where the machine
	// is built — its CLI, its login, its network, and which GitHub host it talks
	// to — rather than inside the question.
	Observe ObserveFunc
	// CreateBranch starts a branch in one of this machine's checkouts. Nil means
	// its own workspace manager does it.
	CreateBranch BranchCreateFunc
	// Publish pushes one of this machine's branches and opens its pull request.
	// Nil means this machine does it itself: its own git, its own GitHub CLI.
	//
	// It is a field for the same reason Observe is: whether a machine can publish
	// at all — a credential helper, an ssh agent, a gh that is logged in — is
	// decided where the machine is built, not inside the question.
	Publish PublishFunc
	// Warn receives problems that have nowhere else to go. Nil means quiet.
	Warn func(format string, args ...any)

	mu       sync.Mutex
	send     WriteFunc
	checkout *workspace.Checkouts
}

// localQueryID is the id given to an answer that is never sent anywhere.
//
// This machine's own console asks the same questions the Hub asks, and it is
// answered by the same code with the same envelope, so that the two cannot
// drift. The id is what an answer carries back to a question; for a question
// asked in process there is nothing to carry it back to.
const localQueryID = "local"

// SetSender installs the connection's write path, and nil when the connection
// ends. Questions that arrive while there is nowhere to answer are warned
// about rather than held: the Hub gives up on them the moment the connection
// ends (see Queries.Abandon).
func (r *Responder) SetSender(send WriteFunc) {
	r.mu.Lock()
	r.send = send
	r.mu.Unlock()
}

func (r *Responder) sender() WriteFunc {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.send
}

func (r *Responder) warn(format string, args ...any) {
	if r.Warn != nil {
		r.Warn(format, args...)
	}
}

// Handle takes one question and answers it.
//
// It returns as soon as the question is understood, and the answer is worked
// out on its own goroutine. This runs on the connection's read loop, and a
// listing is a walk over a directory that may be large or slow: answering here
// would stop this machine hearing everything else, including the cancel for a
// turn it is running.
func (r *Responder) Handle(ctx context.Context, frame worker.Frame) error {
	if frame.Kind != "query" {
		return fmt.Errorf("node does not handle frame kind %q", frame.Kind)
	}
	query, err := Decode[worker.Query](frame)
	if err != nil {
		return err
	}
	// Shape only: which methods exist is this machine's vocabulary, and a
	// question it does not know is answered as such rather than dropped at the
	// door. Silence would leave the Hub waiting for a timeout it cannot explain.
	if err := query.Validate(); err != nil {
		return err
	}
	go func() {
		result := r.answer(ctx, query.ID, query.Method, query.Params)
		send := r.sender()
		if send == nil {
			r.warn("nowhere to send the answer to question %s", result.ID)
			return
		}
		answer, err := worker.NewFrame("query.result", result)
		if err != nil {
			r.warn("the answer to question %s cannot be sent: %v", result.ID, err)
			return
		}
		if err := send(ctx, answer); err != nil {
			// The Hub has already given up on this question: it abandons every
			// question on a connection the moment that connection ends.
			r.warn("could not send the answer to question %s: %v", result.ID, err)
		}
	}()
	return nil
}

// Ask answers one question about this machine, in process.
//
// It is the same answer Handle produces, with the same envelope and the same
// words, for the console that is looking at this machine directly: a bug in one
// path is a bug in both, which is the point.
func (r *Responder) Ask(ctx context.Context, method string, params json.RawMessage) worker.QueryResult {
	return r.answer(ctx, localQueryID, method, params)
}

// answer is the vocabulary of questions this machine can be asked.
//
// Every failure is an answer, not an error: a machine that cannot answer says
// why, in its own words, and the person reading them is looking at the machine
// that said no.
func (r *Responder) answer(ctx context.Context, id, method string, params json.RawMessage) worker.QueryResult {
	switch method {
	case worker.QueryListDirs:
		var asked worker.ListDirsParams
		if err := decodeParams(params, &asked); err != nil {
			return refused(id, err)
		}
		listed, err := r.listDirs(ctx, asked)
		if err != nil {
			return refused(id, err)
		}
		return answered(id, listed)
	case worker.QueryRepoBranches:
		var asked worker.RepoBranchesParams
		if err := decodeParams(params, &asked); err != nil {
			return refused(id, err)
		}
		found, err := r.repoBranches(ctx, asked)
		if err != nil {
			return refused(id, err)
		}
		return answered(id, found)
	case worker.QueryRepoPrepare:
		var asked worker.RepoPrepareParams
		if err := decodeParams(params, &asked); err != nil {
			return refused(id, err)
		}
		prepared, err := r.repoPrepare(ctx, asked)
		if err != nil {
			return refused(id, err)
		}
		return answered(id, prepared)
	case worker.QueryGitBranches:
		var asked worker.GitBranchesParams
		if err := decodeParams(params, &asked); err != nil {
			return refused(id, err)
		}
		found, err := r.gitBranches(ctx, asked)
		if err != nil {
			return refused(id, err)
		}
		return answered(id, found)
	case worker.QueryGitCheckout:
		var asked worker.GitCheckoutParams
		if err := decodeParams(params, &asked); err != nil {
			return refused(id, err)
		}
		switched, err := r.gitCheckout(ctx, asked)
		if err != nil {
			return refused(id, err)
		}
		return answered(id, switched)
	case worker.QueryGitBranchCreate:
		var asked worker.GitBranchCreateParams
		if err := decodeParams(params, &asked); err != nil {
			return refused(id, err)
		}
		created, err := r.branchCreate(ctx, asked)
		if err != nil {
			return refused(id, err)
		}
		return answered(id, created)
	case worker.QueryWorkspaceChanges:
		var asked worker.WorkspaceChangesParams
		if err := decodeParams(params, &asked); err != nil {
			return refused(id, err)
		}
		changed, err := r.workspaceChanges(ctx, asked)
		if err != nil {
			return refused(id, err)
		}
		return answered(id, changed)
	case worker.QueryWorkspaceTree:
		var asked worker.WorkspaceTreeParams
		if err := decodeParams(params, &asked); err != nil {
			return refused(id, err)
		}
		listed, err := r.workspaceTree(ctx, asked)
		if err != nil {
			return refused(id, err)
		}
		return answered(id, listed)
	case worker.QueryWorkspaceFile:
		var asked worker.WorkspaceFileParams
		if err := decodeParams(params, &asked); err != nil {
			return refused(id, err)
		}
		read, err := r.workspaceFile(ctx, asked)
		if err != nil {
			return refused(id, err)
		}
		return answered(id, read)
	case worker.QueryWorkspaceGit:
		var asked worker.WorkspaceGitParams
		if err := decodeParams(params, &asked); err != nil {
			return refused(id, err)
		}
		found, err := r.workspaceGit(ctx, asked)
		if err != nil {
			return refused(id, err)
		}
		return answered(id, found)
	case worker.QueryPRObserve:
		var asked worker.PRObserveParams
		if err := decodeParams(params, &asked); err != nil {
			return refused(id, err)
		}
		observed, err := r.observePR(ctx, asked)
		if err != nil {
			return refused(id, err)
		}
		return answered(id, observed)
	case worker.QueryPRPublish:
		var asked worker.PRPublishParams
		if err := decodeParams(params, &asked); err != nil {
			return refused(id, err)
		}
		published, err := r.publishPR(ctx, asked)
		if err != nil {
			return refused(id, err)
		}
		return answered(id, published)
	default:
		return refused(id, fmt.Errorf("this machine does not know the question %q", method))
	}
}

// repoBranches answers what branches one repository has.
//
// It does not need the repository to be here, and that is the point: a person
// choosing a branch has not paid for a clone yet, and the branches a remote
// offers are knowable without one.
func (r *Responder) repoBranches(ctx context.Context, asked worker.RepoBranchesParams) (worker.RepoBranchesResult, error) {
	checkouts, err := r.checkouts()
	if err != nil {
		return worker.RepoBranchesResult{}, err
	}
	found, err := checkouts.RemoteBranches(ctx, asked.Repo)
	if err != nil {
		return worker.RepoBranchesResult{}, err
	}
	result := worker.RepoBranchesResult{CloneURL: found.CloneURL, DefaultBranch: found.DefaultBranch}
	// The bound is applied where the answer is built rather than where the remote
	// is read: how many branches a repository has is not this machine's to
	// decide, but how many of them fit in one answer is.
	if len(found.Branches) > worker.MaxBranches {
		found.Branches = found.Branches[:worker.MaxBranches]
		result.Truncated = true
	}
	result.Branches = found.Branches
	return result, nil
}

// repoPrepare makes one repository available on this machine and says where.
//
// The path it returns is the only path in this protocol that a later dispatch
// will be handed as a working directory, so it is checked the way a dispatched
// cwd is checked — against the roots this machine declared. Where the checkout
// goes is decided by the machine (see workspace.Checkouts), and this is the
// machine confirming that what it decided is somewhere it works.
func (r *Responder) repoPrepare(ctx context.Context, asked worker.RepoPrepareParams) (worker.RepoPrepareResult, error) {
	checkouts, err := r.checkouts()
	if err != nil {
		return worker.RepoPrepareResult{}, err
	}
	prepared, err := checkouts.EnsureCheckout(ctx, asked.Repo, asked.Branch)
	if err != nil {
		return worker.RepoPrepareResult{}, err
	}
	real, err := resolvePath(prepared.Path)
	if err != nil {
		return worker.RepoPrepareResult{}, fmt.Errorf("there is no %s on this machine", prepared.Path)
	}
	if !withinRoots(real, rootSet(r.Roots).resolved()) {
		return worker.RepoPrepareResult{}, outsideRoots(prepared.Path)
	}
	return worker.RepoPrepareResult{
		Path:   prepared.Path,
		Branch: prepared.Branch,
		Cloned: prepared.Cloned,
	}, nil
}

// gitBranches answers what is checked out in one of this machine's directories,
// and what else could be. It is a read of a directory that is here, which is
// what separates it from repo.branches: that one asks a remote, this one looks.
func (r *Responder) gitBranches(ctx context.Context, asked worker.GitBranchesParams) (worker.GitBranchesResult, error) {
	path, err := r.own(asked.Path)
	if err != nil {
		return worker.GitBranchesResult{}, err
	}
	git, err := r.workspaceFor("what a directory has checked out")
	if err != nil {
		return worker.GitBranchesResult{}, err
	}
	status, err := git.ListBranches(ctx, path)
	if err != nil {
		return worker.GitBranchesResult{}, err
	}
	result := worker.GitBranchesResult{
		Cwd:      status.Cwd,
		IsGit:    status.IsGit,
		Current:  status.Current,
		Detached: status.Detached,
		Dirty:    status.Dirty,
		// Never nil: a console reading this answer reads it as a list, and a
		// directory that is not a repository has an empty one rather than a
		// missing one.
		Branches: []worker.GitBranch{},
		Reason:   status.Reason,
	}
	// Bounded where the answer is built, on the same reasoning as the repo
	// listing: how many branches a checkout has is not this machine's to decide,
	// but how many fit in one answer is.
	branches := status.Branches
	if len(branches) > worker.MaxBranches {
		branches = branches[:worker.MaxBranches]
	}
	for _, b := range branches {
		result.Branches = append(result.Branches, worker.GitBranch{Name: b.Name, Current: b.Current})
	}
	return result, nil
}

// gitCheckout switches one of this machine's directories to a branch.
//
// The directory is one the person chose, so it is checked against the roots
// before anything is written in it — the same boundary a dispatched turn is
// held to, and the reason this cannot be used to rearrange a machine's files
// from a phone. What is inside that boundary is still the machine's business:
// a dirty checkout is refused by the workspace manager, not here.
func (r *Responder) gitCheckout(ctx context.Context, asked worker.GitCheckoutParams) (worker.GitCheckoutResult, error) {
	path, err := r.own(asked.Path)
	if err != nil {
		return worker.GitCheckoutResult{}, err
	}
	git, err := r.workspaceFor("what a directory has checked out")
	if err != nil {
		return worker.GitCheckoutResult{}, err
	}
	if err := git.CheckoutBranch(ctx, path, strings.TrimSpace(asked.Branch)); err != nil {
		return worker.GitCheckoutResult{}, err
	}
	// Read back rather than echo: the branch that is checked out is a fact about
	// the directory, and git is the one that knows it. A switch that named a
	// remote branch, for one, ends up somewhere other than where it was asked to
	// go.
	status, err := git.ListBranches(ctx, path)
	if err != nil {
		return worker.GitCheckoutResult{Cwd: path, Current: strings.TrimSpace(asked.Branch)}, nil
	}
	current := status.Current
	if current == "" {
		current = strings.TrimSpace(asked.Branch)
	}
	return worker.GitCheckoutResult{Cwd: status.Cwd, Current: current}, nil
}

// own resolves a path this machine was asked about and refuses one it does not
// work in.
//
// Both halves matter. Resolving first is what makes the check meaningful: a
// symlink planted inside a root would otherwise name a directory outside it
// while reading as though it were inside. And the check is the whole reason a
// Hub may not simply be believed — it names paths on a filesystem it does not
// own, and the only party that knows where this machine's boundary is, is this
// machine.
func (r *Responder) own(path string) (string, error) {
	real, err := resolvePath(path)
	if err != nil {
		return "", fmt.Errorf("there is no %s on this machine", strings.TrimSpace(path))
	}
	if !withinRoots(real, rootSet(r.Roots).resolved()) {
		return "", outsideRoots(path)
	}
	return path, nil
}

// workspaceFor is the git-backed reader this machine answers with, or the reason
// it has none.
//
// what names the thing that could not be answered, because the reason a machine
// gives for not answering is read by a person looking at a control that asked a
// specific question.
func (r *Responder) workspaceFor(what string) (*workspace.Manager, error) {
	if r.Workspace == nil {
		return nil, fmt.Errorf("this machine has no git, so it cannot say %s", what)
	}
	return r.Workspace, nil
}

// checkouts is where this machine fetches into, or the reason it does not.
func (r *Responder) checkouts() (*workspace.Checkouts, error) {
	if strings.TrimSpace(r.CheckoutRoot) == "" {
		return nil, errors.New("this machine has nowhere to fetch a repository into")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.checkout == nil {
		r.checkout = workspace.NewCheckouts(r.CheckoutRoot)
	}
	return r.checkout, nil
}

// listDirs answers what directories are inside a path on this machine.
func (r *Responder) listDirs(ctx context.Context, asked worker.ListDirsParams) (worker.ListDirsResult, error) {
	roots := rootSet(r.Roots)
	declared := roots.declared()
	path := strings.TrimSpace(asked.Path)

	// No path is not a directory: it is the question "where may I look at all",
	// and the answer is this machine's own declaration — including when that
	// declaration is empty, which is an answer and not a refusal.
	if path == "" {
		return worker.ListDirsResult{Roots: declared}, nil
	}
	if err := ctx.Err(); err != nil {
		return worker.ListDirsResult{}, err
	}
	if len(declared) == 0 {
		return worker.ListDirsResult{}, outsideRoots(path)
	}
	// The protocol already refused a relative path, and this is the same rule
	// stated where the boundary is enforced: it would be resolved against
	// whatever directory this daemon was started in, which is not a choice the
	// Hub gets to make.
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) {
		return worker.ListDirsResult{}, outsideRoots(path)
	}

	// Containment is decided on the real path, and the real path is only
	// available for something that exists. A path that is not there is refused
	// for that reason: it is the difference between a typo and a boundary, which
	// are two different things to tell a person.
	real, err := resolvePath(path)
	if err != nil {
		return worker.ListDirsResult{}, fmt.Errorf("there is no %s on this machine", path)
	}
	if !withinRoots(real, roots.resolved()) {
		return worker.ListDirsResult{}, outsideRoots(path)
	}
	info, err := os.Stat(real)
	if err != nil {
		return worker.ListDirsResult{}, fmt.Errorf("there is no %s on this machine", path)
	}
	if !info.IsDir() {
		return worker.ListDirsResult{}, fmt.Errorf("%s is a file, not a directory", path)
	}

	entries, truncated, err := r.readDir(ctx, roots, real)
	if err != nil {
		return worker.ListDirsResult{}, fmt.Errorf("read %s: %w", path, err)
	}
	return worker.ListDirsResult{
		// The path as it was asked, so a browser shows the way the person got
		// here rather than the way the filesystem resolves it.
		Path:      path,
		Parent:    r.parentOf(roots, path),
		Roots:     declared,
		Entries:   entries,
		Truncated: truncated,
	}, nil
}

// parentOf is what "up" means from one directory, or nothing at a root.
//
// The boundary is visible rather than an error: at the top of what this machine
// agreed to, a person sees no way up instead of a refusal after tapping one.
func (r *Responder) parentOf(roots rootSet, path string) string {
	parent := filepath.Dir(path)
	if parent == path {
		return ""
	}
	if !roots.contains(parent) {
		return ""
	}
	return parent
}

// readDir is the directories directly inside one path, by name, in name order.
//
// Directories only: this is how a person picks a working directory, not a file
// browser, and a machine that lists its files answers a question nobody asked.
// A name is left out when it is not a directory this machine works in — a
// symlink checked into a repository points wherever it likes, and offering a
// name that is refused the moment it is tapped is worse than not offering it.
func (r *Responder) readDir(ctx context.Context, roots rootSet, path string) ([]string, bool, error) {
	names, truncated, err := readDirs(path)
	if err != nil {
		return nil, false, err
	}
	resolvedRoots := roots.resolved()
	sort.Strings(names)

	entries := make([]string, 0, min(len(names), worker.MaxDirEntries))
	for _, name := range names {
		if len(entries) >= worker.MaxDirEntries {
			truncated = true
			break
		}
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		candidate := filepath.Join(path, name)
		real, err := resolvePath(candidate)
		if err != nil || !withinRoots(real, resolvedRoots) {
			continue
		}
		if info, err := os.Stat(real); err != nil || !info.IsDir() {
			continue
		}
		entries = append(entries, name)
	}
	return entries, truncated, nil
}

// readDirs reads the names directly inside one path on this machine.
//
// It is a variable so a test can hold one listing open and prove the read loop
// is not the goroutine waiting for it (see TestResponderDoesNotHoldTheReadLoop).
// What comes back is names and not answers: whether each one is a directory
// this machine works in is decided against the roots, which this function knows
// nothing about.
var readDirs = func(path string) ([]string, bool, error) {
	dir, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer dir.Close()

	names := make([]string, 0, 64)
	for {
		batch, err := dir.ReadDir(readDirBatch)
		for _, entry := range batch {
			names = append(names, entry.Name())
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return names, false, nil
			}
			return nil, false, err
		}
		if len(names) >= maxDirScan {
			// A directory this size is not one a person browses. The rest is not
			// read, and the answer says it was cut: a phone that hung for a minute
			// on somebody's downloads folder would be a worse answer than a short
			// one that admits it is short.
			return names, true, nil
		}
	}
}

const (
	// readDirBatch is how many names are read from the filesystem at a time, so a
	// huge directory does not become one huge allocation.
	readDirBatch = 256
	// maxDirScan bounds one listing's read, in names.
	maxDirScan = 20 * worker.MaxDirEntries
)

// outsideRoots is what this machine says to a path it does not work in.
//
// It is the machine's own sentence, and it travels as the answer: the Hub is
// not the party that knows where this boundary is, so it is not the party that
// gets to word the refusal.
func outsideRoots(path string) error {
	return fmt.Errorf("%s is not a directory this machine works in", path)
}

// decodeParams reads one question's payload. A question with none is the
// method's zero value, which every method here defines an answer for.
func decodeParams(raw json.RawMessage, out any) error {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("read the question: %w", err)
	}
	if validatable, ok := out.(interface{ Validate() error }); ok {
		return validatable.Validate()
	}
	return nil
}

// answered wraps a payload as this machine's answer.
func answered(id string, payload any) worker.QueryResult {
	result, err := worker.Answer(id, payload)
	if err != nil {
		return refused(id, err)
	}
	return result
}

// refused wraps a reason as this machine's answer.
func refused(id string, cause error) worker.QueryResult {
	result, err := worker.Refuse(id, cause)
	if err != nil {
		// The id itself is unanswerable, so there is no answer to send. The
		// caller of Handle has already refused the frame by then.
		return worker.QueryResult{}
	}
	return result
}
