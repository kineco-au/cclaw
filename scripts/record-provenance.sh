#!/usr/bin/env bash
# Record the upstream commits that ported code derives from.
set -euo pipefail
cd "$(dirname "$0")/.."
{
  echo "# Ported-source provenance"
  echo
  echo "Upstream commits that ported code in this repo derives from."
  echo "Regenerate with: scripts/record-provenance.sh"
  echo
  for r in acpx openclaw; do
    d="reference/$r"
    [[ -d "$d/.git" ]] || continue
    printf '## %s\n\n' "$r"
    printf -- '- repo:   https://github.com/openclaw/%s\n' "$r"
    printf -- '- commit: %s\n' "$(git -C "$d" rev-parse HEAD)"
    printf -- '- date:   %s\n' "$(git -C "$d" log -1 --format=%cI)"
    printf -- '- cloned: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  done
} > PROVENANCE.md
echo "wrote PROVENANCE.md"
