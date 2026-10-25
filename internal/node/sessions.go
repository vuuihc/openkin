package node

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/vuuihc/openkin/internal/agent"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// SessionCatalog is the agent sessions that live on this machine, as this
// machine sees them: which providers keep a catalog at all, what those catalogs
// have recorded, and one recorded conversation.
//
// It is an interface rather than *agent.Registry because the responder answers
// questions, and a registry does more than that. What it needs from a registry
// is these three, and *agent.Registry has exactly them.
type SessionCatalog interface {
	// IDs names every agent this machine knows, in the order a listing should
	// walk them. Most of them have no catalog, which is not an error: a
	// registered agent is usually a thing that runs tasks, not a thing that
	// keeps a history.
	IDs() []string
	// ListSessions reads one provider's catalog, or reports
	// agent.ErrSessionCatalogUnavailable when that provider has none.
	ListSessions(ctx context.Context, agentID string, q agent.SessionQuery) ([]agent.SessionInfo, error)
	// ReadSessionHistory reads one page of one recorded session.
	ReadSessionHistory(ctx context.Context, agentID, externalRef string, q agent.HistoryQuery) (agent.HistoryPage, error)
}

// maxSessionsFrame and maxHistoryFrame are how much of one answer may be the
// payload, in the bytes the frame will carry.
//
// Measured rather than estimated: encoding/json is handed the same value the
// envelope will be built from, so what is counted here is what ships. That is
// the only form of this bound that stays true when a field is added — an
// arithmetic bound over per-field limits is a number that is right until
// somebody widens one. Both answers need measuring rather than arithmetic: a
// session's path and title come from the provider, and a history page is up to a
// hundred whole messages, which is megabytes before any of them is unusual.
//
// The budget is under MaxFrameBytes (1 MiB) rather than equal to it, because the
// envelope, the answer's id and its error string travel in the same frame, and a
// machine that filled the frame exactly would fail on the one answer that also
// carried a long reason. That headroom is also what carries the listing's error
// map, which is built outside the loop that measures rows: at most one clipped
// sentence per registered provider, so it takes the headroom only if a machine
// registers thousands of providers (maxSessionError bounds a sentence, and 256
// KiB of headroom holds 512 of them). TestAMachineWithHundredsOfBrokenProviders
// StillFitsOneFrame holds that arithmetic to the frame rather than to this note.
const (
	maxSessionsFrame = 768 << 10
	maxHistoryFrame  = 768 << 10
)

// How long one of a message's identifiers may travel.
//
// These are keys a console matches on rather than prose, so a value long enough
// to need cutting is one this machine does not recognize. Unlike the message
// text, they have no cap of their own below this layer — a provider builds them
// out of whatever its records contain — so this is the only bound they get.
const (
	maxMessageID = 256
	maxKind      = 64
	maxRole      = 64
	maxToolName  = 128
	maxSourceRev = 128
	// The listing's own fields. Today's catalogs bound these (a title at 160
	// runes, paths at what a filesystem allows), so this changes nothing they
	// produce; it is here because SessionCatalog is an interface and a row this
	// machine cannot state the size of is a row that can fail the frame it
	// travels in — which reads as a machine that did not answer.
	maxTitle         = 256
	maxCwd           = 1024
	maxSourceURI     = 512
	maxStatus        = 64
	maxContentDigest = 128
	// maxSessionCursor bounds a provider's own listing cursor. There is no wire
	// bound to borrow: the cursor is answered, never asked, so nothing validates
	// it on the way out.
	maxSessionCursor = 512
	maxSessionError  = 512
)

