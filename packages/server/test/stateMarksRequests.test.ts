// Causal wire evidence: positioned context changes affect N+1, not N's context.
// New and regenerated replies use the model selected now (DESIGN §3.1).
// Regenerating an earlier reply retains its byte-identical causal context.
// All transports are synthetic loopback recorders. Mute changes automatic speaker selection,
// not the bytes for a speaker explicitly picked by the user.
import { assert, it } from "@effect/vitest"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { CastChange } from "@dreamspan/shared/chatSetupApi.ts"
import { type ForkId, type SlotId } from "@dreamspan/shared/chat.ts"
import { newChatNote } from "@dreamspan/shared/editing.ts"
import { Effect } from "effect"
import { Writer } from "../src/db/Database.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

for (const kind of ["cast", "mute", "notes", "model", "preset", "lorebooks", "settings"] as const) {
  it.live(
    kind === "model"
      ? "new and regenerated replies use the model selected now, with unchanged earlier context"
      : `wire position of ${kind}: after N, never in N's regeneration`,
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Noted."], {})))),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        const events: ChatEvent[] = []
        const { chat, version } = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          characters: ["Wren"],
          events
        })
        const chatId = chat.id
        const forkId = chat.currentForkId as ForkId
        const n = version.slotId as SlotId
        const cast = yield* api.GetCast({ chatId, forkId, slotId: n })
        const mira = cast.cards.find((c) => c.name === "Mira")!.entityId
        const wren = cast.cards.find((c) => c.name === "Wren")!.entityId
        const beforeN = mock.requests().at(-1)!.raw
        const next = yield* posted(
          api.Generate({ chatId, forkId, parentSlotId: n, branch: false, speakerEntityId: mira })
        )
        yield* eventually(() => finished(events, next.entry.version.id) !== undefined)
        const beforeNext = mock.requests().at(-1)!.raw
        const userId = (yield* api.Whoami()).id
        const writer = yield* Writer
        const entity = (kind: "card" | "note" | "preset" | "lorebook", doc: object) =>
          writer.CreateEntity({
            userId,
            kind,
            label: "Marker fixture",
            subtitle: "",
            doc: doc as never,
            schemaVersion: 1,
            origin: "user",
            sourcePath: null
          })
        let change: CastChange
        let key: string
        switch (kind) {
          case "cast": {
            const added = yield* entity("card", { ...cardDoc("Keeper"), description: "CAST-SENTINEL" })
            change = { _tag: "Join", entityId: added.entityId }
            key = "participant.join"
            break
          }
          case "mute":
            change = { _tag: "Presence", entityId: wren, present: false }
            key = "presence.set"
            break
          case "notes": {
            const note = yield* entity("note", { ...newChatNote(chatId, "Marker fixture"), content: "NOTE-SENTINEL" })
            change = { _tag: "Note", entityId: note.entityId, active: true }
            key = "note.activate"
            break
          }
          case "model": {
            const defaults = yield* api.GetGenerationDefaults()
            const model = yield* api.AddUserModel({
              connectionId: defaults.model!.connection,
              key: "marker-model",
              overrides: {}
            })
            change = { _tag: "Model", connection: defaults.model!.connection, model: model.id }
            key = "model.binding"
            break
          }
          case "preset": {
            const preset = yield* entity(
              "preset",
              importStPreset(JSON.stringify({ main_prompt: "PRESET-SENTINEL" })).document!
            )
            change = { _tag: "Preset", ref: preset.ref.id }
            key = "preset.binding"
            break
          }
          case "lorebooks": {
            const book = yield* entity(
              "lorebook",
              loreBook([loreEntry({ constant: true, content: "LORE-SENTINEL" })]).document
            )
            change = { _tag: "Lorebook", ref: book.ref.id, active: true }
            key = "lorebook.attach"
            break
          }
          case "settings":
            change = { _tag: "CardsRotation", on: true }
            key = "cards.rotation"
            break
        }
        yield* api.ChangeCast({ chatId, forkId, slotId: n, change })
        const marks = yield* api.GetStateMarks({ chatId, forkId, slotId: next.entry.slotId, keys: [key] })
        assert.isTrue(marks.events.some((e) => e.slotId === n && e.key === key))
        const regenerate = (slotId: SlotId) =>
          Effect.gen(function* () {
            const page = yield* api.ReadPath({ chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 })
            const entry = page.entries.find((e) => e.slotId === slotId)!
            const reply = yield* api.Regenerate({ slotId, forkId, expectedRowVersion: entry.rowVersion })
            yield* eventually(() => finished(events, reply.version.id) !== undefined)
            assert.strictEqual(finished(events, reply.version.id)!.status, "complete")
            return mock.requests().at(-1)!.raw
          })
        const afterNext = yield* regenerate(next.entry.slotId)
        const afterN = yield* regenerate(n)
        if (process.env.STATE_MARK_REQUESTS_OUTPUT)
          writeFileSync(
            join(process.env.STATE_MARK_REQUESTS_OUTPUT, `${kind}.json`),
            JSON.stringify({ beforeN, beforeNext, afterNext, afterN }, null, 2)
          )
        if (kind === "mute") {
          assert.deepStrictEqual(afterNext, beforeNext)
          assert.include((yield* api.GetCast({ chatId, forkId, slotId: n })).absent, wren)
        } else assert.notDeepEqual(afterNext, beforeNext)
        if (kind === "model") {
          assert.strictEqual(JSON.parse(afterN!).model, "marker-model")
          assert.deepStrictEqual(JSON.parse(afterN!).messages, JSON.parse(beforeN!).messages)
        } else assert.strictEqual(afterN, beforeN)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    120_000
  )
}
