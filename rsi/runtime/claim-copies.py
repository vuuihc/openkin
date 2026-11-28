#!/usr/bin/env python3
"""claim-copies.py — one rule, N copies: name every file still teaching the old rule.

A rule that lives in N files drifts one copy at a time. #568 made the
evidence-width rule executable in eight files by hard-coding that list, so the
three copies it missed (the generated worker contract, the dogfooder walk, the
merge gate's screenshot sendback) were found by a model review a round later,
after a full gate. A hard-coded list cannot name the next copy. This checker
reads a registry of sweep groups and walks each group's scope looking for the
old rule, so the copy the sweep missed is named by the worker's own gate.

For every group in the registry:

  * A scoped file whose line matches a `stale` pattern is red unless the file is
    in `swept` or in `allow`; on stderr:
        path:line: stale copy of <id> (not swept, not allowed)
  * Every file in `swept` must carry the new rule (`current`, one line naming
    every number it declares); on stderr:
        path: swept file no longer carries <id>
  * An `allow` entry that suppressed nothing this run is printed on stderr only
    (`unused allow: <path>`) and does not fail the run: removing the last stale
    copy from a file is the point, so a doc cleanup must never red the gate.

Nothing goes to stdout, so a caller that only wants the verdict can ignore both
streams and read the exit code.

Scope globs are relative to the scanned root. Test fixtures and local state
quote the old rule on purpose (a replay case needs the pre-#568 sentence), so
`rsi/runtime/tests/` and `rsi/state/` are excluded by the checker itself: a
registry edit must not be able to turn a fixture into a copy the gate polices.

Usage: claim-copies.py [--root DIR] [--registry FILE]
Exit:  0 = pass, 1 = a stale copy or a drifted swept file, 2 = usage or registry error.

`--root` is the tree to scan (default: this repo); the hermetic suite points it
at throwaway trees. `--registry` defaults to rsi/runtime/claim-copies.json in
this repo, so a fixture tree needs no copy of the registry. Standard library
only, no network, no state dirs: the worker's gate and the merge lane both run
it.
"""

import argparse
import glob
import json
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_REGISTRY = os.path.join(REPO_ROOT, "rsi", "runtime", "claim-copies.json")
EXCLUDE_PREFIXES = ("rsi/runtime/tests/", "rsi/state/")
MIN_ALLOW_REASON = 10


class RegistryError(Exception):
    """The registry cannot be read or does not describe a checkable group."""


def read_text(path):
    """Read a UTF-8 file without ever raising on undecodable bytes."""
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return handle.read()


def normalise(path):
    """A registry path without a leading `./`, using forward slashes."""
    path = path.strip()
    while path.startswith("./"):
        path = path[2:]
    return path.replace(os.sep, "/")


def contained(root, path):
    """True when `path` resolves inside `root` (both real paths)."""
    return path == root or path.startswith(root + os.sep)


def compile_stale(patterns, group_id):
    """Compile a group's stale patterns, raising RegistryError on a bad one."""
    compiled = []
    for pattern in patterns:
        if not isinstance(pattern, str) or not pattern:
            raise RegistryError("group %s has a non-string stale pattern" % group_id)
        try:
            compiled.append(re.compile(pattern))
        except re.error as exc:
            raise RegistryError(
                "group %s: stale pattern %r does not compile: %s" % (group_id, pattern, exc)
            )
    return compiled


def load_groups(path):
    """The registry's groups, validated, or RegistryError."""
    try:
        data = json.loads(read_text(path))
    except OSError as exc:
        raise RegistryError("cannot read %s: %s" % (path, exc))
    except ValueError as exc:
        raise RegistryError("%s is not valid JSON: %s" % (path, exc))
    groups = data.get("groups") if isinstance(data, dict) else None
    if not isinstance(groups, list) or not groups:
        raise RegistryError("%s must be an object with a non-empty 'groups' array" % path)

    seen = set()
    for index, group in enumerate(groups):
        if not isinstance(group, dict):
            raise RegistryError("group %d is not an object" % index)
        group_id = group.get("id")
        if not isinstance(group_id, str) or not group_id.strip():
            raise RegistryError("group %d has no id" % index)
        if group_id in seen:
            raise RegistryError("group id %r appears twice" % group_id)
        seen.add(group_id)
        if not isinstance(group.get("why"), str) or not group["why"].strip():
            raise RegistryError("group %s has no 'why' (the rule's source)" % group_id)
        scope = group.get("scope")
        if not isinstance(scope, list) or not scope or not all(
            isinstance(item, str) and item for item in scope
        ):
            raise RegistryError("group %s has no 'scope' globs" % group_id)
        stale = group.get("stale")
        if not isinstance(stale, list) or not stale:
            raise RegistryError("group %s has no 'stale' patterns" % group_id)
        compile_stale(stale, group_id)
        current = group.get("current")
        if not isinstance(current, dict):
            raise RegistryError("group %s has no 'current' object" % group_id)
        has_digits = "one_line_digits" in current
        has_terms = "one_line_terms" in current
        if has_digits == has_terms:
            raise RegistryError(
                "group %s: 'current' must declare exactly one of one_line_digits or one_line_terms"
                % group_id
            )
        digits = current.get("one_line_digits")
        terms = current.get("one_line_terms")
        if has_digits and not (
            isinstance(digits, list) and digits and all(isinstance(digit, int) for digit in digits)
        ):
            raise RegistryError("group %s: one_line_digits must be a non-empty list of integers" % group_id)
        if has_terms and not (
            isinstance(terms, list) and terms and all(isinstance(term, str) and term for term in terms)
        ):
            raise RegistryError("group %s: one_line_terms must be a non-empty list of strings" % group_id)
        swept = group.get("swept", [])
        if not isinstance(swept, list) or not all(
            isinstance(item, str) and item for item in swept
        ):
            raise RegistryError("group %s: swept must be a list of paths" % group_id)
        allow = group.get("allow", [])
        if not isinstance(allow, list):
            raise RegistryError("group %s: allow must be a list" % group_id)
        for entry in allow:
            if not isinstance(entry, dict):
                raise RegistryError("group %s: an allow entry is not an object" % group_id)
            allow_path = entry.get("path")
            if not isinstance(allow_path, str) or not allow_path.strip():
                raise RegistryError("group %s: an allow entry has no path" % group_id)
            reason = entry.get("reason")
            if not isinstance(reason, str) or len(reason.strip()) < MIN_ALLOW_REASON:
                raise RegistryError(
                    "group %s: allow entry %s has no reason (at least %d characters)"
                    % (group_id, normalise(allow_path), MIN_ALLOW_REASON)
                )
    return groups


