# Deterministic build for Railway (replaces the flaky Nixpacks Metal builder).
# Small, pinned Node base; install prod deps, then run the server.
FROM node:20-slim

WORKDIR /app

# Install dependencies first so this layer caches when only source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

ENV NODE_ENV=production
EXPOSE 8080

# Migrations have exactly ONE owner: server.js's own boot() sequence
# (Production Safety Gate, audit recommendation #1) — it acquires a
# Postgres advisory lock, runs migrations exactly once, and only starts
# accepting HTTP traffic after they succeed. This CMD must NOT also run
# `node src/db/migrate.js` first — that was a second, redundant owner
# (see also railway.json's deploy.startCommand and package.json's start
# script, both simplified the same way).
CMD ["node", "server.js"]
