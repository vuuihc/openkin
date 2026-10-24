package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"strings"
)

// The channel carried commands (turn.dispatch) and reports (turn.*) and nothing
// in between: a Hub that needed to know something about a machine — what is in
// a directory there, whether a repository exists — had no way to ask.
//
// The console on a phone is why that matters. The machine is chosen by name, and
// everything chosen after it lives on that machine's filesystem, which the Hub
// cannot read. So this is one envelope plus a closed table of methods, rather
// than a frame pair per question: the table is one switch on each side, where a
// kind per question would also be an entry in the protocol's registry and a
// sample proving it survives the envelope, for every question ever added.
//
// A question is answered by the machine it is sent to, in its own words, and a
// question that machine does not know is answered too — see QueryResult.

// QueryListDirs asks what directories are inside a path on the machine.
const QueryListDirs = "fs.list"

// QueryRepoBranches asks what branches one repository has.
const QueryRepoBranches = "repo.branches"

// QueryRepoPrepare asks the machine to make one repository available on itself,
// and to say where it put it.
const QueryRepoPrepare = "repo.prepare"

// QueryGitBranches asks what is checked out in one directory on the machine, and
// what else could be.
//
// It is the same question repo.branches answers, asked about a different thing:
// that one asks a remote what it offers, this one reads a checkout the machine
// already has. They are separate methods because they are separate errands —
// one reaches the network with this machine's credentials, the other reads a
// directory — and because the answers mean different things: a name from a
// remote is not a name that is here.
const QueryGitBranches = "git.branches"

// QueryGitCheckout asks the machine to switch one of its own checkouts to a
// branch.
//
// It is a write, and the only one in this table that lands in a directory the
// person chose rather than one the machine derived. What it can reach is
// therefore bounded the same way a dispatched turn is (see Responder).
const QueryGitCheckout = "git.checkout"

// QueryWorkspaceChanges asks what has changed in one of the machine's own
// directories.
//
// A task that runs on this machine keeps its files here, so "what did this
// session change" is a question only this machine can answer — the Hub may hold
// a different checkout of the same repository at the same address, and reading
// that one would show the wrong session's work. It is the same read the Hub
// performs on its own shared workspaces (workspace.ListLiveChanges), asked of
// the machine whose filesystem it is about.
const QueryWorkspaceChanges = "workspace.changes"

// QueryWorkspaceTree asks what is directly inside one directory of a workspace.
//
// One level, not a walk: the console draws one column at a time, and a directory
// with more entries than fit is answered with the first of them and a flag
// saying so.
const QueryWorkspaceTree = "workspace.tree"

// QueryWorkspaceFile asks for the contents of one text file in a workspace.
//
// Text only, and bounded: this is a viewer for a person reading a diff on a
// phone, not a file transfer. What is not text is refused in this machine's own
// words rather than answered with replacement characters.
const QueryWorkspaceFile = "workspace.file"

// QueryWorkspaceGit asks which repository and branch one of the machine's own
// directories is in, and where that branch stands.
//
// It is what makes a remote session's pull-request panel possible at all: the
// Hub cannot read another machine's checkout, so without this it has no way to
// learn the `owner/repo` and branch that a session's work is on. Every read
// behind it is local — nothing here reaches a remote, so the answer does not
// hang on a credential prompt.
//
// The repository comes back canonicalized, with any credential in the remote URL
// stripped before it leaves the machine that holds it (ADR 0022 D7).
const QueryWorkspaceGit = "workspace.git"

