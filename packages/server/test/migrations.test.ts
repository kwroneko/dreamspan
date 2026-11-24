// The current baseline schema, fresh defaults and refusal of incompatible migration ledgers.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit, Layer, Logger } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import { DatabaseStartup, migrate, migrationDefinitions, Migrations, migrations } from "../src/db/migrations.ts"
import { FORK_SUMMARY_FORMAT, summaryValidSql } from "../src/db/summaryValidity.ts"
import { tempDir } from "./support/tempDir.ts"

interface Entry {
  readonly type: string
  readonly name: string
  readonly tbl_name: string
  readonly sql: string
}

/** Recorded current sqlite_master, including deliberate baseline edits; no seed rows. */
const chain = (
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/preSquashSchema.json"), "utf8")) as {
    schema: ReadonlyArray<Entry>
  }
).schema

/** Every message down an error's cause chain. */
const messages = (error: unknown): string => {
  const out: Array<string> = []
  for (let e: unknown = error; e instanceof Error; e = e.cause) out.push(e.message)
  return out.join(" / ")
}

const layer = () => writerConnection(join(tempDir("mig"), "db.sqlite"))

/** Fake migrations for the tests below, numbered after the newest real one, so new real ones never collide. */
const newestReal = Math.max(...Object.keys(migrationDefinitions).map((key) => Number(key.slice(0, 4))))
const fakeKey = (name: string, offset = 1) => `${String(newestReal + offset).padStart(4, "0")}_${name}`
/** The real migrations after 0005, which the tests below leave pending on a database at 0005. */
const after5 = Object.keys(migrationDefinitions)
  .filter((key) => Number(key.slice(0, 4)) > 5)
  .sort()

const upTo = (id: number) =>
  Object.fromEntries(Object.entries(migrationDefinitions).filter(([key]) => Number(key.slice(0, 4)) <= id))

/** Pins of chats that aren't there, made with foreign keys off as an outside tool would. */
const orphanPins = (chats: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT OR IGNORE INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
    yield* sql.unsafe("PRAGMA foreign_keys = OFF")
    for (const chat of chats) yield* sql`INSERT INTO chat_pins (user_id, chat_id) VALUES ('u', ${chat})`
    yield* sql.unsafe("PRAGMA foreign_keys = ON")
  })

const newestRecorded = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql<{ id: number }>`SELECT max(migration_id) AS id FROM effect_sql_migrations`)[0]!.id
})

const pragmaValue = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql.unsafe(`PRAGMA ${name}`)
    return Object.values(row!)[0]
  })

