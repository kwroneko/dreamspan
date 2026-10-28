// Migration 0055 (spec/FORK-INDEPENDENCE-DELTA.md §5 step 5, implementation unit 4): versions a
// fork owns and per-fork flags, on a realistic synthetic import plus a graph built with the
// writer, then taken back to before the migration (support/unmigrateForkVersions.ts) with
// stars, picker flags and an amend written on the versions as the code before did, and
// migrated again. Nothing a user sees may change: every fork shows, at every message of its
// path, the same version with the same text, flags and row version, and every picker there
// lists the same versions with the same flags; no version gets a fork and no override is
// written; and afterwards the database refuses to change a version's flags.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { databaseFile, writerConnection } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { migrations } from "../src/db/migrations.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { docFor } from "./support/docs.ts"
import { writeRealisticStFolder } from "./support/stRealistic.ts"
import { importStFolder } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"
import { unmigrateForkVersions } from "./support/unmigrateForkVersions.ts"

const say = (speaker: EntityId, content: string, writer: "human" | "model" = "human") =>
  new NewVersion({
    speakerEntityId: speaker,
    writer,
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: writer === "human" ? "user_written" : "generated"
  })

interface ForkRow {
  readonly id: ForkId
  readonly chat_id: ChatId
  readonly tip_slot_id: SlotId | null
  readonly deleted_at: number | null
}

interface Shown {
  readonly id: string
  readonly content: string
  readonly starred: boolean
  readonly hidden: boolean
  readonly rowVersion: number
}

const amends = "(SELECT count(*) FROM version_history h WHERE h.version_id = v.id)"

/** What the code before showed on a fork's path: each live message's selected version, read by walking parents. */
const pathBefore = (db: DatabaseSync, tip: SlotId | null) =>
  (
    db
      .prepare(
        `WITH RECURSIVE up(id) AS (
          SELECT ? UNION ALL SELECT s.parent_slot_id FROM slots s JOIN up ON s.id = up.id WHERE s.parent_slot_id IS NOT NULL)
        SELECT s.id AS slotId, v.id, v.content, v.starred, v.hidden, 1 + ${amends} AS rowVersion
        FROM up JOIN slots s ON s.id = up.id JOIN versions v ON v.id = s.selected_version_id
        WHERE s.deleted_at IS NULL ORDER BY s.depth`
      )
      .all(tip) as Array<{
      slotId: string
      id: string
      content: string
      starred: number
      hidden: number
      rowVersion: number
    }>
  ).map(({ slotId, starred, hidden, ...v }) => ({
    slotId,
    version: { ...v, starred: starred === 1, hidden: hidden === 1 }
  }))

/** The picker at a slot as the code before listed it: its live versions by ordinal, with their own flags. */
const pickerBefore = (db: DatabaseSync, slotId: string): Array<Shown> =>
  (
    db
      .prepare(
        `SELECT v.id, v.content, v.starred, v.hidden, 1 + ${amends} AS rowVersion FROM versions v
        WHERE v.slot_id = ? AND v.deleted_at IS NULL ORDER BY v.ordinal`
      )
      .all(slotId) as Array<{ id: string; content: string; starred: number; hidden: number; rowVersion: number }>
  ).map((v) => ({ ...v, starred: v.starred === 1, hidden: v.hidden === 1 }))

const shown = (v: Shown): Shown => ({
  id: v.id,
  content: v.content,
  starred: v.starred,
  hidden: v.hidden,
  rowVersion: v.rowVersion
})

