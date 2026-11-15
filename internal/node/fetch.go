package node

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// AttachmentFetcher brings the files a dispatched prompt refers to onto this
// machine.
//
// The Hub cannot push them: a Node dialled out, and the direction of the
// connection is the boundary. So the Node fetches, over the same origin it
// dialled and with the same device credential — the Hub's upload route already
// answers a paired device, because a phone and a node are both devices to it.
//
// What arrives is a copy under this machine's state directory, and the prompt
// is rewritten to say so: every path the Hub named is replaced with the local
// one, because the Hub's path is an address on a filesystem this machine
// cannot see. A file that cannot be fetched leaves a note in its place rather
// than the original path, which would send the agent looking for something
// that was never here.
type AttachmentFetcher struct {
	// base is the Hub's origin with any path prefix kept, so a Hub mounted
	// under a subpath fetches from the same subpath it dialled.
	base  string
	token string
	// dir is where per-task copies live. Nothing else is kept here.
	dir string
	// Warn receives problems that do not fail the turn. Nil means quiet.
	Warn func(format string, args ...any)

	// Client is the HTTP client. Nil means one with a sane connection timeout.
	Client *http.Client
	// MaxFile and MaxTotal bound one file and one turn. Zero means the
	// defaults, which are at or above what the Hub will store.
	MaxFile  int64
	MaxTotal int64
	// Keep is how long a task's copies survive without being used. Zero means
	// fourteen days.
	Keep time.Duration
	// Now is the clock, for tests. Nil means time.Now.
	Now func() time.Time

	sweepMu   sync.Mutex
	lastSweep time.Time
}

const (
	// The Hub refuses an upload past 20 MiB, so a file above it did not come
	// from the Hub's upload route. The ceiling is repeated rather than
	// imported: this is the Node's own bound on what it will write to disk.
	defaultMaxAttachmentFile  = 20 << 20
	defaultMaxAttachmentTotal = 64 << 20
	// attachmentFetchTimeout bounds one file. The turn's own context bounds
	// all of them.
	attachmentFetchTimeout = 60 * time.Second
	// attachmentSweepInterval is how often old task directories are looked at.
	// The sweep itself is cheap; doing it once per turn would be waste.
	attachmentSweepInterval = time.Hour
	// defaultAttachmentKeep is how long a task's copies survive without use.
	// The Hub never tells a Node that a task was deleted, so the honest bound
	// is time: two weeks is long past any follow-up that would still read the
	// file, and short enough that a machine does not accumulate them forever.
	defaultAttachmentKeep = 14 * 24 * time.Hour
)

// NewAttachmentFetcher prepares a fetcher for one Hub.
//
// hubURL is the same value the Node dials, including any path prefix. A URL
// this cannot turn into an HTTP base is a configuration error rather than a
// per-turn one: the same URL is about to be dialled, and failing here names the
// problem before a turn is ever dispatched.
func NewAttachmentFetcher(hubURL, token, dir string) (*AttachmentFetcher, error) {
	base, err := httpBase(hubURL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("attachments directory is required")
	}
	return &AttachmentFetcher{base: base, token: strings.TrimSpace(token), dir: dir}, nil
}