describe("0001_baseline", () => {
  it.effect("bumps existing connections for provider setting writes, never for reads or unchanged values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Effect.scoped(Layer.build(Migrations))
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
      yield* sql`INSERT INTO connections (id, owner_user_id, name, provider, kind, api, created_at, updated_at)
        VALUES ('c', 'u', 'Synthetic', 'anthropic-bedrock', 'anthropic-bedrock', 'anthropic-messages', 0, 0)`
      const revision = () =>
        sql<{ cache_revision: number }>`SELECT cache_revision FROM connections WHERE id = 'c'`.pipe(
          Effect.map(([row]) => row!.cache_revision)
        )
      const start = yield* revision()
      // Each provider setting can change the transport or the reusable prefix.
      for (const [index, changes] of [
        { auth: "aws-sigv4" },
        { region: "eu-west-3" },
        { cacheBreakpoints: "explicit" },
        { lookback: true },
        { maxMarkers: 3 },
        { minTokens: 1024 },
        { promptCacheKey: true }
      ].entries()) {
        const encoded = JSON.stringify(changes)
        yield* sql`UPDATE connections SET provider_settings_json = ${encoded} WHERE id = 'c'`
        assert.strictEqual(yield* revision(), start + index + 1)
        yield* sql`UPDATE connections SET provider_settings_json = ${encoded} WHERE id = 'c'`
        yield* sql`SELECT * FROM connections WHERE id = 'c'`
        assert.strictEqual(yield* revision(), start + index + 1)
      }
      yield* sql`UPDATE connections SET name = 'Renamed', row_version = row_version + 1 WHERE id = 'c'`
      assert.strictEqual(yield* revision(), start + 7)
    }).pipe(Effect.provide(layer()))
  )
  it.effect("matches the recorded baseline schema and seeds nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "0001_baseline": migrations["0001_baseline"] }) })
      const master = yield* sql<Entry>`SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> 'effect_sql_migrations'`
      const made = master
        .map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql: sql.replace(/\s+/g, " ") }))
        .sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name))
      assert.deepStrictEqual(made, chain)

      const tables = master.filter(
        (entry) => entry.type === "table" && !/_(data|idx|docsize|config|content)$/.test(entry.name)
      )
      for (const table of tables) {
        const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM ${sql(table.name)}`
        assert.strictEqual(row!.n, 0, table.name)
      }
    }).pipe(Effect.provide(layer()))
  )
  it.effect("checks value lists with triggers, on insert and on update", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "0001_baseline": migrations["0001_baseline"] }) })
      const bad = yield* Effect.flip(
        sql`INSERT INTO jobs (id, kind, status, payload_json, created_at, updated_at) VALUES ('j', 'k', 'odd', '{}', 0, 0)`
      )
      assert.match(messages(bad), /jobs\.status must be one of pending, processing, complete, failed/)
      yield* sql`INSERT INTO jobs (id, kind, payload_json, created_at, updated_at) VALUES ('j', 'k', '{}', 0, 0)`
      const update = yield* Effect.flip(sql`UPDATE jobs SET request_class = 'odd' WHERE id = 'j'`)
      assert.match(messages(update), /jobs\.request_class must be one of/)
      yield* sql`UPDATE jobs SET status = 'complete' WHERE id = 'j'`
    }).pipe(Effect.provide(layer()))
  )
})

describe("0002_files", () => {
  it.effect("upgrades a baseline database, keeping its rows, and guards the new tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "0001_baseline": migrations["0001_baseline"] }) })
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at)
        VALUES ('u', 'u', 'Owner', 'user', 0), ('v', 'v', 'Other', 'user', 0)`
      yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('c', 'u', 'rp', 'active', 0)`
      yield* sql`INSERT INTO drafts (id, user_id, target_kind, target_id, content, updated_at)
        VALUES ('d', 'u', 'composer', 'c', 'Synthetic draft', 0)`
      yield* sql`INSERT INTO media_assets (id, sha256, mime, byte_size, path, created_at)
        VALUES ('m', 'aa', 'image/png', 3, 'aa.png', 0)`
      yield* sql`INSERT INTO composer_images (id, draft_id, media_id, alt_text, status)
        VALUES ('i', 'd', 'm', 'A lighthouse', 'active')`
      yield* Effect.scoped(Layer.build(Migrations))
      const ledger = yield* sql<{ name: string }>`SELECT name FROM effect_sql_migrations ORDER BY migration_id`
      assert.deepStrictEqual(
        ledger.map((r) => r.name),
        [
          "baseline",
          "files",
          "subagents",
          "workshop_branches",
          "preview_macro",
          "persona_locks",
          "contract_records",
          "attachment_paths",
          "share_invitations",
          "share_birth",
          "guidance_target",
          "reasoning_stats",
          "native_reasoning",
          "composer_save_session",
          "composer_commits",
          "workshop_starts",
          "library_attachments"
        ]
      )
      // The existing row is kept, an image by default.
      assert.deepStrictEqual(yield* sql`SELECT id, alt_text, kind, name FROM composer_images`, [
        { id: "i", alt_text: "A lighthouse", kind: "image", name: null }
      ])
      assert.includeMembers(
        (yield* sql`PRAGMA table_info(version_attachments)`).map((r) => r.name),
        ["name", "path"]
      )
      yield* sql`INSERT INTO file_versions (id, owner_user_id, path, media_id, byte_size, origin, created_at)
        VALUES ('f', 'u', 'notes/plan.md', 'm', 3, 'agent', 0)`
      // Versions never change; a call is named whole or not at all; nothing is shared with its owner.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(sql`UPDATE file_versions SET path = 'x' WHERE id = 'f'`)))
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(sql`INSERT INTO file_versions (id, owner_user_id, path, byte_size, origin, rollout_id, created_at)
            VALUES ('g', 'u', 'a', 0, 'agent', 'r', 0)`)
        )
      )
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(sql`INSERT INTO file_shares (id, owner_user_id, path, grantee_user_id, mode, created_at)
            VALUES ('s', 'u', 'notes', 'u', 'view', 0)`)
        )
      )
      yield* sql`INSERT INTO file_shares (id, owner_user_id, path, grantee_user_id, mode, created_at)
        VALUES ('s', 'u', 'notes', 'v', 'view', 0)`
      const shares = yield* sql<{ n: number }>`SELECT count(*) AS n FROM file_shares`
      assert.strictEqual(shares[0]!.n, 1)
    }).pipe(Effect.provide(layer()))
  )
})

describe("0004_workshop_branches", () => {
  it.effect("pairs every branch of a workshop with its story's current branch and drops the queued position", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({
          "0001_baseline": migrations["0001_baseline"],
          "0002_files": migrations["0002_files"]
        })
      })
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
      // A chat's first fork is made with it, under the chat's id.
      yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at)
        VALUES ('s', 'u', 'rp', 'active', 0), ('w', 'u', 'workshop', 'active', 0), ('lone', 'u', 'workshop', 'active', 0)`
      yield* sql`INSERT INTO forks (id, chat_id, parent_fork_id, created_at) VALUES ('wf2', 'w', 'w', 1)`
      yield* sql`INSERT INTO state_events (id, chat_id, seq, key, value_json, origin, created_at)
        VALUES ('a', 'w', 0, 'workshop.attached', '{"chat":"s"}', 'user', 0)`
      yield* Effect.scoped(Layer.build(Migrations))
      assert.deepStrictEqual(
        yield* sql`SELECT fork_id, json_extract(value_json, '$.fork') AS story FROM state_events
          WHERE key = 'workshop.paired' ORDER BY fork_id`,
        [
          { fork_id: "w", story: "s" },
          { fork_id: "wf2", story: "s" }
        ]
      )
      assert.notInclude(
        (yield* sql`PRAGMA table_info(queued_messages)`).map((r) => r.name),
        "story_at_json"
      )
      assert.deepStrictEqual(
        (yield* sql<{ state_seq: number }>`SELECT state_seq FROM chats WHERE id = 'w'`).map((r) => r.state_seq),
        [2]
      )
    }).pipe(Effect.provide(layer()))
  )
})

