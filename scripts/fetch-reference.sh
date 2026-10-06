#!/usr/bin/env bash
# Clone the upstream sources cclaw ports from, into the gitignored reference/ dir.
# Read-only: nothing here is imported by shipped code.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p reference

if [[ ! -d reference/acpx/.git ]]; then
  git clone --depth 1 https://github.com/openclaw/acpx.git reference/acpx
fi

# Blobless + sparse: 20 MB instead of the repo's 7.6 GB of history.
if [[ ! -d reference/openclaw/.git ]]; then
  git clone --depth 1 --filter=blob:none --sparse \
    https://github.com/openclaw/openclaw.git reference/openclaw
  git -C reference/openclaw sparse-checkout set \
    src/tui packages/terminal-core packages/acp-core src/acp docs/cli
fi

du -sh reference/acpx reference/openclaw