// Bounds on one question.
const (
	MaxQueryID     = 128
	MaxMethod      = 64
	MaxQueryParams = 256 << 10
	MaxQueryError  = 4096
	// MaxDirEntries bounds one listing. A directory holding more than this is
	// answered with the first of them and a flag saying so: what a picker needs
	// is somewhere to tap, not a whole tree.
	MaxDirEntries = 500
	// MaxRepo bounds one repository, named or addressed.
	MaxRepo = 512
	// MaxBranch bounds one branch name. It is the limit a filesystem puts on one
	// path component, and a branch becomes one under .git/refs/heads, so a longer
	// name is one git could not check out anyway.
	MaxBranch = 255
	// MaxBranches bounds one answer, on the same reasoning as MaxDirEntries.
	MaxBranches = 500
	// MaxWorkspaceChanges bounds one change list, on the same reasoning again: a
	// session that touched everything is answered with the first of them and a
	// flag saying so, rather than with a frame too large to arrive.
	MaxWorkspaceChanges = 500
	// MaxWorkspaceFile bounds the text of one file in an answer.
	//
	// The bound is the frame's, not a judgement about files: MaxFrameBytes is
	// 1 MiB and a JSON string costs at most six bytes per byte of input (a
	// control character, or one of the three HTML characters encoding/json
	// escapes, becomes \uXXXX), so 128 KiB of text — 768 KiB encoded — cannot
	// overflow the frame no matter what is in the file. A larger file is
	// answered with its beginning and Truncated.
	MaxWorkspaceFile = 128 << 10
)

// Query is one question about the machine it is sent to.
type Query struct {
	// ID is the Hub's, unique among that connection's open questions. An answer
	// carries it back; a machine never invents one.
	ID string `json:"id"`
	// Method names the question. Which methods exist is the answering side's
	// vocabulary, checked where the question is worked out.
	Method string `json:"method"`
	// Params is the question's own payload, read by the method that answers it.
	Params json.RawMessage `json:"params,omitempty"`
}

// QueryResult is the answer to one question: a payload, or the reason there is
// none.
//
// An unanswerable question is answered. Silence is indistinguishable from a
// question that never arrived, and the one who pays for the difference is the
// asker, in a wait that ends with a timeout it cannot explain.
type QueryResult struct {
	ID    string `json:"id"`
	Error string `json:"error,omitempty"`
	// Result is the payload, meaningful only when Error is empty.
	Result json.RawMessage `json:"result,omitempty"`
}

// Answer builds an answer that carries a payload.
func Answer(id string, payload any) (QueryResult, error) {
	if err := bounded("query id", id, MaxQueryID); err != nil {
		return QueryResult{}, err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return QueryResult{}, fmt.Errorf("encode the answer to %s: %w", id, err)
	}
	return QueryResult{ID: id, Result: data}, nil
}

// Refuse builds an answer that carries a reason.
func Refuse(id string, cause error) (QueryResult, error) {
	if err := bounded("query id", id, MaxQueryID); err != nil {
		return QueryResult{}, err
	}
	if cause == nil {
		return QueryResult{}, errors.New("refusing a question needs a reason")
	}
	reason := cause.Error()
	if len(reason) > MaxQueryError {
		reason = reason[:MaxQueryError]
	}
	return QueryResult{ID: id, Error: reason}, nil
}

// Into decodes an answer's payload, or reports the reason it has none.
//
// An answer with neither half is a broken machine, not an empty answer: it fails
// here, with a sentence, rather than being taken for a result.
func (r QueryResult) Into(out any) error {
	if strings.TrimSpace(r.Error) != "" {
		return errors.New(r.Error)
	}
	if len(r.Result) == 0 {
		return fmt.Errorf("the answer to %s carries neither a result nor a reason", r.ID)
	}
	if err := json.Unmarshal(r.Result, out); err != nil {
		return fmt.Errorf("decode the answer to %s: %w", r.ID, err)
	}
	return nil
}

func (q Query) Validate() error {
	if err := bounded("query id", q.ID, MaxQueryID); err != nil {
		return err
	}
	if err := bounded("query method", q.Method, MaxMethod); err != nil {
		return err
	}
	if len(q.Params) > MaxQueryParams {
		return fmt.Errorf("query params exceeds %d bytes", MaxQueryParams)
	}
	return nil
}

func (r QueryResult) Validate() error {
	if err := bounded("query id", r.ID, MaxQueryID); err != nil {
		return err
	}
	if len(r.Error) > MaxQueryError {
		return fmt.Errorf("query error exceeds %d bytes", MaxQueryError)
	}
	return nil
}

