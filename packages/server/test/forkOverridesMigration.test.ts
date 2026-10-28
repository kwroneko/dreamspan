// Migration 0054 (spec/FORK-INDEPENDENCE-DELTA.md §5 step 5, implementation unit 3): the
// overlay, lineages and the frozen selection, on a realistic synthetic import plus a graph
// built with the writer, then taken back to before the overlay (support/unmigrateForkOverrides.ts)
// with a selection changed on a slot as the code before did, and migrated again. Nothing a
// user sees may change: every fork shows, at every message of its path, the version the slot
// selected, with the same row version, the same state at its tip and the same tip text; no
// override is written; and afterwards the database refuses to change a slot's selection.
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
import { unmigrateForkOverrides } from "./support/unmigrateForkOverrides.ts"

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

/** What the code before the overlay showed for a fork: its live messages, selections and row versions, read by walking parents. */
const pathBefore = (db: DatabaseSync, tip: SlotId | null) => {
  const rows = db
    .prepare(
      `WITH RECURSIVE up(id) AS (
        SELECT ? UNION ALL SELECT s.parent_slot_id FROM slots s JOIN up ON s.id = up.id WHERE s.parent_slot_id IS NOT NULL)
      SELECT s.id AS slotId, s.selected_version_id AS versionId, s.row_version AS rowVersion, s.depth
      FROM up JOIN slots s ON s.id = up.id WHERE s.deleted_at IS NULL ORDER BY s.depth`
    )
    .all(tip) as Array<{ slotId: string; versionId: string; rowVersion: number }>
  return rows.map(({ slotId, versionId, rowVersion }) => ({ slotId, versionId, rowVersion }))
}

/** StateEventsAt as the code before read it: every event on the path, version-attached ones by the slot's selection. */
const eventsBefore = (db: DatabaseSync, chatId: string, tip: SlotId) =>
  (
    db
      .prepare(
        `WITH RECURSIVE path(id) AS (
          SELECT id FROM slots WHERE id = ? AND chat_id = ?
          UNION ALL
          SELECT s.parent_slot_id FROM slots s JOIN path p ON s.id = p.id WHERE s.parent_slot_id IS NOT NULL)
        SELECT e.key, e.value_json FROM state_events e LEFT JOIN path p ON p.id = e.slot_id LEFT JOIN slots s ON s.id = p.id
        WHERE e.chat_id = ? AND e.superseded_by_changeset IS NULL
          AND (e.slot_id IS NULL OR (p.id IS NOT NULL AND s.deleted_at IS NULL))
          AND (e.version_id IS NULL OR e.version_id = s.selected_version_id)
        ORDER BY coalesce(s.depth, -1), e.seq`
      )
      .all(tip, chatId, chatId) as Array<{ key: string; value_json: string }>
  ).map((e) => ({ key: e.key, value: JSON.parse(e.value_json) as unknown }))

