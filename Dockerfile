# syntax=docker/dockerfile:1

FROM node:24.22.1-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/plugin-api/package.json packages/plugin-api/
RUN npm ci

FROM deps AS build
COPY . .
RUN MIMALLOC_ALLOW_THP=0 npm run build

FROM node:24.22.1-trixie-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/plugin-api/package.json packages/plugin-api/
RUN npm ci --omit=dev

# The server's main thread runs its TypeScript directly (Node's type stripping). The client
# and the database workers are bundled; production uses the bundles (DB_WORKERS=bundle).
# Only what runs is copied: no tests or scripts. The lockfile is part of the bundles' stamp.
FROM node:24.22.1-trixie-slim
WORKDIR /app
# The workshop's command sandbox and its tools (spec/FILES-AND-ENVIRONMENT.md §3.4): bubblewrap
# makes each command's sandbox; the rest is what commands find inside it. Debian packages,
# pinned by the base image's release. Node is the image's own. See docker/README.md for the
# seccomp and AppArmor settings the container needs for bubblewrap.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bubblewrap ca-certificates curl git python3 python3-pip python3-venv ripgrep procps xz-utils unzip less file \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
COPY --from=prod-deps /app/node_modules ./node_modules
# sharp is external to the formats bundle. npm's production optional dependencies above
# include its platform-specific native addon and libvips (no system packages/downloads).
# js-tiktoken (the tokenizer's ranks, several MB) is external to it too, from node_modules.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY packages/plugin-api/package.json packages/plugin-api/
COPY packages/plugin-api/src packages/plugin-api/src
COPY packages/server/package.json packages/server/
COPY packages/server/src packages/server/src
COPY packages/client/src packages/client/src
# The design docs, for the read-only /app-source copy commands see (spec/FILES-AND-ENVIRONMENT.md
# §3.6, files/appSource.ts).
COPY spec/*.md spec/
COPY ARCHITECTURE.md README.md ./
COPY --from=build /app/packages/client/dist packages/client/dist
COPY --from=build /app/packages/server/dist/workers packages/server/dist/workers
# The two guarded development imports must fail plainly in this image.
RUN test ! -d packages/server/src/dev && /usr/bin/setpriv --help | grep -q -- --seccomp-filter && mkdir -p /data/plugins && chown -R node:node /data
# Started as root (compose `user: "0:0"`), the entrypoint gives commands a cgroup subtree and
# runs the server as node; started as node it runs the server as it is (docker/README.md).
COPY docker/entrypoint.sh /usr/local/bin/dreamspan-entrypoint
RUN chmod 0755 /usr/local/bin/dreamspan-entrypoint && mkdir -p /run/dreamspan-cgroup && unshare --help | grep -q -- --map-users
# Names the version in /app-source's SOURCE.md (optional: --build-arg SOURCE_COMMIT=<commit>).
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --start-interval=1s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/dreamspan-entrypoint"]
CMD ["node", "packages/server/src/main.ts"]
