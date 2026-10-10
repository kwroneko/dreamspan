# Architecture

This document describes only what is implemented. Proposals live in `spec/`. When a spec is implemented, its content moves here in the same commit (CLAUDE.md "Design docs").

**State**: Phase 0 scaffold (PLAN.md), 2026-10-10. Not yet built: the data model beyond users (DATA-MODEL.md), built-in login, the provider layer, and every chat feature.

---

## 1. Repository

npm workspaces, TypeScript, ESM throughout.

| Path | Contents |
|---|---|
| `packages/shared` | Code used by both server and client: domain schemas (`domain.ts`), the client-facing RPC contract (`api.ts`), UUIDv7 ids (`id.ts`). Imported as `@rp/shared/<file>.ts`. |
| `packages/server` | The Node server: HTTP, RPC over WebSocket, authentication, the database workers. |
| `packages/client` | The React single-page app, built with Vite and served by the server. |
| `spikes/` | Throwaway experiments with their findings (not part of the build). |
| `spec/` | Proposals and design records. |

**Runtime.** Node 24 runs the server's TypeScript directly through type stripping. There's no server build step, so the code must use erasable syntax only (`erasableSyntaxOnly`). Only the client is bundled.

**Toolchain.**
- TypeScript 6.0 (`tsc --noEmit` per package). TypeScript 7's native compiler isn't used yet, because typescript-eslint doesn't support it.
- ESLint with typescript-eslint, plus `eslint-plugin-react-hooks` including the React Compiler rules.
- Prettier.
- Vitest with `@effect/vitest`.
- `npm run check` runs all of them, and CI (`.github/workflows/ci.yml`) also builds the client.

**Dependencies are pinned to exact versions.** The owner's machine enforces a 5-day cooldown on newly published packages.

**Effect 4** (`effect` 4.0.x) is used on the server and in the client's data layer. Its RPC, HTTP, SQL, worker and reactivity modules are tagged `unstable` upstream (EFFECT.md §2), which is another reason versions are pinned exactly.

---

## 2. Server

`packages/server/src/main.ts` reads configuration from the environment and launches `ServerLive` (`server.ts`). That's one HTTP server with three parts:
- **`/rpc`:** the RPC endpoint (`AppApi` from `@rp/shared/api.ts`) over a WebSocket, JSON-serialized. Every UI action is meant to become an RPC in this group (DESIGN §7.7). Today it has `Health` and `Whoami`.
- **`/healthz`:** a plain-text liveness route, used by the Docker health check.
- **Everything else:** the client build, served as a single-page app (unknown paths return `index.html`, so deep links work).

