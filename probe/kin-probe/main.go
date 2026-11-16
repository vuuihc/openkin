package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// State is the probe's own client state: the device credential minted by
// pairing plus the sync cursor and the last task it watched. It is written
// with mode 0600 and is never committed.
type State struct {
	BaseURL    string `json:"base_url"`
	DeviceID   string `json:"device_id"`
	Token      string `json:"token"`
	Cursor     int64  `json:"cursor"`
	LastTaskID string `json:"last_task_id"`
}

const defaultStatePath = ".kin-probe-state.json"

func loadState(path string) (*State, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var st State
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, fmt.Errorf("parse state %s: %w", path, err)
	}
	return &st, nil
}

func saveState(path string, st *State) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	// WriteFile keeps the mode of an existing temp file; force 0600 before the
	// rename so a stale world-readable temp cannot become the state file.
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func mustState(path string) *State {
	st, err := loadState(path)
	if err != nil {
		fatalf("load state %s: %v (run `kin-probe pair` first)", path, err)
	}
	return st
}

func clientFromState(st *State, baseOverride string) *Client {
	base := st.BaseURL
	if baseOverride != "" {
		base = baseOverride
	}
	return NewClient(base, st.Token)
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "kin-probe: "+format+"\n", args...)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	args := os.Args[2:]

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch cmd {
	case "pair":
		cmdPair(ctx, args)
	case "snapshot":
		cmdSnapshot(ctx, args)
	case "watch":
		cmdWatch(ctx, args)
	case "create":
		cmdCreate(ctx, args)
	case "prompt":
		cmdPrompt(ctx, args)
	case "approvals":
		cmdApprovals(ctx, args)
	case "decide":
		cmdDecide(ctx, args)
	case "catchup":
		cmdCatchup(ctx, args)
	case "run":
		os.Exit(cmdRun(ctx, args))
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "kin-probe: unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `kin-probe — independent OpenKin client probe (public contract only)

Commands:
  pair       mint a device credential through POST /api/pairing/sessions + /exchange
  snapshot   read /api/sessions/cursor, then page the change feed from zero
  watch      stream /api/events (SSE) and summarize frames
  create     POST /api/tasks from -prompt and -cwd
  prompt     POST /api/tasks/{id}/prompt
  approvals  GET /api/approvals
  decide     POST /api/approvals/{id}/decision
  catchup    page the feed from a cursor (persisting it), then task events
  run        execute the six-step acceptance script and write evidence JSON

Every command takes -state (default `+defaultStatePath+`). pair/run also take
-base and -master-token-file; the master token bootstraps the documented
pairing flow, which the public contract does not describe.
`)
}

func stringFlag(fs *flag.FlagSet, name, def, help string) *string {
	return fs.String(name, def, help)
}

// flagWasSet reports whether the user gave a flag explicitly, so an explicit
// -master-token-file wins over the KIN_MASTER_TOKEN environment variable.
func flagWasSet(fs *flag.FlagSet, name string) bool {
	set := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == name {
			set = true
		}
	})
	return set
}

func cmdPair(ctx context.Context, args []string) {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	base := stringFlag(fs, "base", "http://127.0.0.1:7777", "daemon base URL")
	statePath := stringFlag(fs, "state", defaultStatePath, "state file")
	masterFile := stringFlag(fs, "master-token-file", defaultMasterTokenFile(), "file holding the master token (undocumented bootstrap)")
	label := stringFlag(fs, "label", "kin-probe", "device label")
	fs.Parse(args)

	master, err := readMasterToken(*masterFile, !flagWasSet(fs, "master-token-file"))
	if err != nil {
		fatalf("%v", err)
	}
	anon := NewClient(*base, "")
	sess, err := anon.CreatePairingSession(ctx, master, *label)
	if err != nil {
		fatalf("create pairing session: %v", err)
	}
	exch, err := anon.ExchangePairing(ctx, sess.Secret, *label)
	if err != nil {
		fatalf("exchange pairing secret: %v", err)
	}
	st := &State{BaseURL: *base, DeviceID: exch.DeviceID, Token: exch.Token}
	if err := saveState(*statePath, st); err != nil {
		fatalf("save state: %v", err)
	}
	fmt.Printf("paired device_id=%s desktop=%q label=%q state=%s\n",
		exch.DeviceID, exch.DesktopName, exch.Label, *statePath)
}

func cmdSnapshot(ctx context.Context, args []string) {
	fs := flag.NewFlagSet("snapshot", flag.ExitOnError)
	statePath := stringFlag(fs, "state", defaultStatePath, "state file")
	limit := fs.Int("limit", 500, "changes per page")
	maxPages := fs.Int("max-pages", 0, "stop after N pages (0 = until has_more is false)")
	fs.Parse(args)

	st := mustState(*statePath)
	c := clientFromState(st, "")
	start := time.Now()
	cursor, err := c.Cursor(ctx)
	if err != nil {
		fatalf("get cursor: %v", err)
	}
	sessions, deleted, final, pages, err := c.DrainFeed(ctx, 0, *limit, *maxPages)
	if err != nil {
		fatalf("drain feed: %v", err)
	}
	st.Cursor = cursor
	if err := saveState(*statePath, st); err != nil {
		fatalf("save state: %v", err)
	}
	fmt.Printf("cursor_before_snapshot=%d sessions=%d deleted=%d pages=%d final_cursor=%d elapsed=%s\n",
		cursor, len(sessions), len(deleted), pages, final, time.Since(start).Round(time.Millisecond))
}

func cmdWatch(ctx context.Context, args []string) {
	fs := flag.NewFlagSet("watch", flag.ExitOnError)
	statePath := stringFlag(fs, "state", defaultStatePath, "state file")
	task := stringFlag(fs, "task", "", "only print frames for this task id")
	seconds := fs.Int("seconds", 30, "how long to stream")
	fs.Parse(args)

	st := mustState(*statePath)
	c := clientFromState(st, "")
	streamCtx, cancel := context.WithTimeout(ctx, time.Duration(*seconds)*time.Second)
	defer cancel()
	counts := map[string]int{}
	err := c.StreamEvents(streamCtx, func(f SSEFrame) error {
		line := summarizeFrame(f, *task)
		if line == "" {
			return nil
		}
		fmt.Println(line)
		counts[lineKind(f)]++
		return nil
	})
	fmt.Printf("stream ended: %v frames=%v\n", err, counts)
}

func lineKind(f SSEFrame) string {
	switch {
	case f.Event != "":
		return f.Event
	case f.Comment != "":
		return "comment"
	case f.Retry != "":
		return "retry"
	default:
		return "unknown"
	}
}

// summarizeFrame renders one frame in a line, or "" when it is filtered out.
func summarizeFrame(f SSEFrame, wantTask string) string {
	if f.Comment != "" {
		return "comment: " + f.Comment
	}
	if f.Retry != "" {
		return "retry: " + f.Retry
	}
	if f.Event == "" {
		return "frame: (no event)"
	}
	msg, err := DecodeWSMessage(f.Data)
	if err != nil {
		return fmt.Sprintf("event=%s INVALID DATA: %v", f.Event, err)
	}
	switch msg.Kind {
	case "event":
		var ev TaskEvent
		if err := json.Unmarshal(msg.Data, &ev); err != nil {
			return fmt.Sprintf("event=event DECODE FAIL: %v", err)
		}
		if wantTask != "" && ev.TaskID != wantTask {
			return ""
		}
		return fmt.Sprintf("event task=%s seq=%d type=%s payload_keys=%s", ev.TaskID, ev.Seq, ev.Type, payloadKeys(ev.Payload))
	case "task_update":
		var t Task
		if err := json.Unmarshal(msg.Data, &t); err != nil {
			return fmt.Sprintf("event=task_update DECODE FAIL: %v", err)
		}
		if wantTask != "" && t.ID != wantTask {
			return ""
		}
		return fmt.Sprintf("task_update id=%s status=%s hub_seq=%s", t.ID, t.Status, hubSeqString(t.HubSeq))
	case "approval_update":
		var a Approval
		if err := json.Unmarshal(msg.Data, &a); err != nil {
			return fmt.Sprintf("event=approval_update DECODE FAIL: %v", err)
		}
		if wantTask != "" && a.TaskID != wantTask {
			return ""
		}
		return fmt.Sprintf("approval_update id=%s task=%s kind=%s decision=%s", a.ID, a.TaskID, a.Kind, a.Decision)
	case "user_question_update":
		var q struct {
			ID     string `json:"id"`
			TaskID string `json:"task_id"`
			Status string `json:"status"`
		}
		if err := json.Unmarshal(msg.Data, &q); err != nil {
			return fmt.Sprintf("event=user_question_update DECODE FAIL: %v", err)
		}
		if wantTask != "" && q.TaskID != wantTask {
			return ""
		}
		return fmt.Sprintf("user_question_update id=%s task=%s status=%s", q.ID, q.TaskID, q.Status)
	case "task_deleted":
		var d struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(msg.Data, &d)
		if wantTask != "" && d.ID != wantTask {
			return ""
		}
		return fmt.Sprintf("task_deleted id=%s", d.ID)
	default:
		return fmt.Sprintf("UNKNOWN KIND %q data=%s", msg.Kind, truncate(string(msg.Data), 200))
	}
}

func payloadKeys(raw json.RawMessage) string {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return "?"
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return strings.Join(keys, ",")
}

func hubSeqString(v *int64) string {
	if v == nil {
		return "null"
	}
	return fmt.Sprintf("%d", *v)
}

func cmdCreate(ctx context.Context, args []string) {
	fs := flag.NewFlagSet("create", flag.ExitOnError)
	statePath := stringFlag(fs, "state", defaultStatePath, "state file")
	prompt := stringFlag(fs, "prompt", "", "initial prompt (required)")
	agent := stringFlag(fs, "agent", "claude-code", "agent id")
	cwd := stringFlag(fs, "cwd", "", "working directory (required)")
	title := stringFlag(fs, "title", "", "task title")
	permissionMode := stringFlag(fs, "permission-mode", "default", "permission mode")
	fs.Parse(args)

	if *prompt == "" || *cwd == "" {
		fatalf("create: -prompt and -cwd are required")
	}
	st := mustState(*statePath)
	c := clientFromState(st, "")
	t, err := c.CreateTask(ctx, map[string]any{
		"title": *title, "prompt": *prompt, "agent": *agent,
		"cwd": *cwd, "permission_mode": *permissionMode,
	})
	if err != nil {
		fatalf("create task: %v", err)
	}
	st.LastTaskID = t.ID
	if err := saveState(*statePath, st); err != nil {
		fatalf("save state: %v", err)
	}
	fmt.Printf("created task=%s status=%s title=%q\n", t.ID, t.Status, t.Title)
}

func cmdPrompt(ctx context.Context, args []string) {
	fs := flag.NewFlagSet("prompt", flag.ExitOnError)
	statePath := stringFlag(fs, "state", defaultStatePath, "state file")
	task := stringFlag(fs, "task", "", "task id (default: last created)")
	prompt := stringFlag(fs, "prompt", "", "prompt text (required)")
	fs.Parse(args)

	st := mustState(*statePath)
	if *task == "" {
		*task = st.LastTaskID
	}
	if *task == "" || *prompt == "" {
		fatalf("prompt: -task and -prompt are required")
	}
	c := clientFromState(st, "")
	t, err := c.FollowUp(ctx, *task, *prompt)
	if err != nil {
		fatalf("follow-up: %v", err)
	}
	fmt.Printf("prompt accepted task=%s status=%s tokens=%d/%d\n", t.ID, t.Status, t.TokensIn, t.TokensOut)
}

func cmdApprovals(ctx context.Context, args []string) {
	fs := flag.NewFlagSet("approvals", flag.ExitOnError)
	statePath := stringFlag(fs, "state", defaultStatePath, "state file")
	status := stringFlag(fs, "status", "", "pending|approved|denied (empty = all)")
	fs.Parse(args)

	st := mustState(*statePath)
	c := clientFromState(st, "")
	list, err := c.Approvals(ctx, *status)
	if err != nil {
		fatalf("list approvals: %v", err)
	}
	for _, a := range list {
		fmt.Printf("approval id=%s task=%s kind=%s decision=%q created=%d\n", a.ID, a.TaskID, a.Kind, a.Decision, a.CreatedAt)
	}
	fmt.Printf("total=%d\n", len(list))
}

func cmdDecide(ctx context.Context, args []string) {
	fs := flag.NewFlagSet("decide", flag.ExitOnError)
	statePath := stringFlag(fs, "state", defaultStatePath, "state file")
	id := stringFlag(fs, "id", "", "approval id (required)")
	decision := stringFlag(fs, "decision", "approved", "approved|denied")
	fs.Parse(args)

	if *id == "" {
		fatalf("decide: -id is required")
	}
	st := mustState(*statePath)
	c := clientFromState(st, "")
	a, err := c.Decide(ctx, *id, *decision)
	if err != nil {
		fatalf("decide: %v", err)
	}
	decidedAt := "null"
	if a.DecidedAt != nil {
		decidedAt = time.UnixMilli(*a.DecidedAt).UTC().Format(time.RFC3339)
	}
	fmt.Printf("decided id=%s decision=%s decided_at=%s\n", a.ID, a.Decision, decidedAt)
}

func cmdCatchup(ctx context.Context, args []string) {
	fs := flag.NewFlagSet("catchup", flag.ExitOnError)
	statePath := stringFlag(fs, "state", defaultStatePath, "state file")
	task := stringFlag(fs, "task", "", "task id (default: last created)")
	sinceCursor := fs.Int64("since-cursor", -1, "cursor to resume from (default: state cursor)")
	sinceSeq := fs.Int64("since-seq", 0, "task event seq to resume after")
	fs.Parse(args)

	st := mustState(*statePath)
	if *task == "" {
		*task = st.LastTaskID
	}
	if *sinceCursor < 0 {
		*sinceCursor = st.Cursor
	}
	c := clientFromState(st, "")
	sessions, deleted, final, pages, err := c.DrainFeed(ctx, *sinceCursor, 500, 0)
	if err != nil {
		fatalf("drain feed: %v", err)
	}
	fmt.Printf("feed since=%d pages=%d sessions=%d deleted=%d next_cursor=%d\n",
		*sinceCursor, pages, len(sessions), len(deleted), final)
	for _, t := range sessions {
		fmt.Printf("  changed task=%s status=%s hub_seq=%s\n", t.ID, t.Status, hubSeqString(t.HubSeq))
	}
	st.Cursor = final
	if err := saveState(*statePath, st); err != nil {
		fatalf("save state: %v", err)
	}
	if *task == "" {
		fmt.Printf("no task id; events not fetched (use -task)\n")
		return
	}
	events, err := c.TaskEvents(ctx, *task, *sinceSeq)
	if err != nil {
		fatalf("task events: %v", err)
	}
	fmt.Printf("events task=%s since_seq=%d count=%d\n", *task, *sinceSeq, len(events))
	for _, ev := range events {
		fmt.Printf("  seq=%d type=%s keys=%s\n", ev.Seq, ev.Type, payloadKeys(ev.Payload))
	}
}

func defaultMasterTokenFile() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".kin/token"
	}
	return filepath.Join(home, ".kin", "token")
}

func readMasterToken(path string, allowEnv bool) (string, error) {
	if allowEnv {
		if env := os.Getenv("KIN_MASTER_TOKEN"); env != "" {
			return strings.TrimSpace(env), nil
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read master token %s: %w (the public contract documents no way to obtain the first credential)", path, err)
	}
	return strings.TrimSpace(string(data)), nil
}
