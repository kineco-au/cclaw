#!/usr/bin/env bash
# Re-copy the vendored OpenClaw packages from reference/ (run fetch-reference.sh first).
# These are copied verbatim and must not be edited in place.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -d reference/openclaw ]] || { echo "run scripts/fetch-reference.sh first" >&2; exit 1; }

for pkg in gateway-protocol normalization-core gateway-client terminal-core; do
  src="reference/openclaw/packages/$pkg"
  [[ -d $src ]] || { echo "missing $src (add it to the sparse checkout)" >&2; exit 1; }
  rm -rf "src/vendor/$pkg"
  cp -R "$src" "src/vendor/$pkg"
  find "src/vendor/$pkg" -name '*.test.ts' -delete
  rm -rf "src/vendor/$pkg/node_modules"
  echo "vendored $pkg ($(find "src/vendor/$pkg" -name '*.ts' | wc -l | tr -d ' ') files)"
done
./scripts/record-provenance.sh
