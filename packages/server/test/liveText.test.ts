// Live text is what's sent (owner, 2026-11-01; ARCHITECTURE §14.2a): a reply uses every library
// field as it's typed, a generation cuts a revision labelled with the reply only when the text
// it used changed since the last one, switching presets loses nothing, a field's edit history
// is append-only past its revisions, and settings never go to the bin as JSON.
import { assert, describe, it } from "@effect/vitest"
import { HELD_FIELD, textField, valueField } from "@dreamspan/shared/editing.ts"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { Effect } from "effect"
import { Writer } from "../src/db/Database.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const completion = (_request: Recorded, res: Parameters<typeof sse>[0]) =>
  sse(res, completionChunks(["Noted."], { prompt_tokens: 10, completion_tokens: 1 }))

const MAIN = textField(["prompts", "identifier=main", "content"])

/** Text typed into a field, as the editor saves it: on the draft it has, from the head it shows. */
const type = (api: Api, refId: RefId, field: string, content: string) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId })
    const draft = opened.drafts.find((d) => d.key.field === field)
    return yield* api.SaveEditorDraft({
      refId,
      field,
      draftId: draft?.id ?? null,
      content,
      expectedRowVersion: draft?.rowVersion ?? null,
      expectedSession: draft?.session ?? null,
      baseRevisionId: draft?.status === "active" ? (draft.baseRevision as never) : opened.ref.headRevisionId
    })
  })

const fieldTexts = (api: Api, refId: RefId, field: string) =>
  Effect.flatMap(api.EditorDraftHistory({ refId, field, limit: 1000 }), (states) =>
    Effect.forEach(states, (state) => api.EditorDraftState({ refId, field, seq: state.seq }))
  )

