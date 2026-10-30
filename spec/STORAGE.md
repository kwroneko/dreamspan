# Storage engine: SQLite vs Turso

**Status**: Engine choice implemented; obsolete as an implementation proposal (2026-10-30). ARCHITECTURE §3 documents `node:sqlite` through Effect’s driver, FTS5, reader/writer workers, instance locking and the connection design. The Turso evaluation (§1–§2) remains a reference for revisiting it, not an implemented alternative. Original proposal: 2026-10-10; the owner asked that Turso be considered before the Effect spike. The recommendation remains SQLite behind a thin database layer, revisiting Turso later. Nothing here is newly Decided.
**Related**: DATA-MODEL.md (§12 search), EFFECT.md §4 (driver choice), DESIGN §8 (memory retrieval).

---

## 1. What we hoped Turso would bring

In the owner's order of importance:
1. **Indexed vector search (ANN).** sqlite-vec only scans by brute force, and the owner is hitting its limits in Panoptikon. Vector search is assumed to arrive eventually (DESIGN §8). sqlite-vec covers it at chat scale; an index would matter for search across all of a user's chats.
2. **Built-in full-text search** (tantivy in place of FTS5).
3. **Concurrent writers** (MVCC, `BEGIN CONCURRENT`). Only a modest benefit, since we may serialize writes internally anyway.

---

## 2. Findings (2026-10-10, `@tursodatabase/database` 0.8.1, Node 24.15)

Tested in a scratch project with synthetic data. The docs were also read, and they lag behind the code in both directions.

**Maturity.**
- The current release is 0.8.2, still pre-1.0, tracking SQLite 3.50.4. The README says it runs in production at several organizations, but tells users to "keep independent backups".
- FTS, encryption, multi-process WAL and CDC are experimental. MVCC is "not production ready".

**Vectors: no ANN index.**
- It has vector types (f32, f64, int8, 1-bit, sparse) and distance functions, but every search is a brute-force scan.
- The DiskANN issue (#832) is open, and in August 2026 the maintainers said vector indexes are "not part of our short-term roadmap".
- For vectors, Turso is roughly sqlite-vec without the extension. **The main hoped-for benefit doesn't exist yet.**
- libSQL (Turso's C fork) does have DiskANN, but its binding panicked in our test. It's a separate engine and wasn't evaluated further.

**FTS (tantivy): promising, not ready.**
- **Works:**
  - the index updates within the same transaction as the table (no triggers)
  - BM25 scoring, per-column weights, highlighting, phrase/AND/NOT queries
  - queries faster than FTS5 on common terms
- **Broken or missing in our tests, each matching an open issue:**
  - prefix queries silently return nothing (#8167)
  - no stemming or diacritic folding (#8911)
  - no `snippet()`
  - scores of 0 with some parameter bindings (#7636)
  - ranking inverted when combined with another filter (#7524)
  - row-by-row inserts get quadratically slower (3,000 rows took 60 s, #8170)
- It needs an experimental flag.

**SQL compatibility.**
- **Passed:** recursive CTEs, JSON functions, window functions, UPSERT/RETURNING, partial and expression indexes, triggers, views, savepoints, `BEGIN IMMEDIATE`, WAL, STRICT, 1 MB blobs.
- **Missing or limited:**
  - stored generated columns
  - `WITHOUT ROWID` updates and deletes
  - `INSTEAD OF` triggers
  - FTS5
  - loadable extensions (so no sqlite-vec)
  - JS user-defined functions
  - commit/update hooks
  - the backup API

**Node binding and Effect.**
- The promise API still runs queries on the JS thread.
- No Effect SQL driver exists. `@effect/sql-libsql` targets libSQL, not this engine. A custom `SqlClient` adapter would be a few hundred lines.

**Switching back to SQLite** costs this:
- a file with a Turso FTS index won't open in SQLite until the index is dropped (after that, `integrity_check` passed)
- MVCC data must be checkpointed out first
- all `fts_*` and vector SQL must be rewritten

---

## 3. Proposal [P]

**Use SQLite through Node's built-in `node:sqlite`, with the official Effect driver `@effect/sql-sqlite-node`** (EFFECT.md §4).

What we checked for `node:sqlite` on Node 24.15 (SQLite 3.51.3):
- FTS5 works
- `loadExtension` works (so sqlite-vec remains an option)
- JS user-defined functions and aggregates are available
- the session/changeset API is available
- no adapter code needs writing

reference-harness's single-writer pattern carries over: writes are serialized through one connection.

**Keep the engine swappable:**
- All SQL goes through our own storage modules, never from feature code.
- Engine-specific search (FTS5 `MATCH`, bm25, snippet, and later vectors) lives behind one search-service interface. That's also where RRF fusion belongs (DESIGN §8).
- No schema features that would block a move: avoid relying on stored generated columns, `WITHOUT ROWID` tables that need updates, and `INSTEAD OF` triggers, unless they buy something real.

**Revisit Turso** when it ships an ANN index and its FTS issues above are closed. At that point the search-service interface is the only place that changes.

---

## 4. Open

- ~~`node:sqlite` vs better-sqlite3.~~ **Implemented: `node:sqlite`** through `@effect/sql-sqlite-node`, running only in worker threads (ARCHITECTURE.md §3). The owner approved going ahead on this basis (2026-10-10).
- **[O]** Vector search for memory retrieval: per-chat sqlite-vec (partitioned, quantized with rescoring) is probably enough for single-chat retrieval. Search across chats is where an ANN index would be needed. To be decided when memory retrieval is designed.

Test scripts used for §2 are in the session scratchpad and are not committed.