// ListDirsParams asks what directories are inside a path.
//
// An empty path is not a directory: it is the question "where may I look at
// all", answered with the machine's own declared roots.
type ListDirsParams struct {
	Path string `json:"path,omitempty"`
}

// ListDirsResult is one directory listing.
type ListDirsResult struct {
	// Path is the directory that was listed, as it was walked: a path through a
	// link is reported the way the person got there, not the way the filesystem
	// resolves it.
	Path string `json:"path"`
	// Parent is what "up" means from here, or empty at a root: the boundary is
	// visible rather than an error.
	Parent string `json:"parent,omitempty"`
	// Roots is where this machine works. It travels with every answer so a
	// browser can offer them without a second question.
	Roots []string `json:"roots,omitempty"`
	// Entries are the directories inside Path, by name.
	Entries []string `json:"entries,omitempty"`
	// Truncated reports that Entries stopped at MaxDirEntries.
	Truncated bool `json:"truncated,omitempty"`
}

// Validate holds the rule Executor.allowedCwd states for a dispatch: the Hub
// speaks in paths on the machine it is talking to, so a relative path is not a
// question this protocol accepts. It would be resolved against whatever
// directory that daemon was started in, which is not a choice the Hub gets to
// make.
//
// The path is not required here: an empty one is the question "where may I look
// at all", which is a question.
func (p ListDirsParams) Validate() error {
	return directory("path", p.Path, false)
}

// argument checks a value that is about to become an argument to git.
//
// Two shapes are refused here rather than passed on, and neither is a statement
// about whether the repository exists — that is the machine's answer to give,
// and it says so in its own words. What is refused is a name that could be read
// as something other than a name: a leading dash is how a name becomes an
// option, which both `ls-remote` and `checkout` would honour, and a control
// character is how one argument becomes two. The Hub is the other party on this
// channel, so a name it chose must not be able to reach git's option parser.
func argument(field, value string) error {
	if strings.HasPrefix(value, "-") {
		return fmt.Errorf("%s %q starts with a dash, which git would read as an option", field, value)
	}
	if strings.ContainsAny(value, "\x00\n\r") {
		return fmt.Errorf("%s %q contains a control character", field, value)
	}
	return nil
}

// RepoBranchesParams asks which branches one repository has.
//
// The repository is named, not located, and that division is the same one
// fs.list makes: the Hub names a thing, and the machine decides what that name
// means on itself — which remote to reach, and with whose credentials.
type RepoBranchesParams struct {
	Repo string `json:"repo"`
}

// RepoBranchesResult is one repository's branches.
type RepoBranchesResult struct {
	// CloneURL is the repository spelled as a remote this machine will fetch. It
	// travels back because it is what a later repo.prepare must be asked for:
	// the console asks the second question in the words the first answer used,
	// not in the words the person typed.
	//
	// It is the clone URL and not the canonical name on purpose. The canonical
	// name has no transport (`github.com/owner/repo`), so a machine reading it
	// back would have to guess one — and for a remote that is not on GitHub the
	// guess is wrong rather than merely different: `host:port/owner/repo` reads
	// as scp syntax, and the port becomes a path.
	CloneURL string `json:"clone_url"`
	// DefaultBranch is where a session starts when nobody picks one, or empty
	// when the machine could not tell — a remote with no HEAD, or no credential
	// to ask with.
	DefaultBranch string `json:"default_branch,omitempty"`
	// Branches are the branch names the remote reports, sorted.
	Branches []string `json:"branches,omitempty"`
	// Truncated reports that Branches stopped at MaxBranches.
	Truncated bool `json:"truncated,omitempty"`
}

// RepoPrepareParams asks a machine to make one repository available on itself.
//
// It names a repository and a branch and nothing else. Where the checkout goes
// is the machine's decision, not the Hub's: a Hub that could name the
// destination could write anywhere under a root, and a root is permission to run
// an agent, not permission for the Hub to write.
type RepoPrepareParams struct {
	Repo   string `json:"repo"`
	Branch string `json:"branch,omitempty"`
}

