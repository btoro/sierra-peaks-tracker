#!/usr/bin/env bash
# Run the reconcile tests from the repo root so relative paths resolve.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node --test src/data/reconcile.test.ts