describe("the migrator", () => {
  it.effect("refuses a ledger that skipped a migration numbered below its newest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE effect_sql_migrations (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'baseline'), (4, 'workshop_branches')`
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(Migrations)))
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(exit), "0002_files")
    }).pipe(Effect.provide(layer()))
  )

  it.effect("refuses a database whose ledger holds ids this code doesn't know", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE effect_sql_migrations (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'users'), (56, 'card_forks')`
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(Migrations)))
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(exit), "whose database this version can't read")
      assert.notInclude(String(exit), "empty")
      const tables = yield* sql<{ n: number }>`SELECT count(*) AS n FROM sqlite_master WHERE name = 'users'`
      assert.strictEqual(tables[0]!.n, 0)
    }).pipe(Effect.provide(layer()))
  )

  it.effect("refuses data made by a newer version, saying to update or restore, and changes nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Effect.scoped(Layer.build(Migrations))
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (9999, 'from_the_future')`
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(Migrations)))
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(exit), "This data was made by a newer version of Dreamspan (it has 9999_from_the_future")
      assert.include(String(exit), "restore the backup")
      assert.notInclude(String(exit), "empty")
    }).pipe(Effect.provide(layer()))
  )

  it.effect("starts on references broken before, with a warning and a report, when no change is pending", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(migrationDefinitions)
      yield* orphanPins(["gone", "lost"])
      const warnings: Array<string> = []
      const report = yield* migrate(migrationDefinitions).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              if (options.logLevel === "Warn") warnings.push(String(options.message))
            })
          ])
        )
      )
      assert.deepStrictEqual(report, { applied: [], broken: [{ table: "chat_pins", parent: "chats", rows: 2 }] })
      assert.deepStrictEqual(warnings, [
        "Dreamspan's database has 2 rows pointing at rows that don't exist: 2 in chat_pins (pointing into chats). " +
          "No database change ran at this start, so this was already there; Dreamspan starts anyway. " +
          "Items that use those rows may not open or change. Restore a backup from before the problem, or report it. Admins see this on the Server status page."
      ])
      // The writer's layer gives the same report to the Server status page.
      const startup = yield* Effect.scoped(Layer.build(Migrations).pipe(Effect.map(Context.get(DatabaseStartup))))
      assert.deepStrictEqual(startup.broken, report.broken)
      // Mended, the report is clean.
      yield* sql`DELETE FROM chat_pins WHERE chat_id IN ('gone', 'lost')`
      assert.deepStrictEqual(yield* migrate(migrationDefinitions), { applied: [], broken: [] })
    }).pipe(Effect.provide(layer()))
  )

  it.effect("runs pending changes on top of references broken before them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(upTo(5))
      yield* orphanPins(["gone"])
      const report = yield* migrate(migrationDefinitions)
      assert.deepStrictEqual(report, {
        applied: after5,
        broken: [{ table: "chat_pins", parent: "chats", rows: 1 }]
      })
      assert.strictEqual((yield* sql`SELECT name FROM sqlite_master WHERE name = 'persona_locks'`).length, 1)
    }).pipe(Effect.provide(layer()))
  )

  it.effect(
    "refuses a pending change that breaks references, keeping nothing of this start, never saying to empty the data folder",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* migrate(upTo(5))
        // One broken row was there already; the new change adds two more of the same kind.
        yield* orphanPins(["old"])
        const exit = yield* Effect.exit(
          migrate({
            ...migrationDefinitions,
            [fakeKey("breaks")]: {
              statements: [
                "PRAGMA defer_foreign_keys = ON",
                "INSERT INTO chat_pins (user_id, chat_id) VALUES ('u', 'new1'), ('u', 'new2')"
              ]
            }
          })
        )
        assert.isTrue(Exit.isFailure(exit))
        assert.strictEqual(
          messages(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)),
          `Dreamspan won't start: this update's database changes ${[...after5, fakeKey("breaks")].join(", ")} would leave` +
            " 2 rows pointing at rows that don't exist: 2 in chat_pins (pointing into chats). " +
            "So these database changes were undone, and the data is not served. " +
            "Nothing else was changed: the data is as the version you ran before left it. Go back to that version, or restore the backup taken before this update, and report this problem."
        )
        assert.notInclude(String(exit), "empty")
        assert.deepStrictEqual(yield* sql`SELECT name FROM sqlite_master WHERE name = 'persona_locks'`, [])
        assert.strictEqual(yield* newestRecorded, 5)
        assert.strictEqual((yield* sql<{ n: number }>`SELECT count(*) AS n FROM chat_pins`)[0]!.n, 1)
      }).pipe(Effect.provide(layer()))
  )

  it.effect("says which changes were kept when one after them breaks references", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(upTo(5))
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
      yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('c', 'u', 'rp', 'active', 0)`
      yield* sql`INSERT INTO chat_pins (user_id, chat_id) VALUES ('u', 'c')`
      // The real ones after 0005 and a fake one commit as one run; the next, outside a transaction
      // with foreign keys off, deletes a pinned chat.
      const exit = yield* Effect.exit(
        migrate({
          ...migrationDefinitions,
          [fakeKey("fine")]: { statements: ["CREATE TABLE fine_table (id INTEGER PRIMARY KEY) STRICT"] },
          [fakeKey("breaks", 2)]: { outsideTransaction: ["DELETE FROM chats WHERE id = 'c'"] }
        })
      )
      assert.isTrue(Exit.isFailure(exit))
      const message = messages(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause))
      assert.strictEqual(
        message,
        `Dreamspan won't start: this update's database change ${fakeKey("breaks", 2)} would leave` +
          " 3 rows pointing at rows that don't exist: 1 in chat_pins (pointing into chats), 1 in fork_labels (pointing into chats), 1 in forks (pointing into chats). " +
          "So this database change was undone, and the data is not served. " +
          `The changes before it at this start (${[...after5, fakeKey("fine")].join(", ")}) passed the same check` +
          " and were kept, so the version you ran before can't open this data any more: restore the backup taken before this update, and report this problem."
      )
      assert.notInclude(message, "Go back")
      assert.notInclude(message, "empty")
      assert.strictEqual(yield* newestRecorded, newestReal + 1)
      assert.strictEqual((yield* sql`SELECT id FROM chats`).length, 1)
      assert.strictEqual(yield* pragmaValue("foreign_keys"), 1)
    }).pipe(Effect.provide(layer()))
  )

  it.effect("refuses migrations that share a number, changing nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const exit = yield* Effect.exit(
        migrate({
          ...migrationDefinitions,
          [fakeKey("a")]: { statements: ["CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT"] },
          [fakeKey("b")]: { statements: ["CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT"] }
        })
      )
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(exit), `share a number (${fakeKey("a")} and ${fakeKey("b")})`)
      assert.deepStrictEqual(yield* sql`SELECT name FROM sqlite_master`, [])
    }).pipe(Effect.provide(layer()))
  )

  it.effect("runs on a database that already holds the baseline", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(Migrations))
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(Migrations)))
      assert.isTrue(Exit.isSuccess(exit))
    }).pipe(Effect.provide(layer()))
  )
})

it.effect("fresh defaults include composer guidance, branch additions and global chat pins", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.scoped(Layer.build(Migrations))
    yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
    yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('c', 'u', 'rp', 'active', 0)`
    yield* sql`INSERT INTO drafts (id, user_id, target_kind, target_id, content, updated_at)
      VALUES ('d', 'u', 'composer', 'c', 'Synthetic draft', 0)`
    assert.deepStrictEqual(
      (yield* sql`SELECT guidance FROM drafts`).map((r) => r.guidance),
      [0]
    )
    yield* sql`INSERT INTO chat_pins (user_id, chat_id) VALUES ('u', 'c')`
    assert.deepStrictEqual(
      (yield* sql`PRAGMA table_info(chat_pins)`).map((r) => r.name),
      ["user_id", "chat_id"]
    )
    assert.isTrue(
      (yield* sql`PRAGMA table_info(fork_summaries)`).some((r) => r.name === "added_json" && r.dflt_value === "'[]'")
    )
    assert.deepStrictEqual(Object.keys(migrations), [
      "0001_baseline",
      "0002_files",
      "0003_subagents",
      "0004_workshop_branches",
      "0005_preview_macro",
      "0006_persona_locks",
      "0007_contract_records",
      "0008_attachment_paths",
      "0009_share_invitations",
      "0010_share_birth",
      "0011_guidance_target",
      "0012_reasoning_stats",
      "0013_native_reasoning",
      "0014_composer_save_session",
      "0015_composer_commits",
      "0016_workshop_starts",
      "0017_library_attachments"
    ])
  }).pipe(Effect.provide(layer()))
)

