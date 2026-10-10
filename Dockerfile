# --- Build stage: install deps, build backend only ---------------------------
# The legacy React frontend is not built: in arena mode the dashboard
# (arena-dashboard.html) is the home page. Without an arena config the image
# answers "/" with {"message":"Frontend not built yet"}.
FROM node:22-slim AS build

# Native modules (better-sqlite3, nodejs-polars) may need to compile if no
# prebuilt binary matches this platform/ABI.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@8.15.5

WORKDIR /app

# Copy manifests first so dependency installation is cached independently
# of source changes. frontend/package.json is only copied so the workspace
# lockfile stays consistent; its dependencies are not installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/

RUN pnpm install --frozen-lockfile --filter ./backend

# Copy sources and build
COPY backend/ ./backend/

RUN pnpm run build:backend

# --- Runtime stage -----------------------------------------------------------
FROM node:22-slim AS runtime

WORKDIR /app

# pnpm links packages relatively into node_modules/.pnpm, so the workspace root
# and the backend's node_modules must be copied together to stay resolvable.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/package.json ./backend/
COPY --from=build /app/backend/dist ./backend/dist
# Arena dashboard is read from the backend root at runtime
COPY --from=build /app/backend/arena-dashboard.html ./backend/

WORKDIR /app/backend

ENV NODE_ENV=production
# SQLite file location; override to point at a mounted volume for persistence.
ENV DATABASE_PATH=/app/data/data.db
# Arena config is mounted at runtime (see deploy/docker-compose.yml)
ENV ARENA_CONFIG=/app/config/arena.config.json
RUN mkdir -p /app/data /app/config

EXPOSE 5611

CMD ["node", "dist/index.js"]
