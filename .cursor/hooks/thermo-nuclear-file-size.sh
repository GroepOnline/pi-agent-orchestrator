#!/usr/bin/env bash
# Fail-open advisory: warn when an edited source file is near/over 1000 lines.
set -euo pipefail

input=$(cat)
path=$(printf '%s' "$input" | node -e '
let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
  try {
    const j=JSON.parse(s);
    const p=j.file_path||j.path||j.file||"";
    process.stdout.write(String(p));
  } catch { process.stdout.write(""); }
});
')

if [[ -z "$path" || ! -f "$path" ]]; then
  echo '{}'
  exit 0
fi

# Only gate TypeScript/JavaScript sources under src/
case "$path" in
  src/*|./src/*) ;;
  *) echo '{}'; exit 0 ;;
esac

lines=$(wc -l < "$path" | tr -d ' ')
if [[ "$lines" -ge 1000 ]]; then
  node -e '
const lines=process.argv[1];
const path=process.argv[2];
console.log(JSON.stringify({
  additional_context: `Thermo-nuclear file-size gate: ${path} is ${lines} lines (>=1000). Prefer extracting helpers/modules before growing this file further.`
}));
' "$lines" "$path"
  exit 0
fi

if [[ "$lines" -ge 900 ]]; then
  node -e '
const lines=process.argv[1];
const path=process.argv[2];
console.log(JSON.stringify({
  additional_context: `Thermo-nuclear file-size advisory: ${path} is ${lines} lines (approaching 1000). Keep new logic decomposable.`
}));
' "$lines" "$path"
  exit 0
fi

echo '{}'
exit 0
