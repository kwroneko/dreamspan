// Context assembly over the database, in a reader worker (ARCHITECTURE §15): the chat's
// state, cards through their layers, the preset's scope chain, notes and the model, all the
// acting user's, and the same context built again from the database (invariant 6).
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import { textField } from "@rp/shared/editing.ts"
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
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
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
    const entity = (kind: "card" | "preset" | "note" | "lorebook", label: string, doc: object) =>
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
  it.live("attaches lore on a path, isolates ids, and rebuilds after book edits and message amendments", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat, state, entity, sent, assemble } = yield* setup()
      const doc = loreBook([
        loreEntry({ keys: ["flooded"], content: "The levee has seven gates." }),
        loreEntry({ constant: true, probability: 50, content: "A raven watches." }, 1)
      ]).document
      const book = yield* entity("lorebook", "Levee", doc)
      yield* state({ key: "lorebook.attach", value: { ref: book.ref.id } })
      const first = yield* assemble()
      assert.include(texts(first).join("\n"), "The levee has seven gates.")
      assert.strictEqual(first.sources?.lorebooks?.[0]?.found[0]?.revision, book.ref.headRevisionId)
      // A peer branch has the same attachment but did not say the key.
      const message = (parentSlotId: SlotId | null, content: string, human: boolean, branch = false) =>
        writer.AppendMessage({
          userId,
          chatId: chat.id,
          parentSlotId,
          branch,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: null,
            writer: human ? "human" : "model",
            content,
            status: human ? "complete" : "generating",
            macroMode: "verbatim",
            origin: human ? "user_written" : "generated"
          })
        })
      const peer = yield* message(chat.activeLeafSlotId, "The sun shines.", true, true)
      const reply = yield* message(peer.slotId, "", false)
      const branch = yield* reader.AssembleContext({
        userId,
        chatId: chat.id,
        slotId: reply.slotId,
        versionId: reply.version.id,
        now: NOW,
        timeZone: "UTC",
        frozen: null
      })
      assert.notInclude(texts(JSON.parse(branch.snapshot) as ContextSnapshot).join("\n"), "seven gates")
      yield* writer.EditRef({
        userId,
        refId: book.ref.id,
        expectedRowVersion: book.ref.rowVersion,
        doc: { ...doc, entries: [] } as never,
        message: null,
        commitDraft: null
      })
      yield* writer.AmendVersion({ userId, versionId: sent.version.id, content: "Dry road.", expectedRowVersion: 1 })
      yield* state({ key: "lorebook.detach", value: { ref: book.ref.id } }, sent.slotId)
      assert.notInclude(texts(yield* assemble()).join("\n"), "seven gates")
      yield* writer.DeleteEntity({ userId, entityId: book.entityId })
      const rebuilt = yield* reader.RebuildContext({ userId, snapshot: JSON.stringify(first) })
      assert.ok(rebuilt._tag === "Rebuilt")
      assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), first)
      const other = (yield* writer.EnsureUser({ handle: "other-lore", displayName: "Other" })).id
      assert.strictEqual(
        (yield* Effect.flip(
          writer.AddStateEvent({
            userId: other,
            chatId: (yield* writer.CreateChat({
              userId: other,
              kind: "rp",
              status: "active",
              title: "Other",
              participants: [],
              greeting: null
            })).id,
            slotId: null,
            versionId: null,
            scope: null,
            data: { key: "lorebook.attach", value: { ref: book.ref.id } }
          })
        ))._tag,
        "NotFound"
      )
    }).pipe(Effect.provide(database()))
  )

  it.live(
    "assembles a 1,000-message path with a 500-entry book in a reader worker",
    () =>
      Effect.gen(function* () {
        const { writer, reader, userId, chat, entity, state } = yield* setup()
        const book = yield* entity(
          "lorebook",
          "Scale",
          loreBook(
            Array.from({ length: 500 }, (_, uid) =>
              loreEntry({ keys: [`key-${uid}`], content: `Scale lore ${uid}.`, position: "at_depth", depth: 0 }, uid)
            )
          ).document
        )
        yield* state({ key: "lorebook.attach", value: { ref: book.ref.id } })
        let leaf = chat.activeLeafSlotId
        for (let i = 1; i < 1000; i++) {
          const message = yield* writer.AppendMessage({
            userId,
            chatId: chat.id,
            parentSlotId: leaf,
            branch: i === 1,
            commitDraft: null,
            version: new NewVersion({
              speakerEntityId: null,
              writer: "human",
              content: `Turn ${i}: key-42`,
              status: "complete",
              macroMode: "verbatim",
              origin: "user_written"
            })
          })
          leaf = message.slotId
        }
        const reply = yield* writer.AppendMessage({
          userId,
          chatId: chat.id,
          parentSlotId: leaf,
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
        const times: Array<number> = []
        for (let i = 0; i < 6; i++) {
          const start = performance.now()
          const result = yield* reader.AssembleContext({
            userId,
            chatId: chat.id,
            slotId: reply.slotId,
            versionId: reply.version.id,
            now: NOW,
            timeZone: "UTC",
            frozen: null
          })
          times.push(performance.now() - start)
          assert.include(result.generation, "Scale lore 42.")
        }
        console.log(
          `Lore assembly: 1,000 messages / 500 entries, milliseconds: ${times.map((n) => n.toFixed(1)).join(", ")}`
        )
        assert.isBelow(Math.min(...times), 5000)
      }).pipe(Effect.provide(database())),
    120000
  )

  it.live("returns stored legacy snapshots without replaying changed assembler semantics", () =>
    Effect.gen(function* () {
      const { reader, userId, assemble } = yield* setup()
      const built = yield* assemble()
      for (const version of [undefined, 0, 1, 2, 3]) {
        const legacy = { ...built, assemblerVersion: version, sources: { ...built.sources, userMessages: [] } }
        const json = JSON.stringify(legacy)
        const result = yield* reader.RebuildContext({ userId, snapshot: json })
        assert.strictEqual("snapshot" in result, false)
        assert.ok(result._tag === "EarlierAssemblerVersion")
        assert.strictEqual(result.storedSnapshot, json)
      }
      assert.strictEqual(built.assemblerVersion, 4)
      const rebuilt = yield* reader.RebuildContext({ userId, snapshot: JSON.stringify(built) })
      assert.ok(rebuilt._tag === "Rebuilt")
      assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), built)
    }).pipe(Effect.provide(database()))
  )

  it.live("saves chat note drafts at the displayed leaf without moving sibling revisions", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, entity, chat, state, sent, assemble } = yield* setup()
      const note = yield* entity("note", "Weather", {
        schema_version: 1,
        title: "Weather",
        content: "RAIN",
        placement: { mode: "tail", role: "system" },
        owner: { chat: chat.id },
        exportable: false
      })
      yield* state({ key: "note.activate", value: { note: note.entityId } })
      const field = textField(["content"])
      const save = (
        content: string,
        baseRevisionId: typeof note.ref.headRevisionId,
        expectedRowVersion: number | null
      ) =>
        writer.SaveDraft({
          userId,
          key: new DraftKey({ targetKind: "entity_field", targetId: note.ref.id, field }),
          content,
          expectedRowVersion,
          baseRevision: baseRevisionId
        })
      const position = { chatId: chat.id, slotId: sent.slotId }
      const draft = yield* save("SUN", note.ref.headRevisionId, null)
      const committed = yield* writer.CommitEditorDrafts({
        userId,
        refId: note.ref.id,
        expectedRowVersion: note.ref.rowVersion,
        fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null,
        chatNote: position
      })
      const events = yield* reader.StateEventsAt({ userId, chatId: chat.id, slotId: sent.slotId })
      assert.isTrue(
        events.some((e) => e.data.key === "note.binding" && e.data.value.revision === committed.ref.headRevisionId)
      )
      assert.include(texts(yield* assemble()), "system: SUN")
      const elsewhere = yield* reader.OpenEditor({
        userId,
        refId: note.ref.id,
        chatNote: { chatId: chat.id, slotId: chat.activeLeafSlotId }
      })
      assert.strictEqual(elsewhere.doc.content, "RAIN")
      const here = yield* reader.OpenEditor({ userId, refId: note.ref.id, chatNote: position })
      assert.strictEqual(here.doc.content, "SUN")
      assert.strictEqual(here.ref.headRevisionId, committed.ref.headRevisionId)
      assert.strictEqual((yield* reader.OpenEditor({ userId, refId: note.ref.id })).doc.content, "RAIN")
      // A second edit must start from the branch binding, preserving the first edit's other fields.
      const second = yield* save("SNOW", here.ref.headRevisionId, draft.rowVersion + 1)
      yield* writer.CommitEditorDrafts({
        userId,
        refId: note.ref.id,
        expectedRowVersion: here.ref.rowVersion,
        fields: [{ field, draftId: second.id, expectedRowVersion: second.rowVersion }],
        message: null,
        chatNote: position
      })
      assert.strictEqual(
        (yield* reader.OpenEditor({ userId, refId: note.ref.id, chatNote: position })).doc.content,
        "SNOW"
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("refuses a chat note editor position outside its owning chat, on reads and saves", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, chat } = yield* setup()
      const note = yield* writer.CreateChatNote({ userId, chatId: chat.id, title: "Own" })
      const other = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Other",
        participants: [],
        greeting: null
      })
      const peer = (yield* writer.EnsureUser({ handle: "peer", displayName: "Peer" })).id
      const foreign = yield* writer.CreateChat({
        userId: peer,
        kind: "rp",
        status: "active",
        title: "Foreign",
        participants: [],
        greeting: null
      })
      for (const chatNote of [
        { chatId: other.id, slotId: null },
        { chatId: other.id, slotId: chat.activeLeafSlotId },
        { chatId: foreign.id, slotId: null }
      ]) {
        assert.strictEqual(
          (yield* Effect.flip(reader.OpenEditor({ userId, refId: note.id, chatNote })))._tag,
          "NotFound"
        )
        assert.strictEqual(
          (yield* Effect.flip(
            writer.CommitEditorDrafts({
              userId,
              refId: note.id,
              expectedRowVersion: note.rowVersion,
              fields: [],
              message: null,
              chatNote
            })
          ))._tag,
          "NotFound"
        )
      }
    }).pipe(Effect.provide(database()))
  )

  it.live("pins an empty path's zero user count for an immediate rebuild", () =>
    Effect.gen(function* () {
      const writer = yield* Database.Writer
      const reader = yield* Database.Reader
      const userId = (yield* writer.EnsureUser({ handle: "empty", displayName: "Empty" })).id
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Empty",
        participants: [],
        greeting: null
      })
      const note = yield* writer.CreateChatNote({ userId, chatId: chat.id, title: "Interval" })
      const doc = (yield* reader.OpenEditor({ userId, refId: note.id })).doc
      yield* writer.EditRef({
        userId,
        refId: note.id,
        expectedRowVersion: note.rowVersion,
        doc: { ...doc, interval: 2 },
        message: null,
        commitDraft: null
      })
      yield* writer.AddStateEvent({
        userId,
        chatId: chat.id,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "note.activate", value: { note: note.entityId } }
      })
      const reply = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        parentSlotId: null,
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
      const { snapshot } = yield* reader.AssembleContext({
        userId,
        chatId: chat.id,
        slotId: reply.slotId,
        versionId: reply.version.id,
        now: NOW,
        timeZone: "UTC",
        frozen: null
      })
      assert.strictEqual((JSON.parse(snapshot) as ContextSnapshot).sources?.userMessages?.[0]?.count, 0)
      const rebuilt = yield* reader.RebuildContext({ userId, snapshot })
      assert.ok(rebuilt._tag === "Rebuilt")
      assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), JSON.parse(snapshot))
    }).pipe(Effect.provide(database()))
  )

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

  it.live("places the chat's own note on the branch that turned it on, every interval of the user's messages", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, tobin, chat, sent, generating: reply, state } = yield* setup()
      const created = yield* writer.CreateChatNote({ userId, chatId: chat.id, title: "Weather" })
      const note = (fields: Record<string, unknown>, expectedRowVersion: number) =>
        writer.EditRef({
          userId,
          refId: created.id,
          doc: {
            schema_version: 1,
            title: "Weather",
            content: "Rain on {{user}}'s roof.",
            placement: { mode: "depth", depth: 0, role: "system" },
            owner: { chat: chat.id },
            exportable: false,
            ...fields
          } as never,
          expectedRowVersion,
          message: null,
          commitDraft: null
        })
      const edited = yield* note({}, created.rowVersion)
      const append = (parentSlotId: SlotId, human: boolean, content: string, branch = false) =>
        writer.AppendMessage({
          userId,
          chatId: chat.id,
          parentSlotId,
          branch,
          version: new NewVersion({
            speakerEntityId: human ? tobin.entityId : null,
            writer: human ? "human" : "model",
            content,
            status: human ? "complete" : "generating",
            macroMode: "verbatim",
            origin: human ? "user_written" : "generated"
          }),
          commitDraft: null
        })
      const assembleAt = (reply: { readonly slotId: SlotId; readonly version: { readonly id: VersionId } }) =>
        reader
          .AssembleContext({
            userId,
            chatId: chat.id,
            slotId: reply.slotId,
            versionId: reply.version.id,
            now: NOW,
            timeZone: "UTC",
            frozen: null
          })
          .pipe(Effect.map(({ snapshot }) => JSON.parse(snapshot) as ContextSnapshot))
      const raining = (snapshot: ContextSnapshot) => texts(snapshot).includes("system: Rain on Tobin's roof.")

      // Turned on after the user's message, on this branch only.
      yield* state({ key: "note.activate", value: { note: created.entityId } }, sent.slotId)
      assert.isTrue(raining(yield* assembleAt(reply)))
      const greeting = chat.activeLeafSlotId!
      const elsewhere = yield* append(greeting, true, "The bridge held.", true)
      assert.isFalse(raining(yield* assembleAt(yield* append(elsewhere.slotId, false, ""))))
      const listed = (slotId: SlotId) =>
        reader
          .StateEventsAt({ userId, chatId: chat.id, slotId })
          .pipe(Effect.map((events) => events.some((e) => e.data.key === "note.activate")))
      assert.isTrue(yield* listed(sent.slotId))
      assert.isFalse(yield* listed(elsewhere.slotId))

      // Every second message of the user's: the path to the reply has one so far.
      yield* note({ interval: 2 }, edited.ref.rowVersion)
      assert.isFalse(raining(yield* assembleAt(reply)))
      const second = yield* append(sent.slotId, true, "Still raining?", true)
      const later = yield* append(second.slotId, false, "")
      const snapshot = yield* assembleAt(later)
      assert.isTrue(raining(snapshot))
      // The count is pinned: deleting a message of the user's since rebuilds the same context.
      yield* writer.DeleteMessage({ userId, slotId: second.slotId })
      const rebuilt = yield* reader.RebuildContext({ userId, snapshot: JSON.stringify(snapshot) })
      assert.ok(rebuilt._tag === "Rebuilt")
      assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), snapshot)
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
      assert.ok(rebuilt._tag === "Rebuilt")
      assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), first)

      // A card in the bin can come back, and its revisions never changed: it still rebuilds.
      yield* writer.DeleteEntity({ userId, entityId: mira.entityId as EntityId })
      const binned = yield* reader.RebuildContext({ userId, snapshot: JSON.stringify(first) })
      assert.ok(binned._tag === "Rebuilt")
      assert.deepStrictEqual(JSON.parse(binned.snapshot), first)
      // So does a context without a character, which reads no card's notes.
      const empty = yield* assemble()
      assert.deepStrictEqual(
        empty.inputs.cards.map((c) => c.entity),
        [tobin.entityId]
      )
      const again2 = yield* reader.RebuildContext({ userId, snapshot: JSON.stringify(empty) })
      assert.ok(again2._tag === "Rebuilt")
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
