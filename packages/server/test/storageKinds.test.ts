import { inject } from "vitest"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"
import { SqlClient } from "effect/sql"
import { NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import * as Database from "../src/db/Database.ts"
import { StateModules } from "../src/db/stateModules.ts"
import { storageKinds, installStorageKindValidation } from "../src/db/storageKinds.ts"
import { writerConnection } from "../src/db/connection.ts"
import { migrate, migrationDefinitions } from "../src/db/migrations.ts"
import { transaction } from "../src/db/tx.ts"
import { tempDir } from "./support/tempDir.ts"

it.effect("validates extensible draft targets on insert and update, with scoped replacement and disablement", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* migrate(migrationDefinitions)
    yield* installStorageKindValidation
    yield* sql`INSERT INTO users(id,handle,display_name,role,created_at) VALUES ('u','u','U','user',1)`
    const insertDraft = (kind: string, id = "d") =>
      sql`INSERT INTO drafts(id,user_id,target_kind,target_id,content,updated_at)
      VALUES (${id},'u',${kind},${id},'text',1)`.pipe(transaction(sql, "InsertDraft"))
    assert.isTrue(Exit.isFailure(yield* Effect.exit(insertDraft("review/editor"))))
    assert.deepStrictEqual(yield* sql`SELECT id FROM drafts`, [])
    yield* insertDraft("composer")
    const updateDraft = (kind: string) =>
      sql`UPDATE drafts SET target_kind=${kind} WHERE id='d'`.pipe(transaction(sql, "UpdateDraft"))
    assert.isTrue(Exit.isFailure(yield* Effect.exit(updateDraft("review/editor"))))
    assert.strictEqual((yield* sql`SELECT target_kind FROM drafts`)[0]!.target_kind, "composer")
    yield* Effect.scoped(
      Effect.gen(function* () {
        const original = storageKinds.get("drafts.target_kind")!
        yield* storageKinds.register({ ...original, values: [...original.values, "review/editor"] })
        yield* updateDraft("review/editor")
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* storageKinds.disable("drafts.target_kind")
            const error = yield* Effect.flip(insertDraft("composer", "d2"))
            assert.strictEqual(error._tag, "StorageError")
          })
        )
        yield* insertDraft("review/editor", "d2")
      })
    )
    const error = yield* Effect.flip(insertDraft("review/editor", "d3"))
    assert.strictEqual(error._tag, "StorageError")
    if (error._tag === "StorageError") assert.strictEqual(error.reason, "constraint")
    yield* insertDraft("composer", "d3")
  }).pipe(Effect.provide(writerConnection(":memory:")), Effect.scoped)
)

for (const workers of ["source", "bundle"] as const) {
  describe(`storage kinds in ${workers} workers`, () => {
    it.live(
      "rolls back unknown origins and loads plugin registrations before writing",
      () =>
        Effect.gen(function* () {
          const writer = yield* Database.Writer
          const reader = yield* Database.Reader
          const modules = yield* StateModules
          const userId = (yield* writer.EnsureUser({ handle: "kinds", displayName: "Kinds" })).id
          const chat = yield* writer.CreateChat({
            userId,
            kind: "rp",
            status: "active",
            title: "Synthetic",
            participants: [],
            greeting: null
          })
          const append = (origin: string, parentSlotId: SlotId | null = null) =>
            writer.AppendMessage({
              userId,
              chatId: chat.id,
              forkId: chat.currentForkId!,
              parentSlotId,
              branch: false,
              commitDraft: null,
              version: new NewVersion({
                speakerEntityId: null,
                writer: "human",
                content: "Synthetic reply",
                status: "complete",
                macroMode: "verbatim",
                origin
              })
            })
          const failed = yield* Effect.flip(append("review/plugin"))
          assert.strictEqual(failed._tag, "StorageError")
          // The refused append rolled back its slot, text, fork tip and shell stamps.
          assert.isNull((yield* reader.GetChat({ userId, chatId: chat.id })).activeLeafSlotId)
          const source = {
            id: "storage-kinds",
            module: new URL("./support/storageKindPlugin.ts", import.meta.url).href,
            exportName: "install"
          }
          const scope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit))
          yield* Scope.provide(modules.register(source), scope)
          const added = yield* append("review/plugin")
          assert.strictEqual(added.version.origin, "review/plugin")
          yield* Scope.close(scope, Exit.void)
          assert.strictEqual(
            (yield* reader.GetSlot({ userId, slotId: added.slotId, forkId: chat.currentForkId! })).entry.version.origin,
            "review/plugin"
          )
          assert.strictEqual((yield* Effect.flip(append("review/plugin", added.slotId)))._tag, "StorageError")
          yield* append("user_written", added.slotId)
        }).pipe(
          Effect.provide(
            Database.layer({
              dataDir: tempDir("storage-kinds"),
              readers: 1,
              allowNetworkFs: false,
              workers,
              bundleDir: inject("bundleDir")
            })
          ),
          Effect.scoped
        ),
      120_000
    )
  })
}
