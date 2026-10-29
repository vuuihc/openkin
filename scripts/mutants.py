#!/usr/bin/env python3
"""Apply each mutant, prove the test notices, restore, prove the restore.

Usage:
    ./scripts/mutants.py manifest.json [--timeout 300] [--verbose]

The manifest is a JSON array; each entry is

    {"label": "what this breaks",
     "file": "internal/thing/thing.go",
     "test": "go test ./internal/thing -run TestThing -count=1",
     "old": "exact text, occurring exactly once",
     "new": "replacement"}

For every entry the runner first runs `test` unmutated and requires it to pass
(a red baseline would make every mutant look detected), then applies the
replacement, proves the bytes changed, runs `test` again and requires it to
fail, restores the original bytes and proves they match again. A mutant that
survives — or a restore that does not come back byte for byte — exits nonzero.

Newlines in JSON strings are ordinary `\\n` escapes; no shell quoting is
involved, so a mutant can span lines.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path


def run_test(command: str, timeout: float) -> tuple[int | None, str]:
    try:
        proc = subprocess.run(
            command,
            shell=True,
            timeout=timeout,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        out = proc.stdout.decode("utf-8", "replace")
        return proc.returncode, out
    except subprocess.TimeoutExpired as exc:
        out = exc.output or b""
        if isinstance(out, bytes):
            out = out.decode("utf-8", "replace")
        return None, out


def tail(text: str, limit: int = 800) -> str:
    text = text.strip()
    return text if len(text) <= limit else "…" + text[-limit:]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("manifest")
    parser.add_argument("--timeout", type=float, default=300.0,
                        help="seconds per test run (default 300)")
    parser.add_argument("--verbose", action="store_true",
                        help="print the failing output for each red mutant")
    args = parser.parse_args()

    entries = json.loads(Path(args.manifest).read_text())
    if not isinstance(entries, list) or not entries:
        print("manifest must be a non-empty JSON array")
        return 2

    problematic = 0
    baselines: dict[str, int | None] = {}

    for entry in entries:
        label = entry["label"]
        path = Path(entry["file"])
        test = entry["test"]
        old = entry["old"]
        new = entry["new"]

        if test not in baselines:
            code, out = run_test(test, args.timeout)
            baselines[test] = code
            if code != 0:
                print(f"BASELINE {label}: test fails before any mutation "
                      f"(exit {code})")
                print(tail(out))
                problematic += 1
                continue
        elif baselines[test] != 0:
            problematic += 1
            continue

        original = path.read_bytes()
        text = original.decode("utf-8")
        count = text.count(old)
        if count != 1:
            print(f"ERROR    {label}: pattern occurs {count} times, not once")
            problematic += 1
            continue

        mutated = text.replace(old, new)
        if mutated == text:
            print(f"ERROR    {label}: replacement is identical to the original")
            problematic += 1
            continue

        try:
            path.write_bytes(mutated.encode("utf-8"))
            if path.read_bytes() == original:
                print(f"ERROR    {label}: file unchanged after the write")
                problematic += 1
                continue
            code, out = run_test(test, args.timeout)
        finally:
            path.write_bytes(original)

        if path.read_bytes() != original:
            print(f"RESTORE  {label}: FAILED — {path} does not match its backup")
            return 2

        if code is None:
            print(f"TIMEOUT  {label}: test did not finish in {args.timeout:g}s")
            problematic += 1
        elif code == 0:
            print(f"SURVIVED {label}: the test still passed")
            problematic += 1
            if args.verbose:
                print(tail(out))
        else:
            print(f"red      {label} (exit {code})")
            if args.verbose:
                print(tail(out))

    red = len(entries) - problematic
    print(f"\n{red}/{len(entries)} mutants red; {problematic} problem(s)")
    return 1 if problematic else 0


if __name__ == "__main__":
    sys.exit(main())