// RepoPrepareResult is where a repository now is on one machine.
type RepoPrepareResult struct {
	// Path is an absolute path inside this machine's roots, ready to be handed
	// back as a task's working directory.
	Path string `json:"path"`
	// Branch is what is checked out there now, which is not always what was
	// asked for: no branch named means the remote's default.
	Branch string `json:"branch,omitempty"`
	// Cloned reports whether this call is what put it there, as opposed to
	// finding it already present. It is the difference between "this took a
	// minute" and "this machine already had it", which a phone cannot see.
	Cloned bool `json:"cloned,omitempty"`
}

// GitBranchesParams asks about one directory on the machine.
type GitBranchesParams struct {
	Path string `json:"path"`
}

// GitBranch is one local branch, in the shape the console already draws: the
// answer a local read gives and the answer a machine gives have to be the same
// thing, because the control showing them is the same control.
type GitBranch struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
}

// GitBranchesResult is one directory's branches.
//
// Its fields are workspace.BranchStatus's, name for name, because the console
// draws one control from whichever answer it gets: it asked about a machine,
// not about a code path, and an answer that had to be read differently
// depending on which machine gave it would be two controls pretending to be
// one.
type GitBranchesResult struct {
	// Cwd is the directory that was read, as this machine resolved it.
	Cwd string `json:"cwd"`
	// IsGit is false for a directory that is not a checkout, which is not an
	// error: most directories are not, and the person who picked this one is
	// looking at a list of names that did not say.
	IsGit bool `json:"is_git"`
	// Current is the checked-out branch, empty when detached or unknown.
	Current  string      `json:"current,omitempty"`
	Detached bool        `json:"detached,omitempty"`
	Dirty    bool        `json:"dirty,omitempty"`
	Branches []GitBranch `json:"branches"`
	// Reason says why the answer is what it is, in this machine's words.
	Reason string `json:"reason,omitempty"`
}

// GitCheckoutParams asks a machine to switch one of its own checkouts.
type GitCheckoutParams struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
}

// GitCheckoutResult is where that directory stands after the switch, in
// gitCheckoutResponse's shape for the same reason GitBranchesResult is in
// BranchStatus's.
type GitCheckoutResult struct {
	Cwd string `json:"cwd"`
	// Current is what is checked out there now.
	Current string `json:"current"`
}

func (p GitBranchesParams) Validate() error {
	return directory("path", p.Path, true)
}

func (p GitCheckoutParams) Validate() error {
	if err := directory("path", p.Path, true); err != nil {
		return err
	}
	// A branch is not optional here, unlike repo.prepare's: that one means "the
	// remote's default", and a checkout has no equivalent — asking to switch to
	// nothing is not a request this can carry out.
	branch := strings.TrimSpace(p.Branch)
	if err := bounded("branch", branch, MaxBranch); err != nil {
		return err
	}
	if branch == "" {
		return fmt.Errorf("branch is required")
	}
	return argument("branch", branch)
}

// WorkspaceChange is one changed file, as it crosses the wire.
//
// It carries the same fields as the workspace layer's Change and is still a type
// of this protocol's own: this package is the wire specification and imports
// nothing else in the module (ADR 0025 D5), so that what a Hub and a Node agree
// on is written here rather than inherited from whichever internal type happened
// to serialize it. Both sides convert, which is the point — a field the
// workspace layer renames is a change this file has to make deliberately.
type WorkspaceChange struct {
	Path      string `json:"path"`
	OldPath   string `json:"old_path,omitempty"`
	Status    string `json:"status"` // added|modified|deleted|renamed|binary
	Additions int    `json:"additions,omitempty"`
	Deletions int    `json:"deletions,omitempty"`
	Binary    bool   `json:"binary,omitempty"`
}

