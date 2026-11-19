// Lorebook pins over the database (DESIGN §1.3): with "only below the history" off, entries
// above the history stay while its start holds, read back from the previous generation's cut
// state, and RebuildContext reproduces them; a preset's lorebooks go with it while on, and
// only the preset owner's own books are read.
import { assert, describe, it } from "@effect/vitest"
import { NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import type { CardDoc } from "@dreamspan/shared/docs/card.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import type { ConnectionId } from "@dreamspan/shared/providers.ts"
import type { StateEventData } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { generationOf, type ContextSnapshot } from "../src/assembler/types.ts"
import * as Database from "../src/db/Database.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { json, run } from "./formats/support.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const database = () =>
  Database.layer({ dataDir: tempDir("lore-pins"), readers: 1, allowNetworkFs: false, ...testWorkers })

const cardDoc = (name: string, description: string): CardDoc =>
  run(importCard(json({ spec: "chara_card_v2", spec_version: "2.0", data: { name, description } }))).card

const presetDoc = importStPreset(
  readFileSync(new URL("fixtures/presets/default.json", import.meta.url), "utf8")
).document!

const NOW = Date.UTC(2026, 0, 1)

describe("lorebook pins and preset lorebooks over the database", () => {
  it.live(
    "keeps pinned entries until the start moves, rebuilds them exactly, and reads the preset's books while on",
    () =>
      Effect.gen(function* () {
        const writer = yield* Database.Writer
        const reader = yield* Database.Reader
        const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "ana" })).id as UserId
        const entity = (kind: "card" | "preset" | "lorebook", label: string, doc: object) =>
          writer.CreateEntity({
            userId,
            kind,
            label,
            subtitle: "",
            doc: doc as never,
            schemaVersion: 1,
            origin: "user",
            sourcePath: null
          })
        const mira = yield* entity("card", "Mira", cardDoc("Mira", "{{char}} keeps the ledger."))
        const world = yield* entity(
          "lorebook",
          "World",
          loreBook([loreEntry({ constant: true, content: "PRESET_FACT", position: "after_char" })]).document
        )
        // Another user's book, named in this user's preset: read as nothing.
        const boId = (yield* writer.EnsureUser({ handle: "bo", displayName: "bo" })).id as UserId
        const foreign = yield* writer.CreateEntity({
          userId: boId,
          kind: "lorebook",
          label: "Foreign",
          subtitle: "",
          doc: loreBook([loreEntry({ constant: true, content: "FOREIGN_FACT", position: "after_char" })])
            .document as never,
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        const withBooks = (enabled: boolean) => ({
          ...presetDoc,
          lorebooks: [
            { id: world.ref.id, enabled },
            { id: foreign.ref.id, enabled: true }
          ]
        })
        const preset = yield* entity("preset", "Steps", withBooks(true))
        const presetOff = yield* entity("preset", "Steps off", withBooks(false))
        yield* writer.ChangeGenerationDefaults({ userId, change: { preset: preset.ref.id } })
        const chat = yield* writer.CreateChat({
          userId,
          kind: "rp",
          status: "active",
          title: "Ledger",
          participants: [mira.entityId],
          greeting: new NewVersion({
            speakerEntityId: mira.entityId,
            writer: "model",
            content: "Late again.",
            status: "complete",
            macroMode: "verbatim",
            origin: "greeting"
          })
        })
        const state = (data: StateEventData) =>
          writer.AddStateEvent({ userId, chatId: chat.id, slotId: null, versionId: null, scope: null, data })
        const book = yield* entity(
          "lorebook",
          "Levee",
          loreBook([
            loreEntry({ keys: ["flooded"], content: "PIN_LEVEE", position: "before_char" }, 0),
            loreEntry({ keys: ["flooded"], content: "DEPTH_FLOOD", position: "at_depth", depth: 0 }, 1)
          ]).document
        )
        yield* state({ key: "lorebook.attach", value: { ref: book.ref.id } })
        yield* state({ key: "lorebook.below_history", value: { on: false } })
        // The presets listing the book, with its switch in each; the other user's sees none of them.
        assert.deepStrictEqual(
          (yield* reader.LorebookPresets({ userId, ref: world.ref.id })).map((p) => [p.label, p.enabled]),
          [
            ["Steps", true],
            ["Steps off", false]
          ]
        )
        assert.deepStrictEqual(yield* reader.LorebookPresets({ userId: boId, ref: world.ref.id }), [])
        assert.deepStrictEqual(yield* reader.LorebookPresets({ userId: boId, ref: foreign.ref.id }), [])
        const connectionId = uuidv7() as ConnectionId
        yield* writer.CreateConnection({
          userId,
          connectionId,
          kind: "openai-chat",
          api: "openai-completions",
          settings: {
            name: "Pins",
            baseUrl: null,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          credential: { existing: null }
        })
        const model = yield* writer.AddUserModel({ userId, connectionId, key: "pins", overrides: {} })
        yield* writer.ChangeGenerationDefaults({
          userId,
          change: { model: { connection: connectionId, model: model.id } }
        })
        const send = (parent: SlotId, content: string) =>
          writer.AppendMessage({
            userId,
            chatId: chat.id,
            parentSlotId: parent,
            branch: false,
            commitDraft: null,
            version: new NewVersion({
              speakerEntityId: null,
              writer: "human",
              content,
              status: "complete",
              macroMode: "verbatim",
              origin: "user_written"
            })
          })
        const generate = (parent: SlotId) =>
          Effect.gen(function* () {
            const posted = yield* writer.AppendMessage({
              userId,
              chatId: chat.id,
              parentSlotId: parent,
              branch: false,
              commitDraft: null,
              version: new NewVersion({
                speakerEntityId: null,
                writer: "model",
                content: "",
                status: "generating",
                macroMode: "verbatim",
                origin: "generated"
              })
            })
            const { snapshot: json } = yield* reader.AssembleContext({
              userId,
              chatId: chat.id,
              slotId: posted.slotId,
              versionId: posted.version.id,
              now: NOW,
              timeZone: "UTC",
              frozen: null
            })
            const snapshot = JSON.parse(json) as ContextSnapshot
            const gen = generationOf(snapshot)
            const rolloutId = uuidv7()
            yield* writer.StartRollout({
              userId,
              chatId: chat.id,
              slotId: posted.slotId,
              versionId: posted.version.id,
              rolloutId,
              leafSlotId: parent,
              connectionId,
              modelId: model.id,
              snapshot: json,
              issues: gen.issues,
              variables: gen.variables,
              frozenMessages: []
            })
            yield* writer.SaveGeneration({
              userId,
              versionId: posted.version.id,
              content: "The ledger is dry.",
              status: "complete",
              error: null
            })
            yield* writer.FinishRollout({
              userId,
              versionId: posted.version.id,
              rolloutId,
              status: "completed",
              error: null
            })
            return { slot: posted.slotId, snapshot }
          })
        const text = (snapshot: ContextSnapshot) => snapshot.request.messages.map((m) => m.content).join("\n")
        const first = yield* generate((yield* send(chat.activeLeafSlotId!, "The road flooded.")).slotId)
        assert.include(text(first.snapshot), "PIN_LEVEE")
        assert.include(text(first.snapshot), "DEPTH_FLOOD")
        assert.include(text(first.snapshot), "PRESET_FACT")
        assert.notInclude(text(first.snapshot), "FOREIGN_FACT")
        // Both entries above the history are pinned: the levee's and the preset book's (after the character).
        assert.sameMembers(first.snapshot.historyStart?.state?.pinnedLore?.map((p) => p.book) ?? [], [
          book.ref.id,
          world.ref.id
        ])
        // Two messages on, the levee no longer matches: it stays, pinned; the depth entry goes.
        const second = yield* generate((yield* send((yield* send(first.slot, "Hm.")).slotId, "It's sunny now.")).slotId)
        assert.strictEqual(second.snapshot.historyMove, "unchanged")
        assert.include(text(second.snapshot), "PIN_LEVEE")
        assert.notInclude(text(second.snapshot), "DEPTH_FLOOD")
        const rebuilt = yield* reader.RebuildContext({ userId, snapshot: JSON.stringify(second.snapshot) })
        assert.ok(rebuilt._tag === "Rebuilt")
        const { sources: _sources, ...again } = JSON.parse(rebuilt.snapshot) as ContextSnapshot
        const { sources: _pins, ...original } = second.snapshot
        assert.deepStrictEqual(again, original)
        // A preset with the book switched off doesn't send it, and the changed books drop the pin.
        yield* writer.ChangeGenerationDefaults({ userId, change: { preset: presetOff.ref.id } })
        const third = yield* generate((yield* send(second.slot, "Still sunny.")).slotId)
        assert.notInclude(text(third.snapshot), "PRESET_FACT")
        assert.notInclude(text(third.snapshot), "PIN_LEVEE")
        // Attached to the chat as well, a preset's book is read once.
        yield* writer.ChangeGenerationDefaults({ userId, change: { preset: preset.ref.id } })
        yield* state({ key: "lorebook.attach", value: { ref: world.ref.id } })
        const fourth = yield* generate((yield* send(third.slot, "Dry.")).slotId)
        assert.lengthOf(text(fourth.snapshot).match(/PRESET_FACT/g) ?? [], 1)
      }).pipe(Effect.provide(database())),
    120000
  )
})
