#!/usr/bin/env bash
# Console asset extraction for scripts/smoke.sh. Sourced, never executed:
# these are pure functions over the HTML document the daemon serves, so the
# strict asset check can be tested with text fixtures instead of a live daemon.
#
# Why this exists: #482 put the boot guard ahead of the console entry in <head>
# (`vite.config.ts`'s bootGuardEntry). The old check took the first
# /assets/*.js it saw, which is the 1.8 kB guard; with the 1.9 MB
# /assets/index-<hash>.js missing, the guard still answered 200 and the gate
# stayed green over a console that could not start. The document names its
# scripts, so the gate requests all of them and separately insists that one of
# them is the Vite entry (/assets/index-<hash>.js).
#
# Bash 3.2 (macOS's /bin/bash) compatible: no mapfile, no associative arrays.
# The parsing is POSIX awk over the HTML string; both functions take the
# document as $1 because smoke.sh already holds it in a variable.

# console_scripts <html> — every /assets/*.js path the document names, in
# document order, each printed once. Empty output when the document names none.
console_scripts() {
  printf '%s\n' "${1-}" | awk '
    {
      rest = $0
      while (match(rest, /\/assets\/[A-Za-z0-9._-]+\.js/)) {
        path = substr(rest, RSTART, RLENGTH)
        if (!(path in seen)) {
          seen[path] = 1
          print path
        }
        rest = substr(rest, RSTART + RLENGTH)
      }
    }
  '
}

# console_entry <html> — the Vite entry chunk (/assets/index-<hash>.js), printed
# once. Returns nonzero and prints nothing when the document names no entry, so
# smoke.sh's strict mode cannot mistake the boot guard for the console.
console_entry() {
  printf '%s\n' "${1-}" | awk '
    {
      rest = $0
      while (match(rest, /\/assets\/index-[A-Za-z0-9_-]+\.js/)) {
        print substr(rest, RSTART, RLENGTH)
        found = 1
        exit
      }
    }
    END { exit(found ? 0 : 1) }
  '
}