describe("0003_subagents", () => {
  const seed = (sql: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
      for (const chat of ["c", "d"])
        yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES (${chat}, 'u', 'workshop', 'active', 0)`
      yield* sql`INSERT INTO rollouts (id, chat_id, kind, status, role, request_class, created_at, updated_at)
        VALUES ('parent', 'c', 'workshop', 'running', 'reply', 'interactive', 0, 0), ('elsewhere', 'd', 'workshop', 'running', 'reply', 'interactive', 0, 0)`
    })
  const child = (
    sql: SqlClient.SqlClient,
    id: string,
    parent: string | null,
    call: string | null,
    handle: string | null,
    chat = "c"
  ) =>
    sql`INSERT INTO rollouts (id, chat_id, kind, status, role, request_class, created_at, updated_at, spawned_by_rollout_id, spawned_by_call_id, agent_handle)
      VALUES (${id}, ${chat}, 'workshop', 'running', 'subagent', 'interactive', 0, 0, ${parent}, ${call}, ${handle})`

  it.effect("adds the link to a database at the baseline, keeps its rows, and guards the link", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // A database made before this migration, with a synthetic run in it.
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "0001_baseline": migrations["0001_baseline"] }) })
      yield* seed(sql)
      yield* Effect.scoped(Layer.build(Migrations))
      assert.deepStrictEqual(
        yield* sql`SELECT id, spawned_by_rollout_id, spawned_by_call_id, agent_handle FROM rollouts ORDER BY id`,
        [
          { id: "elsewhere", spawned_by_rollout_id: null, spawned_by_call_id: null, agent_handle: null },
          { id: "parent", spawned_by_rollout_id: null, spawned_by_call_id: null, agent_handle: null }
        ]
      )
      yield* child(sql, "kid", "parent", "call_1", "research-1")
      const refused = (effect: Effect.Effect<unknown, unknown>, message: string) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(effect)
          assert.isTrue(Exit.isFailure(exit))
          assert.include(String(exit), message)
        })
      yield* refused(child(sql, "half", "parent", null, "research-2"), "names its parent, call and handle together")
      yield* refused(child(sql, "nohandle", "parent", "call_2", null), "names its parent, call and handle together")
      yield* refused(child(sql, "far", "parent", "call_3", "research-3", "d"), "same chat")
      yield* refused(child(sql, "grandkid", "kid", "call_4", "research-1"), "cannot start subagents")
      yield* refused(sql`UPDATE rollouts SET agent_handle = 'other-1' WHERE id = 'kid'`, "keeps its parent")
      yield* refused(sql`UPDATE rollouts SET spawned_by_rollout_id = NULL WHERE id = 'kid'`, "keeps its parent")
      yield* refused(child(sql, "long", "parent", "call_5", "x".repeat(65)), "CHECK")
      // Other updates of a child still work (its status, as it finishes).
      yield* sql`UPDATE rollouts SET status = 'completed' WHERE id = 'kid'`
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
        SELECT id FROM rollouts WHERE spawned_by_rollout_id = 'parent' AND spawned_by_call_id = 'call_1'`
      assert.isTrue(plan.some((row) => row.detail.includes("rollouts_spawned")))
    }).pipe(Effect.provide(layer()))
  )
})