// WorkspaceTreeEntry is one name in a listing, as it crosses the wire. The same
// reasoning as WorkspaceChange, and the same fields as workspace.TreeEntry —
// whose Type vocabulary is git's (blob|tree), not a browser's (file|dir).
type WorkspaceTreeEntry struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Size int64  `json:"size,omitempty"`
}

// WorkspaceChangesParams names the directory whose changes are asked about.
//
// The path is absolute and names a directory on the machine being asked, for the
// same reason a dispatch's cwd is: a path relative to the Hub would be resolved
// against a directory the Hub does not own.
type WorkspaceChangesParams struct {
	Path string `json:"path"`
}

// WorkspaceChangesResult is what changed in one directory.
type WorkspaceChangesResult struct {
	// Path is the directory that was read, as this machine resolved it.
	Path string `json:"path"`
	// Changes is empty for a clean checkout, which is an answer and not an
	// error: a session that has not changed anything yet is the normal state of
	// a session.
	Changes []WorkspaceChange `json:"changes"`
	// Truncated reports that Changes stopped at MaxWorkspaceChanges.
	Truncated bool `json:"truncated,omitempty"`
}

// WorkspaceTreeParams names one directory of a workspace.
type WorkspaceTreeParams struct {
	// Path is the workspace directory itself — the checkout, not the
	// subdirectory being listed. It is what the machine checks against its roots,
	// and it is the same path every other question about this workspace uses.
	Path string `json:"path"`
	// Dir is the subdirectory to list, relative to Path. Empty means Path.
	Dir string `json:"dir,omitempty"`
}

// WorkspaceTreeResult is one level of a workspace directory.
type WorkspaceTreeResult struct {
	Path      string               `json:"path"`
	Dir       string               `json:"dir,omitempty"`
	Entries   []WorkspaceTreeEntry `json:"entries"`
	Truncated bool                 `json:"truncated,omitempty"`
}

// WorkspaceFileParams names one file in a workspace.
type WorkspaceFileParams struct {
	// Path is the workspace directory, as in WorkspaceTreeParams.
	Path string `json:"path"`
	// File is the file to read, relative to Path.
	File string `json:"file"`
}

// WorkspaceFileResult is one file's text.
type WorkspaceFileResult struct {
	Path string `json:"path"`
	File string `json:"file"`
	// Size is the file's size on disk, which is larger than Content when
	// Truncated says so.
	Size    int64  `json:"size"`
	Content string `json:"content"`
	// Truncated reports that the file was longer than MaxWorkspaceFile and the
	// answer carries its beginning.
	//
	// It is an answer rather than a refusal because the reason to read a file
	// from a phone is to see what changed, and the first 128 KiB of a file that
	// changed says what it says. A file that is not text at all is a different
	// case and is refused (ReadLiveFile decides both).
	Truncated bool `json:"truncated,omitempty"`
}

// WorkspaceGitParams names one directory whose git is asked about. It is the
// workspace directory itself, as in WorkspaceTreeParams.
type WorkspaceGitParams struct {
	Path string `json:"path"`
}

// WorkspaceGitResult is one directory's git, in the shape the workspace layer
// reads it (workspace.GitFacts) — the same fields, because the Hub draws one
// panel from whichever machine answered.
type WorkspaceGitResult struct {
	// Path is the directory that was read, as this machine resolved it.
	Path string `json:"path"`
	// IsGit is false for a directory that is not a checkout. That is an answer:
	// most directories are not, and a person who picked one is looking at a list
	// of names that did not say.
	IsGit bool `json:"is_git"`
	// Repo is the canonical origin remote — host/owner/name, no transport, no
	// credentials — or empty for a checkout with no origin.
	Repo string `json:"repo,omitempty"`
	// Branch is what is checked out, empty when detached or unknown.
	Branch string `json:"branch,omitempty"`
	// DefaultBranch is the branch origin's HEAD names, as this checkout recorded
	// it, or empty when it cannot be told offline.
	DefaultBranch string `json:"default_branch,omitempty"`
	// Detached reports a HEAD that is not on a branch.
	Detached bool `json:"detached,omitempty"`
	// Dirty reports uncommitted work.
	Dirty bool `json:"dirty,omitempty"`
	// Upstream is the tracking branch of Branch, empty when it tracks nothing.
	Upstream string `json:"upstream,omitempty"`
	// HeadOID is the commit HEAD points at.
	HeadOID string `json:"head_oid,omitempty"`
	// Reason says why the answer is what it is, in this machine's words, when git
	// itself could not be read.
	Reason string `json:"reason,omitempty"`
}

