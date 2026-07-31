#!/usr/bin/env bash
# Offline stream / task observability gate (execplan continuous guard).
#
# Checks the durable SQLite event log for regressions that unit tests cannot
# see in production data:
#   1. per-task sequence holes (stream gap)
#   2. terminal tasks with zero events (empty transcript)
#   3. approvals missing execution attribution (post-migration 009)
#
# Usage:
#   ./scripts/stream-health-check.sh              # default ~/.kin/kin.db
#   ./scripts/stream-health-check.sh /path/to.db
#   KIN_DB=/path/to.db make stream-health
#
# Exit 0 = healthy; exit 1 = one or more checks failed (CI-friendly).

set -euo pipefail

DB="${1:-${KIN_DB:-${HOME}/.kin/kin.db}}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "error: sqlite3 required" >&2
  exit 2
fi

if [[ ! -f "$DB" ]]; then
  echo "error: db not found: $DB" >&2
  exit 2
fi

fail=0

echo "== stream health: $DB =="

# --- 1. sequence gaps -------------------------------------------------------
# A healthy task has min(seq)=1 and COUNT(*) == max(seq)-min(seq)+1.
gap_rows="$(sqlite3 "$DB" "
SELECT task_id || ' cnt=' || cnt || ' min=' || min_s || ' max=' || max_s || ' gap=' || gap
FROM (
  SELECT task_id,
         COUNT(*) AS cnt,
         MIN(seq) AS min_s,
         MAX(seq) AS max_s,
         (MAX(seq) - MIN(seq) + 1 - COUNT(*)) AS gap
  FROM events
  GROUP BY task_id
  HAVING gap > 0 OR min_s != 1 OR min_s IS NULL
);
")"
gap_n=0
if [[ -n "$gap_rows" ]]; then
  gap_n="$(printf '%s\n' "$gap_rows" | grep -c . || true)"
fi
if [[ "$gap_n" -gt 0 ]]; then
  echo "FAIL seq gaps: $gap_n task(s)"
  printf '%s\n' "$gap_rows" | head -20
  fail=1
else
  echo "OK   seq gaps: 0"
fi

# --- 2. empty transcripts on terminal tasks ---------------------------------
# queued/running may legitimately have zero events briefly; terminal must not.
empty_rows="$(sqlite3 "$DB" "
SELECT t.id || ' status=' || t.status || ' ' || substr(COALESCE(t.title,''),1,40)
FROM tasks t
WHERE t.status IN ('succeeded','failed','canceled','cancelled','error','degraded')
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id);
")"
empty_n=0
if [[ -n "$empty_rows" ]]; then
  empty_n="$(printf '%s\n' "$empty_rows" | grep -c . || true)"
fi
if [[ "$empty_n" -gt 0 ]]; then
  echo "FAIL empty transcripts: $empty_n terminal task(s)"
  printf '%s\n' "$empty_rows" | head -20
  fail=1
else
  echo "OK   empty transcripts: 0"
fi

# --- 3. approval execution attribution --------------------------------------
# Migration 009 allows NULL on historical rows created before attribution.
# Any approval that has a partial set (some fields set, some not) is rejected
# by the store; here we only flag total missing on recent-ish rows that look
# post-M3 (created after 2026-07-22 UTC ≈ 1753142400000 ms). If the column
# does not exist yet, skip gracefully.
has_exec_col="$(sqlite3 "$DB" "SELECT 1 FROM pragma_table_info('approvals') WHERE name='execution_id' LIMIT 1;" || true)"
if [[ "$has_exec_col" == "1" ]]; then
  cutoff_ms=1753142400000
  missing_rows="$(sqlite3 "$DB" "
  SELECT id || ' task=' || task_id || ' created=' || created_at
  FROM approvals
  WHERE created_at >= $cutoff_ms
    AND (execution_id IS NULL OR execution_id = '');
  ")"
  missing_n=0
  if [[ -n "$missing_rows" ]]; then
    missing_n="$(printf '%s\n' "$missing_rows" | grep -c . || true)"
  fi
  total_post="$(sqlite3 "$DB" "SELECT COUNT(*) FROM approvals WHERE created_at >= $cutoff_ms;")"
  if [[ "$missing_n" -gt 0 ]]; then
    echo "FAIL approval attribution: $missing_n / $total_post post-M3 missing execution_id"
    printf '%s\n' "$missing_rows" | head -20
    fail=1
  else
    echo "OK   approval attribution: 0 missing / $total_post post-M3"
  fi
else
  echo "SKIP approval attribution: execution_id column absent"
fi

# --- summary counts (informational) -----------------------------------------
sqlite3 "$DB" "
SELECT printf('info tasks=%s events=%s approvals=%s',
  (SELECT COUNT(*) FROM tasks),
  (SELECT COUNT(*) FROM events),
  (SELECT COUNT(*) FROM approvals));
"

if [[ "$fail" -ne 0 ]]; then
  echo "== RESULT: FAIL =="
  exit 1
fi
echo "== RESULT: OK =="
exit 0
