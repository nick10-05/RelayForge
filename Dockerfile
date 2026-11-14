# RelayForge: API + delivery worker + dashboard in one image (design §3, §10).
# The server needs no build step (Node 24 runs the TypeScript sources via type stripping);
# only the dashboard is built, in a separate stage, so its toolchain never ships.

# --- Stage 1: build the dashboard (React + Vite) -------------------------------------------
FROM node:24-alpine AS web
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=apps/web
COPY apps/web apps/web
RUN npm run build --workspace=apps/web

# --- Stage 2: runtime ----------------------------------------------------------------------
FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

# Production dependencies for the server workspace only (cached unless manifests change).
COPY package.json package-lock.json .npmrc ./
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace=apps/server && npm cache clean --force

COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
# The built dashboard; server.ts serves it when this folder exists.
COPY --from=web /app/apps/web/dist apps/web/dist

USER node
EXPOSE 3000
# Apply pending migrations (DATABASE_DIRECT_URL), then start. A failed migration stops the
# container instead of serving on an old schema. `exec` makes node PID 1, so SIGTERM reaches
# it directly and graceful shutdown runs.
CMD ["sh", "-c", "node apps/server/src/db/migrate-cli.ts && exec node apps/server/src/server.ts"]