describe("live text", () => {
  it.live("a reply sends the live text and cuts one labelled revision, only when it changed", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(completion)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const writer = yield* Writer
      const me = yield* api.Whoami()
      const { chat, events, version, mira, preset } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      const sentText = () =>
        JSON.stringify(
          mock
            .requests()
            .filter((r) => r.path === "/v1/chat/completions")
            .at(-1)!.body!.messages
        )
      const generate = (parentSlotId: string) =>
        Effect.gen(function* () {
          const { entry } = yield* posted(
            api.Generate({ chatId: chat.id, parentSlotId: parentSlotId as never, branch: false })
          )
          yield* eventually(() => finished(events, entry.version.id) !== undefined)
          return entry
        })
      const miraRef = mira.ref.id
      const revisions = (refId: RefId) => api.ListRevisions({ refId, limit: 50 })
      const before = yield* revisions(miraRef)

      // Typed, never saved: the next reply sends it.
      yield* type(api, miraRef, textField(["description"]), "Mira LIVE-CARD-TEXT counts the coins.")
      yield* type(api, preset.ref.id, MAIN, "LIVE-PRESET-TEXT: write {{char}}'s reply.")
      const first = yield* generate(version.slotId)
      assert.include(sentText(), "Mira LIVE-CARD-TEXT counts the coins.")
      assert.include(sentText(), "LIVE-PRESET-TEXT: write Mira's reply.")

      // One revision each, labelled with the reply that used it, numbered on from the last.
      const cut = yield* revisions(miraRef)
      assert.lengthOf(cut, before.length + 1)
      assert.strictEqual(cut[0]!.origin, "generation")
      assert.isNull(cut[0]!.message)
      assert.deepInclude(cut[0]!.usedBy!, { chatId: chat.id, chatTitle: "Ledger", slotId: first.slotId })
      assert.strictEqual(cut[0]!.usedBy!.message, first.depth + 1)
      assert.strictEqual(cut[0]!.number, before[0]!.number! + 1)
      const opened = yield* api.OpenEditor({ refId: miraRef })
      assert.strictEqual(opened.doc.description, "Mira LIVE-CARD-TEXT counts the coins.")
      assert.strictEqual(opened.revisionNumber, cut[0]!.number)
      // Nothing is changed since that revision now, and the field's edit history runs on.
      assert.isTrue(opened.drafts.every((d) => d.status !== "active"))
      assert.include(
        yield* fieldTexts(api, miraRef, textField(["description"])),
        "Mira LIVE-CARD-TEXT counts the coins."
      )

      // Nothing changed: another reply cuts nothing.
      const second = yield* generate(first.slotId)
      assert.lengthOf(yield* revisions(miraRef), cut.length)
      assert.lengthOf(yield* revisions(preset.ref.id), (yield* revisions(preset.ref.id)).length)

      // Typing on after the checkpoint goes on from that revision: no conflict at Save.
      yield* type(api, miraRef, textField(["description"]), "Mira LIVE-CARD-TEXT counts the coins twice.")
      const typed = yield* api.OpenEditor({ refId: miraRef })
      const draft = typed.drafts.find((d) => d.key.field === textField(["description"]))!
      assert.strictEqual(draft.baseRevision, cut[0]!.id)
      const saved = yield* api.CommitEditorDrafts({
        refId: miraRef,
        expectedRowVersion: typed.ref.rowVersion,
        fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
      const manual = (yield* revisions(miraRef))[0]!
      assert.strictEqual(manual.id, saved.ref.headRevisionId)
      assert.deepInclude(manual, { origin: "user", message: null })

      // A revision's message is a label, added or changed later, auto ones too.
      yield* api.SetRevisionMessage({ refId: miraRef, revisionId: cut[0]!.id, message: "  Coins  " })
      assert.strictEqual((yield* revisions(miraRef)).find((r) => r.id === cut[0]!.id)!.message, "Coins")
      yield* api.SetRevisionMessage({ refId: miraRef, revisionId: cut[0]!.id, message: "" })
      assert.isNull((yield* revisions(miraRef)).find((r) => r.id === cut[0]!.id)!.message)

      // Switching presets loses nothing: the other preset's typing waits, uncommitted, and
      // goes out once that preset is used again.
      const other = yield* writer.CreateEntity({
        userId: me.id,
        kind: "preset",
        label: "Other",
        subtitle: "",
        doc: importStPreset(JSON.stringify({ frequency_penalty: 0 })).document! as never,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* type(api, preset.ref.id, MAIN, "WAITING-PRESET-TEXT for {{char}}.")
      const defaults = yield* api.GetGenerationDefaults()
      yield* api.SetGenerationDefaults({ defaults: { ...defaults, preset: other.ref.id } })
      const presetRevisions = (yield* revisions(preset.ref.id)).length
      const third = yield* generate(second.slotId)
      assert.notInclude(sentText(), "WAITING-PRESET-TEXT")
      assert.lengthOf(yield* revisions(preset.ref.id), presetRevisions)
      const waiting = yield* api.OpenEditor({ refId: preset.ref.id })
      assert.strictEqual(waiting.drafts.find((d) => d.key.field === MAIN)!.content, "WAITING-PRESET-TEXT for {{char}}.")
      assert.strictEqual(waiting.drafts.find((d) => d.key.field === MAIN)!.status, "active")
      yield* api.SetGenerationDefaults({ defaults: { ...defaults, preset: preset.ref.id } })
      yield* generate(third.slotId)
      assert.include(sentText(), "WAITING-PRESET-TEXT for Mira.")
      assert.lengthOf(yield* revisions(preset.ref.id), presetRevisions + 1)
      void (mira.entityId as EntityId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("the held structural changes are never sent or saved by a reply", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(completion)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { chat, events, version, preset } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      const held = yield* type(api, preset.ref.id, HELD_FIELD, JSON.stringify({ order: ["main"], deleted: [] }))
      const revisions = (yield* api.ListRevisions({ refId: preset.ref.id, limit: 50 })).length
      const { entry } = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: version.slotId, branch: false }))
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      assert.lengthOf(yield* api.ListRevisions({ refId: preset.ref.id, limit: 50 }), revisions)
      const opened = yield* api.OpenEditor({ refId: preset.ref.id })
      assert.deepInclude(
        opened.drafts.find((d) => d.id === held.id)!,
        { status: "active" }
      )
      assert.notProperty(opened.doc, "~held")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a prompt added behind the bar waits for Save, definition and all (owner, 2026-11-02)", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(completion)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { chat, events, version, preset } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      const refId = preset.ref.id
      const added = valueField(["prompts", "identifier=added-here"])
      const definition = yield* type(
        api,
        refId,
        added,
        JSON.stringify({ identifier: "added-here", name: "New prompt", role: "system", content: "" })
      )
      const text = textField(["prompts", "identifier=added-here", "content"])
      yield* type(api, refId, text, "HELD-NEW-PROMPT text")
      yield* type(api, refId, HELD_FIELD, JSON.stringify({ added: [{ identifier: "added-here", enabled: true }] }))
      // Typed elsewhere in the preset: the reply checkpoints that, and leaves the new prompt.
      yield* type(api, refId, MAIN, "LIVE-MAIN beside a held prompt.")
      const before = (yield* api.ListRevisions({ refId, limit: 50 })).length
      const { entry } = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: version.slotId, branch: false }))
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const sent = JSON.stringify(
        mock
          .requests()
          .filter((r) => r.path === "/v1/chat/completions")
          .at(-1)!.body!.messages
      )
      assert.include(sent, "LIVE-MAIN beside a held prompt.")
      assert.notInclude(sent, "HELD-NEW-PROMPT")
      assert.lengthOf(yield* api.ListRevisions({ refId, limit: 50 }), before + 1)
      const opened = yield* api.OpenEditor({ refId })
      const prompts = opened.doc.prompts as ReadonlyArray<{ identifier: string }>
      assert.isFalse(prompts.some((p) => p.identifier === "added-here"))
      for (const field of [added, text])
        assert.strictEqual(opened.drafts.find((d) => d.key.field === field)!.status, "active")
      assert.strictEqual(opened.drafts.find((d) => d.id === definition.id)!.status, "active")
      // Revert takes it away: the saved preset never had it.
      yield* api.RevertEditorDrafts({ refId })
      const reverted = yield* api.OpenEditor({ refId })
      assert.strictEqual(reverted.drafts.find((d) => d.key.field === added)!.content, "undefined")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a field's edit history is append-only, and settings never go to the bin", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "History", name: "History" })
      const field = textField(["description"])
      const long = "a".repeat(300)
      yield* type(api, card.id, field, long)
      // Removing 300 characters is destructive: its own state.
      const now = yield* type(api, card.id, field, "b")
      const states = yield* api.EditorDraftHistory({ refId: card.id, field, limit: 100 })
      const earlier = states.find((s) => s.length === 300)!
      const restored = yield* api.RestoreEditorDraft({
        refId: card.id,
        field,
        draftId: now.id,
        seq: earlier.seq,
        expectedRowVersion: now.rowVersion
      })
      assert.strictEqual(restored.content, long)
      const after = yield* api.EditorDraftHistory({ refId: card.id, field, limit: 100 })
      // A new latest state, every earlier one still there: no travelling back, no branches.
      assert.lengthOf(after, states.length + 1)
      assert.strictEqual(after[0]!.kind, "restore")
      assert.deepStrictEqual(
        after.slice(1).map((s) => s.seq),
        states.map((s) => s.seq)
      )
      assert.deepStrictEqual(yield* fieldTexts(api, card.id, field), [long, "b", long, ""])
      // A save keeps the history whole.
      const opened = yield* api.OpenEditor({ refId: card.id })
      const draft = opened.drafts.find((d) => d.key.field === field)!
      yield* api.CommitEditorDrafts({
        refId: card.id,
        expectedRowVersion: opened.ref.rowVersion,
        fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
      assert.lengthOf(yield* api.EditorDraftHistory({ refId: card.id, field, limit: 100 }), after.length)

      // Settings: a value replaced wholesale, discarded, or saved, never reaches the bin.
      const bin = () => Effect.map(api.ListRecoveredTexts({ limit: 100, before: null }), (texts) => texts.length)
      const inBin = yield* bin()
      const tags = valueField(["tags"])
      yield* type(api, card.id, tags, JSON.stringify(Array.from({ length: 60 }, (_, i) => `tag number ${i}`)))
      const cleared = yield* type(api, card.id, tags, "[]")
      yield* api.DiscardEditorDraft({
        refId: card.id,
        field: tags,
        draftId: cleared.id,
        expectedRowVersion: cleared.rowVersion
      })
      yield* type(api, card.id, tags, JSON.stringify(Array.from({ length: 60 }, (_, i) => `another ${i}`)))
      const again = yield* type(api, card.id, tags, '["one"]')
      const reopened = yield* api.OpenEditor({ refId: card.id })
      yield* api.CommitEditorDrafts({
        refId: card.id,
        expectedRowVersion: reopened.ref.rowVersion,
        fields: [{ field: tags, draftId: again.id, expectedRowVersion: again.rowVersion }],
        message: null
      })
      assert.strictEqual(yield* bin(), inBin)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("Revert puts every changed field back to the last revision, keeping the typing in edit history", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Revert", name: "Revert" })
      const description = textField(["description"])
      yield* type(api, card.id, description, "Saved text.")
      const opened = yield* api.OpenEditor({ refId: card.id })
      const draft = opened.drafts.find((d) => d.key.field === description)!
      yield* api.CommitEditorDrafts({
        refId: card.id,
        expectedRowVersion: opened.ref.rowVersion,
        fields: [{ field: description, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
      const revisions = (yield* api.ListRevisions({ refId: card.id, limit: 50 })).length
      yield* type(api, card.id, description, "Saved text. Typed since, then thrown away.")
      yield* type(api, card.id, valueField(["tags"]), '["thrown"]')
      assert.strictEqual((yield* api.RevertEditorDrafts({ refId: card.id })).reverted, 2)
      const reverted = yield* api.OpenEditor({ refId: card.id })
      // Nothing changed since the revision now, and no revision was written.
      assert.isTrue(reverted.drafts.every((d) => d.status !== "active"))
      assert.strictEqual(reverted.doc.description, "Saved text.")
      assert.lengthOf(yield* api.ListRevisions({ refId: card.id, limit: 50 }), revisions)
      // The typing is one state back, the revision's text the newest.
      const texts = yield* fieldTexts(api, card.id, description)
      assert.strictEqual(texts[0], "Saved text.")
      assert.include(texts, "Saved text. Typed since, then thrown away.")
      // Typing on starts from the revision, with no conflict at Save.
      const again = yield* type(api, card.id, description, "Saved text. Again.")
      const reopened = yield* api.OpenEditor({ refId: card.id })
      yield* api.CommitEditorDrafts({
        refId: card.id,
        expectedRowVersion: reopened.ref.rowVersion,
        fields: [{ field: description, draftId: again.id, expectedRowVersion: again.rowVersion }],
        message: null
      })
      assert.strictEqual((yield* api.OpenEditor({ refId: card.id })).doc.description, "Saved text. Again.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  lcmTest("a summary request sends the live text and cuts a revision labelled with its messages", (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server)
      const preset = h.preset.ref.id as RefId
      yield* type(h.api, preset, MAIN, "SUMMARY-LIVE-TEXT for the summarizer.")
      const before = (yield* h.api.ListRevisions({ refId: preset, limit: 50 })).length
      yield* h.enqueue(0, 3)
      assert.isNotNull(yield* h.runNext)
      const sent = h.mock.requests().map((r) => JSON.stringify(r.body?.messages ?? []))
      assert.isTrue(sent.some((body) => body.includes("SUMMARY-LIVE-TEXT for the summarizer.")))
      const revisions = yield* h.api.ListRevisions({ refId: preset, limit: 50 })
      assert.lengthOf(revisions, before + 1)
      assert.strictEqual(revisions[0]!.origin, "generation")
      assert.deepInclude(revisions[0]!.usedBy!, { chatId: h.chat.id, versionId: null, summary: { from: 1, to: 4 } })
      // The same text again: nothing new to checkpoint.
      yield* h.enqueue(4, 7)
      yield* h.runNext
      assert.lengthOf(yield* h.api.ListRevisions({ refId: preset, limit: 50 }), before + 1)
    })
  )
})
