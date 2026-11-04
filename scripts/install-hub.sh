#!/usr/bin/env bash
#
# Install or repair a Kin Hub on this machine.
#
# The caller is meant to be an agent as much as a person: run it once, capture
# stdout, hand the URL to whoever is signing in. Progress and errors go to
# stderr so stdout is always exactly one URL.
#
# What it does, in order: checks Docker and Compose, resolves the public
# hostname from --domain, the shell, or the deployment's own .env, starts the
# same stack that is already there (including any Compose overlays it was
# started with), waits for the Hub to answer, then asks the Hub itself for a
# claim or sign-in link. Running it again is safe: it starts the same Hub and
# mints a fresh link, and minting one retires the previous link.
#
# It deliberately does not install Docker, configure a reverse proxy, or create
# GitHub / Google OAuth apps. Those need a decision (and often a sudo prompt)
# that belongs to the person, not to a script guessing.

set -euo pipefail

usage() {
	cat <<'EOF'
Usage: scripts/install-hub.sh --domain HOST [--email ADDRESS] [--dir DIR]
                              [--service NAME]
                              [--behind-proxy | --tunnel-token TOKEN | --lan]

  --domain HOST    public hostname of this Hub (e.g. kin.example.com).
                   Ports 80 and 443 must reach this machine, unless a mode
                   below says otherwise.
  --email ADDRESS  the owner's sign-in address. With it, the script creates the
                   owner on a new Hub and prints a one-time sign-in link.
                   Without it, a new Hub gets a claim link instead.
  --dir DIR        the checkout or deployment directory to run Compose in.
                   Defaults to the parent of this script.
  --service NAME   the Compose service that runs the Hub (default: kin).

Access modes (exactly one; default is a direct public install):

  (default)        The Hub terminates TLS itself. DNS for --domain has to
                   point at this machine and ports 80/443 have to reach it;
                   the script checks both before starting anything.
  --behind-proxy   An operator-configured reverse proxy on this host already
                   terminates TLS for --domain and forwards to it. The Hub
                   serves plain HTTP on a loopback port and trusts the
                   proxy's forwarding headers. No ports 80/443 needed.
  --tunnel-token T Run a cloudflared sidecar carrying this Cloudflare tunnel
                   token; the Hub serves plain HTTP behind it. Give the token
                   through KIN_TUNNEL_TOKEN or stdin (--tunnel-token -) so it
                   does not sit in shell history or process listings.
  --lan            No public access: reachable only from this machine's own
                   network, over plain HTTP. Say so to no one; the printed
                   link will not answer from a phone on cellular.

  -h, --help       show this help.

Output:
  stdout is exactly one URL to open. Everything else is on stderr.
  A sign-in link works once and expires in 30 minutes; a claim link works once
  and expires in 24 hours. Re-run this script for a new one.

Environment:
  KIN_INSTALL_TIMEOUT  seconds to wait for the Hub to answer (300).
  KIN_DOMAIN           the hostname, if not given with --domain. A value in the
                       shell overrides the one in .env, exactly as it does for
                       Compose.
  KIN_TUNNEL_TOKEN     the tunnel credential, if not given with --tunnel-token.
EOF
}

info() { printf '%s\n' "$*" >&2; }
die() {
	printf 'install-hub: %s\n' "$*" >&2
	exit 1
}

domain=""
email=""
dir=""
service="kin"
mode="direct"
mode_flags=0
tunnel_token=""

while [ $# -gt 0 ]; do
	case "$1" in
	--domain)
		[ $# -ge 2 ] || die "--domain needs a value"
		domain="$2"
		shift 2
		;;
	--email)
		[ $# -ge 2 ] || die "--email needs a value"
		email="$2"
		shift 2
		;;
	--dir)
		[ $# -ge 2 ] || die "--dir needs a value"
		dir="$2"
		shift 2
		;;
	--service)
		[ $# -ge 2 ] || die "--service needs a value"
		service="$2"
		shift 2
		;;
	--behind-proxy)
		mode="proxy"
		mode_flags=$((mode_flags + 1))
		shift
		;;
	--tunnel-token)
		[ $# -ge 2 ] || die "--tunnel-token needs a value ('-' reads stdin)"
		mode="tunnel"
		tunnel_token="$2"
		mode_flags=$((mode_flags + 1))
		shift 2
		;;
	--lan)
		mode="lan"
		mode_flags=$((mode_flags + 1))
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		die "unknown argument: $1 (try --help)"
		;;
	esac
