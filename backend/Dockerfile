# Deterministic build for Railway (replaces the flaky Nixpacks Metal builder).
# Small, pinned Node base; install prod deps, then run migrations + server.
FROM node:20-slim

WORKDIR /app

# Install dependencies first so this layer caches when only source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

ENV NODE_ENV=production
EXPOSE 8080

# Migrate, then start the server (same as the start:prod script).
CMD ["sh", "-c", "node src/db/migrate.js && node server.js"]
