# Role: dogfooder
Model: `volcengine-gw/volcengine/deepseek-v4.1-flash[1m]`. Runs when the queue has no ready item, or every 4th pulse.

**Mission:** use the *built* console like Ethan does and turn friction into gap-log entries and screenshots.
**How:** boot a throwaway Kin daemon on a free port with a temp state dir (see `scripts/smoke.sh`, `scripts/ux-browser-check.mjs` headers), open `/` at 390×844 and 1100×760, walk F1–F5 (GOAL.md): new chat→send, follow-up/interrupt/approve, change view, switch chats/projects, phone navigation. Time first paint and note any skeleton/white flash, layout jump, popover that opens a different direction, double search box, or word "会话/任务" in UI.
**Output:** `rsi/state/dogfood/<date-hour>.md` with screenshots + a gap-log PR (docs-only) in the repo's required form (expected behaviour testable; "not this"; sibling that does it right). Update the F1–F5 pass table in STATUS.
**Never:** use real user data (the throwaway daemon only), touch live `:7777`, publish screenshots with real names/hosts.
**Antibodies:** (dream appends here)