describe("0005_preview_macro", () => {
  it.effect("adds the column to a database at 0004; its older summaries are stale by format", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(upTo(4))
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
      yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('c', 'u', 'rp', 'active', 0)`
      yield* sql`INSERT INTO fork_summaries (fork_id, chat_id, format, stamp, user_stamp, preview, messages,
        cast_json, joined_json, departed_json, activity_json)
        VALUES ('c', 'c', ${FORK_SUMMARY_FORMAT - 1}, 0, 0, 'Hello {{user}}', 1, '[]', '[]', '[]', '[]')`
      yield* Effect.scoped(Layer.build(Migrations))
      assert.isTrue((yield* sql`PRAGMA table_info(fork_summaries)`).some((r) => r.name === "preview_macro"))
      assert.deepStrictEqual(yield* sql`SELECT format, preview, preview_macro FROM fork_summaries`, [
        { format: FORK_SUMMARY_FORMAT - 1, preview: "Hello {{user}}", preview_macro: null }
      ])
      // Valid only at the current format: the older row is read as stale and recomputed.
      const valid = () =>
        sql<{ ok: number }>`SELECT coalesce(${sql.literal(summaryValidSql("s", "c", "0"))}, 0) AS ok
          FROM fork_summaries s JOIN chats c ON c.id = s.chat_id`.pipe(Effect.map(([row]) => row!.ok))
      yield* sql`UPDATE fork_summaries SET format = ${FORK_SUMMARY_FORMAT}, stamp = (SELECT shell_stamp FROM chats WHERE id = 'c')`
      const current = yield* valid()
      yield* sql`UPDATE fork_summaries SET format = ${FORK_SUMMARY_FORMAT - 1}`
      assert.strictEqual(yield* valid(), 0, "a format-10 row is stale")
      assert.strictEqual(current, 1, "the same row at the current format would be valid")
    }).pipe(Effect.provide(layer()))
  )
})

describe("0006_persona_locks", () => {
  it.effect("adds the table to a database at 0005, keeping its cards, and guards its rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(upTo(5))
      for (const user of ["u", "v"])
        yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES (${user}, ${user}, 'Owner', 'user', 0)`
      for (const [id, owner] of [
        ["harbor", "u"],
        ["pilot", "u"],
        ["theirs", "v"]
      ])
        yield* sql`INSERT INTO entities (id, owner_user_id, kind, created_at) VALUES (${id}, ${owner}, 'card', 0)`
      yield* Effect.scoped(Layer.build(Migrations))
      assert.deepStrictEqual(
        (yield* sql`SELECT id FROM entities ORDER BY id`).map((r) => r.id),
        ["harbor", "pilot", "theirs"]
      )
      const lock = (character: string, persona: string, owner = "u") =>
        sql`INSERT INTO persona_locks (owner_user_id, character_entity_id, persona_entity_id, updated_at)
          VALUES (${owner}, ${character}, ${persona}, 0)`
      const refused = (effect: Effect.Effect<unknown, unknown>, message: string) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(effect)
          assert.isTrue(Exit.isFailure(exit))
          assert.include(String(exit), message)
        })
      yield* lock("harbor", "pilot")
      yield* refused(lock("pilot", "pilot"), "two cards of its owner")
      yield* refused(lock("pilot", "theirs"), "two cards of its owner")
      yield* refused(lock("harbor", "pilot"), "UNIQUE")
      yield* refused(sql`UPDATE persona_locks SET persona_entity_id = 'theirs'`, "two cards of its owner")
      yield* refused(sql`UPDATE persona_locks SET character_entity_id = 'pilot'`, "keeps its owner and character")
      assert.deepStrictEqual(yield* sql`SELECT character_entity_id, persona_entity_id FROM persona_locks`, [
        { character_entity_id: "harbor", persona_entity_id: "pilot" }
      ])
    }).pipe(Effect.provide(layer()))
  )
})

