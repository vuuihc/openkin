# ADR 0023: Hub Owner Authority

- Status: Accepted
- Date: 2026-10-22

## Context

ADR 0022 gave the Hub an account system, which introduced a principal the
daemon had never had before: a browser session authenticated by a cookie rather
than by a token. Every privileged REST route was already guarded by a check
that admitted only the daemon master token, written when the only remote
clients were paired devices.

That left the Hub owner unable to administer the daemon they had just claimed.
Reading `/api/settings` returned 403, so the console's settings surface — the
only place to configure a provider, deploy the relay, or sign out — rendered as
an error page. A claimed Hub was usable as a task list and nothing else.

The question is what a Hub owner is. Two answers were defensible: an operator
of the daemon they claimed, or a session manager that outranks nothing.

## Decision

A Hub owner is an operator. The guard on the daemon-administering routes admits
the master token and a signed-in account, and nothing else. It is named
`operatorOnly` rather than `masterOnly` so the code says what it now checks.

Paired device credentials remain excluded. A phone or desktop client drives
tasks; it does not reconfigure the daemon it talks to. The loopback-only routes
(integrated terminal, internal approval bridge) still require loopback as well,
so a Hub owner on a laptop cannot open a terminal on the Hub host.

This was sound at the time for one specific reason, which was load-bearing: a
Hub closes registration after the first claim, so `PrincipalUser` was the owner
and there was no second account to distinguish. The condition under which that
reasoning would stop holding was named here as it was written: *"If a Hub ever
gains a second account, this check must become a role test rather than a kind
test."*

**That condition arrived, and [ADR 0026](./0026-operator-authority-role.md)
makes the change.** `operatorOnly` now admits the master token and an account
whose role is `owner`, rather than any signed-in account. The rest of this ADR
still describes the authority model; only the test the guard performs has
changed.

Widening the guard created an escalation that had to be closed with it: the
settings response included the daemon master token and a connect URL carrying
it. With the route newly reachable, a browser session would have been handed a
credential that outlives its session, works from anywhere, and would land in
browser history as part of a URL. The token is now withheld from any principal
that is not the master, and the connect URL is not built for them either. The
console shows an explanation in its place.

## Consequences

- The console on a Hub is fully usable: settings, providers, devices, relay,
  and minting a pairing session for a new client.
- A Hub owner cannot read the master token or reach the loopback-only routes
  (integrated terminal, internal approval bridge), so a laptop cannot open a
  shell on the Hub host. A paired device token can do neither, and cannot
  reconfigure the daemon at all.
- Any future multi-account Hub needs a role column before this guard is
  correct. This is the first thing to revisit if registration ever reopens.
- `GET /api/settings` now varies by principal, not only by role. Tests cover
  all four cases: master, owner session, device token, anonymous.
