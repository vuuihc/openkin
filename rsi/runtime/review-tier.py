#!/usr/bin/env python3
"""Classify an RSI PR for the merge lane's tiered review (CEO 2026-11-15).

  review-tier.py --title T [--item ID] [--attempts N] [--numstat FILE|-] [--gh-json FILE|-]

Input is a numstat ("add<TAB>del<TAB>path" per line) or the `files` array of `gh pr view/list --json files`.
Prints one line:  <tier> <role> <size> <reasons...>

  small   pure refactor/extract (or <= 400 changed lines), no deps/migrations/auth/persist/permission, no routing-contract
          files, tests only ADDED (no test file deleted or with removed lines), not a foundation/shell/nav slice;
          docs and their design artifacts (a story's Figma frames and review page under docs/) carry no runtime
          surface, so a long one is docs-only small and never pays the size rule (2026-11-23: #629, 1346 lines of
          SVG/HTML, gated as `large` and held the only big slot for 51 minutes)
          -> role `reviewer`, ONE DeepSeek max review; escalation signals other than rework>=2 are ignored (RSI_REVIEW_TIER=small).
          If DeepSeek ends `VERDICT: UNSURE`, merge.sh runs the sol second reviewer once.
  medium  not small, <= 500 lines, nothing risky   -> role `reviewer` (DeepSeek, normal escalation signals)
  large   risky paths, > 500 lines, F*/S*/N*/Q3a items, deps, or 2+ rework rounds -> role `reviewer-alt` (gpt-6.1-sol)

A tier is a review-cost decision only. Build, tests, UX gate, CI and hold rules are identical for every tier.
"""
import argparse, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
IGNORE = re.compile(r"(^|/)(web/dist/index\.html|package-lock\.json)$")
RISKY = re.compile(r"^(go\.mod|go\.sum|ui/package(-lock)?\.json|internal/(auth|store|permission)|.*migrations?/|.*(permission|persist))", re.I)
ROUTING = re.compile(r"(route|router|navigation|areamodel|areas?\.ts|phonenav|phoneback|deeplink|leaveguard)", re.I)
TEST = re.compile(r"(\.(test|spec)\.[a-z]+$|__tests__/|/tests?/|_test\.go$)")
SHELLISH = re.compile(r"^(F\d|S\d|N\d|Q3a)")
DOC = re.compile(r"\.(md|txt)$")
# A story's design artifacts (Figma frames, the review page) sit beside its .md contract and carry no
# runtime surface. Without this they fell through to the size rule: #629 (6 frames + 1 review page,
# 1346 lines) classified `large` and spent the single big merge slot 51 minutes across two gates.
DOC_ARTIFACT = re.compile(r"^docs/.*\.(html|svg|png|jpg|jpeg|webp)$")


def item_info(item):
    try:
        sl = json.load(open(os.path.join(HERE, "..", "astryx-slices.json")))["slices"]
        return next((s for s in sl if s["id"] == item), None)
    except Exception:
        return None


def classify(title, item, attempts, rows):
    rows = [(a, d, p) for a, d, p in rows if not IGNORE.search(p)]
    size = sum(a + d for a, d, _ in rows)
    paths = [p for _, _, p in rows]
    sl = item_info(item) if item else None
    kind_refactor = bool(re.match(r"^refactor(\(|:)", title or "", re.I)) or bool(sl and re.match(r"extract", sl["title"], re.I)) \
        or bool(re.search(r"\bextract\b", title or "", re.I))
    docs_only = bool(paths) and all(DOC.search(p) or DOC_ARTIFACT.search(p) for p in paths)
    why_large = []
    if attempts >= 2: why_large.append("rework-round-%d" % attempts)
    if item and SHELLISH.match(item): why_large.append("foundation/shell/nav:%s" % item)
    risky = [p for p in paths if RISKY.search(p)]
    if risky: why_large.append("risky:%s" % risky[0])
    # Prose and design artifacts have no runtime surface to break, so length is not a risk signal for
    # them. Rework, foundation and risky-path signals above still escalate a docs PR.
    if size > 500 and not docs_only and not (kind_refactor and size <= 800): why_large.append("size:%d" % size)
    if why_large:
        return "large", "reviewer-alt", size, why_large
    # small-safe checks
    routing = [p for p in paths if ROUTING.search(p) and not TEST.search(p)]
    tests_touched_badly = [p for a, d, p in rows if TEST.search(p) and d > 0]
    reasons = []
    if docs_only: reasons.append("docs-only")
    elif kind_refactor and size <= 800: reasons.append("refactor/extract")
    elif size <= 400: reasons.append("size<=400")
    else:
        return "medium", "reviewer", size, ["size:%d" % size]
    if routing: return "medium", "reviewer", size, ["routing-contract:%s" % routing[0]]
    if tests_touched_badly: return "medium", "reviewer", size, ["tests-modified:%s" % tests_touched_badly[0]]
    return "small", "reviewer", size, reasons


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", default=""); ap.add_argument("--item", default=""); ap.add_argument("--attempts", type=int, default=0)
    ap.add_argument("--numstat"); ap.add_argument("--gh-json")
    a = ap.parse_args()
    rows = []
    if a.numstat:
        for l in (sys.stdin if a.numstat == "-" else open(a.numstat)):
            t = l.rstrip("\n").split("\t")
            if len(t) >= 3:
                rows.append((int(t[0]) if t[0].isdigit() else 0, int(t[1]) if t[1].isdigit() else 0, t[2]))
    elif a.gh_json:
        d = json.load(sys.stdin if a.gh_json == "-" else open(a.gh_json))
        for f in d if isinstance(d, list) else d.get("files", []):
            rows.append((int(f.get("additions", 0)), int(f.get("deletions", 0)), f.get("path", "")))
    tier, role, size, why = classify(a.title, a.item, a.attempts, rows)
    print("%s %s %d %s" % (tier, role, size, ";".join(why)))


if __name__ == "__main__":
    main()