describe("0007_contract_records", () => {
  it.effect("adds the rollout's contract columns to a database at 0006, keeping its rollouts, and guards them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(upTo(6))
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
      yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('c', 'u', 'rp', 'active', 0)`
      yield* sql`INSERT INTO rollouts (id, chat_id, kind, status, role, request_class, created_at, updated_at)
        VALUES ('r', 'c', 'generation', 'completed', 'reply', 'interactive', 0, 0)`
      yield* Effect.scoped(Layer.build(Migrations))
      assert.deepStrictEqual(yield* sql`SELECT id, contract_outcome, contract_nudges FROM rollouts`, [
        { id: "r", contract_outcome: null, contract_nudges: null }
      ])
      yield* sql`UPDATE rollouts SET contract_outcome = 'recovered', contract_nudges = 2`
      assert.isTrue(Exit.isFailure(yield* Effect.exit(sql`UPDATE rollouts SET contract_outcome = 'maybe'`)))
      assert.isTrue(Exit.isFailure(yield* Effect.exit(sql`UPDATE rollouts SET contract_nudges = -1`)))
    }).pipe(Effect.provide(layer()))
  )
})

describe("0008_attachment_paths", () => {
  it.effect("adds the path of a workshop's attachment draft, keeping the drafts before it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(upTo(7))
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
      yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('c', 'u', 'workshop', 'active', 0)`
      yield* sql`INSERT INTO drafts (id, user_id, target_kind, target_id, content, updated_at)
        VALUES ('d', 'u', 'composer', 'c', '', 0)`
      yield* sql`INSERT INTO composer_images (id, draft_id, media_id, alt_text, status) VALUES ('i', 'd', NULL, '', 'removed')`
      yield* Effect.scoped(Layer.build(Migrations))
      assert.deepStrictEqual(yield* sql`SELECT id, kind, name, path FROM composer_images`, [
        { id: "i", kind: "image", name: null, path: null }
      ])
    }).pipe(Effect.provide(layer()))
  )
})

