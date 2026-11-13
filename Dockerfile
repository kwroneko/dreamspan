# syntax=docker/dockerfile:1

FROM node:24.22.1-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:24.22.1-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --omit=dev

# The server's main thread runs its TypeScript directly (Node's type stripping). The client
# and the database workers are bundled; production uses the bundles (DB_WORKERS=bundle).
# Only what runs is copied: no tests or scripts. The lockfile is part of the bundles' stamp.
FROM node:24.22.1-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
COPY --from=prod-deps /app/node_modules ./node_modules
# sharp is external to the formats bundle. npm's production optional dependencies above
# include its platform-specific native addon and libvips (no system packages/downloads).
# js-tiktoken (the tokenizer's ranks, several MB) is external to it too, from node_modules.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY packages/server/package.json packages/server/
COPY packages/server/src packages/server/src
COPY --from=build /app/packages/client/dist packages/client/dist
COPY --from=build /app/packages/server/dist/workers packages/server/dist/workers
# The two guarded development imports must fail plainly in this image.
RUN test ! -d packages/server/src/dev && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --start-interval=1s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/src/main.ts"]
