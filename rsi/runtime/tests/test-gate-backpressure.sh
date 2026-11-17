#!/bin/bash
# Hermetic checks for the 2026-11-16 leaf-UI test selector and open-PR backpressure switch.
# No network, no git remote, no model calls.
set -u
H="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

ok() { echo "PASS $*"; }
bad() { echo "FAIL $*" >&2; exit 1; }

WT="$T/wt"
mkdir -p \
  "$WT/ui/src/components/chat" \
  "$WT/ui/src/components/ui" \
  "$WT/ui/src/components/layout" \
  "$WT/ui/src/design" \
  "$WT/ui/src/i18n/locales" \
  "$WT/ui/src/pages" \
  "$WT/ui/src/lib" \
  "$WT/ui/src/api" \
  "$WT/ui/src/store" \
  "$WT/ui/src/hooks" \
  "$WT/ui/src/test"
cat > "$WT/ui/src/components/chat/CwdPicker.tsx" <<'EOF'
export default function CwdPicker() { return null; }
EOF
cat > "$WT/ui/src/components/chat/CwdPicker.dom.test.tsx" <<'EOF'
import CwdPicker from "./CwdPicker";
void CwdPicker;
EOF
cat > "$WT/ui/src/pages/ChatPage.tsx" <<'EOF'
import CwdPicker from "../components/chat/CwdPicker";
export default function ChatPage() { return CwdPicker(); }
EOF
cat > "$WT/ui/src/pages/ChatPage.dom.test.tsx" <<'EOF'
import ChatPage from "./ChatPage";
void ChatPage;
EOF
cat > "$WT/ui/src/pages/composerWiring.test.ts" <<'EOF'
const src = "src/components/chat/CwdPicker.tsx";
void src;
EOF
cat > "$WT/ui/src/design/tokens.test.ts" <<'EOF'
export {};
EOF
cat > "$WT/ui/src/components/layout/PanelSurface.test.ts" <<'EOF'
export {};
EOF
cat > "$WT/ui/src/components/layout/zen.test.ts" <<'EOF'
export {};
EOF
cat > "$WT/ui/src/design/mobileLayout.test.ts" <<'EOF'
export {};
EOF
cat > "$WT/ui/src/i18n/locales/en.ts" <<'EOF'
export default {};
EOF
cat > "$WT/ui/src/i18n/locales.test.ts" <<'EOF'
export {};
EOF
cat > "$WT/ui/src/i18n/documentLang.dom.test.ts" <<'EOF'
export {};
EOF
cat > "$WT/ui/src/components/ui/Button.tsx" <<'EOF'
export default function Button() { return null; }
EOF
cat > "$WT/ui/src/components/layout/AppShell.tsx" <<'EOF'
export default function AppShell() { return null; }
EOF
cat > "$WT/ui/src/design/tokens.ts" <<'EOF'
export {};
EOF
cat > "$WT/ui/src/lib/util.ts" <<'EOF'
export {};
EOF
cat > "$WT/ui/src/api/client.ts" <<'EOF'
export {};
EOF
cat > "$WT/ui/src/store/app.ts" <<'EOF'
export {};
EOF
cat > "$WT/ui/src/hooks/useX.ts" <<'EOF'
export {};
EOF
cat > "$WT/ui/src/test/setup.ts" <<'EOF'
export {};
EOF
cat > "$WT/ui/src/index.css" <<'EOF'
/* shared css */
EOF
cat > "$WT/ui/src/i18n/react.ts" <<'EOF'
export {};
EOF

# 1. Leaf UI + locale -> exit 0, includes direct/transitive reverse tests + wiring + always-tests + locales tests.
OUT1="$(printf 'ui/src/components/chat/CwdPicker.tsx\nui/src/i18n/locales/en.ts\n' | python3 "$H/related-ui-tests.py" --worktree "$WT" --changed-from-stdin)"
RC1=$?
[ $RC1 -eq 0 ] || bad "leaf-ui exit $RC1 != 0"
echo "$OUT1" | grep -qx 'src/components/chat/CwdPicker.dom.test.tsx' || bad "missing CwdPicker.dom.test.tsx"
echo "$OUT1" | grep -qx 'src/pages/ChatPage.dom.test.tsx' || bad "missing transitive ChatPage.dom.test.tsx"
echo "$OUT1" | grep -qx 'src/pages/composerWiring.test.ts' || bad "missing composerWiring.test.ts"
echo "$OUT1" | grep -qx 'src/design/tokens.test.ts' || bad "missing tokens.test.ts"
echo "$OUT1" | grep -qx 'src/components/layout/PanelSurface.test.ts' || bad "missing PanelSurface.test.ts"
echo "$OUT1" | grep -qx 'src/components/layout/zen.test.ts' || bad "missing zen.test.ts"
echo "$OUT1" | grep -qx 'src/design/mobileLayout.test.ts' || bad "missing mobileLayout.test.ts"
echo "$OUT1" | grep -qx 'src/i18n/locales.test.ts' || bad "missing locales.test.ts"
echo "$OUT1" | grep -qx 'src/i18n/documentLang.dom.test.ts' || bad "missing documentLang.dom.test.ts"
ok leaf-ui-and-locales

