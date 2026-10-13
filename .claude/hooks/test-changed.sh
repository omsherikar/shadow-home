#!/usr/bin/env bash
# Stop hook: run the tests for packages touched since the last commit.
# Exit 2 keeps Claude working on the failures; it gives up after one retry
# (stop_hook_active) so a stubborn failure can't loop forever.
set -uo pipefail

input="$(cat)"
active="$(printf '%s' "$input" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try { process.stdout.write(String(JSON.parse(s).stop_hook_active === true)); }
    catch { process.stdout.write("false"); }
  });')"
[ "$active" = "true" ] && exit 0

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$root" || exit 0
[ -x "$root/node_modules/.bin/vitest" ] || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

changed="$( { git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard; } | sort -u)"
[ -z "$changed" ] && exit 0

# Map changed files to test directories: packages/<name> or bench
dirs="$(printf '%s\n' "$changed" | awk -F/ '
  $1 == "packages" && NF > 2 { print "packages/" $2; next }
  $1 == "bench" { print "bench" }' | sort -u)"
[ -z "$dirs" ] && exit 0

failed=""
for d in $dirs; do
  [ -d "$d" ] || continue
  if ! out="$("$root/node_modules/.bin/vitest" run --passWithNoTests --dir "$d" 2>&1 | tail -60)"; then
    failed+="Tests failed in $d:\n$out\n\n"
  fi
done

if [ -n "$failed" ]; then
  printf '%b' "$failed" >&2
  printf 'Fix these before finishing. Do not edit bench/labels or weaken tests.\n' >&2
  exit 2
fi
exit 0
