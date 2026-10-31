// A read of the next context right after a change never answers with the estimate from
// before it (chat/CacheWarmth.ts `next`), over a real server: an edit, a new branch, a
// deleted message and the user's default preset, each read at once, without waiting for
// the pushed estimate. The mechanism for every kind of change is in cacheWarmthHold.test.ts.
import { assert, it } from "@effect/vitest"
import type { SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { presetDoc } from "./support/docs.ts"

it.live(
  "reads the next context afresh after an edit, a branch, a delete and a preset change",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Noted."], {})))),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { chat, connection, model } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, cacheTtlS: 300 },
        model: {}
      })
      const forkId = chat.currentForkId!
      const bottom = () => api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const next = (leafSlotId: SlotId) => api.GetNextContext({ chatId: chat.id, forkId, leafSlotId })
      let window = yield* bottom()
      const leaf = window.entries.at(-1)!.slotId as SlotId
      const warm = yield* next(leaf)
      assert.strictEqual(warm.warmth?.changed ?? null, null)
      // The same read again is the same estimate.
      assert.deepStrictEqual(yield* next(leaf), warm)

      const sent = window.entries[1]!
      yield* api.EditVersion({
        slotId: sent.slotId,
        sourceVersionId: sent.version.id,
        content: "The bridge held.",
        expectedRowVersion: sent.rowVersion
      })
      const edited = yield* next(leaf)
      assert.strictEqual(edited.warmth?.changed?.reason, "Message 2 was edited, or another of its versions chosen.")

      const me = yield* api.Whoami()
      const other = yield* (yield* Writer).CreateEntity({
        userId: me.id,
        kind: "preset",
        label: "Other",
        subtitle: "",
        doc: presetDoc([{ identifier: "main", content: "Write tersely." }]),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: other.ref.id }
      })
      const preset = yield* next(leaf)
      assert.strictEqual(preset.budget?.presetName, "Other")
      assert.strictEqual(preset.warmth?.changed?.reason, "The preset changed.")

      // A message at the end, then deleted: the leaf moves back, and its estimate with it.
      const added = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: leaf, branch: false, content: "Onward.", reply: false })
      )
      const longer = yield* next(added.entry.slotId as SlotId)
      assert.strictEqual(longer.leafSlotId, added.entry.slotId)
      yield* api.DeleteMessage({ slotId: added.entry.slotId, forkId })
      window = yield* bottom()
      assert.strictEqual(window.entries.at(-1)!.slotId, leaf)
      assert.strictEqual((yield* next(leaf)).leafSlotId, leaf)

      // A message under the greeting starts another branch, which becomes the chat's: the
      // active path's estimate is its.
      const branch = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: chat.activeLeafSlotId,
          branch: true,
          content: "Again.",
          reply: false
        })
      )
      const branched = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: null })
      assert.strictEqual(branched.leafSlotId, branch.entry.slotId)
      assert.isNotNull(branched.warmth?.changed ?? null)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  },
  120_000
)
