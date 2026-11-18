#!/usr/bin/env python3
"""Read the journey spec: an index whose `journeys` map names one file per journey.

The walker (walk.mjs) and every shell harness read the spec through this
module, so a PR that adds a leg to one journey edits one file and two walk PRs
never collide in the same JSON. One file per journey is the point; the reader
is what makes it safe.

Inline journey bodies stay valid: old single-file specs, the smoke fixture and
the reduced specs the mutant tests write keep working untouched.

Usage:
  python3 spec.py --resolve <spec>   print the fully inlined spec JSON
  python3 spec.py --ids <spec>       print the journey ids, space-separated
Exit 0 on success; 2 with a one-line stderr message naming the journey id and
the file when a body file is missing, unreadable or has no steps.
"""
import json
import os
import sys


def die(message):
    sys.stderr.write(message + "\n")
    raise SystemExit(2)


def read_json(path, what):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except OSError as exc:
        die("%s: cannot read %s: %s" % (what, path, exc.strerror or exc))
    except ValueError as exc:
        die("%s: %s is not valid JSON: %s" % (what, path, exc))


def resolve(spec_path):
    """The spec with every string journey entry replaced by the file it names."""
    spec_path = os.path.abspath(spec_path)
    spec = read_json(spec_path, "spec")
    if not isinstance(spec, dict):
        die("spec %s: top level is not an object" % spec_path)
    journeys = spec.get("journeys")
    if not isinstance(journeys, dict):
        die("spec %s: no journeys object" % spec_path)
    base = os.path.dirname(spec_path)
    resolved = {}
    for jid, entry in journeys.items():
        if isinstance(entry, dict):
            resolved[jid] = entry
            continue
        if not isinstance(entry, str) or not entry:
            die("journey %s: %s names no body file" % (jid, spec_path))
        body_path = os.path.abspath(os.path.join(base, entry))
        body = read_json(body_path, "journey %s" % jid)
        if not isinstance(body, dict):
            die("journey %s: %s is not an object" % (jid, body_path))
        steps = body.get("steps")
        if not isinstance(steps, list) or not steps:
            die("journey %s: %s has no steps" % (jid, body_path))
        resolved[jid] = body
    out = dict(spec)
    out["journeys"] = resolved
    return out


def journey_ids(spec_path):
    """The resolved ids in natural order (J1, J2, ..., J10, J11), not lexical."""
    spec = resolve(spec_path)
    def key(jid):
        head = jid.rstrip("0123456789")
        tail = jid[len(head):]
        return (head, int(tail) if tail else -1, jid)
    return sorted(spec["journeys"], key=key)


def main(argv):
    if len(argv) != 3 or argv[1] not in ("--resolve", "--ids"):
        sys.stderr.write("usage: spec.py --resolve|--ids <spec>\n")
        return 2
    if argv[1] == "--ids":
        print(" ".join(journey_ids(argv[2])))
    else:
        print(json.dumps(resolve(argv[2]), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
