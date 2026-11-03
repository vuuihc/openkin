#!/usr/bin/env bash
#
# Contract tests for scripts/install-hub.sh.
#
# The real installer runs against a fake `docker` that records its arguments and
# answers the handful of calls the installer makes. No daemon and no network:
# what is under test is what the installer decides -- which hostname it trusts,
# which Compose files it starts, and whether stdout stays exactly one URL.
#
# Usage: scripts/install-hub.test.sh

set -uo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
INSTALL="$ROOT/scripts/install-hub.sh"

TMP=$(mktemp -d /tmp/kin-install-test.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
cat >"$TMP/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# A stand-in for the Docker CLI. It logs every call, then answers the subset the
# installer uses. Behaviour is steered entirely by FAKE_* variables.
set -u
printf '%s\n' "$*" >>"$FAKE_LOG"

command="$1"
shift || true
case "$command" in
version | info)
	exit 0
	;;
compose)
	# The installer passes `-f FILE` pairs when a running stack was started
	# with overlays; skip them to reach the subcommand.
	while [ "${1:-}" = "-f" ] && [ $# -ge 2 ]; do shift 2; done
	sub="$1"
	shift || true
	case "$sub" in
	version)
		exit 0
		;;
	config)
		for arg in "$@"; do
			if [ "$arg" = "--environment" ]; then
				# Compose's precedence: the shell wins over .env; `env -u` hides
				# the shell value so the installer can read the file alone.
				if [ -n "${FAKE_ENV_STATUS:-}" ]; then
					exit "$FAKE_ENV_STATUS"
				fi
				if [ "${KIN_DOMAIN+set}" = set ]; then
					printf 'KIN_DOMAIN=%s\n' "$KIN_DOMAIN"
				else
					printf 'KIN_DOMAIN=%s\n' "${FAKE_FILE_DOMAIN:-}"
				fi
				exit 0
			fi
		done
		# The installer greps the rendered YAML for a service build.
		if [ "${FAKE_HAS_BUILD:-0}" = 1 ]; then
			printf 'services:\n  kin:\n    build:\n      context: .\n'
		else
			printf 'services:\n  kin:\n    image: example.invalid/kin\n'
		fi
		# A large rendered config reproduces the `config | grep -q` SIGPIPE:
		# grep exits at the match above and the producer dies writing this. The
		# `exit` carries that death out of the fake, the way the real Compose
		# process would exit 141 instead of quietly succeeding.
		if [ -n "${FAKE_CONFIG_PADDING:-}" ]; then
			printf '%*s\n' "$FAKE_CONFIG_PADDING" '' | tr ' ' 'x'
			exit $?
		fi
		;;
	ps)
		# Before `up` a real fresh install has no container. After it, one
		# exists; the marker lets one fake serve both moments.
		if [ -n "${FAKE_CONTAINER_ID:-}" ]; then
			printf '%s\n' "$FAKE_CONTAINER_ID"
		elif [ -f "$FAKE_STATE/up" ]; then
			printf 'cid-after-up\n'
		fi
		;;
	pull)
		exit "${FAKE_PULL_STATUS:-0}"
		;;
	up)
		: >"$FAKE_STATE/up"
		exit "${FAKE_UP_STATUS:-0}"
		;;
	logs)
		exit 0
		;;
	exec)
		# `kin health` inside the container is the installer's readiness
		# question; everything else is `kin hub init`, which prints the link.
		for arg in "$@"; do
			if [ "$arg" = health ] && [ -n "${FAKE_EXEC_HEALTH_STATUS:-}" ]; then
				exit "$FAKE_EXEC_HEALTH_STATUS"
			fi
		done
		printf '%s\n' "${FAKE_LINK:-https://kin.example.com/}"
		;;
	esac
	;;
inspect)
	format="${2:-}"
	case "$format" in
	*config_files*) printf '%s' "${FAKE_CONFIG_FILES:-}" ;;
	*'}}yes{{end}}'*) [ "${FAKE_HAS_HEALTH:-1}" = 1 ] && printf 'yes' ;;
	*State.Health*)
		if [ "${FAKE_HAS_HEALTH:-1}" = 1 ]; then
			printf '%s' "${FAKE_HEALTH:-healthy}"
		else
			printf '%s' "${FAKE_STATUS:-running}"
		fi
		;;
	*State.Status*) printf '%s' "${FAKE_STATUS:-running}" ;;
	esac
	;;
