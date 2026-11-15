#!/usr/bin/env python3
"""Today's Mac magpie Volcengine spend at official list prices (CNY, Asia/Singapore day).

Reads ~/.config/magpie/usage.jsonl (fast; no keys printed). Falls back to
`magpie usage --csv today` if the ledger is missing.

DeepSeek V4.1 Flash peak hours (official docs): Mon–Fri 09:00–12:00 and
14:00–18:00 in Beijing time (= Asia/Singapore). Kimi K3.1 Pro is flat.
Cache hits use the official cache-hit unit price. Codex/ChatGPT rows are ignored.

Exit codes for --allow-kimi / --allow-workers: 0 allowed, 1 blocked, 2 error.
--allow-kimi also requires today's Kimi list CNY < RSI_VOLC_KIMI_DAY_MAX (default 80).
Decisions are logged under $RSI_STATE (or rsi/state next to this file).
"""
from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

SGT = timezone(timedelta(hours=8))

# Official 火山方舟 list prices, CNY per million tokens (docs updated 2026-11-13).
KIMI = dict(in_=13.0, cache=1.30, out=68.0)
DS_OFF = dict(in_=1.0, cache=0.02, out=4.0)
DS_PEAK = dict(in_=2.0, cache=0.04, out=8.0)

DEFAULT_KIMI_MAX = 450.0
DEFAULT_KIMI_DAY_MAX = 80.0  # Kimi-only daily cap; remaining escalations fall back to gpt-6.1-sol
DEFAULT_STOP_WORKERS = 560.0
DEFAULT_CACHE_SECS = 180


def now_sgt() -> datetime:
    return datetime.now(SGT)


def today_start(now: datetime | None = None) -> datetime:
    n = now or now_sgt()
    return n.replace(hour=0, minute=0, second=0, microsecond=0)


def parse_ts(value: str) -> datetime | None:
    if not value:
        return None
    v = value.strip()
    try:
        if v.endswith("Z"):
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        else:
            dt = datetime.fromisoformat(v)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=SGT)
        return dt.astimezone(SGT)
    except Exception:
        return None


def is_peak(dt: datetime) -> bool:
    # Monday=0 … Sunday=6; peak only on weekdays.
    if dt.weekday() >= 5:
        return False
    h = dt.hour
    return (9 <= h < 12) or (14 <= h < 18)


def family(model: str, served: str = "", requested: str = "") -> str:
    blob = " ".join([model or "", served or "", requested or ""]).lower()
    if "kimi" in blob:
        return "kimi-k3.1-pro"
    if "deepseek" in blob:
        return "deepseek-v4.1-flash"
    return "other"


def is_volc(provider: str, host: str = "", model: str = "") -> bool:
    blob = " ".join([provider or "", host or "", model or ""]).lower()
    if "codex" in (provider or "").lower() or "chatgpt.com" in blob:
        return False
    return "volc" in blob or "volceapi" in blob or "volcengine" in blob


def price(fam: str, peak: bool) -> dict | None:
    if fam.startswith("kimi"):
        return KIMI
    if "deepseek" in fam:
        return DS_PEAK if peak else DS_OFF
    return None


def cny_for(fam: str, inp: float, out: float, cache: float, peak: bool) -> float:
    p = price(fam, peak)
    if not p:
        return 0.0
    return (inp * p["in_"] + cache * p["cache"] + out * p["out"]) / 1e6


def _num(v) -> float:
    try:
        if v in (None, "", False, True):
            return 0.0
        return float(v)
    except Exception:
        return 0.0


def ledger_path() -> Path:
    return Path(os.environ.get("MAGPIE_USAGE_JSONL") or Path.home() / ".config/magpie/usage.jsonl")


def read_jsonl(path: Path, start: datetime) -> list[dict]:
    rows: list[dict] = []
    if not path.is_file():
        return rows
    # File is append-only chronological. Scan all of today's tail; 100 MB is fine.
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            dt = parse_ts(str(o.get("t") or ""))
            if dt is None or dt < start:
                continue
            if (o.get("source") or "") == "log":
                continue
            if not is_volc(str(o.get("provider") or ""), str(o.get("host") or ""), str(o.get("model") or "")):
                continue
            rows.append(
                dict(
                    t=dt,
                    fam=family(str(o.get("model") or ""), str(o.get("served") or ""), str(o.get("req") or "")),
                    inp=_num(o.get("in")),
                    out=_num(o.get("out")),
                    cache=_num(o.get("cache_read")),
                )
            )
    return rows


