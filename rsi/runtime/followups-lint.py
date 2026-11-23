#!/usr/bin/env python3
"""Mark which open follow-ups cite an already-merged ref, so a planner reads those first.

The loop's process defects are written into ``state/followups.md``, one ``- [ ]`` line each,
usually naming the PR (``#480``) or commit (``a81cbaa1``) it is about. Nothing ever
checks that list, so it passed 1,600 lines and on 2026-11-21 a planner reading it nearly
started three lanes for work already on ``main``. This tool is the read-only answer:

    followups-lint.py [--state DIR] [--status] [--stale] [--json] [--repo DIR] [--base REF]

Reads ``<state>/followups.md`` and ``<state>/merged.log`` and reports, per unchecked line,
whether any of its references is a citation of something already merged. A citation is a
**hint to read that line, not a verdict that it is done**: live lines cite a merged ref as
the trigger, the regression, or the evidence, so the work they ask for can still be open.

``--stale`` adds the column a citation cannot give: whether the repo-relative path — and the
``:line`` or ``:start-end`` it names — still exists at ``--base``. A path token is at least one
``/`` and a final segment with an extension (the same ``PATH_RE`` the gap-log check uses); a bare
basename is ambiguous in this repo and a token carrying ``://`` is a URL, so neither is guessed.
Presence is read from ``<base>:<path>`` through git, **never from the worktree**: a file that
exists only in a working tree is not on the base ref, and one the base has but the worktree
deleted still is. ``present=no`` is the actionable column. Anything unresolvable — no git, an
unknown ``--base``, a timeout, an oversized (>2 MiB) or binary blob — is ``present=unknown``,
**never** ``no``: unknown is a reason to read the line, not a licence to skip it. The extra
columns appear only when ``--stale`` is asked for; ``--status`` is unchanged by it.

* a PR number is cited when ``#<n>`` appears in ``merged.log`` (the merge lane's
  ``<date> <time> PR #<n> … merged <sha> <url>`` line). A bare ``/pull/42`` URL is not the
  marker — only the ``#<n>`` token is;
* a hex id is cited only when ``git cat-file -e`` resolves it *and*
  ``git merge-base --is-ancestor <sha> <base>`` exits 0 (``--base``, default
  ``origin/main``). An id that does not resolve locally is **open**: a shallow or stale
  clone must never produce a false "done".

It is a report, never an editor — no file is written, so ``followups.md``'s hash is identical
after any run. Exit 0 for every successful read (citations are not an error), exit 2 for
a usage error. Seams: ``--state`` then ``$RSI_STATE`` then ``$STATE`` then ``rsi/state``
under the repo; ``--repo`` then ``$RSI_CTRL`` then the repository this script lives in.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# One rule for "a repo-relative path cited in prose", shared with the gap-log check rather than
# restated: at least one `/`, a final segment with an extension, and the match stops before a
# `:line` suffix. The script's own directory is on sys.path, and the import has no side effects.
from gap_log_check import PATH_RE, normalise

CHECKBOX_RE = re.compile(r"^\s*-\s+\[ \]\s*(.*)$")
PR_RE = re.compile(r"#(\d+)")
# In merged.log only a whole `#N` token is the marker, never digits inside another word.
MERGED_PR_RE = re.compile(r"(?<!\w)#(\d+)\b")
SHA_RE = re.compile(r"\b[0-9a-f]{7,40}\b", re.IGNORECASE)
TOKEN_RE = re.compile(r"\S+")
# The `:line` / `:start-end` suffix right after a cited path; the path itself ends before it.
CITED_LINE_RE = re.compile(r":(\d+)(?:-(\d+))?")
MAX_BLOB_BYTES = 2 * 1024 * 1024

CITED, OPEN = "cited", "open"
PRESENT_YES, PRESENT_NO, PRESENT_UNKNOWN = "yes", "no", "unknown"


def repo_dir(arg: str | None) -> Path:
    """--repo, then $RSI_CTRL, then the repository this script sits in (rsi/runtime/../..)."""
    if arg:
        return Path(arg)
    if os.environ.get("RSI_CTRL"):
        return Path(os.environ["RSI_CTRL"])
    return Path(__file__).resolve().parent.parent.parent


def state_dir(arg: str | None, repo: Path) -> Path:
    if arg:
        return Path(arg)
    for key in ("RSI_STATE", "STATE"):
        if os.environ.get(key):
            return Path(os.environ[key])
    return repo / "rsi" / "state"


def open_lines(text: str) -> list[tuple[int, str]]:
    """(1-based line number, text after the checkbox) for every unchecked line only."""
    rows = []
    for n, line in enumerate(text.splitlines(), 1):
        hit = CHECKBOX_RE.match(line)
        if hit:
            rows.append((n, hit.group(1).strip()))
    return rows


def refs_of(text: str) -> list[str]:
    """PR and hex references in the order they appear, deduplicated, shas lowercased."""
    found: list[tuple[int, str]] = []
    for m in PR_RE.finditer(text):
        found.append((m.start(), "#" + m.group(1)))
    for m in SHA_RE.finditer(text):
        found.append((m.start(), m.group(0).lower()))
    out: list[str] = []
    for _, ref in sorted(found, key=lambda pair: pair[0]):
        if ref not in out:
            out.append(ref)
    return out


def merged_prs(text: str) -> set[str]:
    """Every ``#<n>`` token in merged.log; a URL path or slug is not a marker.

    Kept as digit strings so a pathological run of digits cannot overflow int parsing.
    """
    return {n for line in text.splitlines() for n in MERGED_PR_RE.findall(line)}


def git(repo: Path, *args: str):
    try:
        return subprocess.run(["git", "-C", str(repo), *args],
                              capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None


def sha_landed(sha: str, repo: Path, base: str, cache: dict[str, bool]) -> bool:
    """Ancestor of base, and only when the id resolves here: unresolved means open."""
    if sha in cache:
        return cache[sha]
    exists = git(repo, "cat-file", "-e", f"{sha}^{{commit}}")
    ok = exists is not None and exists.returncode == 0
    if ok:
        anc = git(repo, "merge-base", "--is-ancestor", sha, base)
        ok = anc is not None and anc.returncode == 0
    cache[sha] = ok
    return ok


def cited_paths(text: str) -> list[dict]:
    """Repo-relative paths one follow-up line cites, in first-seen order.

    Backticks are prose punctuation, not part of a path. A token carrying ``://`` is a URL and a
    bare basename has no ``/``; neither is turned into a guess. The ``:line`` or ``:start-end``
    suffix is kept beside the path (``token``, ``cited_lines``), never folded into it.
    """
    found: list[dict] = []
    seen: set[tuple[str, tuple[int, ...]]] = set()
    for token in TOKEN_RE.findall(text.replace("`", " ")):
        if "://" in token:
            continue
        for m in PATH_RE.finditer(token):
            path = normalise(m.group(0))
            suffix = CITED_LINE_RE.match(token[m.end():])
            lines = tuple(int(g) for g in suffix.groups() if g) if suffix else ()
            key = (path, lines)
            if key in seen:
                continue
            seen.add(key)
            found.append({"token": m.group(0) + (suffix.group(0) if suffix else ""),
                          "path": path,
                          "cited_lines": list(lines)})
    return found


def at_text(lines: list[str], n: int) -> str:
    """The cited line, whitespace-collapsed and trimmed to 60 chars.

    ``-`` when the line is blank or its text would splice a second ``text=`` field into ours.
    """
    text = re.sub(r"\s+", " ", lines[n - 1]).strip()
    if not text or "text=" in text:
        return "-"
    return text[:60]


class BaseTree:
    """Path presence at a base ref, read from git and never from the worktree.

    The base is resolved once, so an unknown ``--base`` (or a missing git) cannot turn every
    citation into a false ``no``: every answer is then ``unknown`` plus one stderr note.
    """

    def __init__(self, repo: Path, base: str) -> None:
        self.repo = repo
        self.base = base
        resolved = git(repo, "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}")
        self.ok = resolved is not None and resolved.returncode == 0
        if not self.ok:
            print(f"followups-lint: cannot resolve --base {base} — cited paths are unknown",
                  file=sys.stderr)
        self.states: dict[str, str] = {}
        self.blobs: dict[str, list[str] | None] = {}

    def state(self, path: str) -> str:
        """``yes``/``no``/``unknown`` for ``<base>:<path>``; a failed git call is unknown."""
        if not self.ok:
            return PRESENT_UNKNOWN
        if path not in self.states:
            hit = git(self.repo, "cat-file", "-e", f"{self.base}:{path}")
            if hit is None:
                self.states[path] = PRESENT_UNKNOWN
            elif hit.returncode == 0:
                self.states[path] = PRESENT_YES
            else:
                self.states[path] = PRESENT_NO
        return self.states[path]

    def blob(self, path: str) -> list[str] | None:
        """The base blob's lines, or None when it is oversized, binary, or cannot be read."""
        if path not in self.blobs:
            self.blobs[path] = self._blob(path)
        return self.blobs[path]

    def _blob(self, path: str) -> list[str] | None:
        size = git(self.repo, "cat-file", "-s", f"{self.base}:{path}")
        if size is None or size.returncode != 0:
            return None
        try:
            too_big = int(size.stdout.strip()) > MAX_BLOB_BYTES
        except ValueError:
            return None
        if too_big:
            return None
        show = git(self.repo, "show", f"{self.base}:{path}")
        if show is None or show.returncode != 0 or "\x00" in show.stdout:
            return None
        return show.stdout.splitlines()


