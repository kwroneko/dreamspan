// Context assembly over the database, in a reader worker (ARCHITECTURE §15): the chat's
// state, cards through their layers, the preset's scope chain, notes and the model, all the
// acting user's, and the same context built again from the database (invariant 6).
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { ConnectionId } from "@rp/shared/providers.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import * as Database from "../src/db/Database.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { json, run } from "./formats/support.ts"
import { tempDir } from "./support/tempDir.ts"

const database = () =>
  Database.layer({ dataDir: tempDir("assembly"), readers: 1, allowNetworkFs: false, workers: "source" })

const cardDoc = (name: string, description: string): CardDoc =>
  run(importCard(json({ spec: "chara_card_v2", spec_version: "2.0", data: { name, description } }))).card

const presetDoc = importStPreset(
  readFileSync(new URL("fixtures/presets/default.json", import.meta.url), "utf8")
).document!

const NOW = Date.UTC(2026, 0, 1)

const setup = (handle = "ana") =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const user = yield* writer.EnsureUser({ handle, displayName: handle })
    const userId = user.id as UserId
    const entity = (kind: "card" | "preset" | "note", label: string, doc: object) =>
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
    const mira = yield* entity("card", "Mira", cardDoc("Mira", "{{char}} keeps the ledger for {{user}}."))
    const tobin = yield* entity("card", "Tobin", cardDoc("Tobin", "{{user}} draws maps."))
    const preset = yield* entity("preset", "Default", presetDoc)
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Ledger",
      participants: [mira.entityId],
      greeting: new NewVersion({
        speakerEntityId: mira.entityId,
        writer: "model",
        content: "*{{char}} looks up.* Late again, {{user}}.",
        status: "complete",
        macroMode: "template",
        origin: "greeting"
      })
    })
    const state = (data: StateEventData, slotId: SlotId | null = null) =>
      writer.AddStateEvent({ userId, chatId: chat.id, slotId, versionId: null, scope: null, data })
    yield* state({ key: "played_by_me.set", value: { entities: [tobin.entityId] } })
    const sent = yield* writer.AppendMessage({
      userId,
      chatId: chat.id,
      parentSlotId: chat.activeLeafSlotId,
      branch: false,
      version: new NewVersion({
        speakerEntityId: tobin.entityId,
        writer: "human",
        content: "The road flooded.",
        status: "complete",
        macroMode: "verbatim",
        origin: "user_written"
      }),
      commitDraft: null
    })
    const generating = yield* writer.AppendMessage({
      userId,
      chatId: chat.id,
      parentSlotId: sent.slotId,
      branch: false,
      version: new NewVersion({
        speakerEntityId: null,
        writer: "model",
        content: "",
        status: "generating",
        macroMode: "verbatim",
        origin: "generated"
      }),
      commitDraft: null
    })
    const assemble = (as: UserId = userId, frozen: ContextSnapshot["frozen"] | null = null) =>
      reader
        .AssembleContext({
          userId: as,
          chatId: chat.id,
          slotId: generating.slotId,
          versionId: generating.version.id,
          now: NOW,
          timeZone: "UTC",
          frozen
        })
        .pipe(Effect.map(({ snapshot }) => JSON.parse(snapshot) as ContextSnapshot))
    return { writer, reader, userId, entity, mira, tobin, preset, chat, state, sent, generating, assemble }
  })

const texts = (snapshot: ContextSnapshot) => snapshot.request.messages.map((m) => `${m.role}: ${m.content}`)