describe("0009_share_invitations", () => {
  it.effect("binds a database at 0008's shares to their folder, keeping them, and adds invitations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(upTo(8))
      for (const user of ["u", "v"])
        yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES (${user}, ${user}, 'Owner', 'user', 0)`
      yield* sql`INSERT INTO file_shares (id, owner_user_id, path, inode, grantee_user_id, mode, created_at)
        VALUES ('s', 'u', '/files/A', 7, 'v', 'view', 0)`
      yield* Effect.scoped(Layer.build(Migrations))
      assert.deepStrictEqual(yield* sql`SELECT id, inode, device, suspended_at FROM file_shares`, [
        { id: "s", inode: 7, device: null, suspended_at: null }
      ])
      yield* sql`INSERT INTO file_share_invitations (id, owner_user_id, path, inode, device, handle, grantee_user_id, mode, created_at)
        VALUES ('i', 'u', '/files/A', 7, 1, 'nobody', NULL, 'edit', 0)`
      const self = yield* Effect.exit(sql`INSERT INTO file_share_invitations
        (id, owner_user_id, path, inode, device, handle, grantee_user_id, mode, created_at)
        VALUES ('j', 'u', '/files/A', 7, 1, 'u', 'u', 'edit', 0)`)
      assert.isTrue(Exit.isFailure(self))
    }).pipe(Effect.provide(layer()))
  )
})

describe("0010_share_birth", () => {
  it.effect("adds birth times to shares and invitations and a declined mark, keeping what's there", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(upTo(9))
      for (const user of ["u", "v"])
        yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES (${user}, ${user}, 'Owner', 'user', 0)`
      yield* sql`INSERT INTO file_shares (id, owner_user_id, path, inode, device, grantee_user_id, mode, created_at)
        VALUES ('s', 'u', '/files/A', 7, 1, 'v', 'view', 0)`
      yield* sql`INSERT INTO file_share_invitations (id, owner_user_id, path, inode, device, handle, grantee_user_id, mode, created_at)
        VALUES ('i', 'u', '/files/A', 7, 1, 'v', 'v', 'edit', 0)`
      yield* Effect.scoped(Layer.build(Migrations))
      // A share from before has no birth time: inode and device decide.
      assert.deepStrictEqual(yield* sql`SELECT id, inode, device, birth_ms FROM file_shares`, [
        { id: "s", inode: 7, device: 1, birth_ms: null }
      ])
      assert.deepStrictEqual(yield* sql`SELECT id, birth_ms, declined_at FROM file_share_invitations`, [
        { id: "i", birth_ms: null, declined_at: null }
      ])
    }).pipe(Effect.provide(layer()))
  )
})

