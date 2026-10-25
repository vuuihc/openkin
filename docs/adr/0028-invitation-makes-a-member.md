# ADR 0028: An Invitation Makes a Member, a Claim Makes an Owner

- Status: Accepted
- Date: 2026-10-26

## Context

ADR 0026 introduced the `owner`/`member` role split and then closed with a
sentence that named its own limit: *"Nothing in the product creates a member
account yet. Registration is still closed after the first claim, so the role
column has exactly one value in practice."* The guard was made correct before
the feature that needed it, because doing it after is silent privilege
escalation rather than an error.

The Hub direction makes the feature necessary. Two situations need it, and they
are not the same one:

- **A phone is a device, not a person.** The owner reaching their own Hub from a
  phone already works through pairing (ADR 0022 D6), and that path is untouched.
- **A second person is not a device.** Somebody else driving the same machines
  needs their own account — their own sessions, their own tasks, their own
  sign-in — and must not be able to administer the daemon that hosts them.

There was no way to produce such an account. `NeedsBootstrap` gates the only
route that writes a user, so a Hub that already has an owner refuses to create
anyone. The role column had exactly one value, and every test that pinned member
behaviour wrote the row straight through the store — because there was no other
way to make one.

## Decision

**An owner issues an invitation; the invited person creates their own account
with it.** `invite_tokens` holds `token_hash` / `created_at` / `expires_at` /
`used_at`, shaped like `bootstrap_tokens`. `POST /api/auth/invite` is
operator-only and returns the plaintext code exactly once. `POST /api/auth/join`
is unauthenticated, rate limited, and refuses every rejection with the same
answer.

**An invitation cannot claim a Hub.** `RedeemInvite` refuses when
`NeedsBootstrap` is true, and so does `kin hub invite`. An invitation is issued
*by* the owner, so on a Hub that has no owner there is nobody to issue one — and
a redeemable row there would produce a member where an owner should be. The Hub
would then count a user, stop offering itself for claiming, and leave no account
able to issue another invitation. That state has no way back through the API, so
it is worth a query on a path this rare.

The console's gate follows the same rule rather than guessing past it: an
`?invite=` in the address bar opens the join screen on a Hub that has an owner,
and is ignored on one that does not. The invitation is unspendable there, so the
join screen could only fail — and it would hide the claim screen, which is the
only route to a working Hub. An operator whose address bar still carried an old
invitation link would be locked out of claiming their own machine.

The join screen also offers a way out to sign-in, and hides the federated
buttons. A join link is the one way in that reaches people it was not meant for
— forwarded, bookmarked, or opened by somebody who already has an account here —
and without an exit they are pinned to a form that can only fail, with the
address bar as the only escape, which is not an escape on a phone. The provider
buttons are hidden because attaching an identity to a Hub that already has an
owner is refused; a button whose only outcome is an error is worse than no
button.

**The code is answered before the address is.** `RedeemInvite` asks three
questions in a fixed order: is this invitation live, does the address already
have a password account, and only then does it spend the code. The order is the
whole design, and each step earns its place.

Last is the code, because consuming it first turns a fixable mistake — the
invited person already has an account here — into a dead link. The retry says
"not valid", so nobody can tell a spent invitation from a wrong one, and every
replacement the owner sends dies the same way. The address check is not atomic
with the insert, so two joins racing on one address can still spend a code and
lose at the unique index; that path re-checks and answers `email_taken` rather
than the index error, because by then the honest message is all that is left to
give. It only answers that when the row it finds is *somebody else's* — a session
that failed to open after this request wrote its own account is a write failure,
and reporting it as a taken address would send the person to sign in to an
account they have no way to know exists.

First is the invitation, and it is a liveness read rather than the spend. Asking
about the address first makes the route an oracle: `email_taken` for a registered
address and `invite_invalid` for an unregistered one, answered to anyone, no
invitation required, one guess per request. That is the Hub's account list — who
to target for password guessing — handed out to a stranger. Answering the code
first closes it, because a caller who cannot present a live one never reaches the
question. The read does not spend anything: `ConsumeInviteToken` stays the only
thing that decides, so a code spent in between is refused exactly as an unknown
one is.