describe("context assembly from the database", () => {
  it.live("builds the chat's context with its cards, preset and state", () =>
    Effect.gen(function* () {
      const { assemble, state, preset } = yield* setup()
      const builtin = yield* assemble()
      assert.strictEqual(builtin.inputs.preset.scope, "builtin")
      assert.include(texts(builtin), "assistant: *Mira looks up.* Late again, Tobin.")
      assert.include(texts(builtin), "user: The road flooded.")
      assert.include(texts(builtin), "system: Mira keeps the ledger for Tobin.")

      yield* state({ key: "preset.binding", value: { ref: preset.ref.id } })
      const bound = yield* assemble()
      assert.deepStrictEqual(bound.inputs.preset, {
        ref: preset.ref.id,
        revision: preset.ref.headRevisionId,
        scope: "chat"
      })
      assert.strictEqual(texts(bound)[0], "system: You narrate a story starring Mira and Tobin.")
    }).pipe(Effect.provide(database()))
  )

  it.live("uses this chat's override of a card, and a pinned revision over it", () =>
    Effect.gen(function* () {
      const { writer, userId, mira, chat, state, assemble } = yield* setup()
      const override = yield* writer.CreateChatOverride({ userId, refId: mira.ref.id, chatId: chat.id })
      yield* writer.EditRef({
        userId,
        refId: override.id,
        doc: cardDoc("Mira", "{{char}} has given up the ledger.") as never,
        expectedRowVersion: override.rowVersion,
        message: null,
        commitDraft: null
      })
      assert.include(texts(yield* assemble()), "system: Mira has given up the ledger.")
      yield* state({ key: "card.binding", value: { entity: mira.entityId, revision: mira.ref.headRevisionId } })
      assert.include(texts(yield* assemble()), "system: Mira keeps the ledger for Tobin.")
    }).pipe(Effect.provide(database()))
  )

  it.live("sends the chat's imported summary where ST's Summarize extension put it, once it's on", () =>
    Effect.gen(function* () {
      const { entity, chat, state, assemble } = yield* setup()
      const summary = yield* entity("note", "Summary", {
        schema_version: 1,
        title: "Summary",
        content: "The road flooded twice.",
        placement: { mode: "depth", depth: 1, role: "system" },
        owner: { chat: chat.id },
        exportable: true,
        kind: "imported_summary",
        template: "[Summary: {{summary}}]"
      })
      const off = yield* assemble()
      assert.notInclude(texts(off).join("\n"), "flooded twice")
      yield* state({ key: "note.activate", value: { note: summary.entityId as EntityId } })
      const on = yield* assemble()
      assert.deepStrictEqual(texts(on).slice(-3), [
        "assistant: *Mira looks up.* Late again, Tobin.",
        "system: [Summary: The road flooded twice.]",
        "user: The road flooded."
      ])
    }).pipe(Effect.provide(database()))
  )

  it.live("injects the card's first note, and reads the model the chat binds", () =>
    Effect.gen(function* () {
      const { writer, userId, entity, mira, state, assemble } = yield* setup()
      yield* entity("note", "Character's Note", {
        schema_version: 1,
        title: "Character's Note",
        content: "{{char}} never guesses.",
        placement: { mode: "depth", depth: 0, role: "system" },
        owner: { card: mira.entityId },
        exportable: true
      })
      const connectionId = uuidv7() as ConnectionId
      yield* writer.CreateConnection({
        userId,
        connectionId,
        kind: "anthropic",
        api: "anthropic-messages",
        settings: {
          name: "Claude",
          baseUrl: null,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        credential: { existing: null }
      })
      const model = yield* writer.AddUserModel({
        userId,
        connectionId,
        key: "claude-test",
        overrides: { prefill: "assistant" }
      })
      yield* state({ key: "model.binding", value: { connection: connectionId, model: model.id } })
      const snapshot = yield* assemble()
      assert.strictEqual(texts(snapshot).at(-1), "system: Mira never guesses.")
      assert.deepInclude(snapshot.inputs.model!, {
        kind: "anthropic",
        api: "anthropic-messages",
        key: "claude-test",
        prefill: "assistant"
      })
      // A binding to a connection that went is a visible failure, not "no model".
      yield* writer.DeleteConnection({ userId, connectionId })
      const gone = yield* Effect.flip(assemble())
      assert.deepInclude(gone, { _tag: "AssemblyFailed", reason: "no_model" })
    }).pipe(Effect.provide(database()))
  )

  it.live("builds the same context again from the database and the values drawn (invariant 6)", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, preset, mira, tobin, sent, state, assemble } = yield* setup()
      const edited = yield* writer.EditRef({
        userId,
        refId: preset.ref.id,
        doc: {
          ...presetDoc,
          prompts: presetDoc.prompts.map((p) =>
            p.identifier === "main" ? { ...p, content: "{{random::a::b::c::d::e::f}} {{roll::1d100000}} {{time}}" } : p
          )
        } as never,
        expectedRowVersion: preset.ref.rowVersion,
        message: null,
        commitDraft: null
      })
      yield* state({ key: "preset.binding", value: { ref: preset.ref.id } })
      const first = yield* assemble()
      const again = yield* assemble(userId, first.frozen)
      assert.deepStrictEqual(again, first)

      // The chat and the library change after it: the snapshot's pins still read what it read.
      yield* writer.AmendVersion({
        userId,
        versionId: sent.version.id,
        content: "The bridge held.",
        expectedRowVersion: 1
      })
      yield* writer.EditRef({
        userId,
        refId: mira.ref.id,
        doc: cardDoc("Mira", "{{char}} burns the ledger.") as never,
        expectedRowVersion: mira.ref.rowVersion,
        message: null,
        commitDraft: null
      })
      yield* writer.EditRef({
        userId,
        refId: preset.ref.id,
        doc: presetDoc as never,
        expectedRowVersion: edited.ref.rowVersion,
        message: null,
        commitDraft: null
      })
      yield* state({ key: "macro.binding", value: { name: "user", value: "Captain" } }, sent.slotId)
      const now = yield* assemble(userId, first.frozen)
      assert.notDeepEqual(texts(now), texts(first))
      const rebuilt = yield* reader.RebuildContext({ userId, snapshot: JSON.stringify(first) })
      assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), first)

      // A card in the bin can come back, and its revisions never changed: it still rebuilds.
      yield* writer.DeleteEntity({ userId, entityId: mira.entityId as EntityId })
      const binned = yield* reader.RebuildContext({ userId, snapshot: JSON.stringify(first) })
      assert.deepStrictEqual(JSON.parse(binned.snapshot), first)
      // So does a context without a character, which reads no card's notes.
      const empty = yield* assemble()
      assert.deepStrictEqual(
        empty.inputs.cards.map((c) => c.entity),
        [tobin.entityId]
      )
      const again2 = yield* reader.RebuildContext({ userId, snapshot: JSON.stringify(empty) })
      assert.deepStrictEqual(JSON.parse(again2.snapshot), empty)

      // Only by the chat's owner.
      const other = yield* writer.EnsureUser({ handle: "bo", displayName: "bo" })
      const refused = yield* Effect.flip(
        reader.RebuildContext({ userId: other.id as UserId, snapshot: JSON.stringify(first) })
      )
      assert.strictEqual(refused._tag, "NotFound")
    }).pipe(Effect.provide(database()))
  )

  it.live("leaves a failed version out of the context, whatever text it kept (invariant 2)", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, tobin, generating } = yield* setup()
      yield* writer.SaveGeneration({
        userId,
        versionId: generating.version.id,
        content: "*Mira starts to an",
        status: "failed",
        error: { class: "server", message: "The connection dropped." }
      })
      const next = (parentSlotId: SlotId, version: NewVersion) =>
        writer.AppendMessage({ userId, chatId: chat.id, parentSlotId, branch: false, version, commitDraft: null })
      const asked = yield* next(
        generating.slotId,
        new NewVersion({
          speakerEntityId: tobin.entityId,
          writer: "human",
          content: "Hello?",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      )
      const reply = yield* next(
        asked.slotId,
        new NewVersion({
          speakerEntityId: null,
          writer: "model",
          content: "",
          status: "generating",
          macroMode: "verbatim",
          origin: "generated"
        })
      )
      const { snapshot } = yield* reader.AssembleContext({
        userId,
        chatId: chat.id,
        slotId: reply.slotId,
        versionId: reply.version.id,
        now: NOW,
        timeZone: "UTC",
        frozen: null
      })
      const built = texts(JSON.parse(snapshot) as ContextSnapshot)
      assert.include(built, "user: The road flooded.")
      assert.include(built, "user: Hello?")
      assert.isFalse(built.some((m) => m.includes("Mira starts to")))
    }).pipe(Effect.provide(database()))
  )

  it.live("assembles nothing of another user's chat", () =>
    Effect.gen(function* () {
      const { writer, assemble } = yield* setup()
      const other = yield* writer.EnsureUser({ handle: "bo", displayName: "bo" })
      const refused = yield* Effect.flip(assemble(other.id as UserId))
      assert.strictEqual(refused._tag, "NotFound")
    }).pipe(Effect.provide(database()))
  )

  it.live("leaves out a participant card that went to the bin", () =>
    Effect.gen(function* () {
      const { writer, userId, mira, assemble } = yield* setup()
      yield* writer.DeleteEntity({ userId, entityId: mira.entityId as EntityId })
      const snapshot = yield* assemble()
      assert.notInclude(texts(snapshot).join("\n"), "keeps the ledger")
      assert.notInclude(
        snapshot.inputs.cards.map((c) => c.entity),
        mira.entityId
      )
    }).pipe(Effect.provide(database()))
  )
})