def path_verdict(item: dict, tree: BaseTree) -> dict:
    """One cited path's verdict: presence at base, plus the cited line's text when readable."""
    present = tree.state(item["path"])
    at = "-"
    if present == PRESENT_YES and item["cited_lines"]:
        lines = tree.blob(item["path"])
        if lines is None:
            present = PRESENT_UNKNOWN
        else:
            last = max(item["cited_lines"])
            if last > len(lines):
                present = PRESENT_NO
            else:
                at = at_text(lines, last)
    return {**item, "present": present, "at": at}


def classify(items: list[tuple[int, str]], prs: set[str], repo: Path, base: str,
             stale: bool = False) -> list[dict]:
    cache: dict[str, bool] = {}
    tree = BaseTree(repo, base) if stale else None
    rows = []
    for line, text in items:
        refs = refs_of(text)
        cited = None
        for ref in refs:
            if ref.startswith("#"):
                if ref[1:] in prs:
                    cited = ref
                    break
            elif sha_landed(ref, repo, base, cache):
                cited = ref
                break
        shown = cited or (refs[0] if refs else None)
        merged = None
        if shown is not None:
            merged = (shown[1:] in prs) if shown.startswith("#") \
                else sha_landed(shown, repo, base, cache)
        row = {"line": line, "text": text, "refs": refs, "cited": cited, "merged": merged}
        if tree is not None:
            row["paths"] = [path_verdict(item, tree) for item in cited_paths(text)]
            # present is the line's verdict: one gone citation names the whole follow-up stale.
            paths = row["paths"]
            if any(p["present"] == PRESENT_NO for p in paths):
                present = PRESENT_NO
            elif any(p["present"] == PRESENT_YES for p in paths):
                present = PRESENT_YES
            else:
                present = PRESENT_UNKNOWN
            first = paths[0] if paths else None
            row.update({
                "ref": shown or "-",
                "merged_label": "-" if shown is None else ("yes" if merged else "no"),
                "path": first["token"] if first else "-",
                "present": present,
                "at": next((p["at"] for p in paths if p["at"] != "-"), "-"),
            })
        rows.append(row)
    return rows


