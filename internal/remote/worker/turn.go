package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Turn frames (ADR 0022 §6.1). A turn is one adapter run: the Hub decides that
// a task runs on a device, the device runs its local agent, and everything the
// agent says comes back up the same authenticated channel that carried the
// dispatch.
//
// The payloads here carry no credentials. A Node runs with the machine's own
// agent logins and provider keys, which never leave it (ADR 0022 D7), so a
// dispatch describes *what to run*, never *what to run it with*.

// Bounds on one dispatch. Prompts are the only large field, and a prompt that
// does not fit in a frame is a prompt the Hub cannot deliver at all.
const (
	MaxTurnID     = 128
	MaxTaskID     = 128
	MaxAgentID    = 128
	MaxSessionRef = 512
	MaxCwd        = 4096
	MaxPrompt     = 256 << 10
	MaxTurnSeq    = 1 << 20

	// MaxAttachments bounds the files one dispatch may carry. A prompt is
	// already bounded; this bounds the list beside it, which is what a frame
	// carries in addition.
	MaxAttachments = 16
	// MaxResumeTurns bounds the turns one reconnect may claim. It is generous
	// beside the few turns a machine actually runs: the point is a frame small
	// enough to parse without being a way to make the Hub hold arbitrary state.
	MaxResumeTurns = 64
	// MaxAttachmentPath is the same ceiling as a working directory: both are
	// addresses on the Hub's filesystem, and the longer one is not more useful.
	MaxAttachmentPath = MaxCwd
)

// Turn statuses reported by turn.finish.
const (
	TurnOK       = "ok"
	TurnError    = "error"
	TurnCanceled = "canceled"
)

// Dispatch asks a Node to run one turn with one of its agents.
//
// SessionRef is the *Node's* own reference for this conversation, opaque to the
// Hub: the Hub stores whatever the device reports and hands it back on the next
// turn, which is what makes a follow-up resume the same agent session.
// Cwd is a path on the Node's filesystem, checked there against the roots that
// machine agreed to work in; the Hub cannot know another machine's layout.
type Dispatch struct {
	TurnID         string `json:"turn_id"`
	TaskID         string `json:"task_id"`
	Agent          string `json:"agent"`
	Model          string `json:"model,omitempty"`
	Cwd            string `json:"cwd,omitempty"`
	Prompt         string `json:"prompt"`
	SessionRef     string `json:"session_ref,omitempty"`
	PermissionMode string `json:"permission_mode,omitempty"`
	// Attachments are the files the prompt refers to that live on the Hub, so
	// the machine that runs the turn can fetch them before the agent starts.
	// They are not carried in the frame: a photo is far past what a frame is
	// for, and the Hub cannot dial a Node to push one anyway.
	Attachments []Attachment `json:"attachments,omitempty"`
}

// Attachment names one file twice: by the path the prompt already contains,
// and by the name the Hub stores it under.
//
// The path is an address on the Hub's machine and means nothing on any other,
// so it travels only to be rewritten. Stored is what the Node asks for, and it
// is one path element by construction — see SafeAttachmentName.
type Attachment struct {
	Path   string `json:"path"`
	Stored string `json:"stored"`
}

func (a Attachment) Validate() error {
	if strings.TrimSpace(a.Path) == "" {
		return errors.New("attachment path is required")
	}
	if len(a.Path) > MaxAttachmentPath {
		return fmt.Errorf("attachment path exceeds %d bytes", MaxAttachmentPath)
	}
	if strings.ContainsAny(a.Path, "\x00\n\r") {
		return fmt.Errorf("attachment path %q contains a control character", a.Path)
	}
	if !SafeAttachmentName(a.Stored) {
		return fmt.Errorf("attachment name %q is not a single safe path element", a.Stored)
	}
	return nil
}

// TurnEvent is one adapter event on its way up. Seq is local to the turn and
// starts at 1: the Hub is the only thing that allocates a global order, and a
// Node that had to agree on one would have to be reachable to do it.
type TurnEvent struct {
	TurnID string          `json:"turn_id"`
	Seq    int             `json:"seq"`
	Event  json.RawMessage `json:"event"`
}

// TurnStarted is a Node saying it has taken a dispatch and is about to run it.
//
// It exists so the Hub can tell "the device is working on this" from "the device
// is connected but nothing ever happened", which is otherwise indistinguishable
// from silence — and silence is what a Hub waits on forever. It is sent before
// the run begins, so a refusal that follows arrives as a TurnFinish rather than
// as a dispatch that vanished.
type TurnStarted struct {
	TurnID string `json:"turn_id"`
}