describe("0054_fork_overrides", () => {
  it.live(
    "every fork shows what its slots selected, no override is written, and selections are frozen after",
    () => {
      const dataDir = tempDir("fork-overrides-migration")
      return Effect.gen(function* () {
        const built = yield* Effect.gen(function* () {
          const root = tempDir("st-fork-overrides")
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
          const mid = yield* line(main[8]!, 8)
          yield* line(null, 3)
          const doomed = yield* line(main[14]!, 3)
          // Swipes not selected (the selected one is written after unmigrating, as the code
          // before did), one of them carrying an event, and one deleted.
          const swipe = yield* writer.AddVersion({
            userId,
            slotId: main[5]!,
            version: say(mira, "swiped", "model"),
            select: false,
            commitDraft: null
          })
          yield* writer.AddStateEvent({
            userId,
            chatId: chat.id,
            slotId: main[5]!,
            versionId: swipe.id,
            scope: null,
            data: { key: "var.set", value: { name: "on-swipe", value: "yes" } }
          })
          yield* writer.AddStateEvent({
            userId,
            chatId: chat.id,
            slotId: mid[3]!,
            versionId: null,
            scope: null,
            data: { key: "var.set", value: { name: "mid", value: "only" } }
          })
          const gone = yield* writer.AddVersion({
            userId,
            slotId: main[6]!,
            version: say(mira, "gone", "model"),
            select: false,
            commitDraft: null
          })
          yield* writer.DeleteVersion({ userId, versionId: gone.id })
          yield* writer.DeleteMessage({ userId, slotId: main[10]! })
          yield* writer.DeleteBranch({ userId, slotId: doomed[1]! })
          return { swipeSlot: main[5]!, swipe: swipe.id }
        }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ dataDir }), Generator.none)))

        // As the code before left it, with a swipe selected on its slot, which every line
        // through it then showed.
        const db = new DatabaseSync(databaseFile(dataDir))
        unmigrateForkOverrides(db)
        db.prepare("UPDATE slots SET selected_version_id = ?, row_version = row_version + 1 WHERE id = ?").run(
          built.swipe,
          built.swipeSlot
        )
        const forks = db
          .prepare("SELECT id, chat_id, tip_slot_id, deleted_at FROM forks")
          .all() as unknown as Array<ForkRow>
        const live = forks.filter((f) => f.deleted_at === null && f.tip_slot_id !== null)
        assert.isAbove(live.length, 6, "the fixture should have many forks")
        const before = new Map(
          live.map((f) => [
            f.id,
            {
              path: pathBefore(db, f.tip_slot_id),
              events: eventsBefore(db, f.chat_id, f.tip_slot_id!),
              tip: (
                db
                  .prepare(
                    "SELECT substr(v.content, 1, 160) AS t FROM slots s JOIN versions v ON v.id = s.selected_version_id WHERE s.id = ?"
                  )
                  .get(f.tip_slot_id) as { t: string }
              ).t
            }
          ])
        )
        // The swipe's slot is on several lines, and each shows the swipe.
        const throughSwipe = [...before.values()].filter((b) =>
          b.path.some((e) => e.slotId === built.swipeSlot && e.versionId === built.swipe)
        )
        assert.isAbove(throughSwipe.length, 1)
        db.close()

        yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
          Effect.provide(writerConnection(databaseFile(dataDir)))
        )

        const after = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
        try {
          // Structure only: a lineage of itself per fork, no override, no state yet.
          assert.deepStrictEqual(after.prepare("SELECT count(*) AS n FROM fork_overrides").get(), {
            n: 0
          } as unknown as Record<string, unknown>)
          for (const row of after.prepare("SELECT id, lineage_json FROM forks").all() as Array<{
            id: string
            lineage_json: string
          }>)
            assert.deepStrictEqual(JSON.parse(row.lineage_json), [[row.id, null]])
          assert.deepStrictEqual(after.prepare("SELECT count(*) AS n FROM chats WHERE state_seq <> 0").get(), {
            n: 0
          } as unknown as Record<string, unknown>)
        } finally {
          after.close()
        }

        // Every fork reads as it did.
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
              path.entries.map((e) => ({ slotId: e.slotId, versionId: e.version.id, rowVersion: e.rowVersion })),
              was.path,
              fork.id
            )
            const events = yield* reader.StateEventsAt({
              userId,
              chatId: fork.chat_id,
              slotId: fork.tip_slot_id,
              forkId: fork.id
            })
            assert.deepStrictEqual(
              events.map((e) => ({ key: e.data.key, value: e.data.value })),
              was.events,
              fork.id
            )
            const listed = (yield* reader.ListForks({ userId, chatId: fork.chat_id })).find((f) => f.id === fork.id)!
            assert.strictEqual(listed.tipExcerpt, was.tip)
          }
        }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ dataDir }), Generator.none)))

        // From now on a slot's selection is the one it has.
        const frozen = new DatabaseSync(databaseFile(dataDir))
        try {
          const other = (
            frozen
              .prepare("SELECT id FROM versions WHERE slot_id = ? AND id <> ? LIMIT 1")
              .get(built.swipeSlot, built.swipe) as { id: string }
          ).id
          assert.throws(
            () => frozen.prepare("UPDATE slots SET selected_version_id = ? WHERE id = ?").run(other, built.swipeSlot),
            "a slot keeps the selection it was inserted with"
          )
        } finally {
          frozen.close()
        }
      })
    },
    300_000
  )
})
