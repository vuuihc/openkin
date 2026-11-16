#!/usr/bin/env python3
"""Turn a reviewer report into a structured, line-level fix list for the rework worker (CEO 2026-11-15).

  fixlist.py REVIEW.txt            prints a markdown fix list, or nothing when no finding can be located

Prefers the reviewer's own `FIXLIST:` block (lines `- path:line | blocker|major | issue | required change`). Otherwise it extracts every
blocker/major finding that cites path:line from the free-text report. Nits are never listed (they do not fail a PR).
"""
import re, sys

FILE = r"[\w./@+-]+\.(?:tsx?|jsx?|css|go|sh|py|md|json|ya?ml|mjs)"
LOC = re.compile(r"(%s)(?::|#L|, line |\s+line\s+|\()(\d+)(?:[-–]\d+)?\)?" % FILE)
SEV = re.compile(r"\b(blocker|major)\b", re.I)


def from_block(text):
    m = re.search(r"^\s*FIXLIST:?\s*$([\s\S]*?)(?=^\s*VERDICT:|\Z)", text, re.M)
    if not m: return []
    out = []
    for l in m.group(1).splitlines():
        l = l.strip().lstrip("-*• ").strip()
        parts = [p.strip() for p in l.split("|")]
        if len(parts) >= 3 and LOC.search(parts[0]):
            lm = LOC.search(parts[0])
            out.append((lm.group(1), lm.group(2), parts[1] if len(parts) > 3 else "major", parts[-2] if len(parts) > 3 else parts[1], parts[-1]))
    return out


def from_prose(text):
    out, seen = [], set()
    blocks = re.split(r"\n\s*\n|\n(?=\s*(?:[-*]|\d+[.)])\s)", text)
    for b in blocks:
        sv = SEV.search(b)
        if not sv: continue
        if re.search(r"\bnits?\b", b, re.I) and not sv: continue
        lm = LOC.search(b)
        if not lm: continue
        key = (lm.group(1), lm.group(2))
        if key in seen: continue
        seen.add(key)
        one = re.sub(r"\s+", " ", re.sub(r"VERDICT:.*", "", b)).strip(" -*•")
        out.append((lm.group(1), lm.group(2), sv.group(1).lower(), one[:320], "see the issue; make the smallest edit that removes it"))
    return out


def main():
    text = open(sys.argv[1], errors="ignore").read()
    rows = from_block(text) or from_prose(text)
    if not rows: return
    print("| # | file:line | severity | issue | required change |\n|---|---|---|---|---|")
    for i, (f, ln, sev, issue, fix) in enumerate(rows[:25], 1):
        print("| %d | `%s:%s` | %s | %s | %s |" % (i, f, ln, sev, issue.replace("|", "/"), fix.replace("|", "/")))


main()
