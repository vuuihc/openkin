#!/usr/bin/env python3
"""Enforce rsi/ROUTING.md: escalate off DeepSeek only when a necessity signal fires.

Prints shell assignments:
  RSI_ESCALATE_MODEL=hydrogen|hydrogen-high|codex|carbon|kimi|
  RSI_ESCALATE_FALLBACK=codex,carbon,kimi
  RSI_ESCALATE_REASON='...'
  RSI_ESCALATE_COST_SOURCE=chatgpt|antigravity|volcengine|
  RSI_ESCALATE_ID=<uuid>
  RSI_ESCALATE_REUSE=0|1
  RSI_ESCALATE_REUSE_FILE=...
  RSI_ESCALATE_REUSE_VERDICT=PASS|FAIL|
  RSI_ESCALATE_HOLD=|sol-limited|agy-limited|agy-disabled|carbon-disabled|no-strong-model

Logs decisions and outcomes to $RSI_STATE/escalations.jsonl and escalations.log.
--outcome stitches the run result onto the same id.
--weekly writes $RSI_STATE/escalations-weekly.md for the morning brief,
including a daily "was it worth it" line (strong FAIL + B/M after DeepSeek PASS vs agreed)
and one weekly `Worth it:` line whose Kimi spend is priced by review window from the
local usage ledger (`volc-budget.py`), never from the day-cumulative fields on a record.
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
DEPS_PATH = re.compile(r"(^|/)(go\.mod|go\.sum|ui/package(-lock)?\.json)$")
MECHANICAL_GATE = re.compile(
    r"prettier|dirty-tree|dirty-after-build|format-changed-files|"
    r"GATE_RESULT=FAIL:\s*(prettier|format|dirty-tree|dirty-after-build|inventory)|"
    r"merge conflict|inv_resolve|ui-inventory-baseline|conflict with main",
    re.I,
)
GATE_FAIL = re.compile(r"GATE_RESULT=FAIL|gate FAIL", re.I)
SUBSTANTIVE_GATE = re.compile(
    r"GATE_RESULT=FAIL:\s*(?!prettier|dirty-tree|dirty-after-build|format|inventory)(\S+)|"
    r"typecheck|tsc\b|vitest|go test|build failed|test failed",
    re.I,
)
DEEPSEEK_CANT = re.compile(
    r"VERDICT:\s*UNSURE|"
    r"DEEPSEEK_DIAGNOSIS:\s*(UNKNOWN|UNDIAGNOSED|FAILED|CANNOT)|"
    r"could not diagnose|cannot diagnose|can'?t diagnose|"
    r"unable to (find|determine|identify|diagnose) (the )?(root )?cause|"
    r"after (a )?(real|genuine) attempt.{0,120}(cannot|could not|unable|no cause)",
    re.I,
)
ARCH_MARK = re.compile(r"\b(architecture|cross-cutting|ADR\b|KIN-ARCH)\b", re.I)
BM_FINDING = re.compile(
    r"FIXLIST:[\s\S]{0,4000}\|\s*(blocker|major)\s*\|"
    r"|Blocker\s+B\d+|Major\s+M\d+"
    r"|\*\*(blocker|major)\*\*",
    re.I,
)
DEEPSEEK_MODEL = re.compile(r"deepseek|volcengine-gw", re.I)
STRONG_MODEL = re.compile(r"codex|gpt-6\.1-sol|carbon|hydrogen|agy/gemini|kimi-k3", re.I)

COST = {"codex": "chatgpt", "hydrogen": "antigravity", "hydrogen-high": "antigravity", "carbon": "antigravity", "kimi": "volcengine"}


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
        f"merge/{slug}.diagnosis.txt",
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


def read_stamp(path: Path) -> tuple[str, str, list[str]]:
    """Parse '<sha> <verdict> ...' stamps. Returns (sha, verdict, rest)."""
    if not path.is_file():
        return "", "", []
    try:
        parts = path.read_text(errors="replace").strip().split()
    except Exception:
        return "", "", []
    if not parts:
        return "", "", []
    sha = parts[0]
    verd = parts[1].upper() if len(parts) > 1 else ""
    return sha, verd, parts[2:]


def mechanical_gate_only(blob: str) -> bool:
    if not blob or not GATE_FAIL.search(blob):
        return False
    if SUBSTANTIVE_GATE.search(blob) and not MECHANICAL_GATE.search(blob):
        return False
    if MECHANICAL_GATE.search(blob) and not re.search(
        r"GATE_RESULT=FAIL:\s*(?!prettier|dirty-tree|dirty-after-build|format|inventory)\S+",
        blob,
        re.I,
    ):
        return True
    return bool(MECHANICAL_GATE.search(blob)) and not SUBSTANTIVE_GATE.search(blob)


def substantive_gate_fail(blob: str) -> bool:
    if not blob or not GATE_FAIL.search(blob):
        return False
    if mechanical_gate_only(blob):
        return False
    if SUBSTANTIVE_GATE.search(blob):
        return True
    return bool(GATE_FAIL.search(blob)) and not MECHANICAL_GATE.search(blob)


def has_bm_findings(text: str) -> bool:
    return bool(BM_FINDING.search(text or ""))


def last_verdict(text: str) -> str:
    ms = list(re.finditer(r"VERDICT:\s*(PASS|FAIL|UNSURE)", text or "", re.I))
    return ms[-1].group(1).upper() if ms else ""


def is_foundation_or_shell(item: str) -> bool:
    token = (item or "").strip().split()[0] if item else ""
    return token in FOUNDATION_OR_SHELL


def deepseek_verdict(state: Path, slug: str, sha: str = "") -> str:
    """Return PASS/FAIL/UNSURE if we have a recorded DeepSeek review (optionally for this SHA)."""
    if not slug:
        return ""
    sha_st, verd, _ = read_stamp(state / "merge" / f"{slug}.deepseek")
    if verd in {"PASS", "FAIL", "UNSURE"} and (not sha or not sha_st or sha_st == sha):
        return verd
    # Fall back to a saved DeepSeek review body.
    body = state / "merge" / f"{slug}.deepseek.txt"
    if body.is_file():
        v = last_verdict(body.read_text(errors="replace"))
        if v:
            return v
    return ""


def deepseek_passed(state: Path, slug: str, sha: str, blob: str) -> bool:
    if deepseek_verdict(state, slug, sha) == "PASS":
        return True
    # Last-resort: a review file that is clearly DeepSeek and PASSed, and is not a strong-model log.
    for name in (f"{slug}.deepseek.txt", f"{slug}.review.txt.prev", f"{slug}.review.txt"):
        p = state / "merge" / name
        if not p.is_file():
            continue
        text = p.read_text(errors="replace")
        if last_verdict(text) != "PASS":
            continue
        if STRONG_MODEL.search(text) and not DEEPSEEK_MODEL.search(text):
            continue
        if DEEPSEEK_MODEL.search(text) or name.endswith(".deepseek.txt"):
            return True
    return False


def other_reviewer_fail_substance(state: Path, slug: str, blob: str) -> bool:
    """A non-DeepSeek reviewer or UX gate FAILed with substance (not a mechanical typo)."""
    for name in (f"{slug}.strong.txt", f"{slug}.review.txt", f"{slug}.ux.txt"):
        p = state / "merge" / name
        if not p.is_file():
            continue
        text = p.read_text(errors="replace")
        model_p = state / "merge" / (
            f"{slug}.ux-review-model" if name.endswith(".ux.txt") else f"{slug}.review-model"
        )
        model = model_p.read_text(errors="replace").strip() if model_p.is_file() else ""
        is_strong = bool(STRONG_MODEL.search(text) or STRONG_MODEL.search(model) or name.endswith("strong.txt"))
        if not is_strong:
            continue
        if last_verdict(text) == "FAIL" or re.search(r"UX_(VERDICT|gate):\s*FAIL|UX gate FAIL", text, re.I):
            if has_bm_findings(text) or re.search(r"UX_(VERDICT|gate):\s*FAIL|UX gate FAIL", text, re.I):
                return True
    if re.search(r"UX (gate )?FAIL|UX_VERDICT:\s*FAIL", blob or "", re.I):
        return True
    return False


def review_disagreement(state: Path, slug: str, sha: str, blob: str) -> bool:
    """Escalate only when DeepSeek PASSed and a gate/other reviewer FAILed on substance."""
    if not slug or not deepseek_passed(state, slug, sha, blob):
        return False
    if substantive_gate_fail(blob):
        return True
    if other_reviewer_fail_substance(state, slug, blob):
        return True
    return False


def gate_undiagnosed(state: Path, slug: str, blob: str) -> bool:
    """Only after a real DeepSeek-max diagnosis explicitly says it cannot find the cause.

    A build/test/format/inventory/conflict failure by itself is not a signal.
    """
    if not slug:
        return False
    if not substantive_gate_fail(blob):
        # still allow a marker if a diagnosis was attempted on a gate fail that is already cleaned from the blob
        marker = state / "merge" / f"{slug}.deepseek-undiagnosed"
        if not (marker.is_file() and marker.read_text(errors="replace").strip()):
            return False
    marker = state / "merge" / f"{slug}.deepseek-undiagnosed"
    if marker.is_file() and marker.read_text(errors="replace").strip():
        return True
    texts: list[str] = []
    for name in (f"{slug}.diagnosis.txt", f"{slug}.deepseek.txt"):
        p = state / "merge" / name
        if p.is_file():
            try:
                texts.append(p.read_text(errors="replace"))
            except Exception:
                pass
    for t in texts:
        if DEEPSEEK_CANT.search(t):
            return True
    return False


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


def changed_paths(cwd: str) -> list[str]:
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
    return [l.strip() for l in out.splitlines() if l.strip()]


def architecture(blob: str, cwd: str, role: str) -> str | None:
    if ARCH_MARK.search(blob or ""):
        return "architecture-marked"
    areas = areas_from_cwd(cwd)
    if len(areas) >= 3:
        return "architecture-cross-cutting:" + ",".join(areas)
    return None


def deps_reason(cwd: str, blob: str) -> str | None:
    paths = changed_paths(cwd)
    hit = [p for p in paths if DEPS_PATH.search(p)]
    if hit:
        return "deps:" + hit[0]
    if re.search(r"\bdeps-marked\b|RISKY_DEPS", blob or "", re.I):
        return "deps:marked"
    return None


def triggers(state: Path, item: str, slug: str, cwd: str, role: str, sha: str = "") -> list[str]:
    blob = gather_text(state, slug) if slug else ""
    reasons: list[str] = []
    if is_foundation_or_shell(item):
        reasons.append(f"astryx-foundation-or-shell:{item}")
    att = attempts(state, slug) if slug else 0
    if att >= 2:
        reasons.append(f"rework-round-{att}")
    if slug and review_disagreement(state, slug, sha, blob):
        reasons.append("reviewer-disagreement")
    if slug and gate_undiagnosed(state, slug, blob):
        reasons.append("gate-undiagnosed")
    arch = architecture(blob, cwd, role)
    if arch:
        reasons.append(arch)
    deps = deps_reason(cwd, blob)
    if deps:
        reasons.append(deps)
    # Tiered review: a small-safe PR gets exactly one DeepSeek review; only a 2nd+ rework round escalates it.
    if os.environ.get("RSI_REVIEW_TIER") == "small":
        reasons = [r for r in reasons if r.startswith("rework-round")]
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
        cap = float(data.get("RSI_VOLC_KIMI_DAY_MAX") or 150)
    except Exception:
        cap = 150.0
    try:
        total = float(data.get("RSI_VOLC_CNY") or 0)
    except Exception:
        total = 0.0
    ok = level == "ok" and kimi_cny < cap
    return ok, dict(level=level, kimi_cny=kimi_cny, cap=cap, total=total)


def agy_bin() -> str | None:
    candidates = [
        os.environ.get("AGY") or "",
        os.environ.get("M_CARBON_BIN") or "",
        "/opt/homebrew/bin/agy",
        str(Path.home() / ".antigravity/antigravity/bin/agy"),
    ]
    for env in candidates:
        if env and Path(env).is_file() and os.access(env, os.X_OK):
            return env
    return shutil.which("agy")


def agy_enabled() -> bool:
    # RSI_CARBON_ENABLED was the old switch (default 0 after empty SUCCESS reviews).
    # Both flags now default to on; either set to 0 disables every agy model.
    carbon = os.environ.get("RSI_CARBON_ENABLED", "1")
    flag = os.environ.get("RSI_AGY_ENABLED", carbon)
    return flag == "1" and agy_bin() is not None


def carbon_available() -> bool:
    return agy_enabled()


def _limited_until(state: Path, name: str) -> int:
    p = state / name
    try:
        return int(p.read_text().strip() or "0")
    except Exception:
        return 0


def sol_limited_until(state: Path) -> int:
    return _limited_until(state, "sol-limited-until")


def agy_limited_until(state: Path) -> int:
    return _limited_until(state, "agy-limited-until")


def sol_is_limited(state: Path, now_ts: int | None = None) -> bool:
    until = sol_limited_until(state)
    ts = int(now_ts if now_ts is not None else datetime.now().timestamp())
    return until > ts


def agy_is_limited(state: Path, now_ts: int | None = None) -> bool:
    until = agy_limited_until(state)
    ts = int(now_ts if now_ts is not None else datetime.now().timestamp())
    return until > ts


def no_strong_available(state: Path, kimi_ok: bool = False) -> bool:
    """True when Hydrogen/Carbon and sol are all unusable (a hold, not an error)."""
    agy_ok = agy_enabled() and not agy_is_limited(state)
    sol_ok = not sol_is_limited(state)
    return (not agy_ok) and (not sol_ok) and (not kimi_ok)


def wants_high(reasons: list[str]) -> bool:
    # hydrogen-high only for foundation/shell, architecture, or a second pass after disagreement.
    # Never xhigh by default.
    return any(
        r.startswith("astryx-foundation")
        or r.startswith("architecture")
        or r == "reviewer-disagreement"
        or r.startswith("reviewer-disagreement")
        for r in reasons
    )


def preference(role: str, reasons: list[str]) -> list[str]:
    """Strong models in order. Codex first for an ordinary strong review; Hydrogen-medium first
    for UX vision (multimodal) and for the high-stakes class. Kimi is always last."""
    if (role or "").startswith("ux-"):
        if wants_high(reasons):
            return ["hydrogen-high", "hydrogen", "codex", "carbon", "kimi"]
        return ["hydrogen", "codex", "carbon", "kimi"]
    if wants_high(reasons):
        return ["hydrogen-high", "hydrogen", "codex", "carbon", "kimi"]
    return ["codex", "hydrogen", "carbon", "kimi"]


def _agy_name(name: str) -> bool:
    return name in {"hydrogen", "hydrogen-high", "carbon"}


def pick(role: str, reasons: list[str], kimi_ok: bool, state: Path) -> tuple[str, list[str], str]:
    order = preference(role, reasons)
    available: list[str] = []
    blocked_bits: list[str] = []
    for name in order:
        if _agy_name(name):
            if not agy_enabled():
                if "agy-disabled" not in blocked_bits:
                    blocked_bits.append("agy-disabled")
                continue
            if agy_is_limited(state):
                if "agy-limited" not in blocked_bits:
                    blocked_bits.append("agy-limited")
                continue
        if name == "codex" and sol_is_limited(state):
            blocked_bits.append("sol-limited")
            continue
        if name == "kimi" and not kimi_ok:
            blocked_bits.append("kimi-blocked")
            continue
        available.append(name)
    chosen = available[0] if available else ""
    fallback = available[1:]
    blocked = ""
    if not chosen:
        if "sol-limited" in blocked_bits and ("agy-disabled" in blocked_bits or "agy-limited" in blocked_bits):
            # Keep sol-limited when agy is simply off, so existing hold tests and messages stay stable.
            blocked = "agy-limited" if "agy-limited" in blocked_bits else "sol-limited"
        elif "sol-limited" in blocked_bits:
            blocked = "sol-limited"
        elif "agy-limited" in blocked_bits:
            blocked = "agy-limited"
        elif "agy-disabled" in blocked_bits and not available:
            blocked = "no-strong-model" if "kimi-blocked" in blocked_bits else "agy-disabled"
        elif "kimi-blocked" in blocked_bits:
            blocked = "kimi-blocked"
        else:
            blocked = "no-strong-model"
    elif blocked_bits:
        # Keep skipped-path flags (agy-limited, kimi-blocked, ...) in the reason even when a fallback was chosen.
        blocked = ",".join(blocked_bits)
    return chosen, fallback, blocked


def strong_paths(state: Path, slug: str, kind: str = "review") -> tuple[Path, Path]:
    suffix = "strong-ux" if kind == "ux" else "strong"
    return state / "merge" / f"{slug}.{suffix}", state / "merge" / f"{slug}.{suffix}.txt"


def kind_from_role(role: str) -> str:
    return "ux" if (role or "").startswith("ux-") else "review"


def cached_strong(state: Path, slug: str, sha: str, kind: str = "review") -> dict | None:
    if not slug or not sha:
        return None
    stamp, body = strong_paths(state, slug, kind)
    st_sha, verd, rest = read_stamp(stamp)
    if st_sha != sha or verd not in {"PASS", "FAIL"}:
        return None
    if not body.is_file() or body.stat().st_size == 0:
        return None
    model = rest[0] if rest else ""
    return {"sha": st_sha, "verdict": verd, "model": model, "file": str(body)}


def save_strong(state: Path, slug: str, sha: str, verdict: str, model: str, src: str, kind: str = "review") -> int:
    verdict = (verdict or "").upper()
    if not slug or not sha or verdict not in {"PASS", "FAIL"}:
        return 1
    (state / "merge").mkdir(parents=True, exist_ok=True)
    stamp, body = strong_paths(state, slug, kind)
    text = ""
    if src and Path(src).is_file():
        text = Path(src).read_text(errors="replace")
    if not text:
        return 1
    # Never overwrite a cache for this SHA with a worse "empty" body; same SHA is idempotent.
    existing = cached_strong(state, slug, sha, kind)
    if existing:
        return 0
    body.write_text(text, encoding="utf-8")
    stamp.write_text(f"{sha} {verdict} {model}\n", encoding="utf-8")
    return 0


def save_deepseek(state: Path, slug: str, sha: str, verdict: str, src: str = "") -> int:
    verdict = (verdict or "").upper()
    if not slug or not sha or verdict not in {"PASS", "FAIL", "UNSURE"}:
        return 1
    (state / "merge").mkdir(parents=True, exist_ok=True)
    (state / "merge" / f"{slug}.deepseek").write_text(f"{sha} {verdict}\n", encoding="utf-8")
    if src and Path(src).is_file():
        (state / "merge" / f"{slug}.deepseek.txt").write_text(
            Path(src).read_text(errors="replace"), encoding="utf-8"
        )
    return 0


def log_decision(state: Path, rec: dict) -> None:
    state.mkdir(parents=True, exist_ok=True)
    rec = dict(rec)
    rec.setdefault("ts", now().isoformat())
    with (state / "escalations.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, sort_keys=True) + "\n")
    line = (
        f"{rec['ts']} id={rec.get('id') or '-'} role={rec.get('role')} slug={rec.get('slug') or '-'} "
        f"item={rec.get('item') or '-'} model={rec.get('model') or '-'} cost={rec.get('cost_source') or '-'} "
        f"reason={rec.get('reason') or '-'} outcome={rec.get('outcome') or 'pending'} "
        f"kimi_cny=¥{float(rec.get('kimi_cny') or 0):.2f} volc_cny=¥{float(rec.get('total') or 0):.2f}\n"
    )
    if rec.get("kind") in {"reuse", "hold"}:
        line = line.rstrip("\n") + f" kind={rec['kind']}\n"
    with (state / "escalations.log").open("a", encoding="utf-8") as f:
        f.write(line)


def already_logged(state: Path, slug: str, sha: str, kind: str) -> bool:
    path = state / "escalations.jsonl"
    if not path.is_file() or not slug or not sha:
        return False
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return False
    for line in reversed(lines[-400:]):
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("slug") == slug and rec.get("sha") == sha and rec.get("kind") == kind:
            return True
    return False


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
                rec["outcome_ts"] = now().isoformat()
                if model:
                    rec["outcome_model"] = model
                if "has_bm" not in rec and note:
                    rec["has_bm"] = bool(has_bm_findings(note) or re.search(r"\b(blocker|major)\b", note, re.I))
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
            ts=now().isoformat(),
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
    if not value:
        return None
    value = value.replace(" UTC+08:00", "+08:00").replace(" SGT", "+08:00")
    if "T" not in value[:19] and " " in value:
        date, rest = value.split(" ", 1)
        value = date + "T" + rest
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=SGT)
        return dt
    except Exception:
        return None


def primary_triggers(reason: str) -> list[str]:
    out = []
    head = (reason or "").split("|")[0]
    for r in head.split(","):
        r = r.strip()
        if not r:
            continue
        if r.startswith("rework-round-"):
            out.append("rework-round>=2")
        elif r.startswith("astryx-foundation-or-shell"):
            out.append("astryx-F/S")
        elif r.startswith("architecture"):
            out.append("architecture")
        elif r.startswith("deps"):
            out.append("deps")
        elif r in {"reviewer-disagreement", "gate-undiagnosed", "reuse-sha", "sol-limited", "agy-limited", "standing-strong-review"}:
            out.append(r)
        else:
            out.append(r)
    return out


def record_class(rec: dict) -> str:
    """Classify one strong review: missed, agreed, unpaired, or error.

    Shared by the daily line and the weekly worth-it line so the two cannot drift.
    `missed` is the metric that says a strong review added signal: strong FAIL with a
    substantive blocker/major after DeepSeek already PASSed.
    """
    oc = (rec.get("outcome") or "pending").lower()
    if oc in {"error", "api-error"}:
        return "error"
    if oc not in {"pass", "fail"}:
        return "unpaired"
    ds = (rec.get("deepseek_verdict") or "").upper()
    strong = oc.upper()
    bm = rec.get("has_bm")
    if bm is None:
        bm = has_bm_findings(str(rec.get("outcome_note") or ""))
    if ds == "PASS" and strong == "FAIL" and bm:
        return "missed"
    if ds in {"PASS", "FAIL"} and ds == strong:
        return "agreed"
    if ds == "FAIL" and strong == "PASS":
        return "agreed"
    return "unpaired"


def budget_module():
    """volc-budget.py next door, loaded by path.

    The hyphen in its filename rules out a normal import; the module's top level is
    constants only, and its `__main__` guard keeps it inert when executed this way.
    Returns None when the sibling is missing or broken: a report that cannot price
    must still be written, saying spend is unmeasured.
    """
    try:
        import importlib.util

        path = Path(__file__).with_name("volc-budget.py")
        spec = importlib.util.spec_from_file_location("rsi_volc_budget", path)
        if spec is None or spec.loader is None:
            return None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except Exception:
        return None


def worth_lines(rows: list[dict]) -> list[str]:
    """The 'was this week worth it' line: caught defects per review and per yuan.

    Cost is window-priced, not copied from the record: each decided review owns
    [ts, outcome_ts], and the Kimi rows of the local usage ledger inside that window
    are priced with volc-budget.py's table. The `kimi_cny`/`total` fields on the
    record are day-cumulative snapshots taken at creation, so summing them would be
    wrong.

    A record with a PASS/FAIL outcome but no usable ts/outcome_ts has no window: it
    is counted in `unmeasured` and kept out of the decided denominator rather than
    priced as ¥0. A ledger file that does not exist (or cannot be read) makes spend
    unmeasured everywhere, never ¥0.00.
    """
    decided = caught = flat = unmeasured = 0
    windows: list[tuple[datetime, datetime]] = []
    for rec in rows:
        if rec.get("kind") in {"reuse", "hold", "outcome-only"}:
            continue
        if (rec.get("outcome") or "").lower() not in {"pass", "fail"}:
            continue
        ts = parse_ts(str(rec.get("ts") or ""))
        ots = parse_ts(str(rec.get("outcome_ts") or ""))
        if ts is None or ots is None:
            unmeasured += 1
            continue
        decided += 1
        if record_class(rec) == "missed":
            caught += 1
        windows.append((ts, ots))

    if decided == 0:
        return ["Worth it: no decided reviews this week."]

    budget = budget_module()
    ledger = None
    if budget is not None:
        try:
            path = budget.ledger_path()
            if path.is_file():
                ledger = [r for r in budget.read_jsonl(path, min(ts for ts, _ in windows)) if r["fam"].startswith("kimi")]
        except Exception:
            ledger = None

    spend = None
    if ledger is not None:
        spend = 0.0
        for ts, ots in windows:
            window_cny = sum(
                budget.cny_for(r["fam"], r["inp"], r["out"], r["cache"], budget.is_peak(r["t"]))
                for r in ledger
                if ts <= r["t"] <= ots
            )
            if window_cny == 0:
                flat += 1
            spend += window_cny

    pct = 100.0 * caught / decided
    head = f"Worth it: caught {caught} of {decided} decided reviews ({pct:.0f}%);"
    if spend is None:
        spend_s = "spend unmeasured;"
        per = "per caught defect: n/a (spend unmeasured);"
    else:
        spend_s = f"spend ¥{spend:.2f};"
        if caught == 0:
            per = "per caught defect: n/a (none caught);"
        else:
            per = f"¥{spend / caught:.2f} per caught defect;"
    return [
        f"{head} {spend_s} {per} flat-rate {flat}; unmeasured {unmeasured}.",
        "Spend is window-priced from the local usage ledger; a concurrent Kimi call inside a review's window is counted in it.",
    ]


def daily_worth_lines(rows: list[dict], state: Path, worth: list[str] | None = None) -> list[str]:
    """One line per Singapore day: counts by trigger, found-what-DeepSeek-missed vs agreed."""
    by_day: dict[str, list[dict]] = {}
    for rec in rows:
        if rec.get("kind") in {"reuse", "hold", "outcome-only"}:
            continue
        ts = parse_ts(str(rec.get("ts") or ""))
        if ts is None:
            continue
        day = ts.astimezone(SGT).strftime("%Y-%m-%d")
        by_day.setdefault(day, []).append(rec)
    lines = ["## Daily worth-it (Asia/Singapore)", ""]
    if not by_day:
        lines.append("No strong-review decisions this week yet.")
        lines.append("")
        if worth:
            lines.extend(worth)
            lines.append("")
        return lines
    for day in sorted(by_day):
        recs = by_day[day]
        trig: dict[str, int] = {}
        missed = agreed = unpaired = errors = 0
        for rec in recs:
            for t in primary_triggers(str(rec.get("reason") or "")):
                trig[t] = trig.get(t, 0) + 1
            # record_class keeps this line and the weekly worth-it line on one classifier:
            # DeepSeek FAIL + strong PASS counts as agreed; a strong FAIL without B/M is
            # not the miss metric.
            cls = record_class(rec)
            if cls == "error":
                errors += 1
            elif cls == "missed":
                missed += 1
            elif cls == "agreed":
                agreed += 1
            else:
                unpaired += 1
        trig_s = ", ".join(f"{k} {v}" for k, v in sorted(trig.items(), key=lambda kv: (-kv[1], kv[0]))) or "none"
        lines.append(
            f"- {day}: {len(recs)} strong reviews. Triggers: {trig_s}. "
            f"Found-what-DeepSeek-missed: {missed} (strong FAIL + blocker/major after DeepSeek PASS). "
            f"Agreed: {agreed}. Unpaired/pending: {unpaired}. Errors: {errors}."
        )
    lines.append("")
    if worth:
        lines.extend(worth)
        lines.append("")
    lines.append(
        "Found-what-DeepSeek-missed is the 'was it worth it' metric: a strong-model review only "
        "adds signal when it FAILs with a substantive blocker/major after DeepSeek already PASSed."
    )
    missing_ds = sum(1 for recs in by_day.values() for rec in recs if not (rec.get("deepseek_verdict") or "").strip())
    total = sum(len(recs) for recs in by_day.values())
    if total and missing_ds:
        lines.append(
            f"Note: {missing_ds}/{total} records have no stored DeepSeek verdict, so they cannot be scored "
            "as missed vs agreed (typical of the pre-tightening log, or of large-tier PRs that went straight "
            "to a strong model). From 2026-11-15 onward, `escalate.py` records `deepseek_verdict` when it exists."
        )
    lines.append("")
    return lines


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
            if rec.get("kind") in {"outcome-only", "reuse", "hold"} and not rec.get("reason"):
                continue
            rows.append(rec)
    # Count spend (exclude reuse/hold from "escalations this week")
    spend = [r for r in rows if r.get("kind") not in {"reuse", "hold"}]
    by_model: dict[str, dict[str, int]] = {}
    by_reason: dict[str, int] = {}
    outcomes = {"PASS": 0, "FAIL": 0, "error": 0, "pending": 0, "hold": 0, "other": 0}
    for rec in spend:
        m = rec.get("model") or "unknown"
        slot = by_model.setdefault(m, {"n": 0, "PASS": 0, "FAIL": 0, "error": 0, "pending": 0, "hold": 0})
        slot["n"] += 1
        oc = (rec.get("outcome") or "pending").upper()
        if oc in ("PASS", "FAIL"):
            outcomes[oc] += 1
            slot[oc] += 1
        elif oc in ("ERROR", "API-ERROR"):
            outcomes["error"] += 1
            slot["error"] += 1
        elif oc in ("HOLD",):
            outcomes["hold"] += 1
            slot["hold"] += 1
        elif oc in ("PENDING", ""):
            outcomes["pending"] += 1
            slot["pending"] += 1
        else:
            outcomes["other"] += 1
        for r in primary_triggers(str(rec.get("reason") or "")):
            by_reason[r] = by_reason.get(r, 0) + 1
    lines = [
        f"# Escalations week {start.strftime('%Y-%m-%d')}–{(end - timedelta(days=1)).strftime('%Y-%m-%d')} (Asia/Singapore)",
        "",
        f"Updated {now().strftime('%Y-%m-%d %H:%M %Z')}. Policy: `rsi/ROUTING.md`.",
        f"Strong reviews this week (new head SHA only; reuse/holds excluded): {len(spend)}. "
        f"Outcomes: PASS {outcomes['PASS']}, FAIL {outcomes['FAIL']}, "
        f"error {outcomes['error']}, pending {outcomes['pending']}, hold {outcomes['hold']}"
        + (f", other {outcomes['other']}" if outcomes["other"] else "")
        + ".",
        "",
    ]
    judged = outcomes["PASS"] + outcomes["FAIL"]
    if judged:
        rate = 100.0 * outcomes["PASS"] / judged
        lines.append(
            f"Among decided reviews, {outcomes['PASS']}/{judged} ({rate:.0f}%) were PASS after escalation. "
            "The daily worth-it metric below is the one to judge over 2–3 days, together with `reviewer-misses.md`."
        )
    else:
        lines.append("No decided PASS/FAIL outcomes yet this week; worth-it judgement is pending.")
    lines += ["", "## By model", ""]
    if by_model:
        for m, s in sorted(by_model.items(), key=lambda kv: -kv[1]["n"]):
            lines.append(
                f"- `{m}`: {s['n']} (PASS {s['PASS']}, FAIL {s['FAIL']}, error {s['error']}, "
                f"pending {s['pending']}, hold {s['hold']})"
            )
    else:
        lines.append("None.")
    lines += ["", "## By necessity signal", ""]
    if by_reason:
        for r, n in sorted(by_reason.items(), key=lambda kv: -kv[1]):
            lines.append(f"- {r}: {n}")
    else:
        lines.append("None.")
    lines.append("")
    lines.extend(daily_worth_lines(spend, state, worth=worth_lines(spend)))
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
    assert mechanical_gate_only(pretty)
    assert not substantive_gate_fail(pretty)
    hard = "GATE_RESULT=FAIL: typecheck\n error TS2322\n"
    assert substantive_gate_fail(hard)
    assert not mechanical_gate_only(hard)
    fail = "item: Q1\nVERDICT: FAIL — Major M1\n"
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        (st / "sendback").mkdir()
        (st / "merge").mkdir()
        # 1) A typecheck/test/format failure alone must NOT trigger gate-undiagnosed.
        (st / "sendback" / "x.md").write_text("item: T1\nGATE_RESULT=FAIL: typecheck\n error TS2322\n")
        assert not gate_undiagnosed(st, "x", gather_text(st, "x"))
        rs = triggers(st, "T1", "x", "", "reviewer")
        assert "gate-undiagnosed" not in rs
        # prettier alone never escalates
        (st / "sendback" / "p.md").write_text("item: T1\nGATE_RESULT=FAIL: prettier\n")
        assert "gate-undiagnosed" not in triggers(st, "T1", "p", "", "reviewer")
        # 2) Only after DeepSeek explicitly cannot diagnose.
        (st / "merge" / "x.diagnosis.txt").write_text(
            "DeepSeek diagnosis after a real attempt.\nDEEPSEEK_DIAGNOSIS: UNDIAGNOSED\n"
            "could not diagnose the root cause.\n"
        )
        assert gate_undiagnosed(st, "x", gather_text(st, "x"))
        # 3) reviewer-disagreement requires DeepSeek PASS vs substance FAIL, not a mechanical gate.
        (st / "sendback" / "d.md").write_text("item: T1\nGATE_RESULT=FAIL: prettier\nVERDICT: FAIL\n")
        assert not review_disagreement(st, "d", "", gather_text(st, "d"))
        save_deepseek(st, "d", "abc", "PASS")
        (st / "sendback" / "d.md").write_text("item: T1\nGATE_RESULT=FAIL: typecheck\n")
        assert review_disagreement(st, "d", "abc", gather_text(st, "d"))
        # DeepSeek FAIL is not a disagreement (it already found the issue).
        save_deepseek(st, "d", "abc", "FAIL")
        assert not review_disagreement(st, "d", "abc", gather_text(st, "d"))
        # 4) Keep F/S, rework >=2, architecture-marked.
        (st / "sendback" / "f.md").write_text("item: F1\nKIN-ARCH decision recorded.\n")
        (st / "merge" / "f.attempts").write_text("2\n")
        rs = triggers(st, "F1", "f", "", "reviewer")
        assert any(r.startswith("rework-round-") for r in rs)
        assert any(r.startswith("astryx-foundation") for r in rs)
        assert "architecture-marked" in rs
        # small tier keeps only rework
        os.environ["RSI_REVIEW_TIER"] = "small"
        rs_small = triggers(st, "F1", "f", "", "reviewer")
        assert rs_small and all(r.startswith("rework-round") for r in rs_small)
        del os.environ["RSI_REVIEW_TIER"]
        # 5) Dedupe: reuse same SHA, no second spend.
        body = st / "body.txt"
        body.write_text("FIXLIST:\n- a.tsx:1 | major | bug | fix it\nVERDICT: FAIL\n")
        assert save_strong(st, "z", "deadbeef", "FAIL", "codex/gpt-6.1-sol", str(body)) == 0
        hit = cached_strong(st, "z", "deadbeef")
        assert hit and hit["verdict"] == "FAIL"
        assert cached_strong(st, "z", "other") is None
        # 6) sol-limited + agy off: pick returns no model (hold).
        os.environ["RSI_AGY_ENABLED"] = "0"
        os.environ["RSI_CARBON_ENABLED"] = "0"
        (st / "sol-limited-until").write_text(str(int(datetime.now().timestamp()) + 3600))
        chosen, fb, blocked = pick("reviewer", ["astryx-foundation-or-shell:F1"], False, st)
        assert chosen == "" and blocked == "sol-limited"
        assert not carbon_available() and not agy_enabled()
        # sol-limited + agy on: Hydrogen-high is chosen for F1 (do not hold).
        fake = st / "fake-agy"
        fake.write_text("#!/bin/sh\nexit 0\n")
        fake.chmod(0o755)
        os.environ["RSI_AGY_ENABLED"] = "1"
        os.environ["RSI_CARBON_ENABLED"] = "1"
        os.environ["AGY"] = str(fake)
        assert agy_enabled()
        chosen, fb, blocked = pick("reviewer", ["astryx-foundation-or-shell:F1"], False, st)
        assert chosen == "hydrogen-high" and "hydrogen" in fb and "codex" not in fb  # sol still limited
        # ordinary disagreement uses high; a standing/normal review uses medium.
        chosen, fb, blocked = pick("reviewer-alt", ["reviewer-disagreement"], False, st)
        assert chosen == "hydrogen-high"
        chosen, fb, blocked = pick("ux-reviewer", ["standing-strong-review"], False, st)
        assert chosen == "hydrogen"
        # agy-limited + sol free: fall back to sol, skip every agy model.
        (st / "agy-limited-until").write_text(str(int(datetime.now().timestamp()) + 3600))
        (st / "sol-limited-until").write_text("0")
        chosen, fb, blocked = pick("reviewer", ["astryx-foundation-or-shell:F1"], False, st)
        assert chosen == "codex"
        assert all(n not in [chosen, *fb] for n in ("hydrogen", "hydrogen-high", "carbon"))
        os.environ["RSI_AGY_ENABLED"] = "0"
        os.environ["RSI_CARBON_ENABLED"] = "0"
        os.environ.pop("AGY", None)
        # 7) weekly daily worth-it line
        eid = "test-id"
        log_decision(
            st,
            dict(
                id=eid,
                role="reviewer-alt",
                slug="z",
                item="T1",
                model="codex",
                reason="reviewer-disagreement",
                cost_source="chatgpt",
                kimi_cny=0,
                total=0,
                deepseek_verdict="PASS",
                has_bm=True,
                outcome="FAIL",
                sha="deadbeef",
            ),
        )
        weekly(st)
        md = (st / "escalations-weekly.md").read_text()
        assert "Daily worth-it" in md
        assert "Found-what-DeepSeek-missed: 1" in md
        # hold is not an error log storm: already_logged works
        log_decision(st, dict(id="h1", kind="hold", slug="z", sha="deadbeef", outcome="hold", reason="sol-limited"))
        assert already_logged(st, "z", "deadbeef", "hold")
        # outcome error is recorded only when asked; hold != error
        recs = [json.loads(l) for l in (st / "escalations.jsonl").read_text().splitlines()]
        assert any(r.get("kind") == "hold" and r.get("outcome") == "hold" for r in recs)
    order = preference("reviewer", ["reviewer-disagreement"])
    assert order[0] == "hydrogen-high" and "codex" in order and order[-1] == "kimi"
    ordinary = preference("reviewer-alt", ["standing-strong-review"])
    assert ordinary[0] == "codex" and ordinary[1] == "hydrogen" and ordinary[-1] == "kimi"
    ux = preference("ux-reviewer", ["standing-strong-review"])
    assert ux[0] == "hydrogen" and ux[1] == "codex" and ux[-1] == "kimi"
    ux_alt = preference("ux-reviewer-alt", ["standing-strong-review"])
    assert ux_alt[0] == "hydrogen" and ux_alt[-1] == "kimi"
    xh = preference("reviewer-alt", ["astryx-foundation-or-shell:F3"])
    assert xh[0] == "hydrogen-high" and xh[1] == "hydrogen" and xh[2] == "codex"
    arch = preference("director", ["architecture-cross-cutting:ui,internal,desktop"])
    assert arch[0] == "hydrogen-high"
    assert "hydrogen-xhigh" not in preference("reviewer-alt", ["astryx-foundation-or-shell:F1"])
    print("escalate self-test ok")
    return 0


def emit(model, fallback, reason, cost, eid, reuse=None, hold="") -> None:
    sys.stdout.write(f"RSI_ESCALATE_MODEL={model}\n")
    sys.stdout.write(f"RSI_ESCALATE_FALLBACK={','.join(fallback)}\n")
    sys.stdout.write(f"RSI_ESCALATE_REASON='{sh(reason)}'\n")
    sys.stdout.write(f"RSI_ESCALATE_COST_SOURCE={cost}\n")
    sys.stdout.write(f"RSI_ESCALATE_ID={eid}\n")
    sys.stdout.write(f"RSI_ESCALATE_REUSE={1 if reuse else 0}\n")
    sys.stdout.write(f"RSI_ESCALATE_REUSE_FILE={sh((reuse or {}).get('file') or '')}\n")
    sys.stdout.write(f"RSI_ESCALATE_REUSE_VERDICT={(reuse or {}).get('verdict') or ''}\n")
    sys.stdout.write(f"RSI_ESCALATE_HOLD={hold}\n")


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    state = state_dir()
    if "--weekly" in argv:
        p = weekly(state)
        sys.stdout.write(str(p) + "\n")
        return 0
    if "--sol-limited" in argv:
        until = sol_limited_until(state)
        if sol_is_limited(state):
            sys.stdout.write(str(until) + "\n")
            return 0
        sys.stdout.write("0\n")
        return 1
    if "--agy-limited" in argv:
        until = agy_limited_until(state)
        if agy_is_limited(state):
            sys.stdout.write(str(until) + "\n")
            return 0
        sys.stdout.write("0\n")
        return 1
    if "--no-strong-available" in argv:
        allowed, _budget = kimi_allowed()
        if no_strong_available(state, allowed):
            sys.stdout.write("1\n")
            return 0
        sys.stdout.write("0\n")
        return 1
    if "--save-strong" in argv or "--save-deepseek" in argv:
        slug = sha = verdict = model = src = role = ""
        args = list(argv)
        while args:
            a = args.pop(0)
            if a == "--slug" and args:
                slug = args.pop(0)
            elif a == "--sha" and args:
                sha = args.pop(0)
            elif a == "--verdict" and args:
                verdict = args.pop(0)
            elif a == "--model" and args:
                model = args.pop(0)
            elif a == "--file" and args:
                src = args.pop(0)
            elif a == "--role" and args:
                role = args.pop(0)
        if "--save-deepseek" in argv:
            return save_deepseek(state, slug, sha, verdict, src)
        return save_strong(state, slug, sha, verdict, model, src, kind_from_role(role))
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
        # Never invent an 'error' storm from a hold: callers should pass hold, not error.
        return record_outcome(state, eid, outcome, note, model, tag)

    role = tag = cwd = item = slug = sha = ""
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
        elif a == "--sha" and args:
            sha = args.pop(0)
        elif a == "--check":
            continue
    if not slug:
        slug = slug_from_tag(tag) or (os.environ.get("RSI_SLUG") or "")
    if not item:
        item = item_for(state, slug, cwd)
    if not sha and cwd and Path(cwd).is_dir():
        try:
            import subprocess

            sha = (
                subprocess.run(
                    ["git", "-C", cwd, "rev-parse", "HEAD"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                ).stdout
                or ""
            ).strip()
        except Exception:
            sha = ""
    kind = kind_from_role(role)
    reuse = cached_strong(state, slug, sha, kind) if slug and sha else None
    if reuse:
        # Reuse the prior strong verdict for this head SHA. Log kind=reuse at most once; never re-run.
        if not already_logged(state, slug, sha, "reuse"):
            log_decision(
                state,
                dict(
                    id="reuse-" + (sha[:12] if sha else slug),
                    role=role,
                    tag=tag,
                    slug=slug,
                    item=item,
                    sha=sha,
                    model=reuse.get("model") or "",
                    reason="reuse-sha",
                    cost_source="",
                    outcome=reuse.get("verdict"),
                    kind="reuse",
                    kimi_cny=0,
                    total=0,
                ),
            )
        emit(reuse.get("model") or "", [], "reuse-sha", "", "", reuse=reuse, hold="")
        return 0
    reasons = triggers(state, item, slug, cwd, role, sha)
    allowed, budget = kimi_allowed()
    model = reason = cost = eid = ""
    fallback: list[str] = []
    hold = ""
    standing = (not reasons) and role in {"reviewer-alt", "ux-reviewer", "ux-reviewer-alt"}
    if reasons or standing:
        use_reasons = reasons or ["standing-strong-review"]
        model, fallback, blocked = pick(role, use_reasons, allowed, state)
        reason = ",".join(use_reasons)
        if blocked:
            reason = reason + "|" + blocked
        if not model:
            hold = blocked or "no-strong-model"
            # Do not call a strong model, and do not log 'error'. One hold record per slug+SHA.
            if not already_logged(state, slug, sha, "hold"):
                log_decision(
                    state,
                    dict(
                        id="hold-" + (sha[:12] if sha else slug or uuid.uuid4().hex[:12]),
                        role=role,
                        tag=tag,
                        slug=slug,
                        item=item,
                        sha=sha,
                        model="",
                        reason=reason,
                        cost_source="",
                        outcome="hold",
                        kind="hold",
                        kimi_cny=budget.get("kimi_cny", 0),
                        total=budget.get("total", 0),
                        level=budget.get("level"),
                    ),
                )
            emit("", [], reason, "", "", hold=hold)
            return 0
        cost = COST.get(model, "")
        eid = uuid.uuid4().hex[:12]
        ds = deepseek_verdict(state, slug, sha)
        log_decision(
            state,
            dict(
                id=eid,
                role=role,
                tag=tag,
                slug=slug,
                item=item,
                sha=sha,
                model=model,
                fallback=",".join(fallback),
                reason=reason,
                cost_source=cost,
                kimi_cny=budget.get("kimi_cny", 0),
                total=budget.get("total", 0),
                level=budget.get("level"),
                outcome="pending",
                deepseek_verdict=ds,
            ),
        )
    emit(model, fallback, reason, cost, eid, hold=hold)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        raise SystemExit(0)
