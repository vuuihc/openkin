# ADR 0026: Operator Authority Is a Role, Not a Session

- Status: Accepted
- Date: 2026-10-23

## Context

ADR 0023 widened the daemon-administering guard so a claimed Hub's owner could
reach `/api/settings`. The new principal it admitted was `PrincipalUser`, the
kind minted for a browser session authenticated by a login cookie.

That decision was sound, and ADR 0023 said exactly why: a Hub closes
registration after the first claim, so exactly one account exists and
`PrincipalUser` and "the owner" are the same set. It also named the condition
under which the reasoning would stop holding — *"If a Hub ever gains a second
account, this check must become a role test rather than a kind test."*

The goal reset of 2026-10-23 makes that condition imminent. The product is
moving toward an optional hosted mode where a Hub registers accounts beyond the
one that claimed it. Under the guard as written, the second account to register
would be an operator: not because anyone decided that, but because the guard
can only see *how* a caller authenticated, never *who* they are.

The escalation is on the write side, not the read side. The settings response
already blanks the master token for any caller but the master and masks provider
keys, so a member reading settings learns configuration without learning
credentials. `PUT /api/settings` is what makes the wrong field dangerous: it
accepts `provider.base_url`, `provider.api_key`, `relay.url`, and
`notify.bark_url`. A member could repoint the provider at a host they control
and from then on receive the owner's API key and every prompt the daemon sends.
No credential has to leak for the machine to change hands, and the guard
standing in the way was reading *how* the caller authenticated rather than who
they were.

## Decision

**An account administers the daemon if its role says so.** `users` gains a
`role` column. The account that claims a Hub is written as `owner`; every other
account is a `member`. `operatorOnly` admits the master token, and it admits
`PrincipalUser` only when the principal's role is `owner`.

The role travels on the principal because that is where the guard can see it.
`Principal.Role` is copied from the account record at session lookup and is
never inferred from `Kind`.

**An unrecognized role reads as `member`.** Both the scan path and the insert
path normalize anything that is not exactly `owner` down to `member`, so an
account whose role is empty, misspelled, or lost fails closed instead of
inheriting the claim the column exists to record.

This is deliberately not a second concept. There is no permission table, no
capability list, and no per-route role matrix: there is one daemon, one account
that owns it, and accounts that do not. Anything finer can be designed when
there is a case that needs it.

## Consequences

The guard's correctness no longer depends on how many accounts exist. Opening
registration stops being an authorization change, which is what makes it
possible to do at all.

`operatorOnly` now denies a class of caller that it previously admitted, so the
test that pins it covers the case ADR 0023 could only describe: an account that
is signed in, is not the owner, and must still be refused. The test red-verifies
— restoring the kind test makes it fail with a 200 where the 403 belongs. What
the response body contains is not the point; reaching the handler at all is.

This is the second place a single-account assumption was load-bearing, and the
review that followed the change found two more of the same shape: the A2A
principal identity collapsed every browser session into one caller, and the
approval and user-question handlers read no principal at all. Both are fixed in
the same change. The assumption was never localized to the guard — the guard was
merely where it had been written down.

The column is added to the base schema rather than to a migration step. There is
no deployed population to migrate: the only database in existence is the
author's own, and the project is not yet dogfooding. An existing `~/.kin`
database therefore has to be recreated rather than upgraded. This is a
deliberate trade and it expires the moment real data exists — from then on,
schema changes need migrations again.

Nothing in the product creates a member account yet. Registration is still
closed after the first claim, so the role column has exactly one value in
practice. The guard is being made correct *before* the feature that needs it,
because the failure mode of doing it after is silent privilege escalation rather
than an error.

This does not by itself make a multi-account Hub safe. `operatorOnly` was one of
several places that assumed a single account; the assumption is now written down
where it is checked, but the rest of the surface has not been audited against a
second account existing.

*2026-10-24:* the guard this ADR settled now has one exception, on a different
middleware rather than a change to this rule. ADR 0027 records why spending a
node's GitHub query quota is not administering it, and why a paired device may
do the first and still not the second.
