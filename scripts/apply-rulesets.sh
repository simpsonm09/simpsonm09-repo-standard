#!/usr/bin/env bash
set -euo pipefail

repo=""
apply=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) apply=1 ;;
    -h|--help|help)
      echo "usage: $0 <owner/repo> [--apply]"
      exit 0
      ;;
    *) repo="$1" ;;
  esac
  shift
done

if [[ -z "$repo" ]]; then
  echo "usage: $0 <owner/repo> [--apply]" >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

visibility="$(gh api "repos/$repo" --jq .visibility)"
if [[ "$visibility" != "public" ]]; then
  echo "$repo is $visibility. Rulesets stay unenforced until the repository is public."
  for file in "$here"/rulesets/*.json; do
    echo "  would apply $(basename "$file")"
  done
  exit 0
fi

# Resolve only a selectable access level. Legacy and unknown values must be
# migrated explicitly; never upgrade them to full during application.
short="${repo##*/}"
level="$(node "$here/scripts/agent-access.mjs" "$short")"

for file in "$here"/rulesets/*.json; do
  ruleset_name="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$file")"
  payload="$(mktemp)"
  node "$here/scripts/ruleset-payload.mjs" "$file" --level "$level" --repo "$repo" >"$payload"
  ids="$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name==\"$ruleset_name\") | .id")"
  count="$(printf '%s\n' "$ids" | awk 'NF { count += 1 } END { print count + 0 }')"
  if [[ "$count" -gt 1 ]]; then rm -f "$payload"; echo "multiple $ruleset_name rulesets found" >&2; exit 1; fi
  id="$ids"
  if [[ "$apply" == "1" ]]; then
    if [[ -n "$id" ]]; then
      gh api -X PUT "repos/$repo/rulesets/$id" --input "$payload" >/dev/null
      echo "updated $ruleset_name"
    else
      gh api -X POST "repos/$repo/rulesets" --input "$payload" >/dev/null
      echo "created $ruleset_name"
    fi
  else
    if [[ -n "$id" ]]; then echo "would update $ruleset_name"; else echo "would create $ruleset_name"; fi
  fi
  rm -f "$payload"
done
