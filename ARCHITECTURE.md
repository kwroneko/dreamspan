# Architecture

This document describes only what is implemented. Proposals live in `spec/`. When a spec is implemented, its content moves here in the same commit (CLAUDE.md "Design docs").

**State**: Phase 0 (PLAN.md), 2026-10-10. Built: the scaffold, the full schema, the message-graph operations, the library operations and drafts. Not yet built: built-in login, the provider layer, and every chat feature.

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

**Runtime.** Node 24 runs the server's TypeScript directly through type stripping, so the code must use erasable syntax only (`erasableSyntaxOnly`). The client is bundled, and so are the database workers for production (§3.6). The server's main thread runs from source.

Bun was measured as an alternative (2026-10-10) and not adopted. On this server it gave the same RPC latency and throughput and 13% less memory, but it has no `node:sqlite`, stubs the event-loop delay API, and Effect's Node HTTP layer errors under it. Bundling the workers saves far more memory on Node.

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
| `DB_WORKERS` | `bundle` in production, else `source` | Worker entry points (§3.6) |
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

### 3.6 Worker bundles

Each worker thread is a separate V8 isolate that loads its own copy of every module it imports. Loading Effect's module graph from source costs about 85 MB per worker. `npm run build` therefore bundles the two worker entry points into single tree-shaken files with rolldown (`packages/server/scripts/build-workers.ts` writes `packages/server/dist/workers/{writer,reader}.mjs`). A bundled worker costs about 19 MB (measured in `test/database.test.ts`, which fails above 40 MB).

`DB_WORKERS` selects the entry points:
- `source` is the default outside production, so development never runs a stale bundle.
- `bundle` is the default when `NODE_ENV=production`. The server refuses to start if the bundles are missing (`WorkerBundleMissing`).

The tests run the core operations against both.

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

Conventions:
- **Tables:** all `STRICT`, with JSON columns guarded by `json_valid` CHECKs and timestamps in epoch milliseconds.
- **Ids:** UUIDv7 (`@rp/shared/id.ts`), so `ORDER BY id` follows creation order.
- **Concurrency:** mutable rows carry `row_version` for optimistic concurrency.
- **Mutual references** (`slots.selected_version_id` ↔ `versions.slot_id`, a summary ↔ its selected revision) use deferred foreign keys. The version row is inserted first, then the slot, in one transaction.

**Invariants enforced by the database** (`schema/integrity.ts`). No code path can break these, and `test/schema.test.ts` checks each one on a bare connection:
- **Edits are non-destructive.** Changing content creates new rows; it never overwrites. Deliberate deletion is allowed, and foreign keys keep it consistent: for example, a slot can't be left selecting a deleted version, and deleting a chat removes everything in it, its chat-local overrides and drafts included.
  - Model-written versions are frozen once they stop generating.
  - Amending a user-written version copies the previous content into `version_history` automatically.
  - Entity revisions and summary revisions are immutable.
  - A rollout's context snapshot is frozen once written.
  - State events can only be superseded, not changed.
- **The graph is append-only.**
  - A slot's parent is in the same chat, one level up.
  - A slot never moves.
  - A version's slot, writer and origin never change.
- **References stay inside their chat.**
  - A slot selects only its own versions, which is what invariant 3 rests on.
  - A chat's active leaf is one of its slots.
  - A state event's slot is in its chat, and its version is in that slot.
  - A summary selects only its own revisions.

**Full-text search** (`schema/search.ts`). FTS5 external-content indexes cover `versions.content`, `summary_revisions.content` and `entity_revisions.search_text`, using `unicode61` with diacritic folding and prefix indexes, and triggers keep them in sync.
- Each indexed table has an `INTEGER PRIMARY KEY seq` (a rowid alias) next to its public `id`. That's because `VACUUM` can renumber the implicit rowids of TEXT-keyed tables, which would silently corrupt an external-content index.
- Versions are indexed only once they stop generating, so streaming doesn't churn the index.

### 3.8 Message graph operations

Contracts are in `db/ops.ts`, writes in `db/writes.ts` (writer worker), reads in `db/reads.ts` (readers). Domain types are in `@rp/shared/chat.ts`; state-event keys and the fold are in `@rp/shared/state.ts`.

- **Writes:**
  - `CreateEntity`: entity, first revision and base ref. Minimal until the library work.
  - `CreateChat`: pending or active, with participants joined at the initial position and an optional greeting as the root slot.
  - `AppendMessage`: a new slot under any slot, becoming the active leaf; appending under a slot that has children is a branch. The first message turns a pending chat active.
  - `AddVersion`: swipe, edit, or write your own, optionally selected.
  - `SelectVersion`: with `expectedRowVersion`, failing as `StaleWrite` for a stale tab.
  - `AddStateEvent`: at a position, optionally attached to a version.
- **Reads:**
  - `GetChat`
  - `GetPath`: a window, below.
  - `ListVersions`
  - `StateEventsAt`: the events that apply at a slot, in fold order. Version-attached events count only while their version is selected.