def stale_line(row: dict) -> str:
    """One `--stale` table row: fixed columns first, the prose last."""
    state = CITED if row["cited"] else OPEN
    return (f"{state} {row['line']} ref={row['ref']} merged={row['merged_label']} "
            f"path={row['path']} present={row['present']} at={row['at']} "
            f"text={row['text'][:80]}")


def status_line(rows: list[dict]) -> str:
    cited = [r["cited"] for r in rows if r["cited"]]
    line = f"followups: {len(rows)} open, {len(cited)} cite a merged ref"
    if cited:
        line += f" ({', '.join(cited[:5])})"
    return line


def read(path: Path, label: str) -> str | None:
    """Missing/unreadable is a note on stderr and a zero contribution, never a crash."""
    if not path.is_file():
        print(f"followups-lint: no {label} at {path} — treating it as empty", file=sys.stderr)
        return None
    try:
        # utf-8-sig: a BOM must not eat the first follow-up line.
        return path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError as exc:
        print(f"followups-lint: cannot read {path}: {exc} — treating it as empty", file=sys.stderr)
        return None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="mark open follow-ups that cite a merged ref")
    ap.add_argument("--state", help="state dir (default $RSI_STATE, $STATE, repo/rsi/state)")
    ap.add_argument("--status", action="store_true", help="one deterministic summary line")
    ap.add_argument("--stale", action="store_true",
                    help="add whether each cited path/line still exists at --base")
    ap.add_argument("--json", action="store_true", help="machine-readable report")
    ap.add_argument("--repo", help="git repo for SHA checks (default $RSI_CTRL, this repo)")
    ap.add_argument("--base", default="origin/main", help="branch SHAs must be ancestors of")
    a = ap.parse_args(argv)

    repo = repo_dir(a.repo)
    state = state_dir(a.state, repo)
    followups = read(state / "followups.md", "followups.md")
    merged = read(state / "merged.log", "merged.log")
    if followups is None:
        rows: list[dict] = []
    else:
        # --status ignores --stale, so it must not pay for (or report) path lookups either.
        rows = classify(open_lines(followups), merged_prs(merged or ""), repo, a.base,
                        stale=a.stale and not a.status)

    cited = sum(1 for r in rows if r["cited"])
    if a.status:
        print(status_line(rows))
        return 0
    if a.json:
        payload = {
            "open": len(rows),
            "cited": cited,
            "items": [{"line": r["line"], "refs": r["refs"], "cited": r["cited"]}
                      for r in rows],
        }
        if a.stale:
            payload["stale"] = sum(1 for r in rows
                                   if any(p["present"] == PRESENT_NO for p in r["paths"]))
            payload["items"] = [{"line": r["line"], "refs": r["refs"], "cited": r["cited"],
                                 "paths": [{"token": p["token"], "path": p["path"],
                                            "cited_lines": p["cited_lines"],
                                            "present": p["present"], "at": p["at"]}
                                           for p in r["paths"]]}
                                for r in rows]
        print(json.dumps(payload, indent=2))
        return 0
    for r in rows:
        if a.stale:
            print(stale_line(r))
        else:
            print(f"{CITED if r['cited'] else OPEN} {r['line']} {r['text'][:80]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
