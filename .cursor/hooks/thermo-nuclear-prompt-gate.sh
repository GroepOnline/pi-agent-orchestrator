#!/usr/bin/env bash
# Fail-open: remind agents about LiveWidgets / 1k-line / registry boundaries.
set -euo pipefail

input=$(cat)
tool=$(printf '%s' "$input" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
  try {
    const j=JSON.parse(s);
    process.stdout.write(String(j.tool_name||j.toolName||j.tool||""));
  } catch { process.stdout.write(""); }
});
')

case "$tool" in
  Write|Task|MCP:*)
    cat <<'JSON'
{
  "permission": "allow",
  "agent_message": "Thermo-nuclear gate: prefer LiveWidgets fan-out over dual widget/topWidget calls; reuse AdaptiveTick + buildSnapshotHash; do not push src files past 1000 lines; keep UI refresh out of agent-registry."
}
JSON
    ;;
  *)
    echo '{}'
    ;;
esac
exit 0
