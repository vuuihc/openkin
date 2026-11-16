# UX-RUBRIC — how a UI change is judged by what the user sees

Used by the merge lane's UX gate (`runtime/ux-gate.sh`, role `ux-reviewer`) on every PR that touches `ui/src/**/*.tsx|css`. Scores are integers 1–5 per axis.
**3 = acceptable (nothing a daily user trips over), 5 = as good as T3 Code at the same job.** Reject (sendback) when any axis < 3, or the mean < 3.5, or the journey walk has a hard failure (blank page, horizontal overflow, page error, 5xx). The threshold is recomputed from the numbers by the script, not trusted from the model.

| Axis | Ask, on the screenshots of the journeys the PR touches | 1 | 3 | 5 |
|---|---|---|---|---|
| **Clarity** | In 3 seconds: where am I, what is running or waiting for me, what is the one next action? One primary button; status in words, not colour alone; no duplicate titles/lists/search boxes. | can't tell what to do; two competing primaries; mystery icons | structure readable; minor ambiguity | zero-thought; needs-you obvious |
| **Density** | Is the space used for the job? Lists show enough rows; detail not a narrow strip; nothing cramped or lost in empty space; Mac not a stretched phone; phone not a squeezed desktop; truncation never hides the key word. | wasted/cramped, clipped controls | fine at the default size, one awkward spot | tuned for 390/1100/1280, adapts when the diff/file panel opens |
| **Consistency** | Same action, same look and place on every screen/surface; matches the Kin tokens and the approved prototype; pickers open the same way everywhere (Mac anchored popover, phone second-layer sheet); 44 px touch targets on phone. | new one-off patterns, raw controls, colours off-token | mostly the shared controls | indistinguishable from the rest of the product |
| **Feedback / latency** | Does every action show an immediate response? Skeleton only on a block's first load, never a blank page or whole-page skeleton; optimistic send; offline keeps content with a banner; errors say what to do; running work visibly alive; focus/scroll preserved when switching areas. | blank flashes, silent failures, content vanishes | most states covered | every state (empty, loading, error, offline, running, waiting) is deliberate |
| **Keyboard / a11y** | Reachable by Tab in a sensible order, visible focus, Esc closes exactly one layer, shortcuts belong to the visible layer, labels on icon buttons, IME-safe Enter, reduced motion honoured, aria-current/selected for state. | traps, unlabeled icon buttons, invisible focus | usable without a mouse | fast keyboard flow (⌘K, ⌘1–4, ⌘N, j/k) |

## How the reviewer works
1. Open the walk screenshots (`state/shots/<slug>/journeys/*.png`) with the Read tool — they are images and viewable — plus the `.aria.txt` tree and `walk.json` lint. Compare with the BEFORE shots (`state/shots/baseline/`) and the approved prototype (`state/ux-proto/final/`). The product should converge on the prototype, not just not-break the old UI.
2. Score only what the PR can affect, but fail on any regression visible anywhere in the walk.
3. If the daemon was empty (`seed.log`), say what cannot be verified instead of guessing; empty/loading structure still counts.
4. Findings first (screen name → problem → journey affected → fix), then the two final lines:
   `UX_SCORES: clarity=N density=N consistency=N feedback=N keyboard=N`
   `UX_VERDICT: PASS|FAIL`