// sessions answers what sessions this machine has.
//
// It walks the same list the Hub's own import walks on itself, in the same way,
// because the two are the same question about two machines: every provider that
// has a catalog, or one named provider. A provider that cannot be read is
// reported per provider instead of failing the answer — a machine where one CLI
// is broken should still be able to list the sessions of the others, and a
// person who asked for all of them did not ask about that one.
func (r *Responder) sessions(ctx context.Context, asked worker.AgentSessionsParams) (worker.AgentSessionsResult, error) {
	if r.Sessions == nil {
		return worker.AgentSessionsResult{}, errNoSessionCatalog
	}
	limit := asked.Limit
	if limit <= 0 {
		limit = worker.MaxAgentQuery
	}
	named := strings.TrimSpace(asked.Agent)
	ids := []string{named}
	if named == "" {
		ids = r.Sessions.IDs()
	}

	result := worker.AgentSessionsResult{Sessions: []worker.AgentSession{}}
	size := 0
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if err := ctx.Err(); err != nil {
			return worker.AgentSessionsResult{}, err
		}
		sessions, err := r.Sessions.ListSessions(ctx, id, agent.SessionQuery{Limit: limit})
		if err != nil {
			// Most registered agents are things that run tasks, not things that
			// keep a history, and walking every one of them is how this list is
			// built -- so a provider with no catalog is passed over rather than
			// reported. That is the same rule the Hub's own import applies to
			// itself, and it has to be the same: a phone syncing its sessions
			// would otherwise be told about four failures every time, none of
			// which is a failure.
			if named == "" && errors.Is(err, agent.ErrSessionCatalogUnavailable) {
				continue
			}
			// Anything else is this machine's own sentence about one provider,
			// kept per provider: a machine where one CLI is broken should still
			// be able to list the sessions of the others. It is clipped like
			// every other field that travels, and counted by the budget below,
			// because a sentence this machine did not write the length of is
			// still a sentence in an answer that has to fit a frame.
			if result.Errors == nil {
				result.Errors = map[string]string{}
			}
			reason, _ := clipText(err.Error(), maxSessionError)
			result.Errors[clip(id, worker.MaxAgentID)] = reason
			continue
		}
		for _, session := range sessions {
			if len(result.Sessions) >= worker.MaxAgentSessions {
				result.Truncated = true
				return result, nil
			}
			one := wireAgentSession(session)
			encoded, err := json.Marshal(one)
			if err != nil {
				// A session that cannot be described is not a reason to fail a
				// listing of the ones that can.
				continue
			}
			// The first session always goes in: an answer that is empty and says
			// it was cut is worse than one that is over budget by one row, and a
			// machine whose every session is enormous is still a machine with
			// sessions.
			if len(result.Sessions) > 0 && size+len(encoded) > maxSessionsFrame {
				result.Truncated = true
				return result, nil
			}
			size += len(encoded)
			result.Sessions = append(result.Sessions, one)
		}
	}
	return result, nil
}

// sessionHistory answers what one of this machine's recorded sessions says.
//
// The page is the provider's, in the provider's order, with the provider's own
// cursor to continue from. What is this machine's rather than the provider's is
// how much of it fits an answer: how long one message may be, how many messages
// travel, and how long the fields that travel beside them may be. Those are the
// frame's limits, not a judgement about the transcript.
func (r *Responder) sessionHistory(ctx context.Context, asked worker.AgentHistoryParams) (worker.AgentHistoryResult, error) {
	if r.Sessions == nil {
		return worker.AgentHistoryResult{}, errors.New("this machine cannot read its agent session history")
	}
	limit := asked.Limit
	if limit <= 0 {
		limit = worker.MaxAgentHistoryItems
	}
	page, err := r.Sessions.ReadSessionHistory(ctx, strings.TrimSpace(asked.Agent), strings.TrimSpace(asked.Ref),
		agent.HistoryQuery{Cursor: asked.Cursor, Limit: limit})
	if err != nil {
		// Including the provider having no catalog: a Hub that asked about a
		// session it read from this machine deserves this machine's sentence
		// rather than an empty transcript.
		return worker.AgentHistoryResult{}, err
	}
	// The cursor and the revision are the provider's, and clipped for the same
	// reason the items' own fields are: they are the two values that travel
	// outside the loop, so an unclipped one is an answer whose size this machine
	// cannot state in advance.
	result := worker.AgentHistoryResult{
		Items:      []worker.AgentHistoryItem{},
		NextCursor: clip(page.NextCursor, worker.MaxAgentHistoryCursor),
		SourceRev:  clip(page.SourceRev, maxSourceRev),
	}
	size := 0
	for _, item := range page.Items {
		if len(result.Items) >= worker.MaxAgentHistoryItems {
			break
		}
		text, cut := clipText(item.Text, worker.MaxAgentHistoryText)
		one := worker.AgentHistoryItem{
			MessageID: clip(item.MessageID, maxMessageID),
			Kind:      clip(item.Kind, maxKind),
			Role:      clip(item.Role, maxRole),
			ToolName:  clip(item.ToolName, maxToolName),
			Text:      text,
			SourceRev: clip(item.SourceRev, maxSourceRev),
			Truncated: cut,
		}
		if !item.OccurredAt.IsZero() {
			one.OccurredAt = item.OccurredAt.UnixMilli()
		}
		encoded, err := json.Marshal(one)
		if err != nil {
			// A message that cannot be described is not a reason to fail a page
			// of the ones that can.
			continue
		}
		// The first item always goes in: an answer that is empty and says it was
		// cut is worse than one that is over budget by one message, and every
		// field of one item is bounded, so one item always fits.
		if len(result.Items) > 0 && size+len(encoded) > maxHistoryFrame {
			break
		}
		size += len(encoded)
		result.Items = append(result.Items, one)
	}
	// A page that was cut here rather than by the provider has no cursor to
	// continue from: the provider's cursor names the position after the whole
	// page it returned, so passing it on would skip every message this answer
	// left out. An empty cursor ends the reading, which loses messages -- and
	// losing them visibly is the only one of the two that a person can see.
	//
	// "Visibly" is why the flag is set and not just the cursor: an empty cursor
	// is also what the end of a transcript looks like, so without this the
	// reader is shown a short transcript as the whole one — and the same session
	// read on the machine that holds it would page to the end.
	if cutPage(page.Items, result.Items) {
		result.NextCursor = ""
		result.Truncated = true
	}
	return result, nil
}

