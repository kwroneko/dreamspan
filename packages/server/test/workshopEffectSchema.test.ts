import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { newCardDoc } from "@rp/shared/editing.ts"
import { Writer } from "../src/db/Database.ts"
import { StateModules } from "../src/db/stateModules.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

const fixture = (dataDir: string) =>
  Effect.gen(function* () {
    const api = yield* client()
    const user = yield* api.Whoami()
    const chat = yield* api.CreateWorkshop({})
    const rolloutId = `r-${chat.id}`
    yield* fixtureSql(dataDir, [
      {
        sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
        params: [rolloutId, chat.id]
      }
    ])
    return { api, user, chat, rolloutId, writer: yield* Writer }
  })

describe("workshop effect storage", () => {
  it.live("enforces target refs and complete undo recipes in the database", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const a = yield* f.api.CreateCard({ label: "First", name: "First" })
      const b = yield* f.api.CreateCard({ label: "Other", name: "Other" })
      const changed = yield* f.writer.EditRef({
        userId: f.user.id,
        refId: a.id,
        expectedRowVersion: a.rowVersion,
        doc: { ...newCardDoc("First"), description: "New text" },
        message: null,
        commitDraft: null
      })
      const recipe = {
        refId: a.id,
        before: a.headRevisionId,
        head: changed.ref.headRevisionId,
        beforeRowVersion: a.rowVersion,
        rowVersion: changed.ref.rowVersion
      }
      const invalid = [
        {
          kind: "library.revise",
          targetKind: "entity",
          targetId: a.entityId,
          title: "Wrong ref",
          undo: { ...recipe, refId: b.id }
        },
        {
          kind: "library.revise",
          targetKind: "entity",
          targetId: a.entityId,
          title: "Missing versions",
          undo: { refId: a.id, before: a.headRevisionId, head: changed.ref.headRevisionId }
        },
        { kind: "chat.create", targetKind: "chat", targetId: f.chat.id, title: "No undo", undo: null }
      ]
      for (const [i, effect] of invalid.entries()) {
        const result = yield* Effect.exit(
          f.writer.RecordRolloutEffects({
            userId: f.user.id,
            rolloutId: f.rolloutId,
            toolCallId: `bad-${i}`,
            result: "Invalid",
            effects: [effect]
          })
        )
        assert.strictEqual(result._tag, "Failure", effect.title)
      }
      assert.isEmpty(yield* f.api.ListRolloutEffects({ chatId: f.chat.id }))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  for (const workers of ["source", "bundle"] as const) {
    it.live(`keeps recipes immutable and stores extensible undo results in ${workers} workers`, () => {
      const config = testConfig({ dbWorkers: workers })
      return Effect.gen(function* () {
        yield* (yield* StateModules).register({
          id: "review/undo",
          module: new URL("./support/workshopUndoPlugin.ts", import.meta.url).href,
          exportName: "install"
        })
        const f = yield* fixture(config.dataDir)
        const recipe = { beforeCommit: "synthetic-before" }
        yield* f.writer.RecordRolloutEffects({
          userId: f.user.id,
          rolloutId: f.rolloutId,
          toolCallId: "commit",
          result: "Committed",
          effects: [
            {
              kind: "review.commit",
              targetKind: "plugin",
              targetId: "synthetic-plugin",
              title: "Committed a synthetic plugin",
              undo: recipe
            }
          ]
        })
        const effect = (yield* f.api.ListRolloutEffects({ chatId: f.chat.id }))[0]!
        const undone = yield* f.api.UndoRolloutEffect(effect)
        assert.deepStrictEqual(undone.undo, recipe)
        assert.deepStrictEqual(undone.undoResult, { restoredCommit: "synthetic-revert", details: { files: 2 } })
        assert.deepStrictEqual(yield* f.api.UndoRolloutEffect(effect), undone)
        const corrupt = yield* Effect.exit(
          fixtureSql(config.dataDir, [
            { sql: "UPDATE rollout_effects SET undo_json = '{}' WHERE rollout_id = ?", params: [f.rolloutId] }
          ])
        )
        assert.strictEqual(corrupt._tag, "Failure")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })
  }
})