esac
exit 0
FAKE
chmod +x "$TMP/bin/docker"

FAILURES=0
CASE=""
case_dir=""
log=""
status=0

fail() {
	printf 'not ok - %s: %s\n' "$CASE" "$*" >&2
	FAILURES=$((FAILURES + 1))
}

ok() { printf 'ok - %s: %s\n' "$CASE" "$*"; }

expect_eq() { # got want description
	if [ "$1" = "$2" ]; then ok "$3"; else fail "$3 (got: '$1', want: '$2')"; fi
}

expect_contains() { # haystack needle description
	case "$1" in
	*"$2"*) ok "$3" ;;
	*) fail "$3 (missing: '$2')" ;;
	esac
}

expect_not_contains() { # haystack needle description
	case "$1" in
	*"$2"*) fail "$3 (unexpected: '$2')" ;;
	*) ok "$3" ;;
	esac
}

log_has() { # pattern description
	if grep -qE "$1" "$log"; then ok "$2"; else fail "$2 (no line matching /$1/)"; fi
}

log_lacks() { # pattern description
	if grep -qE "$1" "$log"; then fail "$2 (found /$1/)"; else ok "$2"; fi
}

new_case() {
	CASE="$1"
	case_dir="$TMP/$CASE"
	mkdir -p "$case_dir/deploy"
	log="$case_dir/docker.log"
	: >"$log"
	export PATH="$TMP/bin:$PATH"
	export FAKE_LOG="$log"
	export FAKE_STATE="$case_dir"
	export KIN_INSTALL_TIMEOUT=5
	unset FAKE_FILE_DOMAIN FAKE_CONTAINER_ID FAKE_CONFIG_FILES FAKE_HAS_BUILD
	unset FAKE_LINK FAKE_HAS_HEALTH FAKE_HEALTH FAKE_STATUS FAKE_PULL_STATUS FAKE_UP_STATUS
	unset FAKE_ENV_STATUS FAKE_EXEC_HEALTH_STATUS FAKE_CONFIG_PADDING
	unset KIN_DOMAIN
	status=0
}

run_install() {
	: >"$log"
	"$INSTALL" "$@" >"$case_dir/stdout" 2>"$case_dir/stderr"
	status=$?
	if [ "$status" -ne 0 ] && [ -s "$case_dir/stderr" ]; then
		printf '    installer said:\n' >&2
		sed 's/^/      /' "$case_dir/stderr" >&2
	fi
}

# An ordinary checkout with no .env: one command installs it and prints one
# sign-in link. The checkout defines a build, so the installer must run that
# source rather than pull whatever the published tag happens to point at.
case_fresh_install() {
	new_case fresh-install
	printf 'services:\n  kin:\n    build: .\n' >"$case_dir/deploy/compose.yaml"
	token=$(printf 'ab%.0s' {1..32})
	export FAKE_HAS_BUILD=1
	export FAKE_LINK="https://kin.example.com/#login=$token"

	run_install --domain kin.example.com --email owner@example.com --dir "$case_dir/deploy"

	expect_eq "$status" 0 "installs a fresh Hub"
	expect_eq "$(cat "$case_dir/stdout")" "$FAKE_LINK" "stdout is exactly the sign-in link"
	grep -qx 'KIN_DOMAIN=kin.example.com' "$case_dir/deploy/.env" &&
		ok "writes KIN_DOMAIN" || fail "writes KIN_DOMAIN"
	grep -qx 'ACME_EMAIL=owner@example.com' "$case_dir/deploy/.env" &&
		ok "writes ACME_EMAIL" || fail "writes ACME_EMAIL"
	if find "$case_dir/deploy/.env" -perm 600 -print | grep -q .; then
		ok "keeps .env private"
	else
		fail "keeps .env private"
	fi
	log_has 'compose .*up -d --build' "builds the checkout instead of pulling"
	log_lacks 'compose .*pull' "does not pull over a checkout that builds"
	expect_contains "$(cat "$case_dir/stderr")" "30 minutes" "names the sign-in link lifetime"
}