done

# --- locate the deployment directory ---------------------------------------

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if [ -z "$dir" ]; then
	dir=$(CDPATH='' cd -- "$script_dir/.." && pwd)
fi
[ -d "$dir" ] || die "no such directory: $dir"
dir=$(CDPATH='' cd -- "$dir" && pwd)
env_file="$dir/.env"

# Compose accepts all four of these names. A deployment assembled by hand may
# only have .env pointing COMPOSE_FILE at its own file; Compose reads that
# variable from .env, so accepting either keeps the script usable on both.
compose_file_found=0
for name in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
	if [ -f "$dir/$name" ]; then
		compose_file_found=1
		break
	fi
done
if [ "$compose_file_found" -eq 0 ] && [ -z "${COMPOSE_FILE:-}" ] &&
	! grep -qsE '^[[:space:]]*(export[[:space:]]+)?COMPOSE_FILE=' "$env_file"; then
	die "no Compose file in $dir (pass --dir, or point it at a checkout)"
fi

# --- check Docker -----------------------------------------------------------

command -v docker >/dev/null 2>&1 ||
	die "Docker is not installed. Install Docker Engine (or Docker Desktop), then run this again."
docker compose version >/dev/null 2>&1 ||
	die "Docker Compose v2 is required (the 'docker compose' subcommand). Update Docker, then run this again."
docker info >/dev/null 2>&1 ||
	die "Docker is installed but the daemon is not reachable. Start Docker, then run this again."

# --- resolve the public hostname -------------------------------------------

# Ask Compose what it will actually give the container, rather than parsing
# .env here. Compose resolves inline comments, quoting, ${VAR} interpolation,
# and the rule that the shell environment beats .env; a sed one-liner gets one
# of those subtly wrong, and then a valid deployment fails the repair path that
# is supposed to fix it. `env -u` makes a file-only read possible even when the
# caller exported the same variable.
compose_env() {
	local key="$1" output=""
	if [ "${2:-}" = "file" ]; then
		output=$(cd "$dir" && env -u "$key" docker compose config --environment 2>/dev/null) || output=""
	else
		output=$(cd "$dir" && docker compose config --environment 2>/dev/null) || output=""
	fi
	printf '%s\n' "$output" | sed -n "s/^$key=//p" | tail -n 1
}

