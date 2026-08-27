#!/usr/bin/env bash
# External tmux driver for handoff demo choreography (run while asciinema records the pane).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="${HANDOFF_DEMO_SESSION:-handoff-demo-record}"
MIMO_PROVIDER="${MIMO_PROVIDER:-openrouter}"
MIMO_MODEL="${MIMO_MODEL:-xiaomi/mimo-v2.5-pro}"

send() { tmux -f /exec-daemon/tmux.portal.conf send-keys -t "$SESSION" "$@" ; }
pause() { sleep "${1:-2}"; }

send "clear" C-m
pause 1

send "printf '%s\\n' '' '================================================================' '  pi-agent-orchestrator — bounded Explore handoff demo' '  repo: github.com/GroepOnline/pi-agent-orchestrator' '================================================================' '' 'TASK: read-only Explore audits src/handoff.ts → handoff JSON' '' 'LIMITS: read/bash/grep only · max_turns 3 · ${MIMO_PROVIDER} / ${MIMO_MODEL}'" C-m
pause 15

send "export TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=3" C-m
send "pi --provider ${MIMO_PROVIDER} --model ${MIMO_MODEL} --approve -n handoff-demo --thinking off" C-m
pause 18

send "" C-m
pause 2
send "" C-m
pause 3
send C-o
pause 4

send "Use the Agent tool once: subagent_type Explore, description handoff audit, max_turns 3. Prompt: Read src/handoff.ts only (read-only). Return a fenced handoff JSON block (type handoff, status success, summary, findings with exported function names)." C-m
pause 55

send "/agents" C-m
pause 8
send "q" C-m
pause 3

send C-c
pause 3

send "npm test -- test/handoff.test.ts test/e2e-chain.test.ts" C-m
pause 18

send "npm run typecheck" C-m
pause 12

send "node scripts/handoff-demo-check.mjs" C-m
pause 10

send "echo ''; echo 'CHECK: vitest handoff/e2e-chain + typecheck + parseHandoff above'; echo 'DONE'" C-m
pause 12

send C-d
pause 2