func (p WorkspaceChangesParams) Validate() error {
	return directory("path", p.Path, true)
}

func (p WorkspaceGitParams) Validate() error {
	return directory("path", p.Path, true)
}

func (p WorkspaceTreeParams) Validate() error {
	if err := directory("path", p.Path, true); err != nil {
		return err
	}
	// The subdirectory is optional: no subdirectory is the workspace root, which
	// is the first thing a browser shows and therefore the commonest question.
	return relative("dir", p.Dir, false)
}

func (p WorkspaceFileParams) Validate() error {
	if err := directory("path", p.Path, true); err != nil {
		return err
	}
	return relative("file", p.File, true)
}

// relative checks a path that names something inside a directory the machine
// already agreed to work in.
//
// This is not the containment check — the workspace layer makes that one, and it
// is the one that counts, because it is the code that opens the file. What is
// refused here is a path that could not mean what it says: an absolute one would
// silently replace the directory being asked about, and a traversal would make
// the answer about a directory this machine never agreed to show.
func relative(field, value string, required bool) error {
	value = strings.TrimSpace(value)
	if err := optional(field, value, MaxCwd); err != nil {
		return err
	}
	if value == "" {
		if required {
			return fmt.Errorf("%s is required", field)
		}
		return nil
	}
	if strings.ContainsAny(value, "\x00\n\r") {
		return fmt.Errorf("%s %q contains a control character", field, value)
	}
	if isAbsNodePath(value) {
		return fmt.Errorf("%s %q is absolute, and names something inside the directory being asked about", field, value)
	}
	clean := path.Clean(filepath.ToSlash(value))
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return fmt.Errorf("%s %q leaves the directory being asked about", field, value)
	}
	return nil
}

// directory checks a path that names a directory on the machine being asked.
//
// It holds the same rule Executor.allowedCwd states for a dispatch, and for the
// same reason: the Hub speaks in paths on the machine it is talking to, so a
// relative path is not a question this protocol accepts — it would be resolved
// against whatever directory that daemon was started in, which is not a choice
// the Hub gets to make.
func directory(field, path string, required bool) error {
	path = strings.TrimSpace(path)
	if len(path) > MaxCwd {
		return fmt.Errorf("%s exceeds %d bytes", field, MaxCwd)
	}
	if path == "" {
		if required {
			return fmt.Errorf("%s is required", field)
		}
		return nil
	}
	if !isAbsNodePath(path) {
		return fmt.Errorf("%s %q is not absolute", field, path)
	}
	return nil
}

func (p RepoBranchesParams) Validate() error {
	if _, err := repoName(p.Repo); err != nil {
		return err
	}
	return nil
}

func (p RepoPrepareParams) Validate() error {
	if _, err := repoName(p.Repo); err != nil {
		return err
	}
	// A branch is optional — absent means the remote's default — so this is the
	// lenient bound, not the required one. What it is not is unchecked: a branch
	// is an argument to checkout.
	branch := strings.TrimSpace(p.Branch)
	if err := optional("branch", branch, MaxBranch); err != nil {
		return err
	}
	return argument("branch", branch)
}

// repoName reads a repository out of a question, or says why it cannot be one.
func repoName(repo string) (string, error) {
	repo = strings.TrimSpace(repo)
	if err := bounded("repo", repo, MaxRepo); err != nil {
		return "", err
	}
	if err := argument("repo", repo); err != nil {
		return "", err
	}
	return repo, nil
}