// cutPage reports whether this machine dropped messages the provider returned.
func cutPage(read []agent.HistoryItem, sent []worker.AgentHistoryItem) bool {
	return len(read) > len(sent)
}

// wireAgentSession is one catalog row in the protocol's own words.
//
// Every field is clipped, including the ones no catalog has ever made long:
// this is the only place a row's size is decided, and a row that arrives
// oversized would be measured against the frame budget as if it were fine.
func wireAgentSession(session agent.SessionInfo) worker.AgentSession {
	// A title is prose, so it is cut on a rune boundary; the rest are fields a
	// console keys on, which clip cuts to a length the wire carries.
	title, _ := clipText(session.Title, maxTitle)
	out := worker.AgentSession{
		AgentID:       clip(session.AgentID, worker.MaxAgentID),
		ExternalRef:   clip(session.ExternalRef, worker.MaxSessionRef),
		SourceURI:     clip(session.SourceURI, maxSourceURI),
		Title:         title,
		Cwd:           clip(session.Cwd, maxCwd),
		Status:        clip(session.Status, maxStatus),
		SourceCursor:  clip(session.SourceCursor, maxSessionCursor),
		ContentDigest: clip(session.ContentDigest, maxContentDigest),
	}
	if len(session.Capabilities) > 0 {
		out.Capabilities = make([]string, 0, len(session.Capabilities))
		for _, capability := range session.Capabilities {
			out.Capabilities = append(out.Capabilities, string(capability))
		}
	}
	// A zero time is "this provider does not record one", and it must not travel
	// as a number: UnixMilli of the zero time is a large negative year that a
	// store would have to be taught to read as absent.
	if !session.CreatedAt.IsZero() {
		out.CreatedAt = session.CreatedAt.UnixMilli()
	}
	if !session.UpdatedAt.IsZero() {
		out.UpdatedAt = session.UpdatedAt.UnixMilli()
	}
	return out
}

// clipText cuts a message to a size that fits an answer, and says whether it
// cut.
//
// The bound is the provider layer's own per-message cap and it is counted the
// way that cap counts — in runes. Counting bytes here would cut a Chinese
// message at a third of the length the provider kept, which is to say the same
// session would read differently on the machine that holds it and on a phone,
// under a comment claiming the two are the same.
//
// With today's catalogs this therefore never cuts and the flag never fires. It
// is here as this layer's guarantee rather than a second opinion about the same
// number: SessionCatalog is an interface, a machine's next provider may cap at
// nothing, and a message this machine cannot state the size of is a message that
// can fail the frame it travels in — which is not an error anybody reads, it is
// silence until the question times out.
//
// The cut lands on a rune boundary by construction rather than by repair: half a
// rune is not valid UTF-8, and encoding/json would replace it with a replacement
// character, so a byte cut turns the last character of a Chinese message into a
// question mark nobody can explain. The cost of counting runes is that a message
// is bounded in runes and not in bytes — up to 4 bytes each, 6 when JSON escapes
// them — which is why the answer is measured against the frame after clipping
// rather than assumed to fit because its text was clipped.
func clipText(text string, limit int) (string, bool) {
	if limit <= 0 {
		return "", text != ""
	}
	count := 0
	for index := range text {
		if count == limit {
			return text[:index], true
		}
		count++
	}
	return text, false
}

// clip shortens one of a message's identifiers.
//
// It is not clipText: a message id or a role is not prose, it is a field a
// console keys on, and a value long enough to need cutting is one this machine
// does not recognize — so it is cut to a length the wire carries rather than to
// a rune boundary a reader would never see.
func clip(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

// errNoSessionCatalog is what this machine says when it has no session catalog
// at all, which is a different answer from "none of my providers has one".
// internal/api's own import says the same sentence about itself when its
// registry is absent, and the two are the same machine's voice.
var errNoSessionCatalog = errors.New("this machine does not list its agent sessions")
