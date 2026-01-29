#!/usr/bin/env bash
set -euo pipefail

msg="${1:-}"
if [[ -z "${msg}" ]]; then
  echo "usage: ./push.sh \"commit message\"" >&2
  exit 2
fi

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "not a git repository" >&2
  exit 2
}

if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
fi

if git diff --cached --quiet; then
  echo "nothing to commit"
else
  git commit -m "${msg}"
fi

git push