def read_csv(start: datetime) -> list[dict]:
    try:
        proc = subprocess.run(
            ["magpie", "usage", "--csv", "today"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except Exception:
        return []
    text = proc.stdout or ""
    # Drop any leading log lines before the header.
    idx = text.find("time,")
    if idx < 0:
        return []
    rows: list[dict] = []
    reader = csv.DictReader(text[idx:].splitlines())
    for r in reader:
        dt = parse_ts(r.get("time") or "")
        if dt is None or dt < start:
            continue
        if (r.get("source") or "") == "log":
            continue
        if not is_volc(r.get("provider") or "", r.get("host") or "", r.get("model") or r.get("requested_model") or ""):
            continue
        rows.append(
            dict(
                t=dt,
                fam=family(r.get("model") or "", r.get("served_model") or "", r.get("requested_model") or ""),
                inp=_num(r.get("input_tokens")),
                out=_num(r.get("output_tokens")),
                cache=_num(r.get("cache_read_tokens")),
            )
        )
    return rows


def aggregate(rows: list[dict]) -> dict:
    by: dict[str, dict] = {}
    total = 0.0
    unpriced_calls = 0
    for r in rows:
        fam = r["fam"]
        peak = is_peak(r["t"])
        amount = cny_for(fam, r["inp"], r["out"], r["cache"], peak)
        if price(fam, peak) is None:
            unpriced_calls += 1
        slot = by.setdefault(fam, dict(calls=0, inp=0.0, out=0.0, cache=0.0, cny=0.0))
        slot["calls"] += 1
        slot["inp"] += r["inp"]
        slot["out"] += r["out"]
        slot["cache"] += r["cache"]
        slot["cny"] += amount
        total += amount
    return dict(total=total, by=by, unpriced_calls=unpriced_calls, calls=len(rows))


def state_dir() -> Path:
    env = os.environ.get("RSI_STATE") or os.environ.get("STATE")
    if env:
        return Path(env)
    # runtime/volc-budget.py -> rsi/state
    return Path(__file__).resolve().parent.parent / "state"


def thresholds() -> tuple[float, float, float]:
    kimi_max = float(os.environ.get("RSI_VOLC_KIMI_MAX") or DEFAULT_KIMI_MAX)
    stop = float(os.environ.get("RSI_VOLC_STOP_WORKERS") or DEFAULT_STOP_WORKERS)
    kimi_day = float(os.environ.get("RSI_VOLC_KIMI_DAY_MAX") or DEFAULT_KIMI_DAY_MAX)
    return kimi_max, stop, kimi_day


def level_for(total: float, kimi_max: float, stop: float) -> str:
    if total >= stop:
        return "stop-workers"
    if total >= kimi_max:
        return "no-kimi"
    return "ok"


def log_line(state: Path, msg: str) -> None:
    state.mkdir(parents=True, exist_ok=True)
    path = state / "volc-budget.log"
    line = f"{now_sgt().strftime('%Y-%m-%d %H:%M:%S %Z')} {msg}\n"
    with path.open("a", encoding="utf-8") as f:
        f.write(line)


def write_json_atomic(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def snap_path(state: Path) -> Path:
    return state / "volc-budget.json"


def load_cache(state: Path, cache_secs: int, today: str, refresh: bool) -> dict | None:
    if refresh:
        return None
    p = snap_path(state)
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    if data.get("day") != today:
        return None
    try:
        computed = parse_ts(str(data.get("computed_at") or ""))
    except Exception:
        computed = None
    if computed is None or (now_sgt() - computed).total_seconds() > cache_secs:
        return None
    return data


def compute(refresh: bool = False) -> dict:
    kimi_max, stop, kimi_day = thresholds()
    start = today_start()
    today = start.strftime("%Y-%m-%d")
    state = state_dir()
    cache_secs = int(os.environ.get("RSI_VOLC_CACHE_SECS") or DEFAULT_CACHE_SECS)
    cached = load_cache(state, cache_secs, today, refresh)
    if cached:
        return cached

    source = "usage.jsonl"
    rows = read_jsonl(ledger_path(), start)
    if not rows and not ledger_path().is_file():
        source = "magpie-csv"
        rows = read_csv(start)
    agg = aggregate(rows)
    lvl = level_for(agg["total"], kimi_max, stop)
    data = {
        "computed_at": now_sgt().isoformat(timespec="seconds"),
        "day": today,
        "timezone": "Asia/Singapore",
        "cny": round(agg["total"], 2),
        "level": lvl,
        "kimi_max": kimi_max,
        "kimi_day_max": kimi_day,
        "kimi_cny": round(sum(v["cny"] for k, v in agg["by"].items() if k.startswith("kimi")), 2),
        "stop_workers": stop,
        "calls": agg["calls"],
        "unpriced_calls": agg["unpriced_calls"],
        "source": source,
        "by_model": {
            k: dict(calls=v["calls"], inp=int(v["inp"]), out=int(v["out"]), cache=int(v["cache"]), cny=round(v["cny"], 2))
            for k, v in sorted(agg["by"].items())
        },
    }
    return data


def apply(data: dict) -> dict:
    state = state_dir()
    state.mkdir(parents=True, exist_ok=True)
    prev = {}
    p = snap_path(state)
    if p.is_file():
        try:
            prev = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            prev = {}
    write_json_atomic(p, data)

    day = data["day"]
    lvl = data["level"]
    cny = data["cny"]
    prev_day = prev.get("day")
    prev_lvl = prev.get("level") if prev_day == day else "ok"

    no_kimi = state / "VOLC_NO_KIMI"
    stop = state / "VOLC_STOP_WORKERS"
    if lvl == "ok":
        if no_kimi.exists() or stop.exists():
            no_kimi.unlink(missing_ok=True)
            stop.unlink(missing_ok=True)
            log_line(state, f"clear flags: day={day} cny=¥{cny:.2f} level={lvl} (was {prev_lvl})")
    if lvl in ("no-kimi", "stop-workers"):
        no_kimi.write_text(f"{day} ¥{cny:.2f} {lvl}\n", encoding="utf-8")
    else:
        no_kimi.unlink(missing_ok=True)
    if lvl == "stop-workers":
        stop.write_text(
            f"{day} ¥{cny:.2f} stop new worker lanes / box pack / NAS pulse until tomorrow Asia/Singapore\n",
            encoding="utf-8",
        )
    else:
        stop.unlink(missing_ok=True)

    if prev_lvl != lvl or prev_day != day:
        log_line(
            state,
            f"decision: day={day} cny=¥{cny:.2f} level={lvl} (was day={prev_day or '-'} {prev_lvl or '-'}) "
            f"kimi_max=¥{data['kimi_max']:.0f} kimi_day=¥{data.get('kimi_day_max', 80):.0f} kimi_cny=¥{data.get('kimi_cny', 0):.2f} stop=¥{data['stop_workers']:.0f} source={data['source']}",
        )
    return data


def export_sh(data: dict) -> str:
    # Safe numeric/enum values only.
    return (
        f"RSI_VOLC_CNY={data['cny']}\n"
        f"RSI_VOLC_LEVEL={data['level']}\n"
        f"RSI_VOLC_DAY={data['day']}\n"
        f"RSI_VOLC_KIMI_MAX={data['kimi_max']}\n"
        f"RSI_VOLC_KIMI_DAY_MAX={data.get('kimi_day_max', 80)}\n"
        f"RSI_VOLC_KIMI_CNY={data.get('kimi_cny', 0)}\n"
        f"RSI_VOLC_STOP_WORKERS={data['stop_workers']}\n"
    )


def self_test() -> int:
    # Sunday 2026-11-15 is off-peak; a weekday 10:00 is peak.
    sun = datetime(2026, 11, 15, 10, 0, tzinfo=SGT)
    mon = datetime(2026, 11, 16, 10, 0, tzinfo=SGT)
    assert not is_peak(sun)
    assert is_peak(mon)
    assert not is_peak(datetime(2026, 11, 16, 13, 0, tzinfo=SGT))
    # 1M in + 1M cache + 1M out
    k = cny_for("kimi-k3.1-pro", 1_000_000, 1_000_000, 1_000_000, False)
    assert abs(k - (13 + 1.30 + 68)) < 1e-9, k
    d0 = cny_for("deepseek-v4.1-flash", 1_000_000, 1_000_000, 1_000_000, False)
    assert abs(d0 - (1 + 0.02 + 4)) < 1e-9, d0
    d1 = cny_for("deepseek-v4.1-flash", 1_000_000, 1_000_000, 1_000_000, True)
    assert abs(d1 - (2 + 0.04 + 8)) < 1e-9, d1
    assert family("volcengine/deepseek-v4.1-flash", "deepseek-v4-1-flash-261017") == "deepseek-v4.1-flash"
    assert family("kimi-k3.1-pro") == "kimi-k3.1-pro"
    assert is_volc("volcengine-gw", "st8tp3ajl0df3n8b8l8qu.apigateway-cn-beijing.volceapi.com")
    assert not is_volc("codex", "chatgpt.com")
    assert level_for(449, 450, 560) == "ok"
    assert level_for(450, 450, 560) == "no-kimi"
    assert level_for(560, 450, 560) == "stop-workers"
    rows = [
        dict(t=sun, fam="kimi-k3.1-pro", inp=1_000_000, out=0, cache=0),
        dict(t=sun, fam="deepseek-v4.1-flash", inp=0, out=1_000_000, cache=0),
    ]
    agg = aggregate(rows)
    assert abs(agg["total"] - 17.0) < 1e-9, agg
    assert abs(sum(v["cny"] for k, v in agg["by"].items() if k.startswith("kimi")) - 13.0) < 1e-9
    print("volc-budget self-test ok")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    refresh = "--refresh" in argv
    data = compute(refresh=refresh)
    if "--apply" in argv or "--export" in argv or "--allow-kimi" in argv or "--allow-workers" in argv:
        data = apply(data)
    if "--export" in argv:
        sys.stdout.write(export_sh(data))
        return 0
    if "--allow-kimi" in argv:
        kimi_cny = float(data.get("kimi_cny") or 0)
        kimi_day = float(data.get("kimi_day_max") or DEFAULT_KIMI_DAY_MAX)
        return 0 if data["level"] == "ok" and kimi_cny < kimi_day else 1
    if "--allow-workers" in argv:
        return 0 if data["level"] != "stop-workers" else 1
    if "--apply" in argv:
        sys.stdout.write(json.dumps(data, indent=2, sort_keys=True) + "\n")
        return 0
    sys.stdout.write(json.dumps(data, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        raise SystemExit(0)
