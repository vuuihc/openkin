#!/usr/bin/env python3
"""Regenerate internal/store/default_price_table.json from LiteLLM's open price list.

Source:
  https://github.com/BerriAI/litellm
  https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json

Usage:
  python3 scripts/gen_default_price_table.py
  python3 scripts/gen_default_price_table.py --input /path/to/litellm.json
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_JSON = ROOT / "internal" / "store" / "default_price_table.json"
OUT_SRC = ROOT / "internal" / "store" / "default_price_table.SOURCE.txt"
LITELLM_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/"
    "model_prices_and_context_window.json"
)

# Curated model ids Kin agents / cognition commonly report.
ALLOW = {
    # OpenAI / Codex
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5.1",
    "gpt-5.1-chat",
    "gpt-5.1-mini",
    "gpt-5-codex",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "o1",
    "o1-mini",
    "o1-pro",
    "o3",
    "o3-mini",
    "o3-pro",
    "o4-mini",
    # Anthropic / Claude Code
    "claude-3-5-haiku-20241022",
    "claude-3-5-sonnet-20241022",
    "claude-3-7-sonnet-20250219",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-20250514",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-20250514",
    "claude-opus-4-1-20250805",
    "claude-3-5-haiku-latest",
    "claude-3-5-sonnet-latest",
    "claude-sonnet-4-0",
    "claude-opus-4-0",
    "claude-haiku-4-5",
    "claude-sonnet-4-5",
    "claude-opus-4-1",
    # Grok / xAI
    "grok-2",
    "grok-2-latest",
    "grok-2-vision",
    "grok-2-vision-latest",
    "grok-3",
    "grok-3-latest",
    "grok-3-mini",
    "grok-3-mini-latest",
    "grok-3-fast-latest",
    "grok-3-mini-fast",
    "grok-3-mini-fast-latest",
    "grok-4",
    "grok-4-latest",
    "grok-4.5",
    "grok-4.5-latest",
    "grok-4.3",
    "grok-4.3-latest",
    "grok-code-fast",
    "grok-code-fast-1",
    "grok-code-fast-1-0825",
    "grok-4-1-fast",
    "grok-4-fast-reasoning",
    "grok-4-fast-non-reasoning",
}


def per_million(usd_per_token: float) -> float:
    return round(float(usd_per_token) * 1_000_000, 6)


def find_entry(data: dict, name: str):
    for key in (name, f"openai/{name}", f"anthropic/{name}", f"xai/{name}"):
        e = data.get(key)
        if (
            isinstance(e, dict)
            and e.get("input_cost_per_token") is not None
            and e.get("output_cost_per_token") is not None
        ):
            return key, e
    for k, e in data.items():
        if not isinstance(e, dict):
            continue
        if k == name or k.endswith("/" + name):
            if e.get("input_cost_per_token") is not None and e.get("output_cost_per_token") is not None:
                return k, e
    return None, None


def load_litellm(path: Path | None) -> dict:
    if path:
        raw = path.read_text(encoding="utf-8")
    else:
        print(f"fetching {LITELLM_URL} …", file=sys.stderr)
        with urllib.request.urlopen(LITELLM_URL, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
    data = json.loads(raw)
    return {k: v for k, v in data.items() if isinstance(v, dict) and k != "sample_spec"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, help="Local LiteLLM JSON instead of fetching")
    args = ap.parse_args()

    data = load_litellm(args.input)
    out: OrderedDict[str, dict] = OrderedDict()
    missing: list[str] = []
    for name in sorted(ALLOW, key=str.lower):
        _src, e = find_entry(data, name)
        if not e:
            missing.append(name)
            continue
        out[name] = {
            "in": per_million(e["input_cost_per_token"]),
            "out": per_million(e["output_cost_per_token"]),
        }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    OUT_SRC.write_text(
        f"""Default model prices for Kin cost estimates.

Source: LiteLLM model_prices_and_context_window.json (open source)
  https://github.com/BerriAI/litellm
  {LITELLM_URL}

Units in default_price_table.json: USD per 1M input/output tokens
  (LiteLLM stores USD per token; we multiply by 1e6).

Regenerate:
  python3 scripts/gen_default_price_table.py

Curated subset size: {len(out)} models.
Missing from upstream at generation time: {", ".join(missing) if missing else "(none)"}.

Prices change; edit Settings → price_table to override, or regenerate.
""",
        encoding="utf-8",
    )
    print(f"wrote {OUT_JSON} ({len(out)} models)")
    if missing:
        print("missing:", ", ".join(missing), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
