#!/usr/bin/env bash
# Check the API contract against the routes the daemon actually registers and
# the paths the shipped clients actually call.
#
# Three sources, compared as path (and, where visible, method) sets with path
# parameters normalised to {}:
#
#   (a) routes registered in internal/api (read from the chi router, not a
#       list), including routers it mounts, such as /a2a
#   (b) paths declared in api/openapi.yaml
#   (c) API paths used by the shipped clients: the whole console (ui/src,
#       including its api/ layer), desktop/src, and mobile/
#
# Drift that fails:
#   - a client-used path that is not documented
#   - a client-used path that is not registered
#   - a client-used method that is not documented or not registered, when the
#     call makes its method visible
#   - a documented operation whose method+path is not registered
#   - a mounted router this check cannot locate, or a client URL literal whose
#     shape it cannot compare (both would otherwise be silent coverage)
#
# Routes that are registered but not documented are reported as a count and
# listed with --verbose; they are not drift, because the spec's job is the
# client contract, and some surfaces (internal approvals, static files) are
# deliberately outside it.
#
# Usage:
#   ./scripts/check-api-coverage.sh            # fail on drift
#   ./scripts/check-api-coverage.sh --verbose  # also list undocumented routes
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec python3 - "$@" <<'PY'
import pathlib
import re
import sys

VERBOSE = "--verbose" in sys.argv[1:]
ROOT = pathlib.Path.cwd()


def normalise(path):
    """A path with every parameter name collapsed to {}, no trailing slash."""
    path = re.sub(r"\{[^}]*\}", "{}", path)
    if len(path) > 1:
        path = path.rstrip("/")
    return path


def strip_code(line, in_block):
    """Blank string contents and comments so braces can be counted.

    The router registers paths that contain braces (/api/tasks/{id}), so brace
    depth has to come from code punctuation only.
    """
    out = []
    i = 0
    n = len(line)
    while i < n:
        if in_block:
            end = line.find("*/", i)
            if end == -1:
                return " " * n, True
            out.append(" " * (end + 2 - i))
            i = end + 2
            in_block = False
            continue
        ch = line[i]
        if ch == "/" and i + 1 < n and line[i + 1] == "/":
            out.append(" " * (n - i))
            break
        if ch == "/" and i + 1 < n and line[i + 1] == "*":
            in_block = True
            i += 2
            continue
        if ch in ('"', "'", "`"):
            quote = ch
            out.append(" ")
            i += 1
            while i < n:
                c = line[i]
                if quote != "`" and c == "\\" and i + 1 < n:
                    out.append("  ")
                    i += 2
                    continue
                out.append(" ")
                i += 1
                if c == quote:
                    break
            continue
        out.append(ch)
        i += 1
    return "".join(out), in_block


# ---------------------------------------------------------------- (a) routes

ROUTE_CALL = re.compile(
    r"\.(Get|Post|Put|Delete|Patch|Head|Options|Handle|Mount)\(\s*\"([^\"]*)\""
)
MOUNT_CALL = re.compile(r"\.Mount\(\s*\"([^\"]*)\"\s*,\s*([^)]*)\)")
ROUTE_OPEN = re.compile(r"\.Route\(\s*\"([^\"]*)\"")


def parse_router(path, prefix=""):
    """Read one chi router file: literal routes and literal mounts."""
    routes = set()   # (METHOD, normalised path)
    mounts = []      # (normalised path, handler expression)
    depth = 0
    in_block = False
    prefix_stack = []  # (route prefix, brace depth that opened it)

    for raw in path.read_text(errors="ignore").splitlines():
        # Read registrations from the raw line: the path literal is exactly the
        # thing strip_code blanks out.
        for match in ROUTE_CALL.finditer(raw):
            method = match.group(1)
            route_path = match.group(2)
            if not route_path.startswith("/"):
                # A header or query getter such as r.Header.Get("X-...").
                continue
            if method in ("Handle", "Mount"):
                # Static catch-alls and the Federation proxy are not contract
                # paths; mounts are resolved below.
                continue
            full = prefix + "".join(p for p, _ in prefix_stack) + route_path
            routes.add((method.upper(), normalise(full)))
        for match in MOUNT_CALL.finditer(raw):
            full = prefix + "".join(p for p, _ in prefix_stack) + match.group(1)
            mounts.append((normalise(full), match.group(2)))

        stripped, in_block = strip_code(raw, in_block)
        opened_depth = depth + stripped.count("{") - stripped.count("}")
        if "{" in stripped:
            opened = ROUTE_OPEN.search(raw)
            if opened:
                prefix_stack.append((opened.group(1), opened_depth))
        depth = opened_depth
        while prefix_stack and depth < prefix_stack[-1][1]:
            prefix_stack.pop()

    return routes, mounts


