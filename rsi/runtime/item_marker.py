#!/usr/bin/env python3
"""The one rule for reading a slice id out of a PR body (RSI item marker).

  item_marker.py < body          prints the id, or an empty line when there is none
  item_marker.py --self-test     runs the parse table and exits non-zero on a miss

The marker is the line `RSI item: <id>` written by a worker in its PR body. It is
hand-written markdown, so the id arrives as `F1`, **F1**, __R-x__, `F5a`, after a
list bullet, or with a trailing note. Both readers used to carry their own regex;
each one missed emphasis differently and silently fell back to R-<slug>, so
slices.py never marked the slice done and the F1-F3 package.json allow-list was
bypassed (PR #67, 2026-11-15 13:14-13:34). Every reader now calls this module.

The rule: on the first line containing the exact marker, strip the surrounding
whitespace and markdown framing characters, then take the first token that could
be an id. Markdown emphasis around the id is presentation, never part of it.
"""
import re, sys

MARKER = "RSI item:"
FRAMING = "`*_~"                                   # markdown framing around an id
LEAD = " \t" + FRAMING
TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
EXISTING_IDS = ("R-result003-covered", "F5a", "R-walk-mutant")  # must parse unchanged


def parse_item(text):
    for line in text.splitlines():
        i = line.find(MARKER)
        if i < 0:
            continue
        # `RSI items: F1` never reaches here: its text after "RSI item" is "s:", not ":".
        rest = line[i + len(MARKER):].lstrip(LEAD)
        m = TOKEN.match(rest)
        if m:
            return m.group(0).rstrip(FRAMING)      # __R-x__ -> R-x
    return ""


SELF_TEST = (
    ("RSI item: F1", "F1"),
    ("RSI item: **F1**", "F1"),
    ("RSI item:**F1**", "F1"),
    ("RSI item: __R-x__", "R-x"),
    ("RSI item: `F5a`", "F5a"),
    ("RSI item: ~~F2~~", "F2"),
    ("- RSI item: R-z — note", "R-z"),
    ("RSI item: F1 (part a)", "F1"),
    ("body with no marker", ""),
    ("RSI item: **", ""),
    ("RSI item: ` `", ""),
    ("RSI items: F1", ""),
) + tuple((MARKER + " " + i, i) for i in EXISTING_IDS)


def self_test():
    bad = [(text, want, parse_item(text)) for text, want in SELF_TEST if parse_item(text) != want]
    for text, want, got in bad:
        print("FAIL %r -> %r, want %r" % (text, got, want), file=sys.stderr)
    if bad:
        return 1
    print("item_marker: self-test ok (%d cases)" % len(SELF_TEST))
    return 0


def main(argv):
    if "--self-test" in argv:
        return self_test()
    print(parse_item(sys.stdin.read()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
