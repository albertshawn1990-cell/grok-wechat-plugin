#!/bin/sh
# Release gate for the installed base. Runs only on Node v22.23.4.
# Default node is /exec-daemon/node. Do not point NODE at a system Node 24.
# The script archives 5c02e41 from this git repo, applies
# deploy/longpoll-repair-5c02e41.patch in a temp tree, and runs its tests.
# It does not modify the working tree or any installed state directory.
set -eu
NODE="${NODE:-/exec-daemon/node}"
if [ ! -x "$NODE" ]; then
  echo "missing node binary: $NODE" >&2
  exit 1
fi
ver=$("$NODE" -p "process.version")
if [ "$ver" != "v22.23.4" ]; then
  echo "refusing $NODE $ver; the release gate is /exec-daemon/node v22.23.4" >&2
  exit 1
fi
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
PATCH="${1:-$ROOT/deploy/longpoll-repair-5c02e41.patch}"
BASE="${BASE_COMMIT:-5c02e41b8126d6ae323dbb30565014fc16752763}"
WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
git -C "$ROOT" archive "$BASE" | tar -C "$WORK" -x
(
  cd "$WORK"
  git apply --check "$PATCH"
  git apply "$PATCH"
  "$NODE" --test server/test/longpoll.test.js
)
echo "5c02e41 backport gate passed for $BASE on $ver"