def router_candidates(expression):
    """Files that could implement a mounted handler expression.

    A mount says `s.A2A.Handler()`, which names the field, not the package. The
    mounted router is found by looking for an internal package whose name
    appears in that expression and which builds a `chi.NewRouter()` in a
    `Handler()` method.
    """
    words = {word.lower() for word in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", expression)}
    found = []
    for package in sorted((ROOT / "internal").iterdir()):
        if not package.is_dir() or package.name.lower() not in words:
            continue
        for src in sorted(package.glob("*.go")):
            if src.name.endswith("_test.go"):
                continue
            text = src.read_text(errors="ignore")
            if "chi.NewRouter()" in text and re.search(
                r"func \([^)]*\) Handler\(\) http\.Handler", text
            ):
                found.append(src)
    return found


def collect_routes(files, prefix="", unresolved=None):
    """Routes registered by these router files, including mounted subrouters."""
    routes = set()
    unresolved = unresolved if unresolved is not None else []
    for src in files:
        file_routes, mounts = parse_router(src, prefix)
        routes |= file_routes
        for mount_path, expression in mounts:
            candidates = router_candidates(expression)
            if len(candidates) == 1:
                sub_routes, _ = collect_routes([candidates[0]], mount_path, unresolved)
                routes |= sub_routes
            else:
                unresolved.append((mount_path, expression.strip(), len(candidates)))
    return routes, unresolved


routes, unresolved_mounts = collect_routes(
    [p for p in sorted((ROOT / "internal" / "api").glob("*.go")) if not p.name.endswith("_test.go")]
)
route_paths = {path for _, path in routes}


# ----------------------------------------------------------------- (b) spec

spec_ops = set()     # (METHOD, normalised path)
spec_paths = set()
in_paths = False
current_path = None

for line in (ROOT / "api" / "openapi.yaml").read_text().splitlines():
    if line.rstrip() == "paths:":
        in_paths = True
        continue
    if in_paths and line.rstrip() == "components:":
        break
    if not in_paths:
        continue
    path_match = re.match(r"""^  (?:["']([^"']*)["']|(/\S*)):\s*$""", line)
    if path_match:
        current_path = normalise(path_match.group(1) or path_match.group(2))
        spec_paths.add(current_path)
        continue
    method_match = re.match(
        r"^    (get|post|put|delete|patch|head|options):\s*(?:\{\s*\})?\s*$", line
    )
    if method_match and current_path:
        spec_ops.add((method_match.group(1).upper(), current_path))

# ---------------------------------------------------------------- (c) client

CLIENT_ROOTS = ("ui/src", "desktop/src", "mobile")
CLIENT_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")

# A literal can hold a bare path (`/api/tasks`) or a URL built around one
# (`${base}/api/health`, `wss://${host}/api/terminal/...`), so the path is
# found inside the quoted text rather than at the start of it. The console is
# scanned as a whole, not only its api/ layer, because URL literals also live
# beside the components that use them.
API_PATH = re.compile(r"/(?:api|a2a)/[^\"'`\s]*")
PATH_STOP = set(" \t\r\n\"'`<>")
# A query suffix is a variable named for one, or a ternary whose branch is a
# literal query string. A `?` on its own is not enough: `id ?? ""` is a
# segment value, not a query.
QUERY_EXPR = re.compile(r"\b(?:qs|query|suffix|q)\b|[`'\"]\s*\?")


def is_query_suffix(expr):
    return bool(QUERY_EXPR.search(expr))


def interp_end(text, start):
    """Index just past the ${...} that starts at text[start]."""
    depth = 0
    i = start + 1
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return len(text)


def literals(text):
    """Yield (offset, body) for each string literal, templates included.

    A template can nest another template inside `${...}` (the query-suffix
    idiom does), so the closing backtick is found by skipping interpolations.
    A single- or double-quoted string must close on its own line; otherwise an
    apostrophe in prose would swallow the code after it.
    """
    i = 0
    n = len(text)
    while i < n:
        if text.startswith("//", i):
            newline = text.find("\n", i)
            i = n if newline == -1 else newline + 1
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        quote = text[i]
        if quote not in "\"'`":
            i += 1
            continue
        start = i
        i += 1
        closed = False
        while i < n:
            ch = text[i]
            if ch == "\\":
                i += 2
                continue
            if quote == "`" and text.startswith("${", i):
                i = interp_end(text, i)
                continue
            if ch == quote:
                yield start, text[start + 1:i]
                i += 1
                closed = True
                break
            if quote != "`" and ch == "\n":
                break
            i += 1
        if not closed:
            i = max(i, start + 1)


def client_path(literal):
    """Turn a client URL literal into a comparable path.

    The clients build URLs two ways:
      `/api/tasks/${encodeURIComponent(id)}/events`   -> path parameter
      `/api/sessions${qs ? `?${qs}` : ""}`            -> query suffix
    An interpolation that is a whole path segment is a parameter; an
    interpolation that carries a query ends the path. Any other interpolation
    (for example `/api/tasks/${id}.json`) returns None: comparing the parent
    path would mark an undocumented child as covered.
    """
    def finish(parts):
        return normalise("".join(parts).rstrip(".,;:)"))

    out = []
    i = 0
    while i < len(literal):
        if literal.startswith("${", i):
            end = interp_end(literal, i)
            expr = literal[i + 2:end - 1]
            before = literal[i - 1] if i else ""
            after = literal[end] if end < len(literal) else ""
            if before == "/" and after in ("", "/", "?"):
                # A whole path segment is a parameter, whatever the expression
                # looks like: `${id ?? ""}` is still one segment and must not
                # collapse the URL to its parent.
                out.append("{}")
                i = end
                continue
            if is_query_suffix(expr):
                # A query suffix ends the URL. Anything after it means the
                # interpolation was part of a path segment, not a query.
                return finish(out) if after in ("", "?") else None
            if literal.startswith("?", end):
                return finish(out)
            return None
        if literal[i] == "?":
            return finish(out)
        if literal[i] in PATH_STOP:
            return finish(out)
        out.append(literal[i])
        i += 1
    return finish(out)


CALL_NAME = re.compile(r"\b(?:apiFetch|authFetch|fetch)\b")
# Which argument holds the request init: authFetch(path, token, init).
INIT_ARG = {"fetch": 1, "apiFetch": 1, "authFetch": 2}


def skip_quoted(text, i):
    quote = text[i]
    i += 1
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if quote == "`" and text.startswith("${", i):
            i = interp_end(text, i)
            continue
        if text[i] == quote:
            return i + 1
        i += 1
    return len(text)


def call_end(text, open_paren):
    """Index just past the parenthesis that closes this call."""
    depth = 0
    i = open_paren
    while i < len(text):
        ch = text[i]
        if ch in "\"'`":
            i = skip_quoted(text, i)
            continue
        if text.startswith("//", i):
            newline = text.find("\n", i)
            i = len(text) if newline == -1 else newline
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = len(text) if end == -1 else end + 2
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return len(text)


def generic_end(text, start):
    """Index just past a balanced <...> type-argument list, or start."""
    depth = 0
    i = start
    while i < len(text):
        ch = text[i]
        if ch in "\"'`":
            i = skip_quoted(text, i)
            continue
        if ch == "<":
            depth += 1
        elif ch == ">":
            if i and text[i - 1] == "=":
                # The `>` of a `=>` function type, not a closing angle.
                i += 1
                continue
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return start


def call_spans(text):
    """Fetch-style call spans, ignoring calls written inside comments/strings."""
    spans = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in "\"'`":
            i = skip_quoted(text, i)
            continue
        if text.startswith("//", i):
            newline = text.find("\n", i)
            i = n if newline == -1 else newline
            continue
        if text.startswith("/*", i):
            closed = text.find("*/", i + 2)
            i = n if closed == -1 else closed + 2
            continue
        match = CALL_NAME.match(text, i)
        if not match:
            i += 1
            continue
        j = match.end()
        while j < n and text[j].isspace():
            j += 1
        if j < n and text[j] == "<":
            j = generic_end(text, j)
            while j < n and text[j].isspace():
                j += 1
        if j < n and text[j] == "(":
            spans.append((match.start(), j, call_end(text, j), match.group(0)))
        i = match.end()
    return spans


def call_args(text, open_paren, end):
    """Top-level argument ranges of one call, as (start, stop)."""
    args = []
    depth = 0
    start = open_paren + 1
    i = start
    while i < end - 1:
        ch = text[i]
        if ch in "\"'`":
            i = skip_quoted(text, i)
            continue
        if text.startswith("//", i):
            newline = text.find("\n", i)
            i = len(text) if newline == -1 else newline
            continue
        if text.startswith("/*", i):
            closed = text.find("*/", i + 2)
            i = len(text) if closed == -1 else closed + 2
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                break
            depth -= 1
        elif ch == "," and depth == 0:
            args.append((start, i))
            start = i + 1
        i += 1
    args.append((start, end - 1))
    return args


def init_method(init):
    """The method an object-literal request init names, or None if unknowable.

    Only a top-level `method: "<literal>"` counts: a nested object's method, a
    comment, or a shorthand property is not a literal method. A spread after
    the method can override it, so a literal that precedes one does not count
    either. No method and no spread means GET.
    """
    depth = 0
    i = 0
    n = len(init)
    method = None   # (value or None, position)
    last_spread = -1
    while i < n:
        ch = init[i]
        if ch in "\"'`":
            end = skip_quoted(init, i)
            if depth == 1 and init[i + 1:end - 1] == "method":
                literal = re.match(r"\s*:\s*([\"'`])([A-Za-z]+)\1", init[end:])
                method = (literal.group(2).upper() if literal else None, i)
            i = end
            continue
        if init.startswith("//", i):
            newline = init.find("\n", i)
            i = n if newline == -1 else newline
            continue
        if init.startswith("/*", i):
            closed = init.find("*/", i + 2)
            i = n if closed == -1 else closed + 2
            continue
        if ch == "{":
            depth += 1
            i += 1
            continue
        if ch == "}":
            depth -= 1
            i += 1
            continue
        if depth == 1 and init.startswith("...", i):
            last_spread = i
            i += 3
            continue
        if depth == 1 and (ch.isalpha() or ch in "_$"):
            word = re.match(r"[A-Za-z_$][A-Za-z0-9_$]*", init[i:]).group(0)
            if word == "method":
                rest = init[i + len(word):]
                literal = re.match(r"\s*:\s*([\"'`])([A-Za-z]+)\1", rest)
                method = (literal.group(2).upper() if literal else None, i)
            i += len(word)
            continue
        i += 1
    if method is None:
        return None if last_spread >= 0 else "GET"
    value, position = method
    if value is None or last_spread > position:
        return None
    return value


def method_in_call(text, span):
    """The HTTP method a fetch-style call uses, or None when it is not literal.

    `fetch(path)` and `apiFetch(path)` are GET. When the request init object
    names a method, that is the method; an init that is a variable or carries
    a spread could override it, so it stays unknown. `authFetch` takes the
    init third, after the token.
    """
    _, open_paren, end, name = span
    args = call_args(text, open_paren, end)
    index = INIT_ARG.get(name, 1)
    if index >= len(args):
        return "GET"
    init = text[args[index][0]:args[index][1]].strip()
    if not init or init in ("undefined", "null"):
        return "GET"
    if not init.startswith("{"):
        return None
    return init_method(init)


client_paths = {}       # path -> source files
client_ops = {}         # (method or None, path) -> source files
client_unresolved = []  # (file, line, literal) this check cannot compare

for root_name in CLIENT_ROOTS:
    root = ROOT / root_name
    if not root.exists():
        continue
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix not in CLIENT_SUFFIXES:
            continue
        rel = path.relative_to(ROOT)
        if "node_modules" in rel.parts or "generated" in rel.parts:
            continue
        if ".test." in path.name or ".spec." in path.name:
            continue
        text = path.read_text(errors="ignore")
        spans = call_spans(text)
        for offset, body in literals(text):
            enclosing = [s for s in spans if s[0] <= offset < s[2]]
            method = (
                method_in_call(text, min(enclosing, key=lambda s: s[2] - s[0]))
                if enclosing
                else None
            )
            for match in API_PATH.finditer(body):
                start = match.start()
                if start and body[start - 1] in "@.":
                    # A module specifier (@/api/client, ../api/client), not a call.
                    continue
                candidate = client_path(body[start:])
                if candidate is None:
                    line = text.count("\n", 0, offset) + 1
                    client_unresolved.append((str(rel), line, match.group(0)))
                    continue
                if candidate.startswith(("/api/", "/a2a/")):
                    client_paths.setdefault(candidate, set()).add(str(rel))
                    client_ops.setdefault((method, candidate), set()).add(str(rel))

# ------------------------------------------------------------- comparisons

client_undocumented = sorted(p for p in client_paths if p not in spec_paths)
client_unrouted = sorted(p for p in client_paths if p not in route_paths)
# A method is compared only when the call makes it visible. A path that is
# itself undocumented is already reported above, so method checks are limited
# to paths the spec and the router otherwise know.
client_method_undocumented = sorted(
    (method, path)
    for method, path in client_ops
    if method and path in spec_paths and (method, path) not in spec_ops
)
client_method_unrouted = sorted(
    (method, path)
    for method, path in client_ops
    if method and path in route_paths and (method, path) not in routes
)
spec_unrouted = sorted(
    (method, path) for method, path in spec_ops if (method, path) not in routes
)
routed_undocumented = sorted(
    (method, path) for method, path in routes if (method, path) not in spec_ops
)

failed = False


def report(title, rows, detail=None):
    global failed
    if not rows:
        return
    failed = True
    print(f"FAIL {title} ({len(rows)})")
    for row in rows:
        suffix = f"  <- {detail(row)}" if detail else ""
        print(f"  {row}{suffix}")


report(
    "client paths not documented in api/openapi.yaml",
    client_undocumented,
    lambda p: ", ".join(sorted(client_paths[p])),
)
report(
    "client paths not registered by internal/api",
    client_unrouted,
    lambda p: ", ".join(sorted(client_paths[p])),
)
report(
    "client methods not documented in api/openapi.yaml",
    [f"{method} {path}" for method, path in client_method_undocumented],
    lambda row: ", ".join(sorted(client_ops[tuple(row.split(" ", 1))])),
)
report(
    "client methods not registered by internal/api",
    [f"{method} {path}" for method, path in client_method_unrouted],
    lambda row: ", ".join(sorted(client_ops[tuple(row.split(" ", 1))])),
)
report(
    "documented operations no longer registered",
    [f"{method} {path}" for method, path in spec_unrouted],
)
if unresolved_mounts:
    failed = True
    print(f"FAIL mounted routers that could not be parsed ({len(unresolved_mounts)})")
    for mount_path, expression, count in unresolved_mounts:
        print(f"  {mount_path}  <- {expression} ({count} candidates)")
if client_unresolved:
    failed = True
    print(f"FAIL client URL literals this check cannot compare ({len(client_unresolved)})")
    for rel, line, literal in client_unresolved:
        print(f"  {rel}:{line}  {literal}")

print(
    f"routes: {len(routes)} registered, {len(spec_ops)} documented operations, "
    f"{len(client_paths)} client paths"
)
if routed_undocumented:
    print(
        f"note: {len(routed_undocumented)} registered operations are not in the spec"
        + (" (listed below)" if VERBOSE else " (run with --verbose to list)")
    )
    if VERBOSE:
        for method, path in routed_undocumented:
            print(f"  {method} {path}")

if failed:
    sys.exit(1)
print("OK: every client-used path and method is documented and registered; no stale paths")
PY
