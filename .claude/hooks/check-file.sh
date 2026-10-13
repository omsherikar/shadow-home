#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): lint the changed file and type-check its package.
# Exit 2 sends the errors back to Claude. Skips quietly when tooling isn't installed yet.
set -uo pipefail

input="$(cat)"
file="$(printf '%s' "$input" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try { const j = JSON.parse(s); process.stdout.write((j.tool_input && j.tool_input.file_path) || ""); }
    catch { process.stdout.write(""); }
  });')"

[ -z "$file" ] && exit 0
[ -f "$file" ] || exit 0
case "$file" in
  *.ts|*.tsx|*.js|*.mjs|*.cjs|*.json) ;;
  *) exit 0 ;;
esac
case "$file" in
  */node_modules/*|*/.next/*|*/dist/*|*/bench/reports/*) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
errors=""

# 1. Biome on the single file
if [ -x "$root/node_modules/.bin/biome" ]; then
  if ! out="$("$root/node_modules/.bin/biome" check --no-errors-on-unmatched "$file" 2>&1)"; then
    errors+="Biome found problems in $file:\n$out\n\n"
  fi
fi

# 2. Type-check the nearest package that has a tsconfig.json (TypeScript files only)
case "$file" in
  *.ts|*.tsx)
    dir="$(dirname "$file")"
    while [ "$dir" != "/" ] && [ "$dir" != "$root" ] && [ ! -f "$dir/tsconfig.json" ]; do
      dir="$(dirname "$dir")"
    done
    if [ -f "$dir/tsconfig.json" ] && [ -x "$root/node_modules/.bin/tsc" ]; then
      if ! out="$(cd "$dir" && "$root/node_modules/.bin/tsc" --noEmit -p tsconfig.json 2>&1 | head -40)"; then
        errors+="TypeScript errors in $dir:\n$out\n"
      elif printf '%s' "$out" | grep -q "error TS"; then
        errors+="TypeScript errors in $dir:\n$out\n"
      fi
    fi
    ;;
esac

if [ -n "$errors" ]; then
  printf '%b' "$errors" >&2
  exit 2
fi
exit 0
