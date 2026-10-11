# Architecture

This document describes only what is implemented. Proposals live in `spec/`. When a spec is implemented, its content moves here in the same commit (CLAUDE.md "Design docs").

**State**: Phase 0 (PLAN.md), 2026-10-11. Built: the scaffold, the full schema, the message-graph operations, the library operations, drafts, the recycle bin, the provider layer (§6), exposure safety and built-in login (§4). Not yet built: any UI beyond a status page (the connection settings and the login page included), and every chat feature.

---

## 1. Repository

npm workspaces, TypeScript, ESM throughout.

| Path | Contents |
|---|---|
| `packages/shared` | Code used by both server and client: the client-facing RPC contract (`api.ts`), its errors (`errors.ts`), and the domain schemas and pure logic (users, chats and state, library and merge, card and lorebook documents, drafts, the bin, providers and usage), plus UUIDv7 ids (`id.ts`). Imported as `@rp/shared/<file>.ts`. |
| `packages/server` | The Node server: HTTP, RPC over WebSocket, authentication, the database workers. |
| `packages/client` | The React single-page app, built with Vite and served by the server. |
| `spikes/` | Throwaway experiments with their findings (not part of the build). |
| `spec/` | Proposals and design records. |

**Runtime.** Node 24 runs the server's TypeScript directly through type stripping, so the code must use erasable syntax only (`erasableSyntaxOnly`). The client is bundled, and so are the database workers for production (§3.6). The server's main thread runs from source.

Bun was measured as an alternative (2026-10-10) and not adopted. On this server it gave the same RPC latency and throughput and 13% less memory, but it has no `node:sqlite`, stubs the event-loop delay API, and Effect's Node HTTP layer errors under it. Bundling the workers saves far more memory on Node.

**Toolchain.**
- TypeScript 6.0 (`tsc --noEmit` per package). TypeScript 7's native compiler isn't used yet, because typescript-eslint doesn't support it.
- ESLint with typescript-eslint, plus `eslint-plugin-react-hooks` including the React Compiler rules.
- Prettier.
- knip: fails on unused files, exports and dependencies, the shared package's exports included (`knip.jsonc` says why each exception exists).
- Vitest with `@effect/vitest`.
- `npm run check` runs all of them. CI (`.github/workflows/ci.yml`) also builds the client and the workers, and builds the Docker image (without pushing it). It checks that the image refuses to start without exposure settings, and runs it with an admin password until its health check passes.
- `npm run size` prints one line of sizes: code lines in sources and in tests, comment lines, and doc lines (`scripts/size.ts`, tracked files outside `spikes/`). CI prints it too, so growth shows per commit.

**Dependencies are pinned to exact versions.** The owner's machine enforces a 5-day cooldown on newly published packages.

**Effect 4** (`effect` 4.0.x) is used on the server and in the client's data layer. Its RPC, HTTP, SQL, worker and reactivity modules are tagged `unstable` upstream (EFFECT.md §2), which is another reason versions are pinned exactly.

---

## 2. Server

`packages/server/src/main.ts` reads configuration from the environment and launches `ServerLive` (`server.ts`). That's one HTTP server with three parts:
- **`/rpc`:** the RPC endpoint (`AppApi` from `@rp/shared/api.ts`) over a WebSocket, JSON-serialized. Every UI action is meant to become an RPC in this group (DESIGN §7.7). Today it has `Health`, `Whoami`, the account RPCs (§4), and the provider-kind, connection, credential, model, network-settings and usage RPCs (§6).
- **`/healthz`:** a plain-text liveness route, used by the Docker health check.
- **Everything else:** the client build, served as a single-page app (unknown paths return `index.html`, so deep links work).

