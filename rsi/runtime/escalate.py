#!/usr/bin/env python3
"""Decide whether a review should escalate to Kimi k3.1 pro.

Triggers (any one):
  - slice id is Astryx foundation F1–F4 or shell S1–S3
  - the PR is on its 2nd+ rework round (state/merge/<slug>.attempts >= 2)
  - reviewer disagreement: a prior sendback / review on this slug failed the independent review

Then the Volcengine Kimi daily cap (¥80) and the overall ¥450 guard are applied.
If a trigger fires but Kimi is not allowed, we fall back to gpt-6.1-sol and still log it.

Prints shell assignments: RSI_ESCALATE_MODEL=kimi|codex|  RSI_ESCALATE_REASON=...
Logs every decision to $RSI_STATE/escalations.jsonl and escalations.log.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

SGT = timezone(timedelta(hours=8))
FOUNDATION_OR_SHELL = frozenset({"F1", "F2", "F3", "F4", "S1", "S2", "S3"})


def now() -> datetime:
    return datetime.now(SGT)


def state_dir() -> Path:
    env = os.environ.get("RSI_STATE") or os.environ.get("STATE")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "state"


def rsi_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def slug_from_tag(tag: str) -> str:
    # merge-<slug>-review / merge-<slug>-ux / laneN-<slug>-worker
    m = re.match(r"^merge-(.+)-(review|ux)$", tag or "")
    if m:
        return m.group(1)
    m = re.match(r"^lane\d+-(.+)-worker$", tag or "")
    if m:
        return m.group(1)
    return ""


def attempts(state: Path, slug: str) -> int:
    p = state / "merge" / f"{slug}.attempts"
    try:
        return int(p.read_text().strip() or "0")
    except Exception:
        return 0


def item_for(state: Path, slug: str, cwd: str) -> str:
    env = (os.environ.get("RSI_ITEM") or "").strip()
    if env:
        return env
    # sendback header
    sb = state / "sendback" / f"{slug}.md"
    if sb.is_file():
        for line in sb.read_text(errors="replace").splitlines()[:10]:
            if line.lower().startswith("item:"):
                return line.split(":", 1)[1].strip()
    # lane json
    lanes = state / "lanes"
    if lanes.is_dir():
        for p in lanes.glob("*.json"):
            try:
                d = json.loads(p.read_text())
            except Exception:
                continue
            if d.get("slug") == slug and d.get("item"):
                return str(d["item"])
    # cloud claims
    cloud = state / "cloud"
    if cloud.is_dir():
        for p in cloud.glob("*.json"):
            try:
                d = json.loads(p.read_text())
            except Exception:
                continue
            if d.get("slug") == slug and d.get("item"):
                return str(d["item"])
    # worktree name rsi-<slug> doesn't include the item id
    if cwd and "rsi-" in cwd:
        pass
    return ""


def review_disagreement(state: Path, slug: str) -> bool:
    chunks: list[str] = []
    for rel in (
        f"sendback/{slug}.md",
        f"merge/{slug}.review.txt",
        f"merge/{slug}.combined.txt",
        f"merge/{slug}.ux.txt",
    ):
        p = state / rel
        if p.is_file():
            try:
                chunks.append(p.read_text(errors="replace")[-8000:])
            except Exception:
                pass
    # also the most recent done sendback for this slug
    done = state / "sendback" / "done"
    if done.is_dir():
        cands = sorted(done.glob(f"{slug}-*.md"), key=lambda x: x.stat().st_mtime, reverse=True)
        for p in cands[:2]:
            try:
                chunks.append(p.read_text(errors="replace")[-8000:])
            except Exception:
                pass
    blob = "\n".join(chunks)
    if not blob:
        return False
    # Independent review failed, or a previous verdict was FAIL. Gate-only prettier fails do not count.
    if re.search(r"independent review FAIL|VERDICT:\s*FAIL|review FAIL", blob, re.I):
        return True
    if re.search(r"UX (gate )?FAIL", blob, re.I):
        return True
    return False


def is_foundation_or_shell(item: str) -> bool:
    # Exact ids F1–F4 / S1–S3. Not F5a or S4.
    token = (item or "").strip().split()[0] if item else ""
    return token in FOUNDATION_OR_SHELL


def triggers(state: Path, item: str, slug: str) -> list[str]:
    reasons: list[str] = []
    if is_foundation_or_shell(item):
        reasons.append(f"astryx-foundation-or-shell:{item}")
    att = attempts(state, slug) if slug else 0
    if att >= 2:
        reasons.append(f"rework-round-{att}")
    if slug and review_disagreement(state, slug):
        reasons.append("reviewer-disagreement")
    return reasons


def kimi_allowed() -> tuple[bool, dict]:
    budget = Path(__file__).resolve().parent / "volc-budget.py"
    # Import sibling without executing main: call compute via subprocess --export is simpler and stays cached.
    import subprocess

    data: dict = {}
    try:
        proc = subprocess.run(
            [sys.executable, str(budget), "--export"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        for line in (proc.stdout or "").splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                data[k.strip()] = v.strip()
    except Exception:
        pass
    level = data.get("RSI_VOLC_LEVEL", "ok")
    try:
        kimi_cny = float(data.get("RSI_VOLC_KIMI_CNY") or 0)
    except Exception:
        kimi_cny = 0.0
    try:
        cap = float(data.get("RSI_VOLC_KIMI_DAY_MAX") or 80)
    except Exception:
        cap = 80.0
    try:
        total = float(data.get("RSI_VOLC_CNY") or 0)
    except Exception:
        total = 0.0
    ok = level == "ok" and kimi_cny < cap
    return ok, dict(level=level, kimi_cny=kimi_cny, cap=cap, total=total)


def log_decision(state: Path, rec: dict) -> None:
    state.mkdir(parents=True, exist_ok=True)
    rec = dict(rec)
    rec["ts"] = now().strftime("%Y-%m-%d %H:%M:%S %Z")
    jl = state / "escalations.jsonl"
    with jl.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, sort_keys=True) + "\n")
    line = (
        f"{rec['ts']} role={rec.get('role')} slug={rec.get('slug') or '-'} item={rec.get('item') or '-'} "
        f"model={rec.get('model') or '-'} reason={rec.get('reason') or '-'} "
        f"kimi_cny=¥{rec.get('kimi_cny', 0):.2f} volc_cny=¥{rec.get('total', 0):.2f}\n"
    )
    with (state / "escalations.log").open("a", encoding="utf-8") as f:
        f.write(line)


def self_test() -> int:
    assert is_foundation_or_shell("F3")
    assert is_foundation_or_shell("S1")
    assert not is_foundation_or_shell("F5a")
    assert not is_foundation_or_shell("N1")
    assert slug_from_tag("merge-edge-swipe-continuity-review") == "edge-swipe-continuity"
    assert slug_from_tag("merge-foo-ux") == "foo"
    # disagreement detector
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        (st / "sendback").mkdir()
        (st / "sendback" / "x.md").write_text("item: Q1\nVERDICT: FAIL — Major M1\n")
        assert review_disagreement(st, "x")
        (st / "sendback" / "y.md").write_text("item: Q1\nGATE_RESULT=FAIL: prettier\n")
        assert not review_disagreement(st, "y")
        (st / "merge").mkdir()
        (st / "merge" / "z.attempts").write_text("2\n")
        rs = triggers(st, "F1", "z")
        assert any(r.startswith("rework-round-") for r in rs)
        assert any(r.startswith("astryx-foundation") for r in rs)
    print("escalate self-test ok")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    role = tag = cwd = item = slug = ""
    args = list(argv)
    while args:
        a = args.pop(0)
        if a == "--role" and args:
            role = args.pop(0)
        elif a == "--tag" and args:
            tag = args.pop(0)
        elif a == "--cwd" and args:
            cwd = args.pop(0)
        elif a == "--item" and args:
            item = args.pop(0)
        elif a == "--slug" and args:
            slug = args.pop(0)
        elif a == "--check":
            continue
    state = state_dir()
    if not slug:
        slug = slug_from_tag(tag) or (os.environ.get("RSI_SLUG") or "")
    if not item:
        item = item_for(state, slug, cwd)
    reasons = triggers(state, item, slug)
    allowed, budget = kimi_allowed()
    model = ""
    reason = ""
    if reasons:
        reason = ",".join(reasons)
        if allowed:
            model = "kimi"
        else:
            model = "codex"
            why = []
            if budget.get("level") != "ok":
                why.append(f"volc-guard:{budget.get('level')}")
            if budget.get("kimi_cny", 0) >= budget.get("cap", 80):
                why.append("kimi-day-cap")
            reason = reason + "|" + (",".join(why) or "kimi-blocked")
        log_decision(
            state,
            dict(
                role=role,
                tag=tag,
                slug=slug,
                item=item,
                model=model,
                reason=reason,
                kimi_cny=budget.get("kimi_cny", 0),
                total=budget.get("total", 0),
                level=budget.get("level"),
            ),
        )
    # even no-trigger calls are silent (no log spam on every ordinary DeepSeek review)
    # print assignments
    def sh(s: str) -> str:
        return s.replace("'", "'\\''")

    sys.stdout.write(f"RSI_ESCALATE_MODEL={model}\n")
    sys.stdout.write(f"RSI_ESCALATE_REASON='{sh(reason)}'\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        raise SystemExit(0)
