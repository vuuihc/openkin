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

	"github.com/vuuihc/openkin/internal/remote/worker"
)

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
	// Warn receives problems that have nowhere else to go. Nil means quiet.
	Warn func(format string, args ...any)

	mu   sync.Mutex
	send WriteFunc
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
	default:
		return refused(id, fmt.Errorf("this machine does not know the question %q", method))
	}
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
