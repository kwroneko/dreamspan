// The card and preset editors at the real boundary (ARCHITECTURE.md "Editing the library"):
// a real server with its workers, drafts saved and committed over RPC, files over HTTP.
// Cross-user probes are in isolation.test.ts.
import { readFileSync } from "node:fs"
import { assert, layer } from "@effect/vitest"
import type { ChatId } from "@rp/shared/chat.ts"
import type { PresetDoc } from "@rp/shared/docs/preset.ts"
import { textField, valueField } from "@rp/shared/editing.ts"
import { ImportResult } from "@rp/shared/libraryImport.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect, Schema } from "effect"
import { Writer } from "../src/db/Database.ts"
import { chunk, png } from "./formats/support.ts"
import { client, outcome, serverLayer, serverPort, testConfig } from "./support/config.ts"

const config = testConfig()

type Api = Effect.Success<ReturnType<typeof client>>

const base = Effect.map(serverPort, (port) => `http://127.0.0.1:${port}`)

const upload = (path: string, bytes: Uint8Array) =>
  Effect.flatMap(base, (url) =>
    Effect.promise(() =>
      fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
  )

/** The parts of an ST preset file the tests change. */
interface PresetFile {
  temperature: number
  prompts: Array<{ identifier: string; content: string }>
  extensions: { regex_scripts: Array<unknown> }
}

const preset = (name: string, change: (preset: PresetFile) => void = () => {}) => {
  const file = JSON.parse(readFileSync(new URL(`./fixtures/presets/${name}.json`, import.meta.url), "utf8"))
  change(file)
  return new TextEncoder().encode(JSON.stringify(file))
}

const importPreset = (bytes: Uint8Array, into?: RefId) =>
  Effect.gen(function* () {
    const response = yield* upload(`/library/import?name=p.json${into ? `&into=${into}` : ""}`, bytes)
    assert.strictEqual(response.status, 200)
    return Schema.decodeUnknownSync(ImportResult)(yield* Effect.promise(() => response.json())).library!
  })

/** Saves a draft of one field, starting it or carrying on from what's there. */
const draft = (api: Api, refId: RefId, field: string, content: string) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId })
    const existing = opened.drafts.find((d) => d.key.field === field)
    const active = existing?.status === "active"
    return yield* api.SaveEditorDraft({
      refId,
      field,
      content,
      expectedRowVersion: existing?.rowVersion ?? null,
      baseRevisionId: active ? null : opened.ref.headRevisionId
    })
  })

/** Commits every active draft of the ref. */
const commit = (api: Api, refId: RefId, message: string | null = null) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId })
    return yield* api.CommitEditorDrafts({
      refId,
      expectedRowVersion: opened.ref.rowVersion,
      fields: opened.drafts
        .filter((d) => d.status === "active")
        .map((d) => ({ field: d.key.field, expectedRowVersion: d.rowVersion })),
      message
    })
  })

