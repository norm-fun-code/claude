#!/bin/bash
# NormOS one-command setup. Brings up the database, installs dependencies, and
# applies the schema. Safe to run more than once. Plain-language output — you do
# NOT need to be technical to run this.
set -e
cd "$(dirname "$0")"

echo ""
echo "🧠  NormOS setup"
echo "----------------"

# 1) Docker (runs the private database on your machine)
if ! command -v docker >/dev/null 2>&1; then
  echo "✗ Docker isn't installed."
  echo "  Install Docker Desktop from https://www.docker.com/products/docker-desktop"
  echo "  then run ./setup.sh again."
  exit 1
fi
echo "✓ Docker found"

# 2) Start Postgres (your data spine — stays on your machine)
echo "→ Starting the database (docker compose)…"
docker compose up -d
echo "→ Waiting for the database to be ready…"
for i in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U "${POSTGRES_USER:-normos}" >/dev/null 2>&1; then
    echo "✓ Database is up"
    break
  fi
  sleep 2
done

# 3) Backend env + dependencies
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  echo "✓ Created backend/.env — open it and paste in your API keys when ready"
fi
echo "→ Installing backend dependencies…"
npm --prefix backend install --no-audit --no-fund >/dev/null 2>&1
echo "✓ Backend dependencies installed"

# 4) Schema
echo "→ Applying the database schema…"
npm --prefix backend run migrate

# 5) Optional demo data
if [ "${1:-}" = "--demo" ]; then
  echo "→ Loading demo data so you can see it work…"
  npm --prefix backend run seed
  npm --prefix backend run analyze
fi

echo ""
echo "✓ Setup complete."
echo ""
echo "Next:"
echo "  1. Open backend/.env and add your keys (at least one of ANTHROPIC_API_KEY"
echo "     or GEMINI_API_KEY for the AI). See docs/SETUP.md for where to get each."
echo "  2. Check what's ready any time:   npm --prefix backend run doctor"
echo "  3. Start the server:              npm --prefix backend start"
echo ""
echo "Tip: run ./setup.sh --demo to load realistic sample data and see the app work"
echo "     before connecting your real accounts."
echo ""
