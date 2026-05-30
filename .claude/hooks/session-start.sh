#!/bin/bash
# NormOS web-session setup: install dependencies so the backend test suite (and
# the app) are ready to run. Idempotent and non-interactive.
set -euo pipefail

# Only needed in Claude Code on the web (the remote container).
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

# Backend (Node) — required for `npm test` and running the server.
if [ -f "$PROJECT_DIR/backend/package.json" ]; then
  echo "Installing backend dependencies..."
  ( cd "$PROJECT_DIR/backend" && npm install --no-audit --no-fund )
fi

# Mobile (Expo/React Native) — best-effort: it's a large install, and a hiccup
# here shouldn't block the session (the backend is what tests/CI exercise).
if [ -f "$PROJECT_DIR/mobile/package.json" ]; then
  echo "Installing mobile dependencies..."
  ( cd "$PROJECT_DIR/mobile" && npm install --no-audit --no-fund ) \
    || echo "warning: mobile npm install failed (non-fatal)"
fi

echo "NormOS session setup complete."
