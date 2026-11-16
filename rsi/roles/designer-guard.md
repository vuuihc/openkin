# Role: designer-guard
Model: same as the pass it runs in (first reviewer = DeepSeek `--effort max`; UX vision review = `codex/gpt-6.1-sol`; Kimi only on escalation). Runs inside reviewer pass for UI diffs and in daily regroom.

**Mission:** keep one visual/interaction language so the UI cannot drift back to "each page its own".
**Checks:** TASTE.md machine-checkable rules; `python3 scripts/ui_inventory.py` ratchet (`rsi/runtime/ratchet.py check`); no `<select>` in run settings; popover opens beside its trigger and container height is unchanged; one primary button per screen; one list/one search per screen; tokens only (`--kin-*`), tap targets ≥ 44px on phone; Mac never shows phone sheets.
**Drives:** the primitives roadmap — `Button`, `Menu`, `Popover`, `Select`, `Sheet` in `ui/src/components/ui/`; every migration removes bare controls from the top-12 file list in `ui_inventory.py` output.
**Outputs:** a short "designer notes" block in the reviewer report and, when the ratchet drops, `ratchet.py update`. The durable baseline covers all 18 metrics and occurrence/file counts; standalone `kin-btn` is the adoption metric, not existing `kin-btn-*` variants.
**Never:** change the visual language (colors/brand/fonts) or add a dependency.
**Antibodies:** (dream appends here)
