# LESSONS hook

When a gate fails, a reviewer finds a major, or Ethan reports a regression:
1. Fixer fixes it. 2. Reviewer states the *rule* that would have prevented it in one line.
3. `dream` appends it to `docs/product/LESSONS.md` (format there) via a docs-only PR; a rule seen 3 times graduates to TASTE.md or the relevant `rsi/roles/*.md` card as an "antibody".
Role cards stay ≤ 60 lines: dream merges, never just appends.