// httpBase turns the Hub URL into the origin uploads are fetched from.
//
// ws and wss are accepted because the dial accepts them; the fetch is plain
// HTTP either way, so the scheme is mapped rather than refused.
func httpBase(hubURL string) (string, error) {
	trimmed := strings.TrimSpace(hubURL)
	if trimmed == "" {
		return "", errors.New("hub url is required")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("parse hub url: %w", err)
	}
	switch parsed.Scheme {
	case "http", "https":
	case "ws":
		parsed.Scheme = "http"
	case "wss":
		parsed.Scheme = "https"
	default:
		return "", fmt.Errorf("hub url must be http(s), got %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return "", errors.New("hub url has no host")
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/")
	parsed.RawQuery, parsed.Fragment = "", ""
	return parsed.String(), nil
}

func (f *AttachmentFetcher) warn(format string, args ...any) {
	if f.Warn != nil {
		f.Warn(format, args...)
	}
}

func (f *AttachmentFetcher) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

func (f *AttachmentFetcher) client() *http.Client {
	if f.Client != nil {
		return f.Client
	}
	return &http.Client{Timeout: attachmentFetchTimeout}
}

func (f *AttachmentFetcher) maxFile() int64 {
	if f.MaxFile > 0 {
		return f.MaxFile
	}
	return defaultMaxAttachmentFile
}

func (f *AttachmentFetcher) maxTotal() int64 {
	if f.MaxTotal > 0 {
		return f.MaxTotal
	}
	return defaultMaxAttachmentTotal
}

func (f *AttachmentFetcher) keep() time.Duration {
	if f.Keep > 0 {
		return f.Keep
	}
	return defaultAttachmentKeep
}

// Rewrite fetches what it can and returns the prompt the agent should see.
//
// Attachments this machine cannot bring over do not fail the turn: the agent
// is told what is missing, in the line where the path was, and carries on with
// whatever else arrived. A turn that cannot start because a photo would not
// download is worse than a turn that says it has no photo.
func (f *AttachmentFetcher) Rewrite(ctx context.Context, taskID, prompt string, attachments []worker.Attachment) string {
	if f == nil || prompt == "" || len(attachments) == 0 {
		return prompt
	}
	if !worker.SafeTaskID(taskID) {
		f.warn("cannot store attachments for task %q: the id is not a directory name this machine will use", taskID)
		for _, a := range attachments {
			prompt = strings.ReplaceAll(prompt, a.Path, notTransferred("the task id is not safe to store files under"))
		}
		return prompt
	}
	// Sweep before this turn's directory is touched. A directory is aged out on
	// evidence of last use, so letting the sweep run first means this turn's own
	// use is measured rather than being the thing the sweep has not seen yet.
	f.Sweep()

	dir := filepath.Join(f.dir, taskID)
	budget := f.maxTotal()
	fetched := false
	for _, a := range attachments {
		// The dispatch contract says every attachment path is in the prompt;
		// checking again costs nothing and keeps a malformed dispatch from
		// rewriting text that is not there.
		if !strings.Contains(prompt, a.Path) {
			continue
		}
		local, err := f.fetch(ctx, dir, a.Stored, &budget)
		if err != nil {
			f.warn("task %s: attachment %s was not fetched: %v", taskID, a.Stored, err)
			prompt = strings.ReplaceAll(prompt, a.Path, notTransferred(err.Error()))
			continue
		}
		fetched = true
		prompt = strings.ReplaceAll(prompt, a.Path, local)
	}
	if fetched {
		// Mark the directory as used, so the age sweep measures last use rather
		// than creation.
		now := f.now()
		if err := os.Chtimes(dir, now, now); err != nil {
			f.warn("task %s: could not mark the attachment directory: %v", taskID, err)
		}
	}
	return prompt
}

// fetch puts one stored upload in dir and returns its local path. A file that
// is already there is reused: the name is the content's identity, so a second
// turn of the same task does not download the same photo again.
func (f *AttachmentFetcher) fetch(ctx context.Context, dir, stored string, budget *int64) (string, error) {
	if !worker.SafeAttachmentName(stored) {
		return "", fmt.Errorf("the hub named it %q, which is not a single safe path element", stored)
	}
	dst := filepath.Join(dir, stored)
	if info, err := os.Stat(dst); err == nil && info.Mode().IsRegular() {
		// Already here: a second turn of the same task reads the copy an
		// earlier one made. It still counts against this turn's budget, because
		// the budget bounds what the turn asked this machine to hold.
		*budget -= info.Size()
		return dst, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create attachment directory: %w", err)
	}
	if *budget <= 0 {
		return "", errors.New("this turn's attachment budget is used up")
	}
	limit := f.maxFile()
	budgetBound := false
	if *budget < limit {
		limit = *budget
		budgetBound = true
	}
	tooLarge := func(size int64) error {
		if budgetBound {
			return fmt.Errorf("the rest of this turn's attachment budget is %d bytes and it is %d", limit, size)
		}
		return fmt.Errorf("it is %d bytes, over the %d this machine will take for one file", size, limit)
	}

	fetchCtx, cancel := context.WithTimeout(ctx, attachmentFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, f.base+"/api/uploads/"+url.PathEscape(stored), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+f.token)
	resp, err := f.client().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the hub answered %s", resp.Status)
	}
	if resp.ContentLength > limit {
		return "", tooLarge(resp.ContentLength)
	}

	tmp, err := os.CreateTemp(dir, ".part-"+stored+"-*")
	if err != nil {
		return "", fmt.Errorf("create attachment file: %w", err)
	}
	tmpName := tmp.Name()
	written, copyErr := io.Copy(tmp, io.LimitReader(resp.Body, limit+1))
	closeErr := tmp.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(tmpName)
		if copyErr != nil {
			return "", copyErr
		}
		return "", closeErr
	}
	if written > limit {
		_ = os.Remove(tmpName)
		return "", tooLarge(written)
	}
	// The name is final only once the bytes are: a rename in the same
	// directory is what keeps a half-written file from being reused by the
	// next turn as if it were whole.
	if err := os.Rename(tmpName, dst); err != nil {
		_ = os.Remove(tmpName)
		return "", fmt.Errorf("store attachment: %w", err)
	}
	*budget -= written
	return dst, nil
}

// Sweep removes per-task directories nobody has used for a while.
//
// The Hub never tells a Node that a task was deleted, so "the directory goes
// when the task does" is not a signal this machine has. Age is the honest
// substitute: a task that has not run in two weeks will not run a follow-up
// that still reads its photo. It is called for every dispatched turn — an
// attachment is what grows the directory, but any work at all is a good moment
// to notice the ones that stopped growing — and throttled, because the answer
// changes slowly.
func (f *AttachmentFetcher) Sweep() {
	if f == nil {
		return
	}
	f.sweepMu.Lock()
	defer f.sweepMu.Unlock()
	now := f.now()
	if !f.lastSweep.IsZero() && now.Sub(f.lastSweep) < attachmentSweepInterval {
		return
	}
	f.lastSweep = now
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			f.warn("cannot look for stale attachments in %s: %v", f.dir, err)
		}
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) <= f.keep() {
			continue
		}
		if err := os.RemoveAll(filepath.Join(f.dir, entry.Name())); err != nil {
			f.warn("cannot remove stale attachments for %s: %v", entry.Name(), err)
		}
	}
}

// notTransferred is what stands in for a path the agent cannot open.
//
// Two properties matter. It cannot be read as an attachment, so nothing
// downstream tries to open the sentence as a file: a line parses as `label:
// path` only when the text after its last colon is a single token, and this
// always closes with "— attach it again)", so it never does. And it reads as a
// sentence to a model, which is the reader that matters when the file it
// describes is never going to arrive.
func notTransferred(reason string) string {
	reason = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(reason, "\n", " "), "\r", " "))
	reason = truncateRunes(reason, 200)
	if reason == "" {
		return "(not transferred to this computer — attach it again)"
	}
	return "(not transferred to this computer: " + reason + " — attach it again)"
}
