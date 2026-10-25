# RSDP Poker Live! production image: the game server plus the built web app.
# Data goes to Postgres when DATABASE_URL is set, otherwise to PGlite under
# PGLITE_DIR (mount a volume at /data to keep it).

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/tournament/package.json packages/tournament/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 PGLITE_DIR=/data/pglite
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
WORKDIR /app/apps/server
# node directly (not npm) so SIGTERM reaches the server and it saves before exiting.
CMD ["node", "--import", "tsx", "src/index.ts"]
