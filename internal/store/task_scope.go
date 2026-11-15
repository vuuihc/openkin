package store

import (
	"database/sql"
	"strings"

	"github.com/vuuihc/openkin/internal/remote"
)

// ScopeForPrincipal is the one place that decides what a caller may see.
//
// It lives beside TaskScope, rather than in each server that needs it, because
// the REST API and the MCP tool surface must not be able to disagree: a rule
// copied into two packages is a rule that drifts, and the drift here reads
// someone else's tasks.
//
// The master token and the account that claimed this Hub both hold the machine,
// so both are unscoped. That is not a convenience: tasks with no owner at all —
// everything a standalone daemon ever wrote, and everything a routine firing on
// a timer creates — belong to whoever holds the machine, and nothing else can
// reach them. A member account sees only what it created.
//
// A device is unscoped because pairing is operatorOnly, so a device credential
// is minted by the machine's holder and acts for them. When members can pair
// their own devices this has to read the enrolling account's role instead of
// assuming it; devices.owner_user_id already exists to carry that.
func ScopeForPrincipal(p remote.Principal) TaskScope {
	switch p.Kind {
	case remote.PrincipalMaster, remote.PrincipalDevice:
		return Unscoped()
	case remote.PrincipalUser:
		if p.Role == RoleOwner {
			return Unscoped()
		}
		return OwnedBy(p.UserID)
	}
	return TaskScope{}
}

// ActsForHolder reports whether a principal acts for whoever holds this
// machine, rather than as a guest on it.
//
// It is the same question ScopeForPrincipal answers, asked about the machine's
// own records — its projects, routines, artifacts, and agent sessions — instead
// of about tasks. Both are derived from the one switch above rather than
// restated, because two answers to "who holds this machine" is one answer too
// many: the day they disagree, one of them is a leak.
//
// A paired device acts for the holder. That is the point of pairing: a phone is
// enrolled by the holder and is a full client of the machine, not a guest.
func ActsForHolder(p remote.Principal) bool { return ScopeForPrincipal(p).All }

// TaskScope narrows a task query to what one caller is allowed to see.
//
// The zero value matches nothing. That direction is deliberate: a handler that
// forgets to build a scope returns an empty list, which is a visible bug, rather
// than every task on the daemon, which is a leak. Callers that legitimately want
// everything say so with Unscoped.
//
// "Everything" is a real case and not a convenience. Tasks created before
// accounts existed, and tasks created by a routine firing on a timer or by an
// eval run, have no owner at all. Only whoever holds the machine should see
// those, and they should see all of them.
type TaskScope struct {
	// All disables the filter. Set for the master token and for the account that
	// claimed this Hub: both mean "whoever holds this machine".
	All bool

	// OwnerUserID limits the result to the tasks one account created. Ignored
	// when All is set.
	OwnerUserID string
}

// Unscoped returns a scope that matches every task on this daemon.
func Unscoped() TaskScope { return TaskScope{All: true} }

// OwnedBy returns a scope limited to one account's tasks. An empty or blank id
// yields the zero scope, which matches nothing rather than everything.
func OwnedBy(userID string) TaskScope {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return TaskScope{}
	}
	return TaskScope{OwnerUserID: userID}
}

// Matches reports whether a task already in hand falls inside the scope. It is
// the in-memory twin of predicate, for callers that hold a Task rather than a
// query — the live event stream, and anything deciding whether to hand a loaded
// row to a subscriber.
//
// The two must agree. If they ever diverge, the stream becomes a way around the
// list endpoint.
func (s TaskScope) Matches(t Task) bool { return s.MatchesOwner(t.OwnerUserID) }

// MatchesOwner is Matches for a caller that has the owner but not the whole
// task, which is the case for every bus message except task_update.
func (s TaskScope) MatchesOwner(ownerUserID string) bool {
	if s.All {
		return true
	}
	return s.OwnerUserID != "" && ownerUserID == s.OwnerUserID
}

// TaskOwner returns the account that owns a task, or "" when it has no owner or
// does not exist.
//
// It takes no context because its caller is the bus, which attributes messages
// synchronously while publishing and has no request to thread through. The
// lookup is a primary-key hit on a local database.
//
// It must never be called while holding a transaction or an open *sql.Rows: the
// pool is one connection wide, and this would wait for a connection its own
// caller is holding. Every current caller publishes after its store call has
// returned, which is the shape to keep.
func (s *Store) TaskOwner(taskID string) string {
	if s == nil || taskID == "" {
		return ""
	}
	var owner sql.NullString
	if err := s.db.QueryRow(`SELECT owner_user_id FROM tasks WHERE id = ?`, taskID).Scan(&owner); err != nil {
		return ""
	}
	return owner.String
}

// predicate renders the scope as a SQL condition, qualified by alias so it can
// be used in a join. It always returns a usable condition, so callers append it
// with AND and never special-case.
func (s TaskScope) predicate(alias string) (string, []any) {
	col := "owner_user_id"
	if alias != "" {
		col = alias + ".owner_user_id"
	}
	switch {
	case s.All:
		return "1=1", nil
	case s.OwnerUserID == "":
		return "1=0", nil
	default:
		return col + " = ?", []any{s.OwnerUserID}
	}
}