What is left is a caller who holds a *live* invitation and asks after many
addresses with it, learning which are registered without spending the code. That
is the price of the property above, and it is the acceptable side of the trade:
the caller is someone the owner handed a credential to, and members cannot mint
invitations, so this is not reachable by a stranger.

**The rate limiter keys on the connection, not on a header.** The auth attempt
limit is shared with sign-in, and it read `RemoteAddr` — which `middleware.RealIP`
had already rewritten from `X-Forwarded-For`, a value the caller chooses. A
forged header bought a fresh budget on every request. The TCP peer is now
captured before RealIP and the limiter reads that. This is a change to a
pre-existing guard rather than to the invitation, and it is recorded here because
the invitation route is what made it load-bearing: it is unauthenticated and it
writes a user.

**A blocked address cannot spend a credential it does not own.** Keying the
limiter on the connection has a cost that has to be paid explicitly, because
behind a tunnel that does not preserve the peer every caller to the Hub shares
one address: whoever exhausts the budget denies everyone else. So the
authenticated middleware resolves credentials *first* and consults the limiter
only for a caller it refused. A caller presenting a valid credential is not
guessing, and this is the difference between one stranger being turned away and
one stranger locking the owner out of their own machine — including with the
master token. `Identify` already carried this principle for the unauthenticated
routes; this is the same rule applied where the budget is actually spent.

The residual is honest and bounded: while a stranger floods the shared address,
an anonymous caller from it is refused the login route too, so a session that
expires mid-flood cannot be replaced until the flood pauses. That is a
per-address limit with no trusted-proxy setting to key on, which is a
configuration waiting to be written rather than a reason to trust the header —
trusting it is what makes the limit unenforceable in the first place.

**Two tables, not one with a flag.** `bootstrap_tokens` answers "does this Hub
still need claiming?", and that answer drives the login surface's choice between
*claim this Hub* and *sign in*. An outstanding invitation recorded there would
make a claimed Hub offer itself for claiming again — the same class of bug the
separation exists to prevent. The rows also differ in what they may be spent on,
which is easier to see as two tables than as one column each writer must
remember to check.

**An invitation is longer than a claim code.** Twenty characters in four groups
against the claim code's ten in two. A claim code is read off a log by the person
who owns the machine; an invitation is forwarded to somebody else and has to
survive being typed off a phone screen, and joining is the only unauthenticated
route that writes a user.

**Issuing does not invalidate earlier invitations.** `IssueBootstrapToken`
consumes every outstanding row first, because a leaked claim code must not stay
valid forever. An invitation is handed out one per person, so revoking everyone
else's because a new one was minted would make the second invitation break the
first.

**The role is chosen at the token, not by the caller.** `createAccount` takes the
role as a parameter and each of the two callers names it next to the token it
just spent, so which token produces which role is one line to read per token
rather than a decision made on the caller's behalf. Nothing in the request body
can influence it.

## Consequences

ADR 0026's closing limit is discharged: the product creates member accounts now,
through a route, with the role decided at the door.

The isolation machinery was already correct and already tested — `TaskScope`
scopes the whole `/api/tasks/{id}` subtree, and `operatorOnly` reads the role.
What was missing was only the door. The tests that previously fabricated a member
row to test what one may reach now drive the real routes and assert that the
account they produce has the properties the fabricated one was assumed to have.
The fabricated-row helper stays, with a comment saying which file to extend
instead.

A member's console is not finished. Seven `operatorOnly` routes — `/api/machines`,
`/api/settings`, `/api/recent-cwds`, `/api/routing/options`, `/api/usage/summary`,
`/api/routines/unread-count`, `/api/agent-sessions/page` — answer 403 to a
member, so the new-chat page renders without a machine list, recent directories,
usage, or a session list. The refusal is correct and is what ADR 0026 asks for;
the degraded rendering is a real gap, deliberately left for the slice that
decides whether a curated directory is a shared one.

The role split is still only two values, and this ADR deliberately does not add a
third. There is one account that administers the daemon and accounts that do not.
Anything finer can be designed when there is a case that needs it.
