#!/usr/bin/env python3
"""Enforce rsi/ROUTING.md: escalate off DeepSeek only when a necessity signal fires.

Prints shell assignments:
  RSI_ESCALATE_MODEL=codex|carbon|kimi|
  RSI_ESCALATE_FALLBACK=carbon,kimi
  RSI_ESCALATE_REASON='...'
  RSI_ESCALATE_COST_SOURCE=chatgpt|antigravity|volcengine|
  RSI_ESCALATE_ID=<uuid>

Logs decisions and outcomes to $RSI_STATE/escalations.jsonl and escalations.log.
--outcome stitches the run result onto the same id.
--weekly writes $RSI_STATE/escalations-weekly.md for the morning brief.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

SGT = timezone(timedelta(hours=8))
FOUNDATION_OR_SHELL = frozenset({"F1", "F2", "F3", "F4", "S1", "S2", "S3"})
TOP_AREAS = ("ui/", "internal/", "desktop/", "mobile/", "cmd/", "rsi/runtime/")
TRIVIAL_GATE = re.compile(
    r"prettier|dirty-tree|dirty-after-build|GATE_RESULT=FAIL:\s*format|format-changed-files",
    re.I,
)
NONTRIVIAL_GATE = re.compile(
    r"GATE_RESULT=FAIL:\s*(?!prettier|dirty-tree|dirty-after-build|format)(\S+)|"
    r"typecheck|tsc\b|vitest|go test|build failed|test failed|"
    r"could not diagnose|undiagnosed|opaque|no (clear )?finding",
    re.I,
)
ARCH_MARK = re.compile(r"\b(architecture|cross-cutting|ADR\b|KIN-ARCH)\b", re.I)

COST = {"codex": "chatgpt", "carbon": "antigravity", "kimi": "volcengine"}


def now() -> datetime:
    return datetime.now(SGT)


def state_dir() -> Path:
    env = os.environ.get("RSI_STATE") or os.environ.get("STATE")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "state"


def slug_from_tag(tag: str) -> str:
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
    sb = state / "sendback" / f"{slug}.md"
    if sb.is_file():
        for line in sb.read_text(errors="replace").splitlines()[:10]:
            if line.lower().startswith("item:"):
                return line.split(":", 1)[1].strip()
    for folder in ("lanes", "cloud"):
        d = state / folder
        if not d.is_dir():
            continue
        for p in d.glob("*.json"):
            try:
                rec = json.loads(p.read_text())
            except Exception:
                continue
            if rec.get("slug") == slug and rec.get("item"):
                return str(rec["item"])
    return ""


def gather_text(state: Path, slug: str) -> str:
    chunks: list[str] = []
    for rel in (
        f"sendback/{slug}.md",
        f"merge/{slug}.review.txt",
        f"merge/{slug}.combined.txt",
        f"merge/{slug}.ux.txt",
        f"cloud-briefs/{slug}.md",
        f"briefs/{slug}.md",
    ):
        p = state / rel
        if p.is_file():
            try:
                chunks.append(p.read_text(errors="replace")[-12000:])
            except Exception:
                pass
    done = state / "sendback" / "done"
    if done.is_dir():
        cands = sorted(done.glob(f"{slug}-*.md"), key=lambda x: x.stat().st_mtime, reverse=True)
        for p in cands[:2]:
            try:
                chunks.append(p.read_text(errors="replace")[-12000:])
            except Exception:
                pass
    return "\n".join(chunks)


def review_disagreement(blob: str) -> bool:
    if not blob:
        return False
    if re.search(r"independent review FAIL|VERDICT:\s*FAIL|review FAIL", blob, re.I):
        return True
    if re.search(r"UX (gate )?FAIL", blob, re.I):
        return True
    return False


def is_foundation_or_shell(item: str) -> bool:
    token = (item or "").strip().split()[0] if item else ""
    return token in FOUNDATION_OR_SHELL


def gate_undiagnosed(blob: str) -> bool:
    if not blob or not re.search(r"GATE_RESULT=FAIL|gate FAIL", blob, re.I):
        return False
    if NONTRIVIAL_GATE.search(blob):
        return True
    # A GATE_RESULT=FAIL that is only prettier / dirty-tree is not this signal.
    if TRIVIAL_GATE.search(blob) and not re.search(
        r"GATE_RESULT=FAIL:\s*(?!prettier|dirty-tree|dirty-after-build|format)\S+", blob, re.I
    ):
        return False
    return bool(re.search(r"GATE_RESULT=FAIL", blob, re.I)) and not TRIVIAL_GATE.search(blob)


def areas_from_cwd(cwd: str) -> list[str]:
    if not cwd or not Path(cwd).is_dir():
        return []
    try:
        import subprocess

        out = subprocess.run(
            ["git", "-C", cwd, "diff", "--name-only", "origin/main...HEAD"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        ).stdout or ""
    except Exception:
        return []
    hit = []
    for area in TOP_AREAS:
        if any(line.startswith(area) or f"/{area}" in line for line in out.splitlines()):
            hit.append(area.rstrip("/"))
    return hit


def architecture(blob: str, cwd: str, role: str) -> str | None:
    if ARCH_MARK.search(blob or ""):
        return "architecture-marked"
    areas = areas_from_cwd(cwd)
    if len(areas) >= 3:
        return "architecture-cross-cutting:" + ",".join(areas)
    # Ordinary fill pulses (director without a mark or wide diff) do not escalate.
    return None


def triggers(state: Path, item: str, slug: str, cwd: str, role: str) -> list[str]:
    blob = gather_text(state, slug) if slug else ""
    reasons: list[str] = []
    if is_foundation_or_shell(item):
        reasons.append(f"astryx-foundation-or-shell:{item}")
    att = attempts(state, slug) if slug else 0
    if att >= 2:
        reasons.append(f"rework-round-{att}")
    if slug and review_disagreement(blob):
        reasons.append("reviewer-disagreement")
    if slug and gate_undiagnosed(blob):
        reasons.append("gate-undiagnosed")
    arch = architecture(blob, cwd, role)
    if arch:
        reasons.append(arch)
    return reasons


def kimi_allowed() -> tuple[bool, dict]:
    budget = Path(__file__).resolve().parent / "volc-budget.py"
    data: dict = {}
    try:
        import subprocess

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


def carbon_available() -> bool:
    env = os.environ.get("AGY") or os.environ.get("M_CARBON_BIN")
    if env and Path(env).is_file() and os.access(env, os.X_OK):
        return True
    return shutil.which("agy") is not None


def preference(role: str, reasons: list[str]) -> list[str]:
    """Strong models in order. Kimi is always last and only used if earlier ones are unavailable."""
    ux = role in {"ux-reviewer", "ux-reviewer-alt"}
    want_carbon = ux or any(
        r.startswith("architecture-cross-cutting") or "long-context" in r or "second-opinion" in r
        for r in reasons
    )
    # A further opinion after reviewer-alt (already Codex by default) prefers Carbon.
    if role == "reviewer-alt":
        want_carbon = True
    if ux or want_carbon:
        return ["carbon", "codex", "kimi"]
    return ["codex", "carbon", "kimi"]


def pick(role: str, reasons: list[str], kimi_ok: bool) -> tuple[str, list[str], str]:
    order = preference(role, reasons)
    available = []
    for name in order:
        if name == "carbon" and not carbon_available():
            continue
        if name == "kimi" and not kimi_ok:
            continue
        # codex is treated as available; dispatch falls through if exec/claude fails
        available.append(name)
    chosen = available[0] if available else ""
    fallback = available[1:]
    blocked = ""
    if "kimi" in order and not kimi_ok:
        blocked = "kimi-blocked"
    return chosen, fallback, blocked


def log_decision(state: Path, rec: dict) -> None:
    state.mkdir(parents=True, exist_ok=True)
    rec = dict(rec)
    rec.setdefault("ts", now().strftime("%Y-%m-%d %H:%M:%S %Z"))
    with (state / "escalations.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, sort_keys=True) + "\n")
    line = (
        f"{rec['ts']} id={rec.get('id') or '-'} role={rec.get('role')} slug={rec.get('slug') or '-'} "
        f"item={rec.get('item') or '-'} model={rec.get('model') or '-'} cost={rec.get('cost_source') or '-'} "
        f"reason={rec.get('reason') or '-'} outcome={rec.get('outcome') or 'pending'} "
        f"kimi_cny=¥{float(rec.get('kimi_cny') or 0):.2f} volc_cny=¥{float(rec.get('total') or 0):.2f}\n"
    )
    with (state / "escalations.log").open("a", encoding="utf-8") as f:
        f.write(line)


def record_outcome(state: Path, eid: str, outcome: str, note: str, model: str, tag: str) -> int:
    path = state / "escalations.jsonl"
    rows: list[str] = []
    updated = False
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except Exception:
                rows.append(line)
                continue
            if not updated and eid and rec.get("id") == eid:
                rec["outcome"] = outcome
                rec["outcome_note"] = note
                rec["outcome_ts"] = now().strftime("%Y-%m-%d %H:%M:%S %Z")
                if model:
                    rec["outcome_model"] = model
                rows.append(json.dumps(rec, sort_keys=True))
                updated = True
                with (state / "escalations.log").open("a", encoding="utf-8") as f:
                    f.write(
                        f"{rec['outcome_ts']} id={eid} outcome={outcome} model={model or rec.get('model')} "
                        f"tag={tag} note={note}\n"
                    )
            else:
                rows.append(line)
    if not updated:
        rec = dict(
            id=eid or str(uuid.uuid4()),
            ts=now().strftime("%Y-%m-%d %H:%M:%S %Z"),
            tag=tag,
            model=model,
            outcome=outcome,
            outcome_note=note,
            kind="outcome-only",
        )
        rows.append(json.dumps(rec, sort_keys=True))
        with (state / "escalations.log").open("a", encoding="utf-8") as f:
            f.write(f"{rec['ts']} id={rec['id']} outcome={outcome} model={model} tag={tag} note={note}\n")
    path.write_text("\n".join(rows) + ("\n" if rows else ""), encoding="utf-8")
    return 0


def week_bounds(day: datetime | None = None) -> tuple[datetime, datetime]:
    d = (day or now()).replace(hour=0, minute=0, second=0, microsecond=0)
    start = d - timedelta(days=d.weekday())  # Monday
    return start, start + timedelta(days=7)


def parse_ts(value: str) -> datetime | None:
    value = (value or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S %Z", "%Y-%m-%d %H:%M:%S SGT", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            dt = datetime.strptime(value.replace("SGT", "+0800"), fmt.replace("%Z", "%z") if "SGT" in value else fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=SGT)
            return dt
        except Exception:
            continue
    try:
        return datetime.fromisoformat(value)
    except Exception:
        return None


def weekly(state: Path) -> Path:
    start, end = week_bounds()
    rows = []
    path = state / "escalations.jsonl"
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except Exception:
                continue
            ts = parse_ts(str(rec.get("ts") or ""))
            if ts is None or ts < start or ts >= end:
                continue
            if rec.get("kind") == "outcome-only" and not rec.get("reason"):
                continue
            rows.append(rec)
    by_model: dict[str, dict[str, int]] = {}
    by_reason: dict[str, int] = {}
    outcomes = {"PASS": 0, "FAIL": 0, "error": 0, "pending": 0, "other": 0}
    for rec in rows:
        m = rec.get("model") or "unknown"
        slot = by_model.setdefault(m, {"n": 0, "PASS": 0, "FAIL": 0, "error": 0, "pending": 0})
        slot["n"] += 1
        oc = (rec.get("outcome") or "pending").upper()
        if oc in ("PASS", "FAIL"):
            outcomes[oc] += 1
            slot[oc] += 1
        elif oc in ("ERROR", "API-ERROR"):
            outcomes["error"] += 1
            slot["error"] += 1
        elif oc in ("PENDING", ""):
            outcomes["pending"] += 1
            slot["pending"] += 1
        else:
            outcomes["other"] += 1
        for r in str(rec.get("reason") or "").split(","):
            r = r.strip()
            if r:
                by_reason[r.split("|")[0]] = by_reason.get(r.split("|")[0], 0) + 1
    lines = [
        f"# Escalations week {start.strftime('%Y-%m-%d')}–{(end - timedelta(days=1)).strftime('%Y-%m-%d')} (Asia/Singapore)",
        "",
        f"Updated {now().strftime('%Y-%m-%d %H:%M %Z')}. Policy: `rsi/ROUTING.md`.",
        f"Escalations this week: {len(rows)}. Outcomes: PASS {outcomes['PASS']}, FAIL {outcomes['FAIL']}, "
        f"error {outcomes['error']}, pending {outcomes['pending']}"
        + (f", other {outcomes['other']}" if outcomes["other"] else "")
        + ".",
        "",
    ]
    judged = outcomes["PASS"] + outcomes["FAIL"]
    if judged:
        rate = 100.0 * outcomes["PASS"] / judged
        lines.append(
            f"Among decided reviews, {outcomes['PASS']}/{judged} ({rate:.0f}%) were PASS after escalation. "
            "Judge worth over 2–3 days together with `reviewer-misses.md` (reverts / reopenings)."
        )
    else:
        lines.append("No decided PASS/FAIL outcomes yet this week; worth-it judgement is pending.")
    lines += ["", "## By model", ""]
    if by_model:
        for m, s in sorted(by_model.items(), key=lambda kv: -kv[1]["n"]):
            lines.append(f"- `{m}`: {s['n']} (PASS {s['PASS']}, FAIL {s['FAIL']}, error {s['error']}, pending {s['pending']})")
    else:
        lines.append("None.")
    lines += ["", "## By necessity signal", ""]
    if by_reason:
        for r, n in sorted(by_reason.items(), key=lambda kv: -kv[1]):
            lines.append(f"- {r}: {n}")
    else:
        lines.append("None.")
    lines.append("")
    out = state / "escalations-weekly.md"
    state.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out


def sh(s: str) -> str:
    return (s or "").replace("'", "'\\''")


def self_test() -> int:
    assert is_foundation_or_shell("F3") and not is_foundation_or_shell("F5a")
    assert slug_from_tag("merge-foo-ux") == "foo"
    pretty = "GATE_RESULT=FAIL: prettier\n"
    assert not review_disagreement(pretty)
    assert not gate_undiagnosed(pretty)
    hard = "GATE_RESULT=FAIL: typecheck\n error TS2322\n"
    assert gate_undiagnosed(hard)
    fail = "item: Q1\nVERDICT: FAIL — Major M1\n"
    assert review_disagreement(fail)
    order = preference("reviewer", ["reviewer-disagreement"])
    assert order[0] == "codex" and order[-1] == "kimi"
    ux = preference("ux-reviewer", ["reviewer-disagreement"])
    assert ux[0] == "carbon"
    alt = preference("reviewer-alt", ["rework-round-2"])
    assert alt[0] == "carbon"
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        (st / "sendback").mkdir()
        (st / "sendback" / "x.md").write_text("item: F1\nVERDICT: FAIL\nGATE_RESULT=FAIL: typecheck\n")
        (st / "merge").mkdir()
        (st / "merge" / "x.attempts").write_text("2\n")
        rs = triggers(st, "F1", "x", "", "reviewer")
        assert any(r.startswith("rework-round-") for r in rs)
        assert any(r.startswith("astryx-foundation") for r in rs)
        assert "reviewer-disagreement" in rs
        assert "gate-undiagnosed" in rs
        eid = "test-id"
        log_decision(st, dict(id=eid, role="reviewer", slug="x", item="F1", model="codex", reason="reviewer-disagreement", cost_source="chatgpt", kimi_cny=0, total=0))
        record_outcome(st, eid, "PASS", "VERDICT: PASS", "codex", "merge-x-review")
        recs = [json.loads(l) for l in (st / "escalations.jsonl").read_text().splitlines()]
        assert recs[0]["outcome"] == "PASS"
        weekly(st)
        assert (st / "escalations-weekly.md").is_file()
    print("escalate self-test ok")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    state = state_dir()
    if "--weekly" in argv:
        p = weekly(state)
        sys.stdout.write(str(p) + "\n")
        return 0
    if "--outcome" in argv:
        eid = model = tag = outcome = note = ""
        args = list(argv)
        while args:
            a = args.pop(0)
            if a == "--id" and args:
                eid = args.pop(0)
            elif a == "--model" and args:
                model = args.pop(0)
            elif a == "--tag" and args:
                tag = args.pop(0)
            elif a == "--ok" and args:
                outcome = "PASS" if args.pop(0) in {"1", "true", "yes", "PASS"} else "FAIL"
            elif a == "--outcome" and args and not args[0].startswith("--"):
                outcome = args.pop(0)
            elif a == "--note" and args:
                note = args.pop(0)
            elif a == "--outcome":
                continue
        if not outcome:
            outcome = "pending"
        return record_outcome(state, eid, outcome, note, model, tag)

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
    if not slug:
        slug = slug_from_tag(tag) or (os.environ.get("RSI_SLUG") or "")
    if not item:
        item = item_for(state, slug, cwd)
    reasons = triggers(state, item, slug, cwd, role)
    allowed, budget = kimi_allowed()
    model = reason = cost = eid = ""
    fallback: list[str] = []
    if reasons:
        model, fallback, blocked = pick(role, reasons, allowed)
        reason = ",".join(reasons)
        if blocked:
            reason = reason + "|" + blocked
        cost = COST.get(model, "")
        eid = uuid.uuid4().hex[:12]
        log_decision(
            state,
            dict(
                id=eid,
                role=role,
                tag=tag,
                slug=slug,
                item=item,
                model=model,
                fallback=",".join(fallback),
                reason=reason,
                cost_source=cost,
                kimi_cny=budget.get("kimi_cny", 0),
                total=budget.get("total", 0),
                level=budget.get("level"),
                outcome="pending",
            ),
        )
    sys.stdout.write(f"RSI_ESCALATE_MODEL={model}\n")
    sys.stdout.write(f"RSI_ESCALATE_FALLBACK={','.join(fallback)}\n")
    sys.stdout.write(f"RSI_ESCALATE_REASON='{sh(reason)}'\n")
    sys.stdout.write(f"RSI_ESCALATE_COST_SOURCE={cost}\n")
    sys.stdout.write(f"RSI_ESCALATE_ID={eid}\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        raise SystemExit(0)