# 2. Shared UI paths (all 8 SHARED_DIRS + representative SHARED_FILES) -> exit 1 (full suite required).
for sp in \
  ui/src/components/ui/Button.tsx \
  ui/src/components/layout/AppShell.tsx \
  ui/src/design/tokens.ts \
  ui/src/lib/util.ts \
  ui/src/api/client.ts \
  ui/src/store/app.ts \
  ui/src/hooks/useX.ts \
  ui/src/test/setup.ts \
  ui/src/index.css \
  ui/src/i18n/react.ts; do
  if printf '%s\n' "$sp" | python3 "$H/related-ui-tests.py" --worktree "$WT" --changed-from-stdin >/dev/null 2>&1; then
    bad "shared path $sp unexpectedly returned 0"
  fi
done
ok shared-ui-falls-back-to-full

# 3. RSI_GATE_VITEST=full forces exit 1 even on leaf paths.
if printf 'ui/src/components/chat/CwdPicker.tsx\n' | RSI_GATE_VITEST=full python3 "$H/related-ui-tests.py" --worktree "$WT" --changed-from-stdin >/dev/null 2>&1; then
  bad "RSI_GATE_VITEST=full did not force full suite"
fi
ok env-override-full

# 4. Backpressure threshold tests (seam + fake gh JSON filtering).
(
  . "$H/common.sh"
  RSI_MAX_OPEN_PRS=10 RSI_OPEN_PR_COUNT=10 rsi_open_pr_backpressure || exit 1
  if RSI_MAX_OPEN_PRS=10 RSI_OPEN_PR_COUNT=9 rsi_open_pr_backpressure; then exit 1; fi
  if RSI_MAX_OPEN_PRS=0 RSI_OPEN_PR_COUNT=20 rsi_open_pr_backpressure; then exit 1; fi
  exit 0
) || bad open-pr-count-threshold
ok open-pr-count-threshold

mkdir -p "$T/state/merge"
touch "$T/state/merge/blocked-pr.blocked"
cat > "$T/fake-gh" <<'EOF'
#!/bin/bash
cat <<'JSON'
[
  {"number":1,"headRefName":"rsi/a1","isDraft":false,"labels":[]},
  {"number":2,"headRefName":"rsi/a2","isDraft":false,"labels":[]},
  {"number":3,"headRefName":"rsi/blocked-pr","isDraft":false,"labels":[]},
  {"number":4,"headRefName":"rsi/draft-pr","isDraft":true,"labels":[]},
  {"number":5,"headRefName":"rsi/held-pr","isDraft":false,"labels":[{"name":"needs-ceo"}]},
  {"number":6,"headRefName":"feat/other","isDraft":false,"labels":[]}
]
JSON
EOF
chmod +x "$T/fake-gh"
(
  . "$H/common.sh"
  unset RSI_OPEN_PR_COUNT
  GH="$T/fake-gh"
  STATE="$T/state"
  RSI_MAX_OPEN_PRS=2
  rsi_open_pr_backpressure || exit 1
  [ "$RSI_OPEN_RSI_PRS" = 2 ] && [ "$RSI_OPEN_TOTAL_PRS" = 6 ] || exit 1
  RSI_MAX_OPEN_PRS=3
  if rsi_open_pr_backpressure; then exit 1; fi

  # Disabled backpressure must not invoke gh when RSI_OPEN_PR_COUNT is unset.
  cat > "$T/fail-if-called-gh" <<'GHEOF'
#!/bin/bash
touch "$T_CALLED"
exit 1
GHEOF
  chmod +x "$T/fail-if-called-gh"
  T_CALLED="$T/gh-was-called" GH="$T/fail-if-called-gh" RSI_MAX_OPEN_PRS=0 \
    bash -c '. "'"$H"'/common.sh"; unset RSI_OPEN_PR_COUNT; ! rsi_open_pr_backpressure' || exit 1
  [ ! -e "$T/gh-was-called" ] || exit 1

  # Failed gh query prints "-1 -1" once (single line).
  CNT_OUT="$(GH=/usr/bin/false rsi_open_pr_counts 2>/dev/null || true)"
  [ "$(printf '%s\n' "$CNT_OUT" | wc -l | tr -d ' ')" = 1 ] || exit 1
  [ "$CNT_OUT" = "-1 -1" ] || exit 1
  exit 0
) || bad fake-gh-filter
ok fake-gh-filter

# with_timeout must reap its watchdog sleep when the wrapped command exits early.
(
  . "$H/common.sh"
  mkdir -p "$T/sleep-bin"
  cat > "$T/sleep-bin/sleep" <<SEOF
#!/bin/bash
echo \$\$ > "$T/sleep.pid"
exec /bin/sleep "\$@"
SEOF
  chmod +x "$T/sleep-bin/sleep"
  PATH="$T/sleep-bin:$PATH" with_timeout 60 sh -c 'i=0; while [ ! -s "'"$T"'/sleep.pid" ] && [ $i -lt 50 ]; do /bin/sleep 0.02; i=$((i+1)); done' || exit 1
  [ -s "$T/sleep.pid" ] || exit 1
  SPID="$(cat "$T/sleep.pid")"
  i=0
  while kill -0 "$SPID" 2>/dev/null && [ $i -lt 50 ]; do /bin/sleep 0.02; i=$((i+1)); done
  ! kill -0 "$SPID" 2>/dev/null || exit 1
  exit 0
) || bad with-timeout-reaps-sleep
ok with-timeout-reaps-sleep

echo ALL-PASS