- **Ownership.** Every operation takes the acting user and touches only that user's rows. Anything else is `NotFound`, so another user's data isn't even confirmed to exist. That includes using someone else's card as a speaker or participant.
- **State events are typed.** `StateEventData` is a Schema union of the keys in DATA-MODEL §5.3, so an unknown key or malformed value is rejected when the RPC payload is decoded, before it reaches the database. `foldState` is a pure function shared by server and client.
- **Paths are read in windows.** `GetPath` walks up from a leaf and stops after `limit` slots (at most 1000), so its cost depends on the window, not the chat's length. Older history comes from the window ending at the earliest entry's parent.
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
- **"Update available"** is derived, not stored: the followed ref's head differs from the merge base.
- Documents are any JSON object for now. Per-kind schemas arrive with the importers (PLAN phase 1).
- A content hash over canonical JSON (sorted keys) means an edit or re-import that changes nothing creates no revision.

**Operations.**
- **Writes:**
  - `CreateEntity`
  - `EditRef`: a new revision on the head, with `expectedRowVersion`
  - `ForkRef`: a new variant
  - `CreateChatOverride`
  - `PromoteOverride`: override to variant
  - `ImportUpstream`: a new upstream revision
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
- **Ownership** is enforced as in §3.8.

**Changes flow to followers.** After any change to a ref (an edit, an import, a merge), every ref following it is merged in turn, transitively: upstream, then variants, then the chat overrides that follow those. Each follower ends as one of:
- **fast-forward:** it had no edits of its own since the last merge, so it simply moves to the new revision, with no merge revision
- **merged:** a merge revision with two parents
- **conflicts:** left exactly as it was, with "update available" set until the user resolves it

The outcomes are returned, so the UI can report what happened.

**Three-way merge** (`merge3`, shared so the server's merge and the resolver's preview always agree):
- Objects merge per key.
- **Arrays merge per element when every element has a unique `id`, `identifier` or `uid`.** That covers preset prompts and order, card modules and lorebook entries, so additions on either side survive and deletions apply unless the other side edited the element (then it's a conflict). Order follows ours, with theirs' new elements placed after their predecessor in theirs.
- Other arrays are atomic.
- **Text changed on both sides merges word by word** with diff3 (`node-diff3`), keeping whitespace. Edits to different sentences of the same prompt combine; overlapping edits conflict. A conflict keeps ours in the merged value and is reported with its path, e.g. `["prompts", "identifier=main", "content"]`.
- `test/library.test.ts` and `packages/shared/test/merge.test.ts` run the owner's case from DESIGN §4 end to end: a softened impersonation rule and an added `{{summary}}` prompt survive an upstream re-import that rewrote another sentence of the same prompt, changed a sampler and added a prompt.

**Known limits:**
- Reordering on both sides isn't detected as a conflict (ours wins).
- Arrays without element identities, like a card's `alternate_greetings` or `tags`, are atomic: changing them on both sides is a conflict.
- Not built yet: export (flattening a ref to a V2/V3 card), library search, and "used by N chats".

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
- `RestoreDraftState` moves the draft back to that state, and records the restore as its own entry, so it can be undone too.
- At most 1000 entries and 1,000,000 changed characters are kept per draft, oldest dropped first.

**Committing.** `AppendMessage`, `AddVersion` and `EditRef` take an optional `commitDraft` (key plus the row version the client sent from) and commit that draft **in the same transaction**, so a reload never shows already-sent text in the composer. If the draft moved on since (another tab kept typing), it stays active with the newer text, and the write returns it. `ClearDraft` commits or discards a draft explicitly.

**History only lives while a draft is being written** (owner, 2026-10-10). Once committed, the text is preserved in a version or revision, so a commit or discard deletes the draft's history and empties its text. The row stays, so other tabs' row versions keep working. What a commit would otherwise lose is kept in `recovery`, one text per draft, replaced at the next commit or discard:
- **On commit:** the text from just before the session's newest destructive change, if there was one. That's the wipe-then-send case.
- **On discard:** the discarded text.

Edits of existing content need no recovery: their previous version or revision is immutable. The next save after a commit starts a fresh session. `ListActiveDrafts` lists drafts with unsent text.

**The composer belongs to a branch** (DESIGN §6.2, owner):
- Its key is the chat plus the slot the next message goes under (the branch tip), or empty before the first message.
- Each chat and each branch has its own composer, and a half-typed message waits where it was left.
- `AppendMessage` moves the composer at the old tip to the new slot. That way a model reply carries text typed meanwhile forward, and a send's recovery text follows the conversation.
- `CopyComposer` copies the text to a new branch's tip when a branch is started, never overwriting text already there.
- Switching between existing branches carries nothing.

**Cleanup.** Draft targets aren't foreign keys, since one column points into several tables. Triggers delete a draft when its target (chat, slot, version, summary, ref) is deleted (`test/schema.test.ts`).

**Not built yet:** pushing a draft change to the user's other open tabs and devices. That needs the subscription channel; until then, the row version catches the conflict when the other tab saves.

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
- The client and the database workers are built in one stage. The final image holds production dependencies, the server and shared sources, the client build and the worker bundles.
- It runs as the `node` user with `DATA_DIR=/data` as a volume, `HOST=0.0.0.0`, and a health check on `/healthz`.
- The image is about 325 MB on disk, unoptimized so far: it installs every workspace's production dependencies. Memory at idle is about 188 MB.