# A repair of a deployment whose .env interpolates its hostname, carries an
# inline comment, and was started with the OAuth overlay. All three have to
# survive: the Hub must keep the hostname Compose resolves, and `up` must not
# drop the overlay file and take OAuth configuration with it.
case_repair_keeps_compose_shape() {
	new_case repair
	compose_file="$case_dir/deploy/docker-compose.yml"
	overlay_file="$case_dir/deploy/docker-compose.oauth.yml"
	printf 'services:\n  kin: {image: x}\n' >"$compose_file"
	printf 'services:\n  kin: {}\n' >"$overlay_file"
	cat >"$case_dir/deploy/.env" <<'ENV'
HUB_HOST=kin.example.com
KIN_DOMAIN=${HUB_HOST}   # the public name
ACME_EMAIL="owner@example.com"
ENV
	cp "$case_dir/deploy/.env" "$case_dir/env.before"
	chmod 644 "$case_dir/deploy/.env"

	token=$(printf 'cd%.0s' {1..32})
	export FAKE_FILE_DOMAIN=kin.example.com
	export FAKE_CONTAINER_ID=cid-running
	export FAKE_CONFIG_FILES="$compose_file,$overlay_file"
	export FAKE_LINK="https://kin.example.com/#login=$token"

	run_install --dir "$case_dir/deploy"

	expect_eq "$status" 0 "repairs a running deployment"
	expect_eq "$(cat "$case_dir/stdout")" "$FAKE_LINK" "stdout is exactly the sign-in link"
	if cmp -s "$case_dir/env.before" "$case_dir/deploy/.env"; then
		ok "leaves an existing .env alone"
	else
		fail "leaves an existing .env alone"
	fi
	if find "$case_dir/deploy/.env" -perm 600 -print | grep -q .; then
		ok "tightens .env permissions"
	else
		fail "tightens .env permissions"
	fi
	log_has "compose -f $compose_file -f $overlay_file up -d" \
		"starts the stack with the files it was started with"
	log_has 'compose .*pull kin' "pulls the published image when there is no build"
	log_lacks 'up -d --build' "does not force a build on an image-only deployment"
}

# A shell KIN_DOMAIN that disagrees with .env would make Compose run one
# hostname while the installer prints a link for another; it refuses and names
# both sources.
case_shell_conflict_is_refused() {
	new_case shell-conflict
	printf 'services:\n  kin: {image: x}\n' >"$case_dir/deploy/docker-compose.yml"
	printf 'KIN_DOMAIN=kin.example.com\n' >"$case_dir/deploy/.env"
	export FAKE_FILE_DOMAIN=kin.example.com

	export KIN_DOMAIN=other.example.com
	run_install --dir "$case_dir/deploy"
	unset KIN_DOMAIN

	if [ "$status" -ne 0 ]; then ok "refuses the conflict"; else fail "refuses the conflict"; fi
	expect_contains "$(cat "$case_dir/stderr")" "KIN_DOMAIN=kin.example.com" "names the file value"
	expect_contains "$(cat "$case_dir/stderr")" "KIN_DOMAIN=other.example.com" "names the shell value"
	expect_eq "$(cat "$case_dir/stdout")" "" "prints no link"
	log_lacks 'compose .*up' "does not touch the running Hub"
}

# An exported-but-empty KIN_DOMAIN is not unset to Compose: `${KIN_DOMAIN:?}`
# rejects it. The installer must stop before starting a stack that cannot come
# up, and before deciding the hostname from .env.
case_empty_exported_domain_is_refused() {
	new_case empty-exported-domain
	printf 'services:\n  kin: {image: x}\n' >"$case_dir/deploy/docker-compose.yml"
	printf 'KIN_DOMAIN=kin.example.com\n' >"$case_dir/deploy/.env"
	export FAKE_FILE_DOMAIN=kin.example.com

	export KIN_DOMAIN=
	run_install --dir "$case_dir/deploy"
	unset KIN_DOMAIN

	if [ "$status" -ne 0 ]; then ok "refuses an empty exported variable"; else fail "refuses an empty exported variable"; fi
	expect_contains "$(cat "$case_dir/stderr")" "exported but empty" "says what is wrong"
	expect_eq "$(cat "$case_dir/stdout")" "" "prints no link"
	log_lacks 'compose .*up' "starts nothing"
}