describe("0011_guidance_target", () => {
  it.effect("adds the reply a composer's guidance is for, null on the drafts already there", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(upTo(10))
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
      yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES ('c', 'u', 'chat', 'active', 0)`
      yield* sql`INSERT INTO drafts (id, user_id, target_kind, target_id, content, updated_at)
        VALUES ('d', 'u', 'composer', 'c', 'Typed.', 0)`
      yield* Effect.scoped(Layer.build(Migrations))
      assert.deepStrictEqual(yield* sql`SELECT id, content, guidance_slot_id FROM drafts`, [
        { id: "d", content: "Typed.", guidance_slot_id: null }
      ])
    }).pipe(Effect.provide(layer()))
  )
})

describe("0012_reasoning_stats", () => {
  it.effect("adds the reasoning estimate mark and first reasoning/reply times, frozen once closed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(upTo(11))
      yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'Owner', 'user', 0)`
      yield* Effect.scoped(Layer.build(Migrations))
      const columns = (yield* sql<{ name: string; dflt_value: string | null }>`PRAGMA table_info(llm_requests)`).filter(
        (c) => ["reasoning_estimated", "first_reasoning_at", "first_reply_at"].includes(c.name)
      )
      assert.deepStrictEqual(
        columns.map((c) => [c.name, c.dflt_value]),
        [
          ["reasoning_estimated", "0"],
          ["first_reasoning_at", null],
          ["first_reply_at", null]
        ]
      )
      const [trigger] = yield* sql<{
        sql: string
      }>`SELECT sql FROM sqlite_master WHERE name = 'llm_requests_closed_frozen_reasoning'`
      assert.include(trigger!.sql, "OLD.status <> 'running'")
    }).pipe(Effect.provide(layer()))
  )
})

describe("0013_native_reasoning", () => {
  it.effect("adds a reply's provider reasoning record, nullable, JSON only, and outside the version view", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate(upTo(12))
      yield* Effect.scoped(Layer.build(Migrations))
      const columns = yield* sql<{ name: string; notnull: number }>`PRAGMA table_info(version_texts)`
      assert.deepStrictEqual(
        columns.filter((c) => c.name === "native_reasoning").map((c) => c.notnull),
        [0]
      )
      const view = yield* sql<{ name: string }>`PRAGMA table_info(version_records)`
      assert.notInclude(
        view.map((c) => c.name),
        "native_reasoning"
      )
    }).pipe(Effect.provide(layer()))
  )
})

describe("released migrations", () => {
  // A migration's SQL must never change once released, so it can't be built from helpers that
  // later edits could change (review files23 finding 1). The baseline is exempt: it may still
  // change while no deployment holds data.
  it("are self-contained: no migration module imports anything", () => {
    const dir = join(import.meta.dirname, "../src/db")
    const modules = [
      "migrationFiles.ts",
      "subagentSchema.ts",
      "migrationWorkshopBranches.ts",
      "migrationPreviewMacro.ts",
      "migrationPersonaLocks.ts",
      "migrationAttachmentPaths.ts",
      "migrationShareInvitations.ts",
      "migrationShareBirth.ts",
      "migrationGuidanceTarget.ts",
      "migrationReasoningStats.ts",
      "migrationNativeReasoning.ts"
    ]
    for (const module of modules)
      assert.deepStrictEqual(
        readFileSync(join(dir, module), "utf8")
          .split("\n")
          .filter((line) => /^import\b/.test(line)),
        [],
        module
      )
  })
})