const doc = (api: Api, refId: RefId) => Effect.map(api.OpenEditor({ refId }), (opened) => opened.doc)

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("editing the library", (it) => {
  it.effect("a card's fields edit through drafts and save as one revision", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      yield* draft(api, card.id, textField(["description"]), "A keeper.")
      yield* draft(api, card.id, textField(["description"]), "A lighthouse keeper.")
      yield* draft(api, card.id, valueField(["tags"]), '["sea","night"]')
      const module = { id: "m1", title: "Outfit", content: "", exportable: false, agent_editable: true }
      yield* draft(api, card.id, valueField(["modules", "id=m1"]), JSON.stringify(module))
      yield* draft(api, card.id, textField(["modules", "id=m1", "content"]), "A grey coat.")
      yield* draft(
        api,
        card.id,
        valueField(["modules", "id=m1", "placement"]),
        '{"mode":"depth","depth":2,"role":"system"}'
      )

      const saved = yield* commit(api, card.id, "First pass")
      assert.notStrictEqual(saved.ref.headRevisionId, card.headRevisionId)
      const opened = yield* api.OpenEditor({ refId: card.id })
      assert.strictEqual(opened.doc.description, "A lighthouse keeper.")
      assert.deepStrictEqual(opened.doc.tags, ["sea", "night"])
      assert.deepStrictEqual(opened.doc.modules, [
        { ...module, content: "A grey coat.", placement: { mode: "depth", depth: 2, role: "system" } }
      ])
      // The drafts ended with the commit, which emptied them.
      assert.isTrue(opened.drafts.every((d) => d.status === "committed" && d.content === ""))
      const revisions = yield* api.ListRevisions({ refId: card.id, limit: 10 })
      assert.deepStrictEqual(
        revisions.map((r) => [r.origin, r.message]),
        [
          ["user", "First pass"],
          ["user", null]
        ]
      )
      // Saving with nothing changed makes no revision.
      assert.strictEqual((yield* commit(api, card.id)).ref.headRevisionId, saved.ref.headRevisionId)
    })
  )

  it.effect("undo brings a field's earlier text back, and the undo can be undone", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Undo", name: "Undo" })
      const field = textField(["first_mes"])
      const text = "The lamp needs oil before the storm comes in from the west."
      yield* draft(api, card.id, field, text)
      // Select-all and a stray key: destructive, so the text before it is one step back.
      const wiped = yield* draft(api, card.id, field, "x")
      const history = yield* api.EditorDraftHistory({ refId: card.id, field, limit: 10 })
      assert.strictEqual(history[0]!.length, 1)
      const restored = yield* api.RestoreEditorDraft({
        refId: card.id,
        field,
        seq: history[1]!.seq,
        expectedRowVersion: wiped.rowVersion
      })
      assert.strictEqual(restored.content, text)
      const after = yield* api.EditorDraftHistory({ refId: card.id, field, limit: 10 })
      assert.strictEqual(after[0]!.kind, "restore")
      // A stale tab can't restore over newer text.
      assert.strictEqual(
        yield* outcome(
          api.RestoreEditorDraft({ refId: card.id, field, seq: history[1]!.seq, expectedRowVersion: wiped.rowVersion })
        ),
        "StaleWrite"
      )
      // Discarding sends the text to the bin's recovered texts; nothing is saved.
      const discarded = yield* api.DiscardEditorDraft({
        refId: card.id,
        field,
        expectedRowVersion: restored.rowVersion
      })
      assert.strictEqual(discarded.status, "discarded")
      assert.strictEqual((yield* doc(api, card.id)).first_mes, "")
    })
  )

  it.effect("a document that wouldn't be valid, or a protected field, is refused and nothing is saved", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Refused", name: "Refused" })
      yield* draft(api, card.id, valueField(["description"]), "3")
      const invalid = yield* Effect.flip(commit(api, card.id))
      assert.strictEqual(invalid._tag, "InvalidDocument")
      assert.include(invalid._tag === "InvalidDocument" ? invalid.problems.join() : "", "description")
      const opened = yield* api.OpenEditor({ refId: card.id })
      yield* api.DiscardEditorDraft({
        refId: card.id,
        field: valueField(["description"]),
        expectedRowVersion: opened.drafts[0]!.rowVersion
      })
      yield* draft(api, card.id, valueField(["avatar_media_id"]), '"someone-elses-file"')
      assert.strictEqual(yield* outcome(commit(api, card.id)), "InvalidDocument")
      assert.strictEqual(
        yield* outcome(
          api.SaveEditorDraft({
            refId: card.id,
            field: '["__proto__"]',
            content: "{}",
            expectedRowVersion: null,
            baseRevisionId: null
          })
        ),
        "EditRefused"
      )
      assert.strictEqual((yield* api.ListRevisions({ refId: card.id, limit: 10 })).length, 1)
    })
  )

  it.effect("a draft from an older revision conflicts only where the saved version changed that field", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Upstream", name: "Wren" })
      const variant = yield* api.ForkVariant({ refId: card.id, label: "Variant", subtitle: "", moveDrafts: false })
      yield* draft(api, variant.id, textField(["description"]), "Mine.")
      yield* draft(api, variant.id, textField(["personality"]), "Quiet.")
      // The upstream changes the description; the variant follows it (a fast-forward).
      yield* draft(api, card.id, textField(["description"]), "Theirs.")
      const upstream = yield* commit(api, card.id)
      assert.deepStrictEqual(
        upstream.followers.map((f) => f.outcome),
        ["fast_forward"]
      )
      const conflict = yield* Effect.flip(commit(api, variant.id))
      assert.strictEqual(conflict._tag, "EditConflict")
      assert.deepStrictEqual(conflict._tag === "EditConflict" ? conflict.fields : [], [
        { field: textField(["description"]), saved: "Theirs.", draft: "Mine." }
      ])
      // Keeping mine: the same text against the saved version as its new base.
      const opened = yield* api.OpenEditor({ refId: variant.id })
      const mine = opened.drafts.find((d) => d.key.field === textField(["description"]))!
      yield* api.SaveEditorDraft({
        refId: variant.id,
        field: mine.key.field,
        content: "Mine.",
        expectedRowVersion: mine.rowVersion,
        baseRevisionId: opened.ref.headRevisionId
      })
      yield* commit(api, variant.id)
      const merged = yield* doc(api, variant.id)
      assert.deepStrictEqual([merged.description, merged.personality], ["Mine.", "Quiet."])
    })
  )

  it.effect("restoring a revision makes a new one with its content, so nothing in between is lost", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Restore", name: "Restore" })
      yield* draft(api, card.id, textField(["scenario"]), "A storm.")
      const first = yield* commit(api, card.id, "Storm")
      yield* draft(api, card.id, textField(["scenario"]), "A calm sea.")
      const second = yield* commit(api, card.id, "Calm")
      const restored = yield* api.RestoreRevision({
        refId: card.id,
        revisionId: first.ref.headRevisionId,
        expectedRowVersion: second.ref.rowVersion
      })
      assert.strictEqual((yield* doc(api, card.id)).scenario, "A storm.")
      const revisions = yield* api.ListRevisions({ refId: card.id, limit: 10 })
      assert.strictEqual(revisions.length, 4)
      assert.match(revisions[0]!.message!, /^Restored the revision of \d{4}-\d\d-\d\d \d\d:\d\d UTC$/)
      assert.strictEqual(revisions[1]!.id, second.ref.headRevisionId)
      assert.strictEqual(
        (yield* api.GetRevision({ refId: card.id, revisionId: second.ref.headRevisionId })).scenario,
        "A calm sea."
      )
      // A revision of another entity isn't this ref's to restore.
      const other = yield* api.CreateCard({ label: "Other", name: "Other" })
      assert.strictEqual(
        yield* outcome(
          api.RestoreRevision({
            refId: card.id,
            revisionId: other.headRevisionId,
            expectedRowVersion: restored.ref.rowVersion
          })
        ),
        "NotFound"
      )
    })
  )

  it.effect("a variant is one action, taking unsaved drafts along; used-by counts the chats a change reaches", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const me = yield* api.Whoami()
      const card = yield* api.CreateCard({ label: "Used", name: "Used" })
      const chat = yield* writer.CreateChat({
        userId: me.id,
        kind: "rp",
        status: "active",
        title: "With the card",
        participants: [card.entityId],
        greeting: null
      })
      yield* writer.CreateChat({
        userId: me.id,
        kind: "rp",
        status: "active",
        title: "",
        participants: [],
        greeting: null
      })
      assert.strictEqual((yield* api.OpenEditor({ refId: card.id })).usedByChats, 1)

      yield* draft(api, card.id, textField(["description"]), "Unsaved.")
      const variant = yield* api.ForkVariant({ refId: card.id, label: "Noir", subtitle: "rainy", moveDrafts: true })
      const opened = yield* api.OpenEditor({ refId: variant.id })
      assert.deepStrictEqual(
        opened.drafts.map((d) => [d.key.field, d.content]),
        [[textField(["description"]), "Unsaved."]]
      )
      assert.deepStrictEqual(
        opened.variants.map((v) => v.label),
        ["Noir", "Used"]
      )
      assert.strictEqual(opened.usedByChats, 0)
      assert.isEmpty((yield* api.OpenEditor({ refId: card.id })).drafts)
      // A chat override following the variant puts it to use in that chat.
      yield* writer.CreateChatOverride({ userId: me.id, refId: variant.id, chatId: chat.id as ChatId })
      assert.strictEqual((yield* api.OpenEditor({ refId: variant.id })).usedByChats, 1)
      const renamed = yield* api.RenameRef({
        refId: variant.id,
        label: "Noir Wren",
        subtitle: "",
        expectedRowVersion: variant.rowVersion
      })
      assert.strictEqual(renamed.label, "Noir Wren")
      assert.strictEqual(
        yield* outcome(api.RenameRef({ refId: variant.id, label: "Late", subtitle: "", expectedRowVersion: 1 })),
        "StaleWrite"
      )
    })
  )

  it.effect("regex scripts run only once allowed, and an update never allows new ones", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const library = yield* importPreset(preset("full"))
      const refId = library.ref.id
      assert.isFalse((yield* doc(api, refId)).regex_approved)
      const allowed = yield* api.SetRegexApproval({ refId, approved: true, expectedRowVersion: library.ref.rowVersion })
      assert.isTrue((yield* doc(api, refId)).regex_approved)
      assert.strictEqual(
        (yield* api.ListRevisions({ refId, limit: 1 }))[0]!.message,
        "Allowed the regex scripts to run"
      )
      // The user's own edits keep it, a script's included.
      yield* draft(api, refId, textField(["prompts", "identifier=main", "content"]), "Write tersely.")
      yield* draft(api, refId, textField(["regex", "id=8a2d6c1e-0002-4000-8000-000000000001", "replace_string"]), "-")
      yield* commit(api, refId)
      assert.isTrue((yield* doc(api, refId)).regex_approved)
      // A new version of the file with a prompt changed: merged, still allowed.
      yield* importPreset(
        preset("full", (file) => {
          file.temperature = 0.5
        }),
        refId
      )
      assert.isTrue((yield* doc(api, refId)).regex_approved)
      // One that brings a new script: merged, and no longer allowed.
      yield* importPreset(
        preset("full", (file) => {
          file.temperature = 0.5
          file.extensions.regex_scripts.push({ id: "planted", scriptName: "Planted", findRegex: "/(a+)+$/" })
        }),
        refId
      )
      const merged = (yield* doc(api, refId)) as unknown as PresetDoc
      assert.include(
        merged.regex.map((r) => r.id),
        "planted"
      )
      assert.isFalse(merged.regex_approved)
      // Restoring the allowed revision brings its scripts back, but not its approval.
      const current = yield* api.OpenEditor({ refId })
      yield* api.RestoreRevision({
        refId,
        revisionId: allowed.ref.headRevisionId,
        expectedRowVersion: current.ref.rowVersion
      })
      assert.isFalse((yield* doc(api, refId)).regex_approved)
    })
  )

  it.effect("an update with conflicts is resolved per field, against the schema", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const main = (text: string) => (file: PresetFile) => {
        file.prompts.find((p) => p.identifier === "main")!.content = text
      }
      const library = yield* importPreset(preset("default", main("Write vivid prose.")))
      const refId = library.ref.id
      yield* draft(api, refId, textField(["prompts", "identifier=main", "content"]), "Write calm prose.")
      yield* commit(api, refId)
      const update = yield* importPreset(preset("default", main("Write terse prose.")), refId)
      assert.strictEqual(update.outcome, "conflicts")
      const preview = yield* api.PreviewUpdate({ refId })
      assert.deepStrictEqual(
        preview.conflicts.map((c) => [c.path, c.ours, c.theirs]),
        [[["prompts", "identifier=main", "content"], "Write calm prose.", "Write terse prose."]]
      )
      const opened = yield* api.OpenEditor({ refId })
      assert.isTrue(opened.ref.updateAvailable)
      const prompts = (preview.merged as unknown as PresetDoc).prompts.map((p) =>
        p.identifier === "main" ? { ...p, content: "Write terse, calm prose." } : p
      )
      assert.strictEqual(
        yield* outcome(
          api.ResolveUpdate({
            refId,
            doc: { ...preview.merged, prompts: "none" },
            theirsRevisionId: preview.theirsRevisionId,
            expectedRowVersion: opened.ref.rowVersion
          })
        ),
        "InvalidDocument"
      )
      const resolved = yield* api.ResolveUpdate({
        refId,
        doc: { ...preview.merged, prompts },
        theirsRevisionId: preview.theirsRevisionId,
        expectedRowVersion: opened.ref.rowVersion
      })
      assert.isFalse(resolved.ref.updateAvailable)
      const after = (yield* doc(api, refId)) as unknown as PresetDoc
      assert.strictEqual(after.prompts.find((p) => p.identifier === "main")!.content, "Write terse, calm prose.")
    })
  )

  it.effect("a card's notes are their own entities, with a placement and an agent flag", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Noted", name: "Noted" })
      const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "Outfit" })
      yield* draft(api, note.id, textField(["content"]), "A grey coat.")
      yield* draft(api, note.id, valueField(["placement"]), '{"mode":"tail","role":"user"}')
      yield* draft(api, note.id, valueField(["agent_editable"]), "true")
      yield* commit(api, note.id)
      const [listed] = yield* api.ListCardNotes({ cardRefId: card.id })
      assert.deepStrictEqual(listed!.doc, {
        schema_version: 1,
        title: "Outfit",
        content: "A grey coat.",
        placement: { mode: "tail", role: "user" },
        owner: { card: card.entityId },
        exportable: true,
        agent_editable: true
      })
      // ST's Character's Note is in-chat: the tail exports as its depth 0, the card's section not at all.
      const depthPrompt = Effect.gen(function* () {
        const url = yield* base
        const response = yield* Effect.promise(() =>
          fetch(`${url}/library/export`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refId: card.id, format: "card-v3-json" })
          })
        )
        const file = (yield* Effect.promise(() => response.json())) as { data: { extensions: Record<string, unknown> } }
        return file.data.extensions.depth_prompt
      })
      assert.deepStrictEqual(yield* depthPrompt, { prompt: "A grey coat.", depth: 0, role: "user" })
      yield* draft(api, note.id, valueField(["placement"]), '{"mode":"section","section":"card"}')
      yield* commit(api, note.id)
      assert.isUndefined(yield* depthPrompt)
      // The owner never moves to another card.
      yield* draft(api, note.id, valueField(["owner"]), JSON.stringify({ card: "elsewhere" }))
      assert.strictEqual(yield* outcome(commit(api, note.id)), "InvalidDocument")
      const binned = yield* api.DeleteCardNote({ noteRefId: note.id })
      assert.strictEqual(binned.kind, "entity")
      assert.isEmpty(yield* api.ListCardNotes({ cardRefId: card.id }))
      assert.strictEqual(yield* outcome(api.DeleteCardNote({ noteRefId: card.id })), "NotFound")
    })
  )

  it.effect("an avatar upload is a new revision, and the image comes back only as an image", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Pictured", name: "Pictured" })
      const image = png(chunk("tEXt", new TextEncoder().encode("Comment\0pictured")))
      const stale = yield* upload(`/library/avatar?ref=${card.id}&rowVersion=${card.rowVersion + 1}`, image)
      assert.strictEqual(stale.status, 409)
      const text = yield* upload(`/library/avatar?ref=${card.id}&rowVersion=${card.rowVersion}`, new Uint8Array(64))
      assert.strictEqual(text.status, 415)
      const response = yield* upload(`/library/avatar?ref=${card.id}&rowVersion=${card.rowVersion}`, image)
      assert.strictEqual(response.status, 200)
      const opened = yield* api.OpenEditor({ refId: card.id })
      assert.strictEqual((yield* api.ListRevisions({ refId: card.id, limit: 1 }))[0]!.message, "Changed the avatar")
      const url = yield* base
      const served = yield* Effect.promise(() => fetch(`${url}/library/media?id=${opened.doc.avatar_media_id}`))
      assert.strictEqual(served.status, 200)
      assert.strictEqual(served.headers.get("content-type"), "image/png")
      assert.strictEqual(served.headers.get("x-content-type-options"), "nosniff")
      assert.deepStrictEqual(new Uint8Array(yield* Effect.promise(() => served.arrayBuffer())), new Uint8Array(image))
      assert.strictEqual(
        (yield* Effect.promise(() => fetch(`${url}/library/media?id=${card.headRevisionId}`))).status,
        404
      )
    })
  )

  it.effect("a 50 KB description and a 100-prompt preset save through the same path", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Long", name: "Long" })
      const long = "The sea keeps its own counsel. ".repeat(1700)
      yield* draft(api, card.id, textField(["description"]), long)
      yield* commit(api, card.id)
      assert.strictEqual((yield* doc(api, card.id)).description, long)

      const library = yield* importPreset(preset("default"))
      const refId = library.ref.id
      const before = (yield* doc(api, refId)) as unknown as PresetDoc
      const added = Array.from({ length: 88 }, (_, i) => ({
        ...before.prompts[0]!,
        identifier: `extra-${i}`,
        name: `Extra ${i}`,
        system_prompt: false,
        content: `Rule ${i}.`
      }))
      yield* draft(api, refId, valueField(["prompts"]), JSON.stringify([...before.prompts, ...added]))
      const order = [...added.map((p) => ({ identifier: p.identifier, enabled: true })), ...before.order].reverse()
      yield* draft(api, refId, valueField(["order"]), JSON.stringify(order))
      yield* commit(api, refId, "A hundred prompts")
      const after = (yield* doc(api, refId)) as unknown as PresetDoc
      assert.strictEqual(after.prompts.length, 100)
      assert.deepStrictEqual(after.order, order)
      const imported = (yield* api.GetRevision({
        refId,
        revisionId: library.ref.headRevisionId
      })) as unknown as PresetDoc
      assert.strictEqual(imported.prompts.length, 12)
    })
  )
})
