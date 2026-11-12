import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
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
              kind: "plugin.commit",
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
