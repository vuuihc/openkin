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