# The two link kinds have different lifetimes. Telling an operator a claim link
# expires in 30 minutes is false; telling them a sign-in link lasts a day is
# worse, because they stop looking for it far too early.
case_link_lifetimes_are_named() {
	new_case link-lifetimes
	printf 'services:\n  kin: {image: x}\n' >"$case_dir/deploy/docker-compose.yml"
	export FAKE_CONTAINER_ID=cid-running

	export FAKE_LINK='https://kin.example.com/#claim=abcde23456'
	run_install --domain kin.example.com --dir "$case_dir/deploy"
	expect_eq "$status" 0 "installs a fresh Hub without an email"
	expect_eq "$(cat "$case_dir/stdout")" "$FAKE_LINK" "prints a claim link"
	expect_contains "$(cat "$case_dir/stderr")" "claim this Hub" "says the link claims the Hub"
	expect_contains "$(cat "$case_dir/stderr")" "24 hours" "names the claim link lifetime"
	expect_not_contains "$(cat "$case_dir/stderr")" "30 minutes" "does not call it a sign-in link"
	if grep -q '^ACME_EMAIL=' "$case_dir/deploy/.env"; then
		fail "does not invent an email"
	else
		ok "does not invent an email"
	fi

	# Links printed by older Kin versions carry the code in the query string.
	export FAKE_LINK='https://kin.example.com/?claim=abcde23456'
	run_install --dir "$case_dir/deploy"
	expect_eq "$status" 0 "still accepts a legacy claim link"
	expect_contains "$(cat "$case_dir/stderr")" "24 hours" "names its lifetime too"
}

# A Hub that already has an owner and no --email has nothing to hand over but
# the front door; the script must say why instead of printing a dead link.
case_claimed_hub_names_the_missing_email() {
	new_case claimed-hub
	printf 'services:\n  kin: {image: x}\n' >"$case_dir/deploy/docker-compose.yml"
	export FAKE_CONTAINER_ID=cid-running
	export FAKE_LINK='https://kin.example.com/'

	run_install --domain kin.example.com --dir "$case_dir/deploy"

	expect_eq "$status" 0 "finishes on a claimed Hub"
	expect_eq "$(cat "$case_dir/stdout")" "https://kin.example.com/" "prints the front door"
	expect_contains "$(cat "$case_dir/stderr")" "already has an owner" "explains the missing email"
}

# With no hostname from any source and no terminal to ask, the installer must
# stop and name the flag rather than build a URL out of a guess.
case_missing_domain_is_refused() {
	new_case missing-domain
	printf 'services:\n  kin: {image: x}\n' >"$case_dir/deploy/docker-compose.yml"

	: >"$log"
	"$INSTALL" --dir "$case_dir/deploy" </dev/null >"$case_dir/stdout" 2>"$case_dir/stderr"
	status=$?

	if [ "$status" -ne 0 ]; then ok "refuses to guess"; else fail "refuses to guess"; fi
	expect_contains "$(cat "$case_dir/stderr")" "--domain" "names the flag"
	expect_eq "$(cat "$case_dir/stdout")" "" "prints no link"
	log_lacks 'compose .*up' "starts nothing"
}

# An .env that exists but predates KIN_DOMAIN gets the key appended, not a new
# file: the other settings in it are not the installer's to discard.
case_missing_key_is_appended() {
	new_case missing-key
	printf 'services:\n  kin: {image: x}\n' >"$case_dir/deploy/docker-compose.yml"
	printf 'ACME_EMAIL=owner@example.com\n' >"$case_dir/deploy/.env"
	export FAKE_CONTAINER_ID=cid-running
	token=$(printf 'ef%.0s' {1..32})
	export FAKE_LINK="https://kin.example.com/#login=$token"

	run_install --domain kin.example.com --dir "$case_dir/deploy"

	expect_eq "$status" 0 "repairs the file"
	grep -qx 'ACME_EMAIL=owner@example.com' "$case_dir/deploy/.env" &&
		ok "keeps the existing setting" || fail "keeps the existing setting"
	grep -qx 'KIN_DOMAIN=kin.example.com' "$case_dir/deploy/.env" &&
		ok "appends KIN_DOMAIN" || fail "appends KIN_DOMAIN"
}

