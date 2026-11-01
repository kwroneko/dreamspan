// What the preset and model pickers read and write (the owner, 2026-11-01): archiving a preset
// is the user's own and keeps nothing from use, a preset's last-modified and last-used times,
// the backfill of last used from generations made before it was recorded, and models' last use.
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@rp/shared/domain.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { Writer } from "../src/db/Database.ts"
import { client, testConfig, withServer } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

const completion = (_request: Recorded, res: Parameters<typeof sse>[0]) =>
  sse(res, completionChunks(["The ledger ", "balances."], { prompt_tokens: 50, completion_tokens: 4 }))

const mockProvider = Effect.acquireRelease(
  Effect.promise(() => startMockProvider(completion)),
  (m) => Effect.promise(() => m.close())
)

const failure = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(Effect.map((error) => (error as { _tag: string })._tag))

describe("archiving a preset", () => {
  it.live("hides it from the list, keeps its first archive time, and is the owner's alone", () =>
    Effect.gen(function* () {
      const alice = yield* client({ "Remote-User": "alice" })
      const bob = yield* client({ "Remote-User": "bob" })
      const old = yield* alice.CreatePreset({ label: "Old house style" })
      const kept = yield* alice.CreatePreset({ label: "Kept" })
      assert.isNull(old.archivedAt)
      assert.isNull(old.lastUsedAt)

      const archived = yield* alice.SetRefArchived({ refId: old.id, archived: true })
      assert.isNumber(archived.archivedAt)
      // Archiving changes nothing it was edited by.
      assert.strictEqual(archived.updatedAt, old.updatedAt)
      assert.strictEqual(archived.rowVersion, old.rowVersion)
      assert.deepStrictEqual(
        (yield* alice.ListLibrary({ kind: "preset" })).map((ref) => ref.label),
        ["Kept"]
      )
      const listed = yield* alice.ListLibrary({ kind: "preset", archived: true })
      assert.deepStrictEqual(
        listed.map((ref) => [ref.label, ref.archivedAt]),
        [["Old house style", archived.archivedAt]]
      )
      yield* Effect.sleep(5)
      // Archiving again keeps when it was first archived (two tabs, say).
      assert.strictEqual(
        (yield* alice.SetRefArchived({ refId: old.id, archived: true })).archivedAt,
        archived.archivedAt
      )

      // Another user can't archive it, unarchive it, or see it.
      assert.strictEqual(yield* failure(bob.SetRefArchived({ refId: old.id, archived: false })), "NotFound")
      assert.strictEqual(yield* failure(bob.SetRefArchived({ refId: kept.id, archived: true })), "NotFound")
      assert.lengthOf(yield* bob.ListLibrary({ kind: "preset", archived: true }), 0)
      assert.isNull((yield* alice.ListLibrary({ kind: "preset" })).find((ref) => ref.id === kept.id)!.archivedAt)

      const back = yield* alice.SetRefArchived({ refId: old.id, archived: false })
      assert.isNull(back.archivedAt)
      assert.lengthOf(yield* alice.ListLibrary({ kind: "preset", archived: true }), 0)
      assert.strictEqual(yield* failure(alice.SetRefArchived({ refId: "nope" as RefId, archived: true })), "NotFound")
    }).pipe(Effect.scoped, withServer(testConfig({ authMode: "proxy" })))
  )

  it.live("leaves a preset in use in use, records its last use and the model's, and refuses a chat's copy", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const before = Date.now()
      const { preset, chat, connection, model } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      const other = yield* api.CreatePreset({ label: "Never used" })
      const used = (yield* api.ListLibrary({ kind: "preset" })).find((ref) => ref.id === preset.ref.id)!
      assert.isAtLeast(used.lastUsedAt!, before)
      assert.isAtMost(used.lastUsedAt!, Date.now())
      assert.isNull(other.lastUsedAt)
      // The model that wrote it, for the model picker's Last used.
      const use = yield* api.ListModelUse()
      assert.deepStrictEqual(
        use.map((row) => [row.connectionId, row.modelId]),
        [[connection.id, model.id]]
      )
      assert.isAtLeast(use[0]!.lastUsedAt, before)

      // Archiving the preset in use keeps it in use: it stays the account's, and replies use it.
      yield* api.SetRefArchived({ refId: preset.ref.id, archived: true })
      assert.strictEqual((yield* api.GetGenerationDefaults()).preset, preset.ref.id)
      const next = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
      assert.strictEqual(next.preset?.ref ?? null, preset.ref.id)

      // A chat's own copy isn't a library entry to archive.
      const writer = yield* Writer
      const userId = (yield* api.Whoami()).id as UserId
      const override = yield* writer.CreateChatOverride({ userId, refId: preset.ref.id, chatId: chat.id })
      assert.strictEqual(yield* failure(api.SetRefArchived({ refId: override.id, archived: true })), "EditRefused")
      return { refId: preset.ref.id, at: used.lastUsedAt! }
    }).pipe(
      Effect.scoped,
      withServer(config),
      // A database from before last use was recorded: the startup migration fills it in from the
      // generations' context snapshots.
      Effect.tap(() =>
        fixtureSql(config.dataDir, [
          { sql: "UPDATE entity_refs SET last_used_at = NULL" },
          { sql: "DELETE FROM effect_sql_migrations WHERE name = 'preset_last_used'" }
        ])
      ),
      Effect.flatMap(({ refId, at }) =>
        Effect.gen(function* () {
          const api = yield* client()
          const ref = (yield* api.ListLibrary({ kind: "preset", archived: true })).find((entry) => entry.id === refId)!
          assert.isNumber(ref.lastUsedAt)
          assert.isAtMost(Math.abs(ref.lastUsedAt! - at), 1_000)
        }).pipe(Effect.scoped, withServer(config))
      )
    )
  })

  it.live("moves last modified with an edit or a rename, not with archiving", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const created = yield* api.CreatePreset({ label: "Tuned" })
      yield* Effect.sleep(5)
      const renamed = yield* api.RenameRef({
        refId: created.id,
        label: "Tuned again",
        subtitle: "",
        expectedRowVersion: created.rowVersion
      })
      assert.isAbove(renamed.updatedAt, created.updatedAt)
      yield* Effect.sleep(5)
      const archived = yield* api.SetRefArchived({ refId: created.id, archived: true })
      assert.strictEqual(archived.updatedAt, renamed.updatedAt)
      assert.isAbove(archived.archivedAt!, renamed.updatedAt)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )
})
