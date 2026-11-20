# syntax=docker/dockerfile:1

FROM node:24.22.1-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/plugin-api/package.json packages/plugin-api/
# npm's download cache survives between builds (BuildKit cache mount), so a lockfile change
# downloads only the packages that changed.
RUN --mount=type=cache,id=dreamspan-npm,target=/root/.npm npm ci

FROM deps AS build
COPY . .
# The React Compiler's per-file output is kept between builds (packages/client/scripts/babelCache.ts),
# so a UI change compiles only the files that changed. The client and the database workers build
# side by side (the root `build` script runs them one after the other).
RUN --mount=type=cache,id=dreamspan-babel,target=/babel-cache export RP_BABEL_CACHE=/babel-cache MIMALLOC_ALLOW_THP=0 \
  && { npm run build -w @dreamspan/server & workers=$!; npm run build -w @dreamspan/client && wait $workers; }
# What the image runs, gathered into two trees so the final stage adds each as one layer: the
# server's, and the client's with the design docs (the read-only /app-source copy commands see,
# spec/FILES-AND-ENVIRONMENT.md §3.6, files/appSource.ts). A UI change rebuilds only the second.
# The guarded development imports must fail plainly in the image.
RUN mkdir /server /client \
  && cp -a --parents package.json package-lock.json packages/shared/package.json packages/shared/src \
    packages/plugin-api/package.json packages/plugin-api/src packages/server/package.json packages/server/src \
    packages/server/dist/workers /server \
  && cp -a --parents packages/client/src packages/client/dist spec/*.md ARCHITECTURE.md README.md /client \
  && test ! -d /server/packages/server/src/dev

FROM node:24.22.1-trixie-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/plugin-api/package.json packages/plugin-api/
RUN --mount=type=cache,id=dreamspan-npm,target=/root/.npm npm ci --omit=dev

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
RUN /usr/bin/setpriv --help | grep -q -- --seccomp-filter && mkdir -p /data/plugins && chown -R node:node /data
# Started as root (compose `user: "0:0"`), the entrypoint gives commands a cgroup subtree and
# runs the server as node; started as node it runs the server as it is (docker/README.md).
COPY docker/entrypoint.sh /usr/local/bin/dreamspan-entrypoint
RUN chmod 0755 /usr/local/bin/dreamspan-entrypoint && mkdir -p /run/dreamspan-cgroup && unshare --help | grep -q -- --map-users
# sharp is external to the formats bundle. npm's production optional dependencies above
# include its platform-specific native addon and libvips (no system packages/downloads).
# js-tiktoken (the tokenizer's ranks, several MB) is external to it too, from node_modules.
COPY --from=prod-deps /app/node_modules ./node_modules
# The app last, in two layers (the build stage's /server and /client).
COPY --from=build /server/ ./
COPY --from=build /client/ ./
# Names the version in /app-source's SOURCE.md (optional: --build-arg SOURCE_COMMIT=<commit>).
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --start-interval=1s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/dreamspan-entrypoint"]
CMD ["node", "packages/server/src/main.ts"]