# A hand-assembled compose file may have no healthcheck. Waiting for the word
# "healthy" would then never succeed, so the installer asks the daemon itself
# before handing over a link.
case_hand_assembled_without_healthcheck() {
	new_case no-healthcheck
	printf 'services:\n  kin: {image: x}\n' >"$case_dir/deploy/docker-compose.yml"
	export FAKE_CONTAINER_ID=cid-running
	export FAKE_HAS_HEALTH=0
	export FAKE_STATUS=running
	export FAKE_LINK='https://kin.example.com/'

	run_install --domain kin.example.com --dir "$case_dir/deploy"

	expect_eq "$status" 0 "waits for a container without a healthcheck"
	expect_eq "$(cat "$case_dir/stdout")" "$FAKE_LINK" "prints the link"
	log_has 'compose exec -T kin kin health' "asks the daemon whether it is ready"
}

# A container can satisfy its healthcheck and still not answer the daemon
# endpoint the link will hit. The installer asks `kin health` once more before
# minting, so a dead Hub never produces a link that reads as success.
case_unresponsive_daemon_gets_no_link() {
	new_case unresponsive
	printf 'services:\n  kin: {image: x}\n' >"$case_dir/deploy/docker-compose.yml"
	export FAKE_CONTAINER_ID=cid-running
	export FAKE_EXEC_HEALTH_STATUS=1

	run_install --domain kin.example.com --dir "$case_dir/deploy"

	if [ "$status" -ne 0 ]; then ok "refuses to print a link"; else fail "refuses to print a link"; fi
	expect_eq "$(cat "$case_dir/stdout")" "" "prints no link"
	expect_contains "$(cat "$case_dir/stderr")" "does not answer" "says the daemon is not answering"
}

# A file written without a final newline is valid to Compose, and a naive
# append joins the new key onto the last line -- corrupting an OAuth secret and
# dropping both settings. The append has to add the separator first.
case_append_keeps_an_unterminated_line() {
	new_case unterminated
	printf 'services:\n  kin: {image: x}\n' >"$case_dir/deploy/docker-compose.yml"
	# No trailing newline after the secret, on purpose.
	printf 'KIN_DOMAIN=kin.example.com\nKIN_OIDC_CLIENT_SECRET=s3cret' >"$case_dir/deploy/.env"
	export FAKE_CONTAINER_ID=cid-running

	run_install --email owner@example.com --dir "$case_dir/deploy"

	expect_eq "$status" 0 "repairs the file"
	grep -qx 'KIN_OIDC_CLIENT_SECRET=s3cret' "$case_dir/deploy/.env" &&
		ok "keeps the secret intact" || fail "keeps the secret intact"
	grep -qx 'ACME_EMAIL=owner@example.com' "$case_dir/deploy/.env" &&
		ok "appends the email on its own line" || fail "appends the email on its own line"
}

# A rendered Compose config can be larger than a pipe buffer. Asking whether it
# builds must not let `grep -q` close the pipe early: with `pipefail` that reads
# as "no build", and a checkout silently runs a published image instead.
case_build_detection_survives_a_large_config() {
	new_case large-config
	printf 'services:\n  kin:\n    build: .\n' >"$case_dir/deploy/compose.yaml"
	export FAKE_HAS_BUILD=1
	export FAKE_CONFIG_PADDING=200000
	token=$(printf '34%.0s' {1..32})
	export FAKE_LINK="https://kin.example.com/#login=$token"

	run_install --domain kin.example.com --email owner@example.com --service hub --dir "$case_dir/deploy"

	expect_eq "$status" 0 "installs from the checkout"
	log_has 'compose .*up -d --build' "still builds with a large config"
	log_lacks 'compose .*pull' "does not pull over the checkout"
	log_has 'compose exec -T hub kin health' "uses the service name it was given"
}