describe("0055_fork_versions", () => {
  it.live(
    "every fork shows the same versions, texts and flags, nothing is written, and flags are frozen after",
    () => {
      const dataDir = tempDir("fork-versions-migration")
      return Effect.gen(function* () {
        const built = yield* Effect.gen(function* () {
          const root = tempDir("st-fork-versions")
          writeRealisticStFolder(root)
          const files = new Map(
            readdirSync(root, { recursive: true, withFileTypes: true })
              .filter((entry) => entry.isFile())
              .map((entry) => {
                const path = join(entry.parentPath, entry.name)
                return [relative(root, path), new Uint8Array(readFileSync(path))] as const
              })
          )
          yield* importStFolder(files)

          const api = yield* client()
          const writer = yield* Database.Writer
          const userId = (yield* api.Whoami()).id as UserId
          const { entityId: mira } = yield* writer.CreateEntity({
            userId,
            kind: "card",
            label: "Mira",
            subtitle: "",
            doc: docFor("card", "Mira"),
            schemaVersion: 1,
            origin: "user",
            sourcePath: null
          })
          const chat = yield* writer.CreateChat({
            userId,
            kind: "rp",
            status: "active",
            title: "Harbor",
            participants: [mira],
            greeting: new NewVersion({ ...say(mira, "The bell rings."), origin: "greeting" })
          })
          let n = 0
          const line = (from: SlotId | null, count: number) =>
            Effect.gen(function* () {
              const slots: Array<SlotId> = from === null ? [] : [from]
              for (let i = 0; i < count; i++) {
                const sent = yield* writer.AppendMessage({
                  userId,
                  chatId: chat.id,
                  parentSlotId: slots.at(-1) ?? null,
                  branch: true,
                  version: say(mira, `message ${n++}`, n % 2 ? "model" : "human"),
                  commitDraft: null
                })
                slots.push(sent.slotId)
              }
              return slots
            })
          const main = yield* line(chat.activeLeafSlotId!, 20)
          yield* line(main[8]!, 8)
          yield* line(null, 3)
          const doomed = yield* line(main[14]!, 3)
          // Swipes not selected, one of them deleted; a user's message amended in place.
          const swipes = []
          for (const slot of [main[5]!, main[11]!])
            swipes.push(
              yield* writer.AddVersion({
                userId,
                slotId: slot,
                version: say(mira, "swiped", "model"),
                select: false,
                commitDraft: null
              })
            )
          const gone = yield* writer.AddVersion({
            userId,
            slotId: main[6]!,
            version: say(mira, "gone", "model"),
            select: false,
            commitDraft: null
          })
          yield* writer.DeleteVersion({ userId, versionId: gone.id })
          yield* writer.DeleteBranch({ userId, slotId: doomed[1]! })
          return { swipes: swipes.map((s) => s.id), human: main[2]! }
        }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ dataDir }), Generator.none)))

        // As the code before left it: flags on the versions themselves, and an amend in place.
        const db = new DatabaseSync(databaseFile(dataDir))
        unmigrateForkVersions(db)
        db.prepare("UPDATE versions SET starred = 1 WHERE id = ?").run(built.swipes[0]!)
        db.prepare("UPDATE versions SET hidden = 1, starred = 1 WHERE id = ?").run(built.swipes[1]!)
        db.prepare(
          "UPDATE versions SET hidden = 1 WHERE id IN (SELECT id FROM versions WHERE writer = 'model' AND deleted_at IS NULL ORDER BY seq LIMIT 3)"
        ).run()
        const human = db.prepare("SELECT selected_version_id AS id FROM slots WHERE id = ?").get(built.human) as {
          id: string
        }
        db.prepare("UPDATE versions SET content = 'amended', updated_at = 1 WHERE id = ?").run(human.id)
        assert.deepStrictEqual(db.prepare("SELECT count(*) AS n FROM fork_overrides").get(), {
          n: 0
        } as unknown as Record<string, unknown>)
        const live = (
          db.prepare("SELECT id, chat_id, tip_slot_id, deleted_at FROM forks").all() as unknown as Array<ForkRow>
        ).filter((f) => f.deleted_at === null && f.tip_slot_id !== null)
        assert.isAbove(live.length, 6, "the fixture should have many forks")
        const before = new Map(
          live.map((f) => {
            const path = pathBefore(db, f.tip_slot_id)
            return [f.id, { path, pickers: path.map((e) => pickerBefore(db, e.slotId)) }]
          })
        )
        const flagged = [...before.values()].flatMap((b) => b.pickers.flat()).filter((v) => v.starred || v.hidden)
        assert.isAbove(new Set(flagged.map((v) => v.id)).size, 2, "flags should be on several lines' versions")
        db.close()

        yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
          Effect.provide(writerConnection(databaseFile(dataDir)))
        )

        const after = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
        try {
          // Structure only: no version has a fork, no override is written.
          assert.deepStrictEqual(after.prepare("SELECT count(*) AS n FROM versions WHERE fork_id IS NOT NULL").get(), {
            n: 0
          } as unknown as Record<string, unknown>)
          assert.deepStrictEqual(after.prepare("SELECT count(*) AS n FROM fork_overrides").get(), {
            n: 0
          } as unknown as Record<string, unknown>)
        } finally {
          after.close()
        }

        // Every fork reads as it did: paths, and the picker at every message on them.
        yield* Effect.gen(function* () {
          const api = yield* client()
          const reader = yield* Database.Reader
          const userId = (yield* api.Whoami()).id as UserId
          for (const fork of live) {
            const was = before.get(fork.id)!
            const path = yield* reader.GetPath({
              userId,
              chatId: fork.chat_id,
              forkId: fork.id,
              leafSlotId: null,
              limit: 1000
            })
            assert.deepStrictEqual(
              path.entries.map((e) => ({ slotId: e.slotId, version: shown(e.version) })),
              was.path,
              fork.id
            )
            for (const [i, entry] of path.entries.entries()) {
              const listed = yield* reader.ListVersions({ userId, slotId: entry.slotId, forkId: fork.id })
              assert.deepStrictEqual(listed.map(shown), was.pickers[i], `${fork.id} at ${entry.slotId}`)
            }
          }
        }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ dataDir }), Generator.none)))

        // From now on a version's flags are the ones it has; forks set their own.
        const frozen = new DatabaseSync(databaseFile(dataDir))
        try {
          assert.throws(
            () => frozen.prepare("UPDATE versions SET starred = 0 WHERE id = ?").run(built.swipes[0]!),
            "a version keeps the flags it was inserted with"
          )
          assert.throws(
            () => frozen.prepare("UPDATE versions SET hidden = 0 WHERE id = ?").run(built.swipes[1]!),
            "a version keeps the flags it was inserted with"
          )
        } finally {
          frozen.close()
        }
      })
    },
    300_000
  )
})