def iter_scoped(root, patterns):
    """Every regular file under `root` matching a scope glob, sorted, minus exclusions.

    A symlink that resolves outside the scanned tree is not part of the tree and
    is skipped rather than read.
    """
    root_real = os.path.realpath(root)
    found = set()
    for pattern in patterns:
        for path in glob.glob(os.path.join(root, pattern), recursive=True):
            if not os.path.isfile(path):
                continue
            if not contained(root_real, os.path.realpath(path)):
                continue
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            if rel.startswith(EXCLUDE_PREFIXES):
                continue
            found.add(rel)
    return sorted(found)


def carries_current(text, current):
    """True when one line carries every digit or term the rule declares."""
    digits = current.get("one_line_digits")
    if digits is not None:
        needles = [re.compile(r"(?<![0-9])%d(?![0-9])" % digit) for digit in digits]
        return any(
            all(needle.search(line) for needle in needles) for line in text.splitlines()
        )
    terms = current["one_line_terms"]
    return any(all(term in line for term in terms) for line in text.splitlines())


def matches_stale(line, stale):
    """True when any stale pattern matches this line."""
    return any(regex.search(line) for regex in stale)


def check_group(root, group, problems, unused):
    """Append this group's findings to `problems` and its unused allows to `unused`."""
    group_id = group["id"]
    stale = compile_stale(group["stale"], group_id)
    current = group["current"]
    swept = [normalise(path) for path in group.get("swept", [])]
    swept_set = set(swept)
    allow = {
        normalise(entry["path"]): entry["reason"] for entry in group.get("allow", [])
    }
    used = set()

    for rel in iter_scoped(root, group["scope"]):
        if rel in swept_set:
            continue  # the drift check below owns this file
        try:
            lines = read_text(os.path.join(root, rel)).splitlines()
        except OSError as exc:
            raise RegistryError("cannot read the scoped file %s: %s" % (rel, exc))
        for lineno, line in enumerate(lines, 1):
            if matches_stale(line, stale):
                if rel in allow:
                    used.add(rel)
                else:
                    problems.append(
                        "%s:%d: stale copy of %s (not swept, not allowed)"
                        % (rel, lineno, group_id)
                    )

    for rel in swept:
        try:
            text = read_text(os.path.join(root, rel))
        except OSError:
            problems.append("%s: swept file no longer carries %s" % (rel, group_id))
            continue
        if not carries_current(text, current):
            problems.append("%s: swept file no longer carries %s" % (rel, group_id))

    for rel in sorted(set(allow) - used):
        unused.append(rel)


def main(argv):
    parser = argparse.ArgumentParser(
        prog="claim-copies.py",
        description="Name every copy of a rule that still teaches the old rule.",
    )
    parser.add_argument("--root", default=REPO_ROOT, help="tree to scan (default: this repo)")
    parser.add_argument(
        "--registry", default=DEFAULT_REGISTRY, help="sweep-group registry JSON"
    )
    args = parser.parse_args(argv[1:])

    if not os.path.isdir(args.root):
        sys.stderr.write("claim-copies: no such root: %s\n" % args.root)
        return 2
    problems, unused = [], []
    try:
        for group in load_groups(args.registry):
            check_group(args.root, group, problems, unused)
    except RegistryError as exc:
        sys.stderr.write("claim-copies: %s\n" % exc)
        return 2

    for line in problems:
        sys.stderr.write(line + "\n")
    # A doc cleanup must never red the gate: name the allow entry the cleanup
    # freed and keep the run green.
    for rel in unused:
        sys.stderr.write("unused allow: %s\n" % rel)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