**Configuration** (`config.ts`, environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Listen address |
| `DATA_DIR` | `./data` | Database, instance lock, later media |
| `DB_READERS` | `2` | Reader worker count, at least 1 (§3) |
| `DB_ALLOW_NETWORK_FS` | `false` | Override the refusal of filesystems not known to be local (§3.4) |
| `DB_WORKERS` | `bundle` in production, else `source` | Worker entry points (§3.6) |
| `AUTH_MODE` | `single` | `single` or `proxy` (§4) |
| `AUTH_PROXY_HEADER` | `remote-user` | Identity header in proxy mode |
| `ALLOWED_IPS` | unset | IPs and CIDR ranges besides loopback that may connect in single mode (§4) |
| `TRUSTED_PROXIES` | unset (loopback) | The only addresses that may connect in proxy mode (§4) |
| `ALLOW_INSECURE_EXPOSURE` | `false` | Serve every address without protection (§4) |
| `LOOPBACK_REQUIRES_LOGIN` | `true` | Once an account has a password, loopback needs a login too (§4) |
| `ADMIN_PASSWORD_FILE`, `ADMIN_PASSWORD`, `ADMIN_USER` | unset | The first admin's password, for headless servers. Applies only while no enabled admin has one (§4) |
| `PUBLIC_ORIGINS` | unset | Origins the app is served at by name, e.g. `https://rp.example.com` (§4) |
| `CLIENT_DIST` | `packages/client/dist` | Static files to serve |
| `SECRET_KEY`, `SECRET_KEY_FILE` | unset | The server secret (below). Generated into `DATA_DIR/secret.key` when neither is set |
| `KEY_HOST_BINDING` | `true` | Keys go only to the hosts their credential was entered for (§3.12). A security setting, so it's set only here, never from inside the app |

**Secrets** (`secrets.ts`). Connection secrets (API keys, header values, proxy URLs) are encrypted at rest with AES-256-GCM, under a key derived (HKDF-SHA256) from the server secret.
- **Bound to where they belong.** Each ciphertext is bound to what it belongs to (`credential:<id>:key`, `connection:<id>:headers`, `connection:<id>:proxy_url`), so it doesn't decrypt anywhere else.
- **Format:** a version byte, a fresh 12-byte nonce, the tag, then the ciphertext.
- **Only the main thread holds the secret.** The database workers only ever see ciphertext.
- **The secret is automatic** (owner, 2026-10-10: setup must be trivial). It comes from `SECRET_KEY` or `SECRET_KEY_FILE` (a Docker secret) when set. Otherwise it's generated at first start into `DATA_DIR/secret.key`, mode 0600 (tightened if a restore loosened it), and never overwritten.
- **Honest scope:** with the key file next to the database, encryption protects a leaked database or backup on its own, not a copy of the whole data directory.
- **A changed secret** makes stored secrets unreadable (`SecretUnreadable`), which surfaces as "enter the key again". It never surfaces as a crash.

**Outgoing requests** (`net/`, spec/PROVIDERS.md §6.2). Every request the server sends goes through the `Network` service. ESLint forbids the global `fetch`, `undici` and `node:https` anywhere else in `packages/server/src`, so nothing can skip the proxy by accident.
- **The instance settings** are an optional proxy (HTTP, HTTPS or SOCKS5) and a bypass list of hostnames, `*.domain` suffixes, IPs and CIDR ranges. Local ranges are on the bypass list by default (loopback, RFC 1918, link-local, CGNAT, IPv6 ULA and link-local). A hostname bypasses by address only if every address it resolves to is on the list, and its connection is then pinned to those addresses (`bypassOnlyLookup`), so a second lookup can't land elsewhere. A host the admin listed by name or suffix goes direct whatever it resolves to, unpinned. With `forceProxy`, non-admins can't send direct or through their own proxy (§6).
  - They're stored in `app_settings`, with the proxy URL encrypted, since it can hold credentials.
  - The proxy is only ever shown as scheme, host and port.
  - Unusable settings are refused with `InvalidNetworkSettings`.
- **Each connection overrides the route** with `inherit`, `direct` or its own proxy. The route for a request (`route.ts`, pure and unit-tested):
  - the override wins
  - otherwise a target on the bypass list goes direct, matched by name, by literal IP, or by its resolved addresses (IPv4-mapped IPv6 counts as IPv4)
  - otherwise the instance proxy is used
  - a failed DNS lookup leaves the target to the proxy
- **The route is reported:** `fetchFor(override, onRoute)` gives a `fetch` for one connection's requests and reports each request's route, e.g. "direct: 192.168.1.20 is in the bypass list" or "via proxy socks5://vpn:1080".
- **One undici dispatcher per route** (`Agent`, `ProxyAgent`, `Socks5ProxyAgent`), reused across requests and closed with the layer. undici marks its SOCKS5 support experimental. SOCKS5 sends the hostname to the proxy, so DNS for proxied targets resolves remotely.
- `test/network.test.ts` runs real requests through a local HTTP proxy (CONNECT and absolute-URI forwarding) and a SOCKS5 proxy with credentials (`test/support/proxies.ts`), counting the tunnels.
- **pi-ai:** its Chat Completions, Responses and Anthropic adapters take our `fetch`. Its Google adapter rejects a custom `fetch`, and only its Bedrock and Codex adapters, which we don't use, read `HTTP_PROXY`.

**Event-loop monitoring** (`eventLoop.ts`). A 10 ms timer measures how late each tick runs, into one-second buckets. `Health` reports the last minute: the longest single delay (`eventLoopMaxMs`) and the worst one-second p99 (`eventLoopP99Ms`). Reading them resets nothing, so callers don't affect each other. Node's `monitorEventLoopDelay` isn't used: it discards the first interval after a reset, so a 300 ms stall starting just after a bucket change showed as 0.3 ms. Tested: a single 300 ms block shows in the max, including 2, 10 and 25 ms after a bucket change, and still does after another read and a bucket change. Anything that blocks the loop delays every live stream, so this is a budgeted metric (CLIENT-FRAMEWORK §7).

---

## 3. Database

SQLite through Node's built-in `node:sqlite` and Effect's driver (`@effect/sql-sqlite-node`); see STORAGE.md for why not Turso. Code is in `packages/server/src/db/`.

### 3.1 SQLite never runs on the main thread

`node:sqlite` is synchronous: a query blocks the thread that runs it, for its full duration. On the main thread, that would stall every WebSocket stream for as long as any query runs. So all SQL runs in worker threads:
- **One writer worker** (`writer.ts`) holds the **only read-write connection**. It runs migrations at startup, then serves `WriteOps` one at a time (`concurrency: 1`). A crashed writer is respawned every second by Effect's worker pool, which logs nothing, so `writerProtocol` logs it on the main thread: the first stop with its cause, then failed restarts as a count (after 1, 2, 4, 8, … of them), then the recovery (`test/readerPool.test.ts`).
- **A pool of reader workers** (`reader.ts`, `DB_READERS`) each hold one **read-only** connection (opened with `readOnly`, plus `PRAGMA query_only`). They serve `ReadOps`. A request goes to an idle reader, so one slow query doesn't hold up the others.
- **The main thread** talks to both through typed Effect RPC over `worker_threads` (`Database.ts`: the `Writer` and `Reader` services). Errors cross the boundary typed: `StorageError { reason: busy | constraint | corrupt | other }` from the operation, `RpcClientError` if the worker itself fails.
  - `StorageError.message` carries SQLite's own message (e.g. `UNIQUE constraint failed: users.handle`). `corrupt` is `SQLITE_CORRUPT` or `SQLITE_NOTADB`; unique, check, not-null and foreign-key failures are `constraint`. The worker logs every one. The message never leaves the server: every client-facing handler turns storage failures into `ServerError` with a fixed message.

**The reader pool** (`readerPool.ts`) is our own RPC transport, not Effect's worker pool (`RpcClient.layerProtocolWorker`, still used for the single writer):
- **A reader is busy until it answers.** `node:sqlite` can't stop a running query. Effect's pool freed a reader as soon as its caller gave up (a timeout, a closed tab), so the next read went to the reader still running the old query. Measured with 2 readers: after a 2 s read timed out at 200 ms, the next light read waited 1,843 ms while the other reader idled. Here an interrupted read is forwarded to its reader, which stops at its next statement at best, and the reader takes nothing new until it answers.
- **A crashed reader gets nothing until it's back.** Effect's pool kept routing to it until it respawned (a light read waited 1,651 ms). Here it's out of the rotation from the crash until the respawned thread is ready, about a second later; a crash fails the reads in flight at that moment.
- **Every crash is logged** on the main thread with the worker's error (e.g. its exit code), and the reader is respawned every second.
- **While no reader is up, queued reads fail** (`RpcClientError`) at each crash or failed respawn, instead of waiting for a respawn that may never succeed. With every respawn failing, a read fails within about a second.
- **Startup waits for one reader to be ready**, and fails if every reader dies before any is.
- Requests queue in arrival order for the first idle reader. A request whose send fails gets a defect, and its reader is released.
- Tested (`test/readerPool.test.ts`) with a test reader whose requests block like queries: after the interrupted read and after a crash, each light read takes well under 300 ms, and the crashed reader is replaced by a new thread; with readers that die as they start, startup fails, and a read after all readers crashed fails in about a second.

Measured (`test/database.test.ts`): the same CPU-heavy 800 ms query blocks the main event loop for **795 ms** when run on the main thread, and **0.8 ms** when run through a reader worker (a test-only one, `test/support/diagnostics.ts`, with the readers' connection setup). Light reads on another reader finish while it runs.

### 3.2 Storage operations are named commands

Operations (`ops.ts`) are declared as RPC groups and implemented inside the workers. **A write operation is one synchronous transaction executed entirely inside the writer.** You can't send a closure to a worker thread, so a transaction structurally can't span an `await`, a network call or an LLM request. That's the usual way transactions grow long and hold locks.

Operations that run over 25 ms are logged (`timed.ts`): a write holds the writer, so a slow one delays all writes.

**A read operation is one read transaction** (`query` in `tx.ts`, a deferred `BEGIN` on the read-only connection), so all its statements see the same snapshot. Readers still never block the writer or each other. Measured cost on a trivial point read through the workers: about 40 µs per read (≈190 µs to ≈230 µs sequential) and about 8% fewer reads per second at saturation; no difference on a list read.

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
- **Only filesystems known to be local are accepted** (`statfs` on Linux): ext2/3/4, XFS, Btrfs, ZFS, F2FS, tmpfs and overlayfs (Docker's container filesystem). Network and FUSE filesystems (NFS, CIFS/SMB, sshfs, rclone, virtiofs, Docker Desktop file sharing, WSL2's 9p `/mnt/c`, Ceph, AFS) may not provide the POSIX locks SQLite relies on, and WAL can corrupt there. Anything else is refused as unrecognized. `DB_ALLOW_NETWORK_FS=1` overrides this, and is also what a local filesystem not on the list needs (e.g. exFAT or NTFS on a USB disk, bcachefs, eCryptfs).
- **Nothing else should open the live database.** Backups will be done by the app through SQLite's backup API, not by copying the file or opening it from another tool. Not built yet.
- **Backstop.** If an outside process does take a lock anyway, the workers' 5 s `busy_timeout` applies. It blocks only that worker thread, never the main thread, and anything that still fails surfaces as `StorageError { reason: "busy" }`.

### 3.5 Connection settings

| | Writer | Readers |
|---|---|---|
| Mode | read-write, `journal_mode = WAL` | `readOnly`, `query_only = ON` |
| Durability | `synchronous = FULL`: a committed transaction survives power loss | n/a |
| Other | `foreign_keys = ON`, `temp_store = MEMORY`, 64 MiB cache, `journal_size_limit` 64 MiB | `temp_store = MEMORY`, 32 MiB cache |

### 3.6 Worker bundles

Each worker thread is a separate V8 isolate that loads its own copy of every module it imports. Loading Effect's module graph from source costs about 85 MB per worker. `npm run build` therefore bundles the two worker entry points into single tree-shaken files with rolldown (`packages/server/scripts/build-workers.ts` writes `packages/server/dist/workers/{writer,reader}.mjs`). A bundled worker costs about 19 MB (measured in `test/database.test.ts`, which fails above 40 MB).

`DB_WORKERS` selects the entry points:
- `source` is the default outside production, so development never runs a stale bundle.
- `bundle` is the default when `NODE_ENV=production`. The server refuses to start if the bundles are missing (`WorkerBundleMissing`) or stale (`WorkerBundleStale`), with a message to run `npm run build`.

**Stale bundles are refused.** The build writes `stamp.json` next to the bundles (`workerStamp.ts`): the repository files among the bundled modules (43 today) plus `package-lock.json`, and a SHA-256 of their contents. At startup the server hashes the same files again, in about 3 ms, and again before spawning each worker thread, so a crashed worker isn't replaced by code from an `npm run build` run after the server started (`WorkerBundleStale`; the reader is retried every second, and reads fail meanwhile). Without it, `git pull && npm start` would run new main-thread code against old workers: migrations wouldn't run, and a new operation would fail every in-flight request with "Unknown request tag".

The tests run the core operations against both, and build the bundles into a temporary directory.

**The server tests run with `--no-wasm-code-gc`** (`vitest.config.ts`). Node's type stripping is WebAssembly, so every source-mode worker runs Wasm. In Node 24's V8, Wasm code GC can free an import wrapper twice while another isolate is tiering it up ([nodejs/node#66366](https://github.com/nodejs/node/issues/66366), fixed upstream in V8 `9b8ca54d5a` and not yet in a 24.x release). The tests create and terminate workers constantly, so without the flag about 1 run in 14 of the database test files died with SIGSEGV or `Check failed: jit_page.has_value()`. With the flag, none did in 70 runs. Node 22 has a V8 version older than the bug. The server isn't exposed in production: its bundled workers run no Wasm, so only the main thread does. In development, the source workers also run Wasm, but they live as long as the server.

Measured whole-server memory with the main thread, the writer and 2 readers: about 380 MB from source, and **188 MB** with bundles (Docker image, idle). The main thread still runs from source.

### 3.7 Schema

Migrations (`migrations.ts`) run in the writer through Effect's `SqliteMigrator`. The DDL lives in `db/schema/` as lists of statements, because `node:sqlite` prepares one statement at a time:
- `0001_users`
- `0002_data_model`: every table in DATA-MODEL.md
  - library: `entities`, `entity_revisions`, `entity_refs`, `entity_tags`
  - message graph: `chats`, `lanes`, `slots`, `slot_parents`, `versions`, `version_history`, `version_attachments`
  - `state_events`
  - rollouts: `rollouts`, `rollout_payloads`, `rollout_branches`
  - summaries: `summaries`, `summary_revisions`, `summary_inputs`, `summary_parents`, `summarization_jobs`
  - `changesets`, `changeset_items`
  - per-user data: `drafts`, `user_prefs`, `user_settings`, `app_settings`
  - `connections`, `models`
  - `media_assets`, `media_refs`
  - `jobs`
- `0003_draft_history` (§3.10), `0004_recycle_bin` (§3.11)
- `0005_providers` (§3.12): `connections` and `models` in their final shape, and the `llm_requests` usage ledger
- `0006_credentials` (§3.12): keys as credentials that connections reference, bound to hosts
- `0007_accounts` (§4): `users.password_hash`, and `sessions`
- `0008_secret_bindings` (§3.12): `connections.headers_origin`, `credentials.connection_owned`
- `0009_bin_index` (§3.11): an index on `bin_items(target_id)`
- `0010_graph_integrity`: foreign-key indexes, and the triggers below that weren't in `0002` (`schema/graphIntegrity.ts`)
- `0011_ownership`: every owner column is immutable, as is a ref's entity (`schema/ownership.ts`). One `UPDATE` could otherwise hand a credential, session, draft or bin item to another user.

Conventions:
- **Tables:** all `STRICT`, with JSON columns guarded by `json_valid` CHECKs and timestamps in epoch milliseconds.
- **Ids:** UUIDv7 (`@rp/shared/id.ts`), so `ORDER BY id` follows creation order.
- **Concurrency:** mutable rows carry `row_version` for optimistic concurrency.
- **Mutual references** (`slots.selected_version_id` ↔ `versions.slot_id`, a summary ↔ its selected revision) use deferred foreign keys. The version row is inserted first, then the slot, in one transaction.

**Invariants enforced by the database** (`schema/integrity.ts`, `schema/graphIntegrity.ts`). Triggers check each statement, so no single statement can break these, and `test/schema.test.ts` checks each one on a bare connection. A sequence of statements still can, for example deleting a selected model version and inserting another under its id in one transaction: no trigger can tell that from a legitimate insert. The writer is the only code path that writes, and these back it up:
- **Edits are non-destructive.** Changing content creates new rows; it never overwrites. Deliberate deletion is allowed, and foreign keys keep it consistent: for example, a slot can't be left selecting a deleted version, and deleting a chat removes everything in it, its chat-local overrides and drafts included.
  - Model-written versions are frozen once they stop generating, and a version never goes back to generating. Only deleting for good from the recycle bin empties one: `purged_at` set, under a bin item of the chat's owner for that version, its message, or a branch in its chat. `purged_at` is never cleared on versions and slots.
  - Amending a user-written version copies the previous content into `version_history` automatically.
  - Entity revisions and summary revisions are immutable.
  - A rollout's context snapshot is frozen once written.
  - State events can only be superseded, not changed.
- **The graph is append-only.**
  - A slot's parent is in the same chat, one level up.
  - A merge slot's extra parents (`slot_parents`) are in its chat and recorded before anything is appended below it, which keeps the graph acyclic: an edge out of a slot nothing points to can't close a cycle. Triggers can't run a recursive cycle check.
  - A slot and its merge parents never move.
  - A version's slot, writer and origin never change, and its source can only be cleared.
- **References stay inside their chat.**
  - A slot selects only its own versions, which is what invariant 3 rests on.
  - A chat's active leaf is one of its slots.
  - A lane forks from a slot of its chat.
  - A version's source ("edited from #7") is a version of the same slot. Deleting the source clears the reference.
  - A state event's slot is in its chat, and its version is in that slot.
  - A summary selects only its own revisions.
  - Rollouts (slot, leaf, parent), summaries (first and last slot, rollout), summary inputs (slot, and a version of that slot), summary parents, summarization jobs (slots, summaries), changesets (rollout), versions (rollout, changeset) and superseded state events (changeset) refer only within their chat. A reference into another chat would also block that chat's deletion with a foreign-key error.
  - A chat override is of an entity of the chat's owner.
  - Each holds on insert and on update. Rows others refer to never move to another chat: slots, lanes, state events, rollouts, changesets, summaries, summarization jobs and bin items. A chat override can only stop being one.
- **What a user owns stays theirs.** Nothing with an owner ever changes owner: chats, entities and connections (0010), and credentials, sessions, drafts, bin items, recovered texts, settings, media references, jobs and ledger rows (0011). A ref never moves to another entity.
- **Not enforced here:** ownership of the ids inside a state event's value (§3.8), and that a reference points at something not in the recycle bin. The writer checks both.

**Foreign keys are indexed on the referencing side** wherever the referenced row can be deleted; `test/schema.test.ts` fails on a new one without an index. SQLite checks a key from that side, so without the index, every insert or delete of a referenced row scans the referencing table. Measured on a bare connection (`0010` added the missing ones): appending a message with 100,000 slots in the database took 6.2 ms before (a scan of `slots` for `selected_version_id`) and 0.07 ms after; deleting a 2,000-slot chat among 20,000 slots took 6.5 s before and 55 ms after.

**Full-text search** (`schema/search.ts`). FTS5 external-content indexes cover `versions.content`, `summary_revisions.content` and `entity_revisions.search_text`, using `unicode61` with diacritic folding and prefix indexes, and triggers keep them in sync.
- Each indexed table has an `INTEGER PRIMARY KEY seq` (a rowid alias) next to its public `id`. That's because `VACUUM` can renumber the implicit rowids of TEXT-keyed tables, which would silently corrupt an external-content index.
- Versions are indexed only once they stop generating, so streaming doesn't churn the index.
- Every indexed table's triggers cover inserts, deletes and (for mutable tables) updates; `test/schema.test.ts` checks this for every FTS table. A deleted row's `seq` can be reused by the next insert (SQLite can't add `AUTOINCREMENT` without rebuilding the table, and the rebuild would cascade-delete the rows referencing it), so the delete trigger is what keeps a deleted text from matching whoever's row takes its `seq` next. `0010` rebuilt `entity_revisions_fts`, which had no delete trigger.

### 3.8 Message graph operations

Contracts are in `db/ops.ts`, writes in `db/writes.ts` (writer worker), reads in `db/reads.ts` (readers). Domain types are in `@rp/shared/chat.ts`; state-event keys and the fold are in `@rp/shared/state.ts`.

- **Writes:**
  - `CreateChat`: pending or active, with participants joined at the initial position and an optional greeting as the root slot.
  - `AppendMessage`: a new slot, becoming the active leaf. The first message turns a pending chat active. A branch is explicit (`branch: true`, any live parent); otherwise the parent must be the active leaf, and a tab that missed a newer message gets `LeafMoved`, with the current leaf, instead of silently forking.
  - `AddVersion`: swipe, edit, or write your own, optionally selected. An edit's `sourceVersionId` must be a live version of the same slot.
  - `SelectVersion`: with `expectedRowVersion`, failing as `StaleWrite` for a stale tab.
  - `AddStateEvent`: a user's state change (origin `user`) at a live position, optionally attached to a version. Events from rollouts, changesets and imports will be written by those operations.
- **Reads:**
  - `GetChat`
  - `GetPath`: a window, below.
  - `ListVersions`
  - `StateEventsAt`: the events that apply at a slot, in fold order. Version-attached events count only while their version is selected, and events on a deleted message only once it's restored (DESIGN §3.4, proposed). Events naming a library entity, ref or revision that was deleted for good, or scoped to a card that was, are left out (`played_by_me.set` keeps its other entities), so restoring a message can't bring a purged card back.
- **Ownership.** Every operation takes the acting user and touches only that user's rows. Anything else is `NotFound`, so another user's data isn't even confirmed to exist. That includes:
  - someone else's card as a speaker or participant
  - every entity, ref, revision, connection and model a state event's value names (`db/stateRefs.ts`), with the kind each key expects (a note for `note.activate`). Each key declares its id fields, with their table, kind and links (`stateKeyIds` in `@rp/shared/state.ts`), and the checker reads only the declarations. A new key doesn't compile until it's declared. Every id schema (`EntityId`, `RefId`, `ConnectionId`, …) is made by `idSchema` (`@rp/shared/id.ts`), which annotates its table (`ID_TABLE`); ESLint forbids `Schema.brand` anywhere else in `src`. `packages/shared/test/state.test.ts` walks each key's value schema, record keys included: an id the declaration doesn't name, an id below a top-level field, an id inside a template literal or a suspended schema, or a declared field that isn't an id schema fails it. An id typed as a plain string isn't seen, so state values use the id schemas. `test/stateKeys.test.ts` checks every key's ids through the writer against an oracle written apart from the declarations: another user's id, an id of another kind, one that doesn't belong to the value's other ids, and things in the bin (allowed only for `removes` keys) are each `NotFound`. Keys that add something need it live; keys that remove something (`removes`: `participant.leave`, `presence.set`, `note.deactivate`, `lorebook.detach`) check ownership only, so a deleted or purged card can still be taken out of a chat.
  - another user's version as an edit's source
- An event's `scope` is a role (`narrator`, `summarizer`) or a participant, which must be a live card of the user's, checked like a value's ids (`scopeIds`). Lane and `agent:<entity>` scopes (DATA-MODEL §5.1) aren't accepted until something uses them.
- `orchestration.mode`'s `config` and `var.set`'s `value` are free-form and not checked: whatever later reads an id from them must check ownership itself.
- **State events are typed.** `StateEventData` is a Schema union of the keys in DATA-MODEL §5.3, so an unknown key or malformed value is rejected when the RPC payload is decoded, before it reaches the database. `foldState` is a pure function shared by server and client.
- **Paths are read in windows.** `GetPath` walks up from a leaf and stops after `limit` slots (at most 1000), so its cost depends on the window, not the chat's length. Deleted messages count toward the limit but aren't returned, so a window can be short or empty; `olderLeafSlotId` is where the next older window ends, null at the root.
  - Measured on a 2,001-slot chat: a 200-slot window takes about 22 ms end to end, and paging back reconstructs the whole path without gaps (`test/graph.test.ts`).
  - Reading all 2,001 slots in one call took 113 ms, of which the SQL was 13 ms; at 20,000 slots the SQL alone is about 180 ms. Hence the windows.
- **Append cost.** About 2.6 ms per message end to end, including the RPC hop and a commit with a full flush (`synchronous = FULL`, ZFS).

**Known limits:**
- **`StateEventsAt` walks the whole path to the root,** because state can come from any ancestor. It's linear in chat length: about 10 ms of SQL at 2,000 slots, roughly 180 ms at 20,000. Options before chats get that long: index branch segments so ancestry costs O(branches) instead of O(depth), or cache folded state at checkpoints as DATA-MODEL §5.2 proposes.
- **Results cost about 0.1 ms per path entry** to encode and decode as Schema classes across the worker boundary, and the decode side runs on the main thread. If large windows show up in the event-loop budget, the transfer types should become plain structs.

### 3.9 Library operations

Layered, versioned documents (DESIGN §4, DATA-MODEL §3) for cards, presets, lorebooks, notes and preset overlays, one mechanism for all of them. Contracts are in `db/ops.ts`, writes in `db/libraryWrites.ts`, reads in `db/reads.ts`, and the logic both share in `db/library.ts`. Domain types are in `@rp/shared/library.ts`; the merge is in `@rp/shared/merge.ts`.

**The model.**
- **Revisions** are immutable snapshots with parents, like git commits.
- **Refs** are movable pointers:
  - an `upstream` ref is the base line (imported, or the original of something the user created)
  - a `variant` follows another ref
  - a `chat_override` follows a ref for one chat only
- A ref that follows another records the revision it last merged from (`merge_base_revision_id`).
- **An upstream ref follows its imports.** Imports form their own line of revisions, each one's parent the previous import. The upstream merges the latest import, and its merge base is the import it last merged. So a re-import merges with edits made on the upstream itself, as a variant's merge does.
- **"Update available"** is derived, not stored: what the ref follows (for an upstream, its latest import) differs from the merge base.
- Documents are any JSON object for now. Per-kind schemas arrive with the importers (PLAN phase 1).
- A content hash over canonical JSON (sorted keys) means an edit, re-import or merge that changes nothing creates no revision. A merge that brings nothing new only moves the merge base and reports `up_to_date`.

**Operations.**
- **Writes:**
  - `CreateEntity`
  - `EditRef`: a new revision on the head, with `expectedRowVersion`. It commits its draft even when it changes nothing.
  - `ForkRef`: a new variant
  - `CreateChatOverride`
  - `PromoteOverride`: override to variant
  - `ImportUpstream`: a new import revision, merged into the upstream; it returns the upstream's outcome and its followers'
  - `MergeFollowed`
  - `ResolveMerge`: commit a hand-resolved merge, refused if the followed ref moved again since the preview
  - `SetEntityTags`: folders; `persona` is the persona folder
  - `SetEntityArchived`
- **Reads:**
  - `ListLibrary`: by kind, tag and archive state; chat overrides excluded
  - `GetRef`
  - `RefHistory`: first-parent chain
  - `PreviewMerge`: the resolver's view
  - `ListChatOverrides`
- **Ownership** is enforced as in §3.8. Binned entities and chats are `NotFound`.

**Changes flow to followers.** After any change to a ref (an edit, a merged import, a merge), every ref following it is merged in turn, transitively: upstream, then variants, then the chat overrides that follow those. Each follower ends as one of:
- **fast-forward:** it had no edits of its own since the last merge, so it simply moves to the new revision, with no merge revision
- **merged:** a merge revision with two parents
- **conflicts:** left exactly as it was, with "update available" set until the user resolves it

An upstream merging a new import ends the same ways. The outcomes are returned, so the UI can report what happened.

**Schema versions (interim, until per-kind migrations exist).** Every revision of an entity has the schema version it was created with. `ImportUpstream` refuses a document of another `schemaVersion` before writing anything, so no merge ever spans versions.

**Three-way merge** (`merge3`, shared so the server's merge and the resolver's preview always agree):
- Objects merge per key. Only own keys count, so `__proto__` or `constructor` are plain data.
- **Arrays merge per element when every element has a unique `id`, `identifier` or `uid`.** That covers preset prompts and order, card modules and lorebook entries, so additions on either side survive and deletions apply unless the other side edited the element (then it's a conflict). **Order** follows the side that reordered the elements all three share, or ours if neither did, with the other side's new elements placed after their predecessor there. Both reordering differently is a conflict at the array, and ours' order is kept.
- Other arrays are atomic.
- **Text changed on both sides merges word by word** with diff3 (`node-diff3`), keeping whitespace. Edits to different sentences of the same prompt combine; overlapping edits conflict. A conflict keeps ours in the merged value and is reported with its path, e.g. `["prompts", "identifier=main", "content"]`, and each side's value; a side with no value there (added or deleted) has none.
- `test/library.test.ts` and `packages/shared/test/merge.test.ts` run the owner's case from DESIGN §4 end to end: a softened impersonation rule and an added `{{summary}}` prompt survive an upstream re-import that rewrote another sentence of the same prompt, changed a sampler and added a prompt.

**Known limits:**
- Arrays without element identities, like a card's `alternate_greetings` or `tags`, are atomic: changing them on both sides is a conflict.
- Not built yet: exporting a ref (the card formats exist, §8), library search, and "used by N chats".

### 3.10 Drafts

Drafts with server-persisted undo history, for every text field (DESIGN §6.2). The patch model and history policy are in `@rp/shared/drafts.ts`, storage in `db/drafts.ts` (shared by the writer and readers), and the history table in migration `0003_draft_history`, which replaced the `drafts.undo_log` blob.

**Keys.** A draft is keyed by user and target:
- `composer` (a chat, with the branch tip in `field`; `composerKey()` builds it)
- `version_edit` (a version)
- `scratchpad` (a slot)
- `entity_field` (a ref plus a JSON path in `field`)
- `summary_edit` (a summary)

The first save checks that the target belongs to the user. Drafts are never visible to other users.

**Saving.**
- The client saves debounced while the user types (`SaveDraft`). Each save passes the row version it last saw: null to create, and anything else is `StaleWrite` if another tab saved since. So a stale tab can't silently overwrite newer text.
- The server diffs the new text against the stored text into one reversible patch (`start`, `removed`, `inserted`) and records it in `draft_history`. Patch boundaries never split a surrogate pair, so stored text stays valid UTF-8.
- History is a row per entry, not a blob, so a save never rewrites the whole history.
- Text is capped at 1,000,000 characters (`DraftTooLarge`).

**History.**
- **Typing coalesces.** A save within 5 s of the last entry extends it, until the entry spans 60 s, so continuous typing is one entry per minute rather than one per save.
- **A destructive change always gets its own entry,** so the text before it is one step back. Destructive means removing more than 200 characters or more than half the text, e.g. select-all plus a stray key.
- `DraftHistory` lists the restorable states newest first, with lengths and short excerpts. `GetDraftState` returns one state's full text, built by undoing newer entries from the current text.
- Walking history back needs only lengths, since destructiveness depends only on them. Earlier text is rebuilt only as far back as needed, as slices of the current text, so no step copies the whole text.
- `RestoreDraftState` moves the draft back to that state, and records the restore as its own entry, so it can be undone too.
- At most 1000 entries and 1,000,000 changed characters are kept per draft, oldest dropped first. The text from before a dropped destructive change goes to the recovered-text section first.

**Committing.** `AppendMessage`, `AddVersion` and `EditRef` take an optional `commitDraft` (key plus the row version the client sent from) and commit that draft **in the same transaction**, so a reload never shows already-sent text in the composer. If the draft moved on since (another tab kept typing), it stays active with the newer text, and the write returns it. `ClearDraft` commits or discards a draft explicitly.

**History only lives while a draft is being written** (owner, 2026-10-10). Once committed, the text is preserved in a version or revision, so a commit or discard deletes the draft's history and empties its text. The row stays, so other tabs' row versions keep working. What a commit or discard would otherwise lose goes to the recycle bin's **recovered-text section** (§3.11):
- the text from just before **each** destructive change in the session (hours of typing in a card field wiped, then saved)
- a discarded draft's text

This applies to every kind of draft: what a bad save loses is the editing session, and the previous version being intact doesn't change that. The next save after a commit starts a fresh session. `ListActiveDrafts` lists drafts with unsent text.

**The composer belongs to a branch** (DESIGN §6.2, owner):
- Its key is the chat plus the slot the next message goes under (the branch tip), or empty before the first message.
- Each chat and each branch has its own composer, and a half-typed message waits where it was left.
- `AppendMessage` moves the composer at the old tip to the new slot. That way a model reply carries text typed meanwhile forward, and a send's recovery text follows the conversation.
- `CopyComposer` copies the text to a new branch's tip when a branch is started, never overwriting text already there.
- Switching between existing branches carries nothing.

**Cleanup.** Draft targets aren't foreign keys, since one column points into several tables. Triggers delete a draft when its target (chat, slot, version, summary, ref) is deleted (`test/schema.test.ts`).

**Not built yet:** pushing a draft change to the user's other open tabs and devices. That needs the subscription channel; until then, the row version catches the conflict when the other tab saves.

### 3.11 Recycle bin

Deleting is deliberate and fundamentally non-destructive (DESIGN §6.2): deletes go to a per-user bin, from which they can be restored or deleted for good. Schema in migrations `0004_recycle_bin` and `0009_bin_index`, logic in `db/bin.ts`, handlers in `db/binWrites.ts`, types in `@rp/shared/bin.ts`. The writer builds one bin, with the draft store it recovers text for, and shares it across its handler groups.

**Deleting marks, it doesn't remove.**
- A delete creates one `bin_items` row and marks everything it covers with `deleted_at` and that item's id: one slot for a message, a whole subtree for a branch, one version for a swipe, a chat, or an entity.
- Every read skips marked rows. Paths walk through deleted messages without showing them, so their replies stay where they were. Writes treat deleted things as `NotFound`.
- Restoring clears the marks, so things come back exactly where they were, with their versions and attached state.

**Deletes need no confirmation:** each returns the bin item for the "deleted, open the bin" toast. The behaviors:
- **Swipes:** `DeleteVersion` deletes one swipe, the normal delete (owner). If it was showing, the previous swipe shows, as in ST, or the next one if it was the first. Deleting a message's only remaining version deletes the message.
- **Messages and branches:** `DeleteMessage` deletes one message, and its replies stay. `DeleteBranch` deletes a message and everything below it, as one item.
- **The active leaf:** if it's deleted, the chat's tip moves to the nearest remaining ancestor, and the composer goes with it unless that tip has text of its own. An empty composer already there is ended as a discard before it's replaced, so text typed and wiped there is recovered.
- **Chats and entities:** `DeleteChat` and `DeleteEntity`.

**Deleting for good** (`PurgeBinItem`, `EmptyBin`; the UI confirms these):
- **A chat** is deleted, with everything in it and its other bin items. A connection whose preset was one of its chat overrides loses that preset.
- **An entity** loses its refs, revisions and tags. The entity row stays, so messages that named it as their speaker still point somewhere.
- **A message, branch or swipe** has its versions emptied: content, reasoning, display forms, amend history and attachments. Its slots stay as placeholders, so the conversation's structure and any summaries over it remain valid. This is the one exception to model output being frozen: a version may be emptied only as part of a purge of its own bin item (§3.7).
- Purging is set-based: `EmptyBin` runs the same few statements whatever the bin holds.

**Two independent sections**, each evicting its own oldest entries past its own limits, never the other's:
- **Deleted items** (`ListBin`): 10,000 items or 2 GB by default. Eviction deletes the oldest for good, never the item the delete just made, each in a savepoint: a purge that fails is rolled back, logged and skipped, so it never fails the delete that triggered it. If what can go can't make room, nothing goes and the bin stays over its limits (DESIGN §6.2, proposed).
- Sizes are UTF-8 bytes. A deleted item's is what deleting it for good frees: its versions' text columns, amend history and attachment alt text; for a chat also its rollouts and their payloads, summaries, state events and changesets; for an entity its revisions and their search text. Messages and swipes already in the bin count only under their own items.
- **Recovered text** (`ListRecoveredTexts`, `GetRecoveredText`, `DeleteRecoveredText`, `ClearRecoveredTexts`): 2,000 texts or 200 MB by default. It's produced passively by draft commits, discards and history retention (§3.10), so it never shows a toast.
- Each entry records where it came from: a title, an excerpt and origin details for deleted items, a source label like `Composer in "Harbor"` for recovered text. So text can be copied out without restoring.
- Both lists page newest first, with a cursor of the last entry's time and id, so entries from the same millisecond are never skipped.
- Limits are `Database.layer({ binLimits })`.

### 3.12 Connections, models and the usage ledger

The provider layer's storage (spec/PROVIDERS.md §2, §3.1, §9.1), in migration `0005_providers` (`db/schema/providers.ts`).

**`credentials`** (migration `0006_credentials`): keys, each stored once and used by any number of connections.
- **The columns:** `key_enc` (encrypted, bound to `credential:<id>:key`), `key_hint` (its last 4 characters; empty for keys under 12, where 4 characters would be most of the key), a name, `origins_json`, the origins (scheme, host and port) the key may be sent to, and `connection_owned` (0008): the credential was made from a key typed into one connection.
- **The rule** (owner, 2026-10-11): a key is sent only to an origin its credential allows.
  - The origins are recorded when the key is entered.
  - Adding one takes the key typed again (`AllowCredentialHost`). The main thread checks it against the stored key with a constant-time comparison.
  - Code acting as the user without knowing the key (a stolen session, an XSS, a plugin in the page) can edit connections, but can't redirect a key to a new host.
  - Changing a path on the same host needs nothing.
  - **Replacing a key states its origins again** (`ReplaceCredentialKey` takes them). Origins approved under the old key don't carry over: otherwise a stolen session could swap in a junk key, approve its own host with it, and wait for the user to re-enter the real one.
    - **The client must make the user confirm each origin** in the replace-key dialog, starting from the hosts of the connections using the credential. It must not pre-fill and submit the stored list: a stolen session can replace the key and the origins together, and the server can't tell that from the user. A stolen session can also re-point those connections first, so the dialog flags every origin that wasn't in the credential's list before.
  - **Header values are bound the same way.** `headers_origin` (0008) records the origin they were set for, and they're refused anywhere else until set again. Gateway tokens, Azure's `api-key` and Cloudflare Access secrets live in headers. Headers from before 0008 have no origin and must be set again.
  - **A key typed into a connection** (`SetConnectionKey`) is bound to the base URL of the row version the user saw. A stale form is a `StaleWrite`, so a key isn't bound to a URL someone changed in the meantime. The connection's previous key is deleted if the connection owned it and nothing else uses it, so a rotated (possibly leaked) key doesn't stay at rest. Purging a connection deletes its own key the same way. A credential the user created and attached is never deleted this way.
  - **Redirects stay within the origin** (`Network.fetchFor`). undici strips only `authorization` and cookies on a cross-origin redirect, so `x-api-key`, `x-goog-api-key` and custom headers would follow an open redirect on an allowed host. Same-origin redirects are followed (at most 5), each routed afresh. A redirect to another origin is a `RedirectRefused` error, reported as `unusable` and never retried. Google's adapter uses pi-ai's own fetch, so its redirects aren't covered.
  - **A connection's own proxy can't carry a key over `http`.** Setting one needs no key, and over `http` the proxy reads every byte. Such a connection is `unusable` until it uses `https` or the instance proxy.
  - **Why:** keys are money, so making them easy to steal makes the frontend worth attacking. ST is a target for exactly this reason.
  - **Switching it off** is possible only from outside the app: `KEY_HOST_BINDING=false`. Most settings are meant to be changeable from inside, including by the user's agent; security settings are the exception.
  - **Server-side code can still read keys** (spec/PLUGINS.md §6.1). This protects against everything that acts through the browser.

**`connections`**: one provider kind, one wire API, one base URL, and at most one credential per row.
- `kind` and `api` follow pi-ai's catalog, so the shared schema will validate them rather than a CHECK list.
- `credential_id` references the key the connection sends (`ON DELETE SET NULL`). The database allows only the connection owner's credentials.
- **Other secrets are columns of their own,** written encrypted:
  - `headers_enc`, with only `header_names_json` in the clear, because header values often carry credentials
  - `proxy_url_enc`
- **The database keeps them consistent:**
  - `proxy_mode = 'custom'` always has a proxy URL, and the other modes never do
  - a purged connection (`purged_at`) holds no credential, headers, proxy or base URL; it stays as a tombstone so old messages and ledger rows still name their model
- **0005's per-connection key columns are retired.** `api_key_enc` and `key_hint` stay in the table, but triggers keep them empty. They go when migrations are squashed for the first release.
- `deleted_at` and `bin_item_id` are for the recycle bin, whose `bin_items.kind` now includes `connection`. The table was rebuilt for that, keeping its rows.

**`models`**: what the upstream reports (`upstream_json`, rewritten by every refresh) and what the user edited (`overrides_json`, never touched by a refresh) are separate columns, merged when read. A model the list stops reporting gets `missing_since` instead of being deleted. A model never moves to another connection or key.

**`llm_requests`**: one row per request to a model, retries and failed attempts included.
- **Opened as `running`** before the request is sent, and closed with its status, timings, normalized token counts (`input_uncached`, `cache_read`, `cache_write` with its long-TTL subset `cache_write_long`, `output` with its `reasoning` subset), the provider's raw usage object, any provider-reported cost, and the computed cost with its currency and formula. `running` exactly when `ended_at` is unset.
- **Unknown counts are `NULL`, never zero.** Provider-reported numbers have no CHECKs, so a quirky upstream can never make the closing write fail and leave a billed request unrecorded.
- **A closed request is a record:** only its cost can be recomputed, and a cost always names its currency and formula.
- **Attribution stays inside the user's data:** a request names only its own user's chat, a rollout and a version of that chat, and a model of its connection. Attribution can be cleared, never moved.
- **The ledger outlives what it's attributed to:** deleting a chat for good keeps its requests and clears their chat, rollout and version (`ON DELETE SET NULL`, indexed so a large chat deletes quickly).
- Indexed by user and by connection over time, for totals and later limits.

**Operations** (`db/providerWrites.ts`, `db/providerReads.ts`; types in `@rp/shared/providers.ts` and `@rp/shared/usage.ts`):
- **Connections:**
  - `CreateConnection`: the caller picks the id, since secrets are encrypted bound to it
  - `UpdateConnection`: with `expectedRowVersion`
  - `SetConnectionKey` (a typed key or none, with `expectedRowVersion`), `SetConnectionCredential`, `SetConnectionHeaders` (with `expectedRowVersion`), `SetConnectionProxy`
  - `DeleteConnection`: through the bin. A purge leaves the tombstone described above.
  - `ListConnections`, `GetConnection`: secrets appear only as `hasKey`, `keyHint` and header names
  - `ResolveConnection`: the ciphertext and the credential's origins, for the provider layer only
- **Credentials:**
  - `CreateCredential`, `RenameCredential`
  - `ReplaceCredentialKey`: updates every connection using it, with the origins stated again
  - `AddCredentialOrigin`
  - `DeleteCredential`: connections using it are left without a key
  - `ListCredentials`: with how many connections use each
  - `ResolveCredential`: the ciphertext only, for checking a retyped key
- **Models:**
  - `SyncFetchedModels`: adds new models, refreshes `upstream_json`, and marks unlisted ones missing. Models only ever added by hand are never marked.
  - `AddUserModel`
  - `EditModel`: with `expectedRowVersion`
  - `SetModelHidden`
  - `ListModels`, `GetModel`
  - `resolveModel` (shared) merges the sources, user edits first. It reports each field's source, and fields no source knows as `unknown` with a safe default.
- **Ledger:**
  - `OpenLlmRequest`, `CloseLlmRequest`
  - `InterruptRunningLlmRequests`, for startup
  - `ListLlmRequests`
- **Ownership:** as in §3.8, everything on another user's connection, model or ledger row is `NotFound` (`test/providers.test.ts` runs every operation as a second user).
  - A connection's preset override must be one of the user's own live refs. Another user's ref, and a ref that doesn't exist, are the same `NotFound`, so ref ids can't be probed.
  - A key given at creation is stored in the same transaction as the connection.
  - `ListLlmRequests` pages by `(started_at, id)`, so requests started in the same millisecond aren't skipped.
  - A model list that repeats a key keeps the last entry.
- **Not built yet:** the rollups into `rollouts` and `versions.usage_json`. They arrive with generation (PLAN phase 2).

**Migration guard.** `0005_providers` recreates `connections` and `models` rather than altering them, which is only safe because nothing had written them. The migration refuses to run if either holds rows (`test/migrations.test.ts`).

---

## 4. Authentication

`auth/Accounts.ts` implements the `Authentication` RPC middleware declared in `@rp/shared/api.ts`. It provides `CurrentUser` to every handler, resolved on every call. Over the WebSocket, the headers are those of the upgrade request. A session is still checked on each call, so a logout reaches connections that are already open. `accounts.test.ts` checks that every RPC in `AppApi` carries the middleware: one added to the group after `.middleware()` would skip it.
- **The isolation matrix** (`test/isolation.test.ts`) has an entry for every RPC in `AppApi`, and fails on an RPC without one or an entry whose RPC is gone. An entry is one of:
  - a probe, run both ways between an admin and a user over real sockets: one reads, changes or references the other's connection, credential, model, preset or ledger row, and is refused or sees nothing. Everything the owner can list (and, for an admin, the users and network settings) is the same afterwards.
  - an admin-only probe: a user is `Forbidden`
  - `global` (no user's data) or `createOnly` (names nothing that exists), with the reason
- **Message headers are dropped** (`TransportHeadersOnly` in `server.ts`). Effect's RPC server appends the headers a client puts in each message after the upgrade request's, and the later entries win. Before this, any client could name any user in proxy mode by sending `remote-user` in a message. The serialization now empties message headers when decoding, so identity can only come from the upgrade request (`rpc.test.ts` checks this).
- **`AUTH_MODE=single`, built-in login** (DESIGN §10.1):
  - **No account has a password:** loopback and `ALLOWED_IPS` are the implicit local admin `local`, without logging in. That's local use. It's checked on every call, not only when a connection opens: a socket opened from elsewhere while login was required doesn't become the local admin if the last password goes.
  - **Once an enabled user has a password,** a session is required. With `LOOPBACK_REQUIRES_LOGIN=false`, loopback skips login and acts as the oldest enabled admin. Loopback is judged by `x-rp-peer`, which `RequestGuard` sets from the socket's address and which replaces any copy the client sends. Behind a reverse proxy on the same host, every client arrives from loopback, so this setting would make everyone the admin.
  - **Login and logout** are HTTP, since only a response can set a cookie: `POST /auth/login` (JSON `{handle, password}`, at most 4 KiB) and `POST /auth/logout`. A login must be `application/json`, so a cross-site form can't send one, on top of the Origin check. Over plain HTTP beyond loopback, passwords cross the network in the clear: put TLS in front.
  - **The session cookie** `rp_session` is 32 random bytes, `HttpOnly`, `SameSite=Strict`, `Secure` when the page is on https, and lasts 30 days. The database stores only its SHA-256, so a copy of the database holds no live session.
  - **Login attempts** count before the password is checked, so a burst can't outrun the count. The limits are 10 per address and handle and 50 per address in 15 minutes, then `429` with `Retry-After`; a success forgives its address and handle.
    - Keying by address and handle means nobody can lock someone else out by name. Behind a same-host proxy, all clients share one address, so they also share its limits.
    - At most two password checks run at once. scrypt shares libuv's 4-thread pool with DNS and file reads, so further attempts get `429` instead of queueing.
    - Malformed handles and over-long passwords fail like a wrong password, before any hashing, and count only against their address.
    - A check holds its permit until scrypt finishes, even when the client disconnects, since the hash can't be cancelled.
    - The counts are capped at 10,000 keys: stale ones go first, then the oldest.
    - An unknown handle takes as long as a wrong password (a dummy scrypt check).
    - Checking the current password in `SetPassword` is throttled the same way, so a stolen session can't guess at full speed.
    - The counts are kept in memory.
  - **Passwords** use scrypt (N=2^15, r=8, p=3) on libuv's thread pool, so the event loop stays free. The hash is stored as `scrypt$N$r$p$salt$hash`. A password needs 8 to 1024 characters, and nothing else (NIST SP 800-63B).
  - **No sign-up:** an admin creates accounts (`CreateUser`, `SetUserDisabled`). An admin without a password of their own can't: the new account's password would make login required, and the admin couldn't log in. Users set their own password with the current one, if they have one; an admin can set anyone's (`SetPassword`). Changing a password or disabling a user ends that user's sessions, and the last enabled admin can't be disabled.
  - **Headless servers:** `ADMIN_PASSWORD_FILE` or `ADMIN_PASSWORD` (with an optional `ADMIN_USER`) gives the first admin a password at startup. The account is the named user, else the oldest enabled admin (so the local admin keeps its data), else a new `admin`. It applies only while no enabled admin has a password, so a password changed in the app survives restarts. Proxy mode ignores it, with a warning.
  - **Caches:** sessions aren't cached, so a revoked one stops working at once. Users are cached per process and cleared on every account change, all of which go through this process. A lookup that started before a change doesn't write its stale answer back.
- **`AUTH_MODE=proxy`:** the user is whoever the reverse proxy names in `AUTH_PROXY_HEADER` (Authelia's `Remote-User`). A missing header is `Unauthorized`, and so is one containing a comma or a control character. Node joins a repeated header with `, `, so a proxy that added its header next to a client's would otherwise produce a name made of both.
  - The header is trusted because only the proxy can connect (exposure, below).
  - Login, passwords and account creation don't apply. Disabling a user does.

**Exposure** (`net/exposure.ts`, DESIGN §11). Who may connect at all, decided per connection from the socket's source address, never from a forwarded header. Configuration is environment-only, as for every security setting.
- **Single mode:** loopback, plus `ALLOWED_IPS`. Without `ALLOWED_IPS`, every address may connect while an enabled user has a password, since everyone then has to log in. This is checked per connection, so if the last password goes, access beyond loopback goes with it. An allowlist stays a restriction even with passwords.
- **Proxy mode:** `TRUSTED_PROXIES` only, or loopback when it's unset. Anyone else who could connect could send the identity header and be any user. `ALLOWED_IPS` is a startup error here.
- **Refused peers** get a bare `403` written to the socket on connect, which is then destroyed before it's read. Ending it isn't enough: the HTTP parser is already attached, and on a half-open socket it would still dispatch the peer's requests (`exposure.test.ts` checks that no handler runs).
- **At startup,** listening beyond loopback (`HOST` other than `localhost`, `127.0.0.0/8` or `::1`) with nothing beyond loopback allowed is an `UnsafeExposure` error naming the fix. So are entries that aren't IPs or CIDR ranges (a prefix must be 0–3 digits: `Number("")` is `0`, so `10.0.0.0/` would otherwise allow everyone).
- **`ALLOW_INSECURE_EXPOSURE=true`** serves every address. Combined with `ALLOWED_IPS` or `TRUSTED_PROXIES`, which it would silently undo, it's a startup error.

**Cross-site requests** (`crossSiteProblem`, a global router middleware). A page from any site can open a WebSocket to the user's loopback, and a page whose domain is re-resolved to `127.0.0.1` (DNS rebinding) is same-origin with itself. So every request gets a `403` unless:
- **`Origin`**, when present, is in `PUBLIC_ORIGINS`, or names the `Host` the request was sent to. That second route doesn't apply to a public host, so `http://` can't stand in for a public `https://`. Clients that send no `Origin` aren't browsers, so they have no session to borrow.
- **`Host`** is `localhost`, an IP literal (rebinding needs a name), or a public origin's host.
- **Proxy mode with `TRUSTED_PROXIES` set skips the `Host` check.** Only the named proxies can connect, so no rebound page reaches the server. And proxies often forward their own upstream name (nginx's default `Host` is `$proxy_host`). With `TRUSTED_PROXIES` unset, loopback is trusted, so the check stays. A page rebound to loopback is same-origin and could `fetch()` with its own identity header. A same-host proxy forwards `127.0.0.1` or `localhost`, which pass. Behind a proxy under a domain, set `PUBLIC_ORIGINS` to its public origin. Without it the server warns at startup: browsers are refused unless the proxy forwards the `Host` they used.
- **`PUBLIC_ORIGINS` entries** must be exact origins (scheme, host, optional port; a trailing slash is allowed). A path, credentials or a wildcard is a startup error, not something silently dropped.
- Vite's dev proxy keeps `Host` as `localhost:5173`, which matches the page's origin.

Users are created on first sight (`EnsureUser`): the local user, and proxy identities. The first user of an instance becomes `admin`. A disabled user is refused.

Not built yet: the login page (it waits for its design).

In proxy mode, a WebSocket keeps the identity it opened with until it disconnects, so logging out of the proxy doesn't end an open tab's access. That's deliberate (DESIGN §10.1).

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

## 6. Provider layer

`packages/server/src/providers/` (spec/PROVIDERS.md §4, §7, §9). It's the one entry point to models, for the assembler (phase 2) and later the agent loop. It sits on `@earendil-works/pi-ai` 1.0.3, unpatched.

**The provider registry** (`providers/registry.ts`, `providers/builtins.ts`; the generic mechanism is `src/registry.ts`). This is the first registry of the structure in spec/PLUGINS.md §3.1: the core registers its features through the same registries plugins will use.
- **A registry** holds entries by id. Registering adds an entry or overrides the one with the same id, and `disable` hides one. Each registration lasts as long as its scope, and closing the scope restores whatever it hid, in any order (`test/registry.test.ts`). Wrapping is `get`, then registering a replacement that calls the original.
- **The `ProviderRegistry` service has four registries:**
  - **Provider kinds:** label, pi provider id, wire API id and implementation (pi-ai's `ProviderStreams` or the plugin's own), whether it takes our `fetch`, default base URL, whether a key is optional, a model lister, and an optional catalog.
  - **Request transforms:** payload rewrites through pi-ai's `onPayload`, applied in registration order to requests whose kind and API they apply to.
  - **Response observers:** readers of the raw stream events.
  - **Cost formulas:** each prices a finished request for the ledger, or passes (null). They're tried newest registration first, so a user's or plugin's formula goes before the built-ins. The ledger records the id of the one that priced it.
- **The built-ins** are registered at startup:
  - the six kinds, in picker order: OpenAI Chat Completions, Anthropic, OpenAI Responses, OpenRouter, DeepSeek, Google
  - the Anthropic explicit breakpoints, as a transform
  - the usage capture, as one observer per wire API
  - the cost formulas `builtin` (the price table), then `reported` (the provider's own figure), so a reported figure wins
- **`kind` and `api` are open strings** (`@rp/shared/providers.ts`), checked against the registry where they're used:
  - an unknown kind can't create a connection
  - a connection whose kind is gone, for example its plugin was removed, is `unusable`
  - `ListProviderKinds` gives the client the kinds in effect
- `test/providerStream.test.ts` registers a gateway kind and a transform in a scope, the way a plugin will. It streams through them, then closes the scope and checks that both are gone.

**Calling pi-ai.** The kinds' wire API implementations (pi-ai's lazy `api/*.lazy` modules for the built-ins) are called directly, never pi-ai's `Models` collection:
- **Each request gets:**
  - an explicit key: a placeholder for keyless local servers, since pi's direct calls require one
  - `env: {}`
  - `maxRetries: 0`, so retries happen only in our layer and are visible
  - the fiber's abort signal
  - our `fetch` (§2, outgoing requests)
  - `onResponse` for the status and `Retry-After`
  - `onProviderStreamEvent` for raw usage
- **The result:** no request can pick up a key from the server's environment.
- **The pi model** is built per request from the merged description (`resolveModel`). When pi's catalog entry is for the same wire API, it's the base, so its request settings carry over. For example, DeepSeek's `max_tokens` field and reasoning replay come from the catalog (`test/providerStream.test.ts` checks the request body).
- **Catalogs** (`catalog.ts`) belong to their kind and load on first use. pi-ai's per-provider catalogs serve the built-ins.

**Connections** (`Providers`):
- `createCredential`, `replaceCredentialKey` and `allowCredentialOrigin` (which checks the retyped key) handle credentials, and `setHeaders` and `setProxy` encrypt the other secrets (§2) before calling storage (§3.12).
- `createConnection` and `setKey` accept a key typed for a connection: it becomes a credential named after the connection, bound to its origin.
- **Before a request or a model-list fetch,** the connection's origin is checked against its credential, before the key is even decrypted. An origin the credential doesn't allow is `unusable`: "enter the key again to allow it", and nothing is sent.
- `refreshModels` fetches the upstream's list (`modelLists.ts`; OpenAI-style, Anthropic and Google formats, decoded with Schema) and merges each model over pi's catalog. What the list reports wins: OpenRouter's context length, pricing, modalities and parameters, vLLM's `max_model_len`.
- `testConnection` fetches the list and reports the route the request took.

**Streaming** (`stream`): a `Stream` of events:
- `attempt`
- `route`, e.g. "direct: no proxy configured"
- `text` and `thinking` deltas
- `retrying`
- `done`, with pi's final message, the counts and the cost

It fails with a typed `ProviderError`.

- **Error classes** (`errors.ts`):
  - `unusable`: no key, an unreadable secret, a route the API can't take
  - `auth`, `rate_limited`, `overloaded`, `context_overflow`, `refused`, `bad_request`, `network`, `aborted`, `unknown`

  They're classified from pi's final message, the HTTP status (or the status the SDK left at the start of the message), and pi's overflow and retry checks. A refusal carries Anthropic's category when given.
- **Retries happen only before the first token:** `rate_limited`, `overloaded` and `network`, with `Retry-After` honored or exponential backoff. After output, a failure is never retried; it ends the stream with `afterTokens`.
- **Rate limits:**
  - The status and `Retry-After` are read in our own `fetch` wrapper, because pi-ai's `onResponse` only fires for successful responses (the SDKs throw first).
  - A `Retry-After` pauses the whole connection. A request waiting on it emits a `paused` event, and the pause is checked after taking a concurrency permit, so queued requests honor it too.
  - A pause longer than the retry policy's maximum (60 s by default) fails fast as `rate_limited` instead of stalling silently.
- **Overflow:** a completed generation is never turned into a failure afterwards. An error counts as `context_overflow` only against a context window that some source reported, never against the default used for unknown models.
- **The stream always ends.** Typed failures go through its queue, and a defect becomes a `ProviderError` (`unknown`) instead of leaving the stream open. An invalid base URL is an `unusable` error.
- **A per-connection cap** (`max_concurrent`) queues requests.
- **Every attempt is a ledger row** (§3.12), opened and closed with `acquireUseRelease`, so it closes on every exit:
  - a stopped stream aborts the HTTP request and closes the row as `aborted`, wherever the interruption lands
  - a call that throws instead of reporting, and a defect, close it as `failed`
- **Secrets never appear in errors.** Error text (including the response bodies quoted in model-list errors, scrubbed before they're shortened) passes through a per-request scrubber before it's stored or shown. The scrubber covers the key, header values and the custom proxy URL with its password, longest first, and skips values under 6 characters.
- **Google:** pi-ai's adapter rejects a custom `fetch`, so a Google connection whose route is a proxy is refused as `unusable` rather than silently going direct.
- **A kind's wire API is fixed per connection.** If a plugin overrides a kind with another `api`, existing connections become `unusable` rather than silently speaking another API.
- **Forcing the proxy** (owner, 2026-10-11): with `forceProxy` in the network settings (admin), non-admins' connections ignore `direct` and custom proxies and use the instance proxy, and setting either is refused. The bypass list still applies; the admin sets it. Forcing needs a proxy (`setInstance` refuses it without one), and without a usable one, non-admins' requests are `unusable` rather than direct.

**Explicit cache breakpoints** (`breakpoints.ts`, PROVIDERS §8), for Anthropic Messages so far:
- **The caller names positions:** `options.breakpoints` lists indices into the request's `context.messages`, most important first.
- **The `onPayload` step finds their wire messages by alignment, not by index.** It walks the transcript and the payload in order and matches by role and text. pi-ai drops empty user messages, merges consecutive tool results and may append mid-conversation system messages, so positions shift.
- **The marker** goes on each message's last cacheable block (never a thinking block). It reuses pi-ai's own `cache_control` value, so TTLs match.
- **Limits:** nothing is added when pi placed no marker (caching off), and the total stays within Anthropic's four.
- **pi-ai's own markers stay:** the system prompt, the last tool, the last message.

**Usage and cost** (`usage.ts`):
- **Counts:** pi-ai's normalized usage (uncached input, cache reads, cache writes with Anthropic's 1-hour subset, output, reasoning) when the provider reported usage.
  - The provider's raw usage object is kept with it. OpenRouter's reported cost and routed upstream are read from it.
  - Usage is estimated from the context and the output when the provider produced output without reporting usage, and unknown when nothing came back.
  - A stopped or failed request records as output at least the tokens of the text that arrived, marked `estimated` when that's more than reported. Anthropic's `message_start` reports only a placeholder output of 1.
- **Cost:** from the cost-formula registry (above). With the built-ins only: the provider's reported cost when there is one, otherwise the price table.
  - The formula uses per-million rates from the model's price (catalog or list), with the context-size tier on total input.
  - Long cache writes are priced at twice the input rate.
  - User formulas aren't built yet.

**Tested** (`test/providerStream.test.ts`) against a scripted provider speaking the real wire formats (`test/support/mockProvider.ts`):
- OpenRouter streaming with reported cost and upstream, and the built-in cost
- a 429 retried with each attempt recorded
- a mid-stream failure kept and not retried, a 401 not retried
- stopping, a missing key, Google behind a proxy
- Anthropic's cache split and catalog pricing
- explicit breakpoints through pi-ai's real Anthropic conversion
- DeepSeek's dialect
- a keyless local server

**Client RPCs** (`api/providers.ts`, contract in `@rp/shared/api.ts`):
- **Connections:** `ListConnections`, `CreateConnection` (with an existing credential or a typed key), `UpdateConnection`, `SetConnectionKey`, `SetConnectionCredential`, `SetConnectionHeaders`, `SetConnectionProxy`, `DeleteConnection`, `TestConnection`.
- **Credentials:** `ListCredentials`, `CreateCredential`, `RenameCredential`, `ReplaceCredentialKey`, `AllowCredentialHost` (the key typed again), `DeleteCredential`.
- **Models:** `RefreshModels`, `ListModels`, `AddUserModel`, `EditModel`, `SetModelHidden`.
- **Network and usage:** `GetNetworkSettings`/`SetNetworkSettings` (admins only, otherwise `Forbidden`), and `ListLlmRequests`.
- **Errors keep their tags** (`NotFound`, `StaleWrite`, `ModelKeyTaken`, `ProviderError`, `Forbidden`, from `@rp/shared/errors.ts`). Storage and worker failures are logged on the server and reach the client only as `ServerError`, including from the provider operations and network settings.
- `test/rpc.test.ts` checks over a real WebSocket that a key never comes back out. Cross-user access is checked by the isolation matrix (§4).
- **At startup,** requests a previous process left `running` are marked `interrupted`.


---

## 7. Deployment

`Dockerfile`: a multi-stage build on `node:24-slim`.
- The client and the database workers are built in one stage. The final image holds only what runs: production dependencies, the root `package.json` and lockfile (the bundles' stamp includes it), the shared and server packages' `package.json` and `src`, the client build and the worker bundles. No tests or scripts.
- `.dockerignore` keeps data directories, databases (`*.db*`, `*.sqlite*`), `secret.key`, `instance.lock` and `.env` files out of the build context at any depth (`**/`). Verified with throwaway builds: files planted in `packages/server/data/` (including `.sqlite`), `packages/shared/` (`.db-wal`, `.sqlite3`) and `packages/server/.env` didn't reach the image.
- It runs as the `node` user with `DATA_DIR=/data` as a volume, `HOST=0.0.0.0`, and a health check on `/healthz`.
- **It doesn't start without exposure settings** (§4), since `HOST=0.0.0.0` is beyond loopback; CI checks this. Connections from the host arrive from the bridge gateway (e.g. `172.17.0.1`).
  - Behind a reverse proxy: `AUTH_MODE=proxy`, `TRUSTED_PROXIES` set to the proxy container's address, and `PUBLIC_ORIGINS` set to the public URL.
  - Built-in login: set `ADMIN_PASSWORD_FILE` (a Docker secret). The server then starts with the admin protected, and no browser needs to reach loopback. Until the login page exists, logging in takes a `POST /auth/login` by hand.
  - Single user without a password: publish on loopback only (`-p 127.0.0.1:8080:8080`) and set `ALLOWED_IPS` to the gateway.
  - Publishing beyond loopback (`-p 8080:8080`) makes the gateway allowlist unsafe: where Docker doesn't pass the client's address through (rootless Docker's default port driver, `docker-proxy` for IPv6 clients), outside clients also appear to come from it.
  - **The health check** fetches `127.0.0.1` on `PORT` inside the container. In proxy mode with `TRUSTED_PROXIES` set, add `127.0.0.1` to the list, or the container reports unhealthy. Inside a container, loopback is only the container's own processes, which can read `/data` and the server secret anyway.
- The image is about 325 MB on disk, unoptimized so far: it installs every workspace's production dependencies. Memory at idle is about 188 MB.

---

## 8. Import formats: cards and lorebooks

**Documents** (`@rp/shared/docs/`, Effect Schema). Each has a `schema_version`.
- **Cards** (`card.ts`): the union of Character Card V2 and V3, in the specs' field names, plus card modules (`modules[]`, DESIGN §4.1).
  - `extensions` is the card's `data.extensions`, verbatim, so `extensions.<plugin-id>` survives (PLUGINS §3.3).
  - Keys the specs don't define are kept verbatim too: `unknown_fields` for those in `data`, `unknown_root_fields` for the top level. They can't go in `extensions`: an export would then write them to a different place, or a plugin's namespace could collide with them.
- **Lorebooks** (`lorebook.ts`): ST's World Info entry fields in snake_case, the same document for standalone lorebooks and a card's `character_book`. ST's numeric enums are named (`position: "at_depth"`, `role: "system"`, `selective_logic: "and_any"`). Each entry has a unique safe-integer `uid`, so the three-way merge (§3.9) matches entries by it. On import, usable ids are kept (the first wins), and every other entry, missing, invalid or duplicate, gets a number after the largest, so renumbering never takes an id another entry has. A card book id that isn't a whole number is kept in `unknown_fields` and written back on export. Our own fields are `decision_hint` and `placement_override`.

**Parsers** (`packages/server/src/formats/`) are pure functions over bytes: no database, no files. Each returns an `Effect` that fails with `FormatError` when the file can't be imported at all. Everything recoverable becomes an issue in the `ImportReport` (`@rp/shared/importReport.ts`) instead, so one bad field never costs the whole file.
- **Lenient fields** (`fields.ts`). A missing or null field takes its default quietly, as in ST. A field of the wrong type takes its default too, and the report names its path. Whole numbers must be safe integers (up to 2^53), as `Schema.Int` requires; file values are only converted to text when they are text or numbers, since an object's `toString` can throw.
- **Bounded reports** (`ReportBuilder`, `@rp/shared/importReport.ts`). At most 200 issues per file, then one `report.truncated` issue with the count. Paths keep 16 segments; file text quoted in a message or path is cut to 40 characters (`shownText`). Stream D's preset report uses the same numbers.

**Card import** (`importCard`, `cardImport.ts`, `card.ts`). The format comes from the bytes, never the file name.
- **JSON:** detection follows ST: any `spec` with a `data` object is V2 or V3 (an unknown spec is read as V3, with a warning), otherwise a `name` means V1. V1 is mapped as ST maps it (its placeholder creator note dropped, comma-separated tags split).
- **ST's top-level copies** of V1 fields and its local state (`chat`, `create_date`, `fav`, `avatar`) aren't kept; other top-level keys are.
- **The embedded `character_book`** is mapped as ST's `convertCharacterBook` does: ST's World Info fields come out of each entry's `extensions` into the entry, with its defaults; whatever else is in `extensions` stays. One deliberate difference: the spec's own `case_sensitive` is the fallback when the extension has none (ST ignores it). An entry without `enabled` is disabled, as in ST, with a warning.
- **Card modules** come back from `extensions.rp_harness.modules`, where an export puts them.
- **PNG** (`png.ts`): the card is base64 JSON in a `tEXt` chunk. As in ST (`src/character-card-parser.js`), `ccv3` wins over `chara`, keywords match in any case, and a bad CRC or a missing IEND rejects the file. The avatar returned is the PNG without its card chunks. V3's `chara-ext-asset_` chunks are skipped with a note (the spec discourages them; ST ignores them).
- **CHARX** (`zip.ts`, our own reader of the central directory; stored and deflated entries only): `card.json` at the root, or else, as in ST, the first entry whose name ends in `card.json`. It must be V2 or V3. Assets come from `embeded://`, `embedded://` and `__asset:` URIs, normalized as ST normalizes them. The avatar is the main icon, as ST picks it. Only ST's image formats are extracted; other assets (audio, Risu modules and scripts) and unreferenced files are reported and skipped. Each returned file keeps the URI the card's `assets` use for it.

**Card export** (`cardExport.ts`) flattens a card document to a standard card.
- **V2 and V3 carry the same `data`,** V3's fields included, as ST's two PNG chunks do. V2 also has the V1 fields at the top level, for V1 readers. Fields the specs don't define go back where they came from, written first, so they never override a defined field.
- **The embedded lorebook** is written as ST's `convertWorldInfoToCharacterBook` writes it, our own entry fields in `extensions.rp_harness`. One difference: `use_regex` is false unless the entry says otherwise. ST writes true, but its keys are plain text, which a V3 reader would take as patterns. An imported `true` is kept, though it's usually ST's boilerplate: ST never reads the field. The keyword matcher, when it's built, must decide whether to honor `use_regex` before it lands.
- **Card modules:** only exportable ones, into `extensions.rp_harness.modules`. Private ones never leave.
- **PNG:** existing card chunks are removed, then `chara` (V2) and `ccv3` (V3) go in before IEND, as ST writes them. The image must be a valid PNG.
- **CHARX:** `card.json` (V3), the avatar as the main icon (at its own path if it came from a CHARX, otherwise `assets/icon/images/main.<ext>`), and each embedded asset whose file is given. An embedded asset without a file, with a path outside the archive's folder, or with a name already taken (`card.json`, the avatar's, another asset's) is left out of the card, so our own import takes every export back.
- **Round trips are lossless:** an exported card imports back to the same document, in every format, and keeps every field of the file it came from (`test/formats/cardExport.test.ts`). The exceptions are ST's top-level copies and local state, and private modules.

**Lorebooks** (`worldInfo.ts`, `lorebook.ts`).
- **ST World Info files** import with `importLorebook` and export with `exportLorebook`. A file must have `entries` (an object keyed by uid, or a list), as ST's import requires. Missing fields take the defaults of ST's `newWorldInfoEntryDefinition`. Entry `extensions` are kept verbatim, as ST keeps them. The book is named after the file unless it names itself. ST's `originalData`, a copy of the card book a World Info file was made from that goes stale with every edit, is dropped with a note.
- **A card's `character_book` and World Info** convert through the same document, following ST's two conversions (`convertCharacterBook`, `convertWorldInfoToCharacterBook`). What one format has no place for is lost going to the other, as in ST: a card book's settings (description, scan depth, token budget, recursive scanning) and its entries' `name`, `priority` and `use_regex` don't go into World Info, and World Info's character filter doesn't go into a card book.
- **Our own entry fields** (`decision_hint`, `placement_override`) are written to `extensions.rp_harness` in both formats and read back from there.
- Round trips are lossless within each format: an export keeps every field of the file it came from (except `originalData`) and imports back to the same document.
- Not supported: other lorebook formats ST converts (NovelAI, Agnai, RisuAI), and V3's standalone `lorebook_v3`.

**Hardening** (`safety.ts`). These parse untrusted files, so every input is capped (`defaultLimits`), and each cap has a test with a crafted file that fails when the check is removed.

| Cap | Default | Why |
|---|---|---|
| File size | 64 MiB | Bounds memory and work for everything below |
| Card JSON | 8 MiB | About 2M tokens of text, more than any model's context holds: a bigger card couldn't be used. Applies to a JSON file, a PNG's card chunk once decoded, and a CHARX's `card.json` |
| World Info JSON | 32 MiB | Lorebooks are scanned, not sent whole, so they can outgrow a context: a full lorebook with 2 KB of content per entry fits. The value cap, not this one, bounds the parse work |
| JSON nesting | 64 levels | Real cards nest about 8 deep. Counted in the bytes before parsing, which also bounds the recursive walk after it |
| JSON objects and lists | 250,000 | Counted before parsing: 10M empty objects in 32 MB cost `JSON.parse` 1.1 GB. A full lorebook has about 60,000 |
| JSON values and keys | 1,200,000 | Counted before parsing (every comma and colon): parsing costs about 1 µs each, and a 30 MiB list of zeros took 4 s and 1.1 GB without it. ST writes about 110 per entry, so a full lorebook has 1.1M |
| Prototype keys | 100 | Each is dropped with a warning; more make the file hostile |
| Lorebook entries | 10,000 | An assumption to revisit with real files: a lorebook of a few thousand entries is already exceptional. 20,000 full ST entries would need 2.2M values, about 2 s of parsing |
| PNG chunks | 16,384 | Bounds the chunk walk |
| PNG chunk size | 32 MiB | Checked against the declared length before anything is read |
| Zip entries | 1,024 | Bounds the directory walk |
| Zip entry, uncompressed | 64 MiB | Checked against the declared size before inflating |
| Zip total, uncompressed | 128 MiB | Over every entry extracted from one archive |
| Compression ratio | 100 | For entries over 1 MiB; a zip bomb's is in the thousands |

- **Inflating stops at the declared size** (`maxOutputLength`), so a header that understates an entry can't make the parser allocate more than the caps allow (`zip.bomb`). Sizes and CRCs are checked after.
- **Zip paths** must stay inside the archive: no `..` segment, leading `/`, backslash, drive letter or NUL. One bad path, duplicate name or encrypted entry rejects the whole archive, so an importer that later writes files by these names can't be pointed elsewhere.
- **Prototype keys** (`__proto__`, `constructor`, `prototype`) are dropped right after `JSON.parse`, with a warning. `JSON.parse` makes them plain own keys, but a later assignment, `Object.assign` or merge can turn one into a prototype change.
- **Nothing in a file is executed or rendered.** Scripts in a card (RisuAI's modules, Lua assets) are skipped, never stored.

**Known limits:**
- **The importer must run the parsers off the main thread.** They're synchronous: measured on this host under load (2026-10-11, load average 25), the worst file within the caps (one object of 595,000 keys) took 850 ms and 80 MB of heap, a list of 1.19M short strings 460 ms, and a full lorebook (10,000 entries with every ST field and 2 KB of content, 29 MiB) 480 ms. The walk after parsing steps through lists by index and skips scalars, and unknown fields and extensions are kept by deleting the known keys from the parsed objects instead of copying them. On the main thread that would stall every live stream (§3.1).
- Not built yet: the importer itself (storing the document, the avatar and assets, and the report), and registering these formats as importers (PLUGINS §8).