**Configuration** (`config.ts`, environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Listen address |
| `DATA_DIR` | `./data` | Database, instance lock, later media |
| `DB_READERS` | `2` | Reader worker count (§3) |
| `DB_ALLOW_NETWORK_FS` | `false` | Override the network-filesystem refusal (§3.4) |
| `AUTH_MODE` | `single` | `single` or `proxy` (§4) |
| `AUTH_PROXY_HEADER` | `remote-user` | Identity header in proxy mode |
| `CLIENT_DIST` | `packages/client/dist` | Static files to serve |

**Event-loop monitoring** (`eventLoop.ts`). The main thread's event-loop delay is sampled continuously. `Health` reports its p99, with the sampling interval subtracted so the number is delay added by work. Anything that blocks the loop delays every live stream, so this is a budgeted metric (CLIENT-FRAMEWORK §7).

---

## 3. Database

SQLite through Node's built-in `node:sqlite` and Effect's driver (`@effect/sql-sqlite-node`); see STORAGE.md for why not Turso. Code is in `packages/server/src/db/`.

### 3.1 SQLite never runs on the main thread

`node:sqlite` is synchronous: a query blocks the thread that runs it, for its full duration. On the main thread, that would stall every WebSocket stream for as long as any query runs. So all SQL runs in worker threads:
- **One writer worker** (`writer.ts`) holds the **only read-write connection**. It runs migrations at startup, then serves `WriteOps` one at a time (`concurrency: 1`).
- **A pool of reader workers** (`reader.ts`, `DB_READERS`) each hold one **read-only** connection (opened with `readOnly`, plus `PRAGMA query_only`). They serve `ReadOps`. A pool request goes to an idle reader, so one slow query doesn't hold up the others.
- **The main thread** talks to both through typed Effect RPC over `worker_threads` (`Database.ts`: the `Writer` and `Reader` services). Errors cross the boundary typed: `StorageError { reason: busy | constraint | corrupt | other }` from the operation, `RpcClientError` if the worker itself fails.

Measured (`test/database.test.ts`): the same CPU-heavy 800 ms query blocks the main event loop for **795 ms** when run on the main thread, and **0.8 ms** when run through a reader worker. Light reads on another reader finish while it runs.

### 3.2 Storage operations are named commands

Operations (`ops.ts`) are declared as RPC groups and implemented inside the workers. **A write operation is one synchronous transaction executed entirely inside the writer.** You can't send a closure to a worker thread, so a transaction structurally can't span an `await`, a network call or an LLM request. That's the usual way transactions grow long and hold locks.

Operations that run over 25 ms are logged (`timed.ts`): a write holds the writer, so a slow one delays all writes.

### 3.3 Why `SQLITE_BUSY` can't happen inside the process

`SQLITE_BUSY` ("database is locked") means one connection needs a lock another connection holds. The setup rules out every in-process way for that to happen:

| Possible conflict | Why it can't occur |
|---|---|
| Two writers | There is exactly one read-write connection, and the writer worker serializes its operations. Within it, Effect's driver serializes statements and holds the connection for a whole transaction. |
| A writer and a reader | The database is in WAL mode, where readers never block the writer and the writer never blocks readers. Reader connections are read-only and can't take write locks. |
| A read transaction upgrading to a write | Readers can't write, and the writer opens transactions with `BEGIN IMMEDIATE`, so there's no upgrade. |
| Checkpoints | Only automatic PASSIVE checkpoints run (the writer, at commit). PASSIVE never waits on or blocks readers. `journal_size_limit` bounds the WAL file. |
| Readers opening before the file exists or is migrated | Readers are spawned only after the writer answers `Ready`, which it does only after migrations. |

Tested (`test/database.test.ts`): 500 concurrent writes and 500 concurrent reads complete with no errors, and every completed write is visible to readers.

### 3.4 Outside the process

Other processes are the remaining risk, so they're kept out:
- **Instance lock.** At startup the main thread takes an exclusive SQLite lock on `DATA_DIR/instance.lock` (`locking_mode = EXCLUSIVE` + `BEGIN EXCLUSIVE`) and holds it for the process lifetime. It's an OS file lock, so the kernel releases it if the process dies; there's no stale lock file to clean up. A second instance on the same data directory exits immediately with `InstanceLocked`, instead of contending for the database. Examples: a second `npm start`, or two containers on one volume. This is tested both in-process and from a separate process.
- **Network filesystems are refused.** NFS, CIFS and SMB (detected with `statfs` on Linux) don't provide the POSIX locks SQLite relies on, and WAL can corrupt there. `DB_ALLOW_NETWORK_FS=1` overrides this.
- **Nothing else should open the live database.** Backups will be done by the app through SQLite's backup API, not by copying the file or opening it from another tool. Not built yet.
- **Backstop.** If an outside process does take a lock anyway, the workers' 5 s `busy_timeout` applies. It blocks only that worker thread, never the main thread, and anything that still fails surfaces as `StorageError { reason: "busy" }`.

### 3.5 Connection settings

| | Writer | Readers |
|---|---|---|
| Mode | read-write, `journal_mode = WAL` | `readOnly`, `query_only = ON` |
| Durability | `synchronous = FULL`: a committed transaction survives power loss | n/a |
| Other | `foreign_keys = ON`, `temp_store = MEMORY`, 64 MiB cache, `journal_size_limit` 64 MiB | `temp_store = MEMORY`, 32 MiB cache |

### 3.6 Schema

Migrations (`migrations.ts`) run in the writer through Effect's `SqliteMigrator`. So far there's only `users`. The full data model (DATA-MODEL.md) is the next phase-0 step. Tables use `STRICT`. Ids are UUIDv7 (`@rp/shared/id.ts`), so `ORDER BY id` follows creation order.

---

## 4. Authentication

`auth.ts` implements the `Authentication` RPC middleware declared in `@rp/shared/api.ts`. It provides `CurrentUser` to every handler. Over the WebSocket, the headers are those of the upgrade request, so the identity applies to the whole connection.
- **`AUTH_MODE=single`:** every connection is the implicit local user `local`. This is for running on your own machine.
- **`AUTH_MODE=proxy`:** the user is whoever the reverse proxy names in `AUTH_PROXY_HEADER` (Authelia's `Remote-User`). A missing header is `Unauthorized`.
  - **This mode trusts the header unconditionally**, so the server must be reachable only through the proxy. That's the reason for the default bind to `127.0.0.1`; in Docker, keep the port on an internal network.

Users are created on first sight (`EnsureUser`). The first user of an instance becomes `admin`. Resolved users are cached per process, so authentication doesn't hit the writer on every connection.

Not built yet: built-in login (PLAN phase 0), and per-user ownership checks, which arrive with the first owned tables.

---

## 5. Client

`packages/client`:
- **Build and routing:** React 19 with React Compiler 1.0 (Babel plugin), Vite 8, and TanStack Router (code-based routes, `router.tsx`).
- **Server state:** comes through one `AtomRpc` client (`rpc.ts`) over the same WebSocket protocol, with reconnect on transient errors. Components read it with `@effect/atom-react`.
- **Styling** (CLIENT-FRAMEWORK §8):
  - **Semantic tokens only.** `styles.css` defines colors by role (`canvas`, `surface`, `text`, `muted`, `accent`, `danger`, …), for light and dark, with `data-theme` overrides.
  - **The default Tailwind palette is removed** (`--color-*: initial`), so a class like `bg-zinc-800` doesn't exist. Only token utilities (`bg-surface`, `text-muted`) can be written. A redesign changes token values, not components.
  - **One import path for UI components.** Feature code imports from `src/ui/`, never from Base UI directly; ESLint enforces it. Base UI carries behavior and accessibility, and `src/ui/` carries the look.
- **Development:** `npm run dev:server` and `npm run dev:client`. Vite proxies `/rpc` to the server.

---

## 6. Deployment

`Dockerfile`: a multi-stage build on `node:24-slim`.
- The client is built in one stage. The final image holds production dependencies, the server and shared sources, and the client build.
- It runs as the `node` user with `DATA_DIR=/data` as a volume, `HOST=0.0.0.0`, and a health check on `/healthz`.
- The image is about 325 MB, unoptimized so far: it installs every workspace's production dependencies.