// TurnFinish ends a turn. It is the only frame that says how it ended, so a
// Node that dies without sending one leaves the Hub to conclude the turn
// itself (M2.4).
type TurnFinish struct {
	TurnID string `json:"turn_id"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

// TurnCancel asks a Node to stop a turn it is running.
type TurnCancel struct {
	TurnID string `json:"turn_id"`
	Reason string `json:"reason,omitempty"`
}

// TurnResume is the first thing a Node says after reconnecting: which turns it
// still holds.
//
// A control channel can drop while an agent is working. Treating that as the
// end of the work wastes a run the machine is still finishing, and the Hub
// cannot tell a machine that reconnected with its turns from one that
// reconnected empty. So the machine answers the question on arrival: the Hub
// keeps the turns listed here on the new connection, and ends the ones this
// device used to hold that are not listed — the run is gone, and saying so is
// better than waiting for a report that will never come.
//
// It is sent on every connection, not only after a drop, exactly because an
// empty list is an answer too.
type TurnResume struct {
	TurnIDs []string `json:"turn_ids"`
}

func (r TurnResume) Validate() error {
	if len(r.TurnIDs) > MaxResumeTurns {
		return fmt.Errorf("turn resume lists %d turns, more than %d", len(r.TurnIDs), MaxResumeTurns)
	}
	seen := make(map[string]bool, len(r.TurnIDs))
	for i, id := range r.TurnIDs {
		if err := bounded(fmt.Sprintf("turn_ids[%d]", i), id, MaxTurnID); err != nil {
			return err
		}
		if seen[id] {
			return fmt.Errorf("turn_ids[%d] repeats %q", i, id)
		}
		seen[id] = true
	}
	return nil
}

func (d Dispatch) Validate() error {
	if err := bounded("turn_id", d.TurnID, MaxTurnID); err != nil {
		return err
	}
	if err := bounded("task_id", d.TaskID, MaxTaskID); err != nil {
		return err
	}
	if err := bounded("agent", d.Agent, MaxAgentID); err != nil {
		return err
	}
	if strings.TrimSpace(d.Prompt) == "" {
		return errors.New("dispatch has no prompt")
	}
	if len(d.Prompt) > MaxPrompt {
		return fmt.Errorf("dispatch prompt exceeds %d bytes", MaxPrompt)
	}
	if err := optional("model", d.Model, MaxAgentID); err != nil {
		return err
	}
	if err := optional("session_ref", d.SessionRef, MaxSessionRef); err != nil {
		return err
	}
	if err := optional("permission_mode", d.PermissionMode, 64); err != nil {
		return err
	}
	if len(d.Cwd) > MaxCwd {
		return fmt.Errorf("dispatch cwd exceeds %d bytes", MaxCwd)
	}
	if len(d.Attachments) > MaxAttachments {
		return fmt.Errorf("dispatch carries %d attachments, more than %d", len(d.Attachments), MaxAttachments)
	}
	seen := make(map[string]bool, len(d.Attachments))
	for i, a := range d.Attachments {
		if err := a.Validate(); err != nil {
			return fmt.Errorf("attachments[%d]: %w", i, err)
		}
		// An attachment the prompt does not contain is one the Node would
		// download and then have nowhere to put: the whole contract is that
		// Path is the text to replace.
		if !strings.Contains(d.Prompt, a.Path) {
			return fmt.Errorf("attachments[%d].path %q does not appear in the prompt", i, a.Path)
		}
		if seen[a.Path] {
			return fmt.Errorf("attachments[%d].path %q is listed twice", i, a.Path)
		}
		seen[a.Path] = true
	}
	return nil
}

func (e TurnEvent) Validate() error {
	if err := bounded("turn_id", e.TurnID, MaxTurnID); err != nil {
		return err
	}
	if e.Seq < 1 || e.Seq > MaxTurnSeq {
		return fmt.Errorf("turn event seq %d is out of range", e.Seq)
	}
	if len(e.Event) == 0 {
		return errors.New("turn event has no payload")
	}
	return nil
}

func (s TurnStarted) Validate() error {
	return bounded("turn_id", s.TurnID, MaxTurnID)
}

func (f TurnFinish) Validate() error {
	if err := bounded("turn_id", f.TurnID, MaxTurnID); err != nil {
		return err
	}
	switch f.Status {
	case TurnOK, TurnError, TurnCanceled:
	default:
		return fmt.Errorf("unknown turn status %q", f.Status)
	}
	if len(f.Error) > 4096 {
		return errors.New("turn finish error exceeds 4096 bytes")
	}
	return nil
}

func (c TurnCancel) Validate() error {
	if err := bounded("turn_id", c.TurnID, MaxTurnID); err != nil {
		return err
	}
	if len(c.Reason) > 512 {
		return errors.New("turn cancel reason exceeds 512 bytes")
	}
	return nil
}

// bounded checks a required identifier, in bytes: an identifier's limit is the
// wire's, and a byte is what the wire counts. The message says bytes for the same
// reason `optional` does — see the note there, and `chars` below for the fields
// whose bound is their reader's rather than the frame's.
func bounded(field, value string, limit int) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fmt.Errorf("%s is required", field)
	}
	if len(trimmed) > limit {
		return fmt.Errorf("%s exceeds %d bytes", field, limit)
	}
	return nil
}

// optional checks a field that may be absent but not oversized, in bytes: what it
// bounds are things the wire carries, and a byte is what the wire counts. The
// message says bytes for that reason — a body of 11,000 Chinese characters is
// refused for being 32 KiB, not for being 32,768 characters, and a message that
// said the second would send the person looking for a limit they had not reached.
func optional(field, value string, limit int) error {
	if len(value) > limit {
		return fmt.Errorf("%s exceeds %d bytes", field, limit)
	}
	return nil
}

// chars checks a field that is prose rather than an identifier, so its bound is
// counted the way its reader counts it.
//
// The difference is not academic: a title of 256 Chinese characters is 768 bytes
// and is a title GitHub accepts, and a bound counted in bytes would refuse it —
// telling somebody writing in their own language that their title is too long
// when it is not.
func chars(field, value string, limit int) error {
	if utf8.RuneCountInString(value) > limit {
		return fmt.Errorf("%s exceeds %d characters", field, limit)
	}
	return nil
}
