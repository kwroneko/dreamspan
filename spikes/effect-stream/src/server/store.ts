import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { NotFound, Slot, StaleWrite, Version, type VersionStatus } from "../shared/api.ts"

interface VersionRow {
  readonly id: string
  readonly slot_id: string
  readonly ordinal: number
  readonly content: string
  readonly status: VersionStatus
  readonly row_version: number
}

const toVersion = (row: VersionRow) =>
  new Version({
    id: row.id,
    slotId: row.slot_id,
    ordinal: row.ordinal,
    content: row.content,
    status: row.status,
    rowVersion: row.row_version
  })

const Migrations = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "0001_graph": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE slots (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          depth INTEGER NOT NULL,
          selected_version_id TEXT NOT NULL
        ) STRICT
      `
      yield* sql`
        CREATE TABLE versions (
          id TEXT PRIMARY KEY,
          slot_id TEXT NOT NULL REFERENCES slots(id),
          ordinal INTEGER NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL,
          row_version INTEGER NOT NULL DEFAULT 1
        ) STRICT
      `
      yield* sql`CREATE INDEX versions_slot ON versions(slot_id, ordinal)`
      yield* sql`CREATE INDEX slots_chat ON slots(chat_id, depth)`
    })
  })
})

const filler = (i: number) => {
  // Deterministic synthetic text with varied lengths, so rows have varied heights.
  const sentences = [
    "She set the cup down without drinking.",
    "*The wind shifts, carrying the smell of salt and tar.*",
    "\"You're late,\" he said, not looking up from the map.",
    "Outside, the market was closing; someone was arguing about the price of rope.",
    "For a long moment nobody spoke."
  ]
  const count = 1 + ((i * 37) % 13)
  const parts: Array<string> = [`#${i}`]
  for (let k = 0; k < count; k++) parts.push(sentences[(i + k) % sentences.length]!)
  return parts.join(((i + 1) % 4 === 0) ? "\n\n" : " ")
}

export class Store extends Context.Service<Store, {
  readonly listSlots: (chatId: string) => Effect.Effect<ReadonlyArray<Slot>>
  readonly createVersion: (slotId: string) => Effect.Effect<Version, NotFound>
  readonly finishVersion: (versionId: string, content: string, status: VersionStatus) => Effect.Effect<void>
  readonly editVersion: (
    versionId: string,
    content: string,
    expectedRowVersion: number
  ) => Effect.Effect<Version, NotFound | StaleWrite>
  readonly touchVersion: (versionId: string) => Effect.Effect<Version, NotFound>
}>()("spike/Store") {
  static readonly layer = (options: { readonly filename: string; readonly seedSlots: number }) =>
    Layer.effect(
      Store,
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient

        const [count] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM slots`
        if (count?.n === 0) {
          yield* Effect.logInfo(`seeding ${options.seedSlots} slots`)
          yield* sql.withTransaction(Effect.gen(function*() {
            for (let i = 0; i < options.seedSlots; i++) {
              const slotId = `s${i}`
              const versionId = `v${i}`
              yield* sql`INSERT INTO slots ${sql.insert({ id: slotId, chat_id: "c1", depth: i, selected_version_id: versionId })}`
              yield* sql`INSERT INTO versions ${
                sql.insert({ id: versionId, slot_id: slotId, ordinal: 0, content: filler(i), status: "complete" })
              }`
            }
          }))
        }

        const findVersion = (versionId: string) =>
          sql<VersionRow>`SELECT * FROM versions WHERE id = ${versionId}`.pipe(
            Effect.orDie,
            Effect.flatMap(([row]) => row ? Effect.succeed(row) : Effect.fail(new NotFound({ id: versionId })))
          )

        const listSlots = (chatId: string) =>
          Effect.gen(function*() {
            const slots = yield* sql<{ id: string; depth: number; selected_version_id: string }>`
              SELECT id, depth, selected_version_id FROM slots WHERE chat_id = ${chatId} ORDER BY depth`
            const versions = yield* sql<VersionRow>`
              SELECT v.* FROM versions v JOIN slots s ON s.id = v.slot_id
              WHERE s.chat_id = ${chatId} ORDER BY v.slot_id, v.ordinal`
            const bySlot = new Map<string, Array<Version>>()
            for (const row of versions) {
              const list = bySlot.get(row.slot_id) ?? []
              list.push(toVersion(row))
              bySlot.set(row.slot_id, list)
            }
            return slots.map((s) =>
              new Slot({
                id: s.id,
                depth: s.depth,
                selectedVersionId: s.selected_version_id,
                versions: bySlot.get(s.id) ?? []
              })
            )
          }).pipe(Effect.orDie, Effect.withSpan("Store.listSlots"))

        const createVersion = (slotId: string) =>
          sql.withTransaction(Effect.gen(function*() {
            const [slot] = yield* sql<{ id: string }>`SELECT id FROM slots WHERE id = ${slotId}`
            if (!slot) return yield* new NotFound({ id: slotId })
            const [ordinal] = yield* sql<{ next: number }>`
              SELECT coalesce(max(ordinal), -1) + 1 AS next FROM versions WHERE slot_id = ${slotId}`
            const id = `${slotId}-g${crypto.randomUUID().slice(0, 8)}`
            const [row] = yield* sql<VersionRow>`INSERT INTO versions ${
              sql.insert({ id, slot_id: slotId, ordinal: ordinal!.next, content: "", status: "generating" })
            } RETURNING *`
            yield* sql`UPDATE slots SET selected_version_id = ${id} WHERE id = ${slotId}`
            return toVersion(row!)
          })).pipe(Effect.catchTag("SqlError", Effect.die))

        const finishVersion = (versionId: string, content: string, status: VersionStatus) =>
          sql`UPDATE versions SET content = ${content}, status = ${status}, row_version = row_version + 1
              WHERE id = ${versionId}`.pipe(Effect.asVoid, Effect.orDie)

        const editVersion = (versionId: string, content: string, expectedRowVersion: number) =>
          Effect.gen(function*() {
            const [row] = yield* sql<VersionRow>`
              UPDATE versions SET content = ${content}, row_version = row_version + 1
              WHERE id = ${versionId} AND row_version = ${expectedRowVersion}
              RETURNING *`.pipe(Effect.orDie)
            if (row) return toVersion(row)
            const current = yield* findVersion(versionId)
            return yield* new StaleWrite({ versionId, expected: expectedRowVersion, actual: current.row_version })
          })

        const touchVersion = (versionId: string) =>
          sql<VersionRow>`UPDATE versions SET row_version = row_version + 1 WHERE id = ${versionId} RETURNING *`.pipe(
            Effect.orDie,
            Effect.flatMap(([row]) => row ? Effect.succeed(toVersion(row)) : Effect.fail(new NotFound({ id: versionId })))
          )

        return Store.of({ listSlots, createVersion, finishVersion, editVersion, touchVersion })
      })
    ).pipe(
      Layer.provide(Migrations),
      Layer.provideMerge(SqliteClient.layer({ filename: options.filename }))
    )
}
