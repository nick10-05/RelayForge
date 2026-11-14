# RelayForge server. No build step: Node 24 runs the TypeScript sources directly (type stripping).
FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

# Install production dependencies for the server workspace only (cached unless manifests change).
COPY package.json package-lock.json .npmrc ./
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace=apps/server && npm cache clean --force

COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle

USER node
EXPOSE 3000
CMD ["node", "apps/server/src/server.ts"]
