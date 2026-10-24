package worker

import (
	"encoding/json"
	"errors"
	"fmt"
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
func (p ListDirsParams) Validate() error {
	path := strings.TrimSpace(p.Path)
	if len(path) > MaxCwd {
		return fmt.Errorf("path exceeds %d bytes", MaxCwd)
	}
	if path != "" && !isAbsNodePath(path) {
		return fmt.Errorf("path %q is not absolute", path)
	}
	return nil
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