# Fallback for when Compose cannot render the stack yet (for example a fresh
# checkout whose compose file requires KIN_DOMAIN with `:?`). It handles the
# parts of Compose's .env syntax that occur in practice: matching quotes,
# trailing whitespace, and a comment introduced by whitespace.
env_value() {
	[ -f "$env_file" ] || return 0
	sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$env_file" 2>/dev/null | tail -n 1 |
		tr -d '\r' |
		sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' \
			-e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# An exported-but-empty KIN_DOMAIN is not "unset" to Compose: `${KIN_DOMAIN:?}`
# rejects it. Treating it as unset here would validate a hostname from .env and
# then start a stack that refuses to come up.
if [ "${KIN_DOMAIN+set}" = set ] && [ -z "$KIN_DOMAIN" ]; then
	die "KIN_DOMAIN is exported but empty. Unset it (or give it a value), then run this again."
fi

file_domain=$(compose_env KIN_DOMAIN file)
[ -n "$file_domain" ] || file_domain=$(env_value KIN_DOMAIN)

if [ -z "$domain" ] && [ -n "${KIN_DOMAIN:-}" ]; then
	domain="$KIN_DOMAIN"
fi
if [ -z "$domain" ]; then
	domain="$file_domain"
fi
if [ -z "$domain" ] && [ -t 0 ]; then
	printf 'Hub hostname (e.g. kin.example.com): ' >&2
	IFS= read -r domain || true
fi
if [ -z "$domain" ] && [ "$mode" != "lan" ]; then
	# A LAN install has no public hostname by definition; every other mode
	# needs one to print a link for.
	[ -n "$domain" ] || die "pass --domain HOST (the Hub's public hostname)"
fi

# Accept a pasted URL as well as a bare hostname; reject anything that would
# produce a link pointing somewhere else.
domain=${domain#https://}
domain=${domain#http://}
domain=${domain%%/*}
domain=${domain%/}
case "$domain" in
*[!A-Za-z0-9.-]* | .* | -* | *. | *..*)
	die "that does not look like a hostname: $domain"
	;;
esac

# A file or a shell variable that names a different host would install a Hub
# under one name and print a link for another. Either is a refusal, not a
# silent rewrite: repointing a live Hub is a different deployment wearing the
# same data volume.
if [ -n "$file_domain" ] && [ "$file_domain" != "$domain" ]; then
	if [ -n "${KIN_DOMAIN:-}" ]; then
		die "$env_file sets KIN_DOMAIN=$file_domain and your shell sets KIN_DOMAIN=${KIN_DOMAIN}, which wins. Make them agree, then run this again."
	fi
	die "$env_file sets KIN_DOMAIN=$file_domain; refusing to use $domain. Update the file or pass the same hostname."
fi
if [ -n "${KIN_DOMAIN:-}" ] && [ "${KIN_DOMAIN}" != "$domain" ]; then
	die "KIN_DOMAIN=${KIN_DOMAIN} is set in your shell and would override --domain $domain; unset it and run this again."
fi

if [ -n "$email" ] && ! printf '%s' "$email" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+$'; then
	die "that does not look like an email address: $email"
fi

# --- access mode ------------------------------------------------------------

# Exactly one mode. The combinations say contradictory things about who
# terminates TLS, and a deployment must not have to guess.
if [ "$mode_flags" -gt 1 ]; then
	die "pick one access mode: (default), --behind-proxy, --tunnel-token, or --lan"
fi
if [ "$mode" = "lan" ]; then
	if [ -n "$domain" ]; then
		die "--lan takes no --domain: a LAN install has no public hostname"
	fi
	if [ -n "${file_domain:-}" ]; then
		die "$env_file sets KIN_DOMAIN=$file_domain; remove it or drop --lan before running this again."
	fi
fi
if [ "$mode" != "tunnel" ] && [ -n "${KIN_TUNNEL_TOKEN:-}" ]; then
	die "KIN_TUNNEL_TOKEN is set but no mode asked for it. Pass --tunnel-token (or --tunnel-token - to read the token from stdin), then run this again."
fi
if [ "$mode" = "tunnel" ] && [ -z "${tunnel_token:-}" ]; then
	tunnel_token="${KIN_TUNNEL_TOKEN:-}"
fi

case "$mode" in
direct)
	# G3, before anything is started: the name must resolve, and this machine
	# must be the place it points at, on the two ports the certificate needs.
	# A failure here is named, not implied -- DNS, port forward, and rate
	# limit each fail the same install in a different way.
	if [ -z "$domain" ]; then
		die "pass --domain HOST (the Hub's public hostname)"
	fi
	info "checking public access for $domain"
	# `|| true` keeps `set -o pipefail` from treating "grep found no address"
	# as a crash: an empty answer is exactly the case being checked, and the
	# die below is the message, not a silent exit with no diagnosis.
	ip=$(dig +short A "$domain" +timeout=5 2>/dev/null | grep -E '^[0-9]+\.' | head -n 1 || true)
	[ -n "$ip" ] || ip=$(dig +short AAAA "$domain" +timeout=5 2>/dev/null | grep -E ':' | head -n 1 || true)
	[ -n "$ip" ] || ip=$(dig +short CNAME "$domain" +timeout=5 2>/dev/null | head -n 1 || true)
	if [ -z "$ip" ]; then
		die "$domain does not resolve (no A, AAAA, or CNAME record). Create the record at your DNS provider and wait for it to answer, then run this again."
	fi
	info "$domain resolves to $ip"
	# New installations burn no Let's Encrypt budget: the check runs before
	# the first certificate is ever requested. Rate-limit failures surface
	# later, from the ACME log, with Let's Encrypt's own message.
	if command -v nc >/dev/null 2>&1; then
		for port in 443 80; do
			if ! nc -z -w 5 "$domain" "$port" >/dev/null 2>&1; then
				die "port $port is not reachable on $domain. Forward it to this machine (or open it in the firewall), then run this again. A missing port 80 fails certificate issuance and renewal; a missing 443 makes the Hub unreachable."
			fi
		done
		info "ports 80 and 443 answer on $domain"
	else
		info "nc is not installed; skipping the port reachability check (ports 80/443 must still reach this machine)"
	fi
	;;
proxy)
	info "behind an operator-configured proxy: the Hub serves plain HTTP on a loopback port and trusts its forwarding headers"
	if command -v nc >/dev/null 2>&1; then
		# The proxy, not this script, owns the certificate; checking the two
		# public ports would be checking a neighbor's work.
		if ! nc -z -w 5 127.0.0.1 7777 >/dev/null 2>&1; then
			info "nothing listens on 127.0.0.1:7777 yet (expected on a first install)"
		else
			info "something already listens on 127.0.0.1:7777; the Hub will replace it"
		fi
	fi
	;;
lan)
	# G4's last path: say the truth about reachability, twice -- once here,
	# once in the final hint.
	info "LAN-only: the Hub will serve plain HTTP and be reachable only from this machine's network"
	info "a phone on cellular will NOT be able to reach it; anyone on the same network can read the traffic"
	;;
tunnel)
	if [ "$tunnel_token" = "-" ]; then
		printf 'Tunnel token: ' >&2
		IFS= read -r tunnel_token || die "no tunnel token given"
	fi
	[ -n "$tunnel_token" ] || die "no tunnel token given"
	if [ -z "$domain" ]; then
		die "pass --domain HOST (the public hostname the tunnel serves)"
	fi
	info "running a cloudflared sidecar with the tunnel you supplied; the Hub serves plain HTTP behind it"
	;;
esac

# Validate before touching Docker: a non-numeric value would otherwise reach a
# shell arithmetic expansion much later and exit with a raw syntax error.
timeout=${KIN_INSTALL_TIMEOUT:-300}
case "$timeout" in
*[!0-9]* | "") die "KIN_INSTALL_TIMEOUT must be a whole number of seconds (got: $timeout)" ;;
esac
# A leading zero is octal to shell arithmetic, and `08` is not a valid octal
# number at all. Read the digits as decimal whatever the caller wrote.
timeout=$((10#$timeout))

# --- write .env without touching what is already there ----------------------

# A file written without a final newline is valid to Compose, and `>>` would
# join the next key onto its last line: `KIN_OIDC_CLIENT_SECRET=secret` becomes
# `...secretACME_EMAIL=...`, silently corrupting the secret and dropping both
# settings. Add the separator first when it is missing.
append_env() {
	if [ -s "$env_file" ] && [ "$(tail -c 1 "$env_file" | wc -l | tr -d ' ')" -eq 0 ]; then
		printf '\n' >>"$env_file"
	fi
	printf '%s\n' "$1" >>"$env_file"
}

if [ ! -f "$env_file" ]; then
	(
		umask 077
		{
			printf '%s\n' '# Written by scripts/install-hub.sh. Docker Compose reads this file.'
			# A LAN install has no public hostname: the variable stays unset so
			# the base compose file's :? guard cannot pass, and the deployment
			# must be brought up with the LAN overrides below instead.
			if [ "$mode" != "lan" ]; then
				printf 'KIN_DOMAIN=%s\n' "$domain"
			fi
			# Not `[ ... ] && printf`: a false test as the last command of the
			# group would make this whole block exit 1 under `set -e`.
			if [ -n "$email" ]; then
				printf 'ACME_EMAIL=%s\n' "$email"
			fi
		} >"$env_file"
	)
	info "wrote $env_file"
else
	if [ "$mode" != "lan" ] && [ -z "$file_domain" ]; then
		append_env "KIN_DOMAIN=$domain"
		info "added KIN_DOMAIN to $env_file"
	fi
	if [ -n "$email" ] && ! grep -qs '^ACME_EMAIL=' "$env_file"; then
		append_env "ACME_EMAIL=$email"
		info "added ACME_EMAIL to $env_file"
	fi
	chmod 600 "$env_file" 2>/dev/null || true
fi

# A tunnel token is a live credential for this deployment's front door. It is
# written only here, next to the other secrets this deployment keeps, never to
# a log: this script's stderr names it nowhere, and `compose config` renders
# the variable rather than its value only because Compose interpolates at run
# time.
if [ "$mode" = "tunnel" ] && ! grep -qs '^KIN_TUNNEL_TOKEN=' "$env_file"; then
	append_env "KIN_TUNNEL_TOKEN=$tunnel_token"
	info "added KIN_TUNNEL_TOKEN to $env_file"
	chmod 600 "$env_file" 2>/dev/null || true
fi

# --- keep the stack the user started ---------------------------------------

# `docker compose up` with no -f uses the project's default files. A deployment
# started with explicit -f flags (the OAuth overlay is one) would come back
# without them: the Hub would lose its provider configuration and the overlay's
# services would be orphaned. Compose records the files it used on the running
# container, so ask it rather than guessing which overlays are in play.

# A tunnel deployment layers the proxy overlay over the base file, and records
# exactly that on its container. A first tunnel install names the pair here.
compose_files=()
if [ "$mode" = "tunnel" ]; then
	base_file=""
	for name in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
		if [ -f "$dir/$name" ]; then
			base_file="$dir/$name"
			break
		fi
	done
	proxy_file=""
	for name in "$dir/docker-compose.proxy.yml" "$dir/docker-compose.proxy.yaml"; do
		if [ -f "$name" ]; then
			proxy_file="$name"
			break
		fi
	done
	[ -n "$base_file" ] || die "no Compose file in $dir (pass --dir, or point it at a checkout)"
	[ -n "$proxy_file" ] || die "no docker-compose.proxy.yml in $dir; the tunnel mode needs the overlay from a checkout"
	compose_files+=(-f "$base_file" -f "$proxy_file")
fi

existing_id=$(cd "$dir" && docker compose ps -q "$service" 2>/dev/null | head -n 1 || true)
if [ -n "$existing_id" ]; then
	recorded=$(docker inspect --format \
		'{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
		"$existing_id" 2>/dev/null || true)
	if [ -n "$recorded" ] && [ "${#compose_files[@]}" -eq 0 ]; then
		IFS=',' read -r -a recorded_files <<<"$recorded"
		for recorded_file in "${recorded_files[@]}"; do
			if [ ! -f "$recorded_file" ]; then
				info "ignoring a compose file recorded by the running Hub but no longer present: $recorded_file"
				compose_files=()
				break
			fi
			compose_files+=(-f "$recorded_file")
		done
	fi
fi

compose() { (cd "$dir" && docker compose ${compose_files[@]+"${compose_files[@]}"} "$@"); }

# A checkout that defines a build should run that source, not whichever image
# happens to be published under the same tag. A deployment that only names an
# image pulls the release. `config` (plain YAML) is used rather than
# `--format json` because the flag is newer than the Compose v2 that this
# script promises; a missing flag would silently turn a checkout into a
# published-image install.
needs_build=0
# Capture first: `compose config | grep -q` lets grep exit at the first match
# and SIGPIPE the producer, which `pipefail` reports as a failed pipeline --
# silently turning a checkout into a published-image install.
config_out=$(compose config 2>/dev/null || true)
if grep -qE '^[[:space:]]+build:' <<<"$config_out"; then
	needs_build=1
fi

if [ "$needs_build" -eq 0 ]; then
	if ! compose pull "$service" >&2; then
		info "could not pull the image; Compose will use or build the local one"
	fi
fi

info "starting the Hub in $dir (the first run can take a few minutes)"

logs() {
	info ""
	info "last lines from the Hub:"
	compose logs --tail=60 "$service" >&2 || true
}

up_args=(-d)
[ "$needs_build" -eq 1 ] && up_args+=(--build)
if ! compose up "${up_args[@]}" >&2; then
	logs
	die "docker compose up failed"
fi

container_id=$(compose ps -q "$service")
[ -n "$container_id" ] || die "Compose did not create the '$service' service container"

deadline=$((SECONDS + timeout))
has_health=$(docker inspect --format '{{if .State.Health}}yes{{end}}' "$container_id" 2>/dev/null || true)
while :; do
	status=$(docker inspect --format \
		'{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
		"$container_id" 2>/dev/null || printf 'missing')
	case "$status" in
	healthy) break ;;
	unhealthy | exited | dead)
		logs
		die "the Hub container is $status"
		;;
	running)
		# A hand-assembled compose file may have no healthcheck. Running is not
		# the same as ready, so ask the daemon's HTTP endpoint before handing
		# over a link.
		if [ -z "$has_health" ] && compose exec -T "$service" kin health >/dev/null 2>&1; then
			break
		fi
		;;
	esac
	if [ "$SECONDS" -ge "$deadline" ]; then
		logs
		die "the Hub did not become ready within ${timeout}s"
	fi
	sleep 3
done

# The healthcheck may belong to an older compose file. Before minting a link,
# make sure the thing the link points at actually answers.
if ! compose exec -T "$service" kin health >/dev/null 2>&1; then
	logs
	die "the Hub container is running but the daemon does not answer /api/health"
fi
info "Hub is up"

# --- mint the link ----------------------------------------------------------

# A LAN install has no public hostname, so the link is the LAN origin in plain
# HTTP. The daemon is asked for the pairing address it already computed for
# this exact purpose rather than the script guessing an interface.
link_domain="$domain"
if [ "$mode" = "lan" ]; then
	lan_origin=""
	# Reaching the host's LAN address from inside the container is the one
	# thing the container cannot do, so the script asks the host's routing
	# table: the default route's interface, then that interface's address.
	lan_ip=""
	if route -n get default >/dev/null 2>&1; then
		lan_dev=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
		[ -n "$lan_dev" ] && lan_ip=$(ipconfig getifaddr "$lan_dev" 2>/dev/null)
	fi
	if [ -z "$lan_ip" ]; then
		# Linux: the default interface's first address.
		dev=$(ip route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -n 1)
		[ -n "$dev" ] && lan_ip=$(ip -4 addr show "$dev" 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -n 1)
	fi
	if [ -n "$lan_ip" ]; then
		lan_origin="http://$lan_ip:7777"
	else
		lan_origin="http://$(hostname):7777"
	fi
	init_args=(hub init --print-url)
else
	init_args=(hub init --domain "$domain" --print-url)
fi
[ -n "$email" ] && init_args+=(--email "$email")

if ! link=$(compose exec -T "$service" kin "${init_args[@]}"); then
	logs
	die "the Hub is running but could not issue a sign-in link"
fi
link=$(printf '%s\n' "$link" | tr -d '\r' | tail -n 1)
if [ "$mode" = "lan" ]; then
	# Rewrite the daemon's placeholder origin for the LAN's: the daemon knows
	# the token, the script knows where the phone will actually point.
	token_part=""
	case "$link" in
	*'#login='*) token_part="#login=${link##*#login=}" ;;
	*'#claim='*) token_part="#claim=${link##*#claim=}" ;;
	esac
	link="$lan_origin/$token_part"
fi
case "$link" in
http://*|https://*) ;;
*)
	logs
	die "the Hub did not print a usable link (got: $link)"
	;;
esac

# stdout is the interface. Keep it to one line.
printf '%s\n' "$link"

info ""
case "$link" in
*'#login='*)
	info "Open the link above once to sign in${email:+ as $email}."
	;;
*'#claim='* | *'?claim='*)
	# Older versions put the code in the query string; both are claim links.
	info "Open the link above to claim this Hub and create its owner."
	;;
*)
	# `kin hub init` answers with the front door when the Hub already has an
	# owner and no --email said which account the link is for.
	info "This Hub already has an owner. Pass --email to mint a sign-in link."
	;;
esac
case "$link" in
*'#login='*)
	info "It works once and expires in 30 minutes. Re-run this script for a new one."
	;;
*'#claim='* | *'?claim='*)
	info "It works once and expires in 24 hours. Re-run this script for a new one."
	;;
esac
if [ "$mode" = "lan" ]; then
	info ""
	info "LAN-only deployment: this link answers only from this machine's network, over plain HTTP."
	info "Anyone on the same network can read the traffic. A phone on cellular cannot reach it."
fi