# A --domain that disagrees with the deployment's .env would install one
# hostname and print a link for another; it is a refusal, not a rewrite.
case_domain_flag_conflict_is_refused() {
	new_case domain-conflict
	printf 'services:\n  kin: {image: x}\n' >"$case_dir/deploy/docker-compose.yml"
	printf 'KIN_DOMAIN=kin.example.com\n' >"$case_dir/deploy/.env"
	export FAKE_FILE_DOMAIN=kin.example.com

	run_install --domain other.example.com --dir "$case_dir/deploy"

	if [ "$status" -ne 0 ]; then ok "refuses the conflict"; else fail "refuses the conflict"; fi
	expect_contains "$(cat "$case_dir/stderr")" "refusing to use other.example.com" "names the refusal"
	expect_eq "$(cat "$case_dir/stdout")" "" "prints no link"
	log_lacks 'compose .*up' "starts nothing"
}

# Garbage in KIN_INSTALL_TIMEOUT must be a sentence, not an arithmetic error
# from deep inside the wait loop.
case_non_numeric_timeout_is_refused() {
	new_case bad-timeout
	printf 'services:\n  kin: {image: x}\n' >"$case_dir/deploy/docker-compose.yml"
	# Otherwise the run would stop earlier for a different reason and the case
	# would not be about the timeout at all.
	export FAKE_CONTAINER_ID=cid-running
	export FAKE_HAS_HEALTH=0
	export FAKE_EXEC_HEALTH_STATUS=1
	export KIN_INSTALL_TIMEOUT=soon

	run_install --domain kin.example.com --dir "$case_dir/deploy"
	unset KIN_INSTALL_TIMEOUT

	if [ "$status" -ne 0 ]; then ok "refuses the value"; else fail "refuses the value"; fi
	expect_contains "$(cat "$case_dir/stderr")" "KIN_INSTALL_TIMEOUT" "names the variable"
	expect_not_contains "$(cat "$case_dir/stderr")" "syntax error" "does not leak a bash error"
	log_lacks 'compose .*up' "starts nothing"

	# A leading zero is octal to shell arithmetic; `08` would abort the wait.
	export KIN_INSTALL_TIMEOUT=08
	unset FAKE_EXEC_HEALTH_STATUS
	run_install --domain kin.example.com --dir "$case_dir/deploy"
	unset KIN_INSTALL_TIMEOUT
	expect_eq "$status" 0 "reads a leading zero as decimal"
}

# When Compose cannot render `config --environment` (an old version, or an
# unrelated required variable not yet set), the fallback still has to read the
# quoting and inline comment that occur in real .env files.
case_env_fallback_reads_the_file() {
	new_case env-fallback
	printf 'services:\n  kin: {image: x}\n' >"$case_dir/deploy/docker-compose.yml"
	printf 'KIN_DOMAIN="kin.example.com"   # written by hand\n' >"$case_dir/deploy/.env"
	export FAKE_ENV_STATUS=1
	export FAKE_CONTAINER_ID=cid-running
	token=$(printf '12%.0s' {1..32})
	export FAKE_LINK="https://kin.example.com/#login=$token"

	run_install --dir "$case_dir/deploy"

	expect_eq "$status" 0 "installs with the fallback parser"
	expect_eq "$(cat "$case_dir/stdout")" "$FAKE_LINK" "prints the link"
}

case_fresh_install
case_repair_keeps_compose_shape
case_shell_conflict_is_refused
case_domain_flag_conflict_is_refused
case_empty_exported_domain_is_refused
case_link_lifetimes_are_named
case_claimed_hub_names_the_missing_email
case_missing_domain_is_refused
case_missing_key_is_appended
case_append_keeps_an_unterminated_line
case_build_detection_survives_a_large_config
case_hand_assembled_without_healthcheck
case_unresponsive_daemon_gets_no_link
case_non_numeric_timeout_is_refused
case_env_fallback_reads_the_file

if [ "$FAILURES" -ne 0 ]; then
	printf '\n%d assertion(s) failed\n' "$FAILURES" >&2
	exit 1
fi
printf '\ninstall-hub: all checks passed\n'
