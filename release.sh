#!/usr/bin/env bash
set -euo pipefail

version="${1:-}"
if [[ -z "${version}" ]]; then
  echo "usage: ./release.sh \"vX.Y.Z\"  (or X.Y.Z)" >&2
  exit 2
fi

tag="${version}"
if [[ "${tag}" != v* ]]; then
  tag="v${tag}"
fi

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "not a git repository" >&2
  exit 2
}

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is not clean; commit or stash first" >&2
  exit 2
fi

git fetch --tags origin >/dev/null 2>&1 || true

if git rev-parse "${tag}" >/dev/null 2>&1; then
  echo "tag already exists: ${tag}" >&2
  exit 2
fi

git tag -a "${tag}" -m "${tag}"
git push origin "${tag}"
