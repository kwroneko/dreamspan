// The card and preset editors at the real boundary (ARCHITECTURE.md "Editing the library"):
// a real server with its workers, drafts saved and committed over RPC, files over HTTP.
// Cross-user probes are in isolation.test.ts.
import { readFileSync } from "node:fs"
import { assert, layer } from "@effect/vitest"
import type { LegacyPresetDoc as PresetDoc } from "@rp/shared/docs/preset.ts"
import { textField, validateDoc, valueField } from "@rp/shared/editing.ts"
import { ImportResult } from "@rp/shared/libraryImport.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect, Exit, Schema } from "effect"
import { presetDoc } from "./support/docs.ts"
import { docHash, searchText } from "../src/db/documents.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { chunk, png, stCardV2 } from "./formats/support.ts"
import { client, outcome, post, serverLayer, serverPort, testConfig } from "./support/config.ts"

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
      draftId: null,
      expectedSession: null,
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
        .map((d) => ({ field: d.key.field, draftId: d.id, expectedRowVersion: d.rowVersion })),
      message
    })
  })

const doc = (api: Api, refId: RefId) => Effect.map(api.OpenEditor({ refId }), (opened) => opened.doc)

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("editing the library", (it) => {
  it.effect("restoring a legacy preset without Main materializes a disabled first slot", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const me = yield* api.Whoami()
      // Simulate an old stored revision through the writer's prevalidated-import boundary.
      const legacy = presetDoc([{ identifier: "style", content: "STYLE" }])
      const imported = yield* writer.ImportFile({
        userId: me.id,
        intoRefId: null,
        kind: "preset",
        label: "Legacy without Main",
        docJson: JSON.stringify(legacy),
        docHash: docHash(legacy),
        searchText: searchText(legacy),
        schemaVersion: 1,
        sourceName: "legacy.json",
        sourceHash: "a".repeat(64),
        media: [],
        noteDocJson: null
      })
      const refId = imported.ref.id
      yield* draft(api, refId, textField(["prompts", "identifier=style", "content"]), "CHANGED")
      const saved = yield* commit(api, refId)
      const restored = yield* api.RestoreRevision({
        refId,
        revisionId: imported.ref.headRevisionId,
        expectedRowVersion: saved.ref.rowVersion
      })
      // Read the stored revision, bypassing the editor's virtual normalization.
      const stored = yield* api.GetRevision({ refId, revisionId: restored.ref.headRevisionId })
      assert.deepStrictEqual((stored.order as PresetDoc["order"])[0], { identifier: "main", enabled: false })
      assert.isTrue((stored.prompts as PresetDoc["prompts"]).some((p) => p.identifier === "main"))
      assert.strictEqual(
        (stored.prompts as PresetDoc["prompts"]).find((p) => p.identifier === "style")!.content,
        "STYLE"
      )
    })
  )

  it.effect("creates a prompt preset with editable ordered prompts and safe overrides", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ref = yield* api.CreatePreset({ label: "From scratch" })
      assert.strictEqual(ref.kind, "preset")
      assert.strictEqual(ref.label, "From scratch")
      assert.include(
        (yield* api.ListLibrary({ kind: "preset" })).map((p) => p.id),
        ref.id
      )
      const first = yield* doc(api, ref.id)
      const prompts = first.prompts as PresetDoc["prompts"]
      const order = first.order as PresetDoc["order"]
      assert.isAbove(order.length, 5)
      assert.isTrue(order.every((e) => prompts.some((p) => p.identifier === e.identifier)))
      for (const [identifier, content] of [
        ["groupNudge", "[Write {{speaker}}'s next message. Write only for {{speaker}}.]"],
        ["impersonationPrompt", "[Write {{speaker}}'s next message. Write only for {{speaker}}.]"],
        ["directionPrompt", "[What happens next: {{direction}}]"]
      ]) {
        assert.strictEqual(prompts.find((p) => p.identifier === identifier)!.content, content)
        assert.isFalse(order.some((entry) => entry.identifier === identifier))
      }
      for (const id of ["main", "jailbreak"]) assert.isTrue(prompts.find((p) => p.identifier === id)!.forbid_overrides)
      assert.isFalse(first.regex_approved)
      assert.notProperty(first, "samplers")
      const field = textField(["prompts", "identifier=main", "content"])
      yield* draft(api, ref.id, field, "A synthetic instruction")
      yield* commit(api, ref.id)
      assert.strictEqual(
        ((yield* doc(api, ref.id)).prompts as PresetDoc["prompts"]).find((p) => p.identifier === "main")!.content,
        "A synthetic instruction"
      )
      const original = yield* api.GetRevision({ refId: ref.id, revisionId: ref.headRevisionId })
      assert.notStrictEqual((original.prompts as PresetDoc["prompts"])[0]!.content, "A synthetic instruction")
    })
  )

  it.effect("standard card names survive create, rename, fork, revision history and V3 export", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({
        label: "Ignored legacy label",
        name: "Display",
        nickname: "Model",
        version: "1.0"
      })
      assert.strictEqual(card.label, "Display")
      assert.strictEqual(card.subtitle, "1.0")
      const first = yield* doc(api, card.id)
      assert.deepStrictEqual([first.name, first.nickname, first.character_version], ["Display", "Model", "1.0"])
      yield* draft(api, card.id, textField(["name"]), "Renamed display")
      yield* draft(api, card.id, textField(["character_version"]), "2.0")
      const saved = yield* commit(api, card.id)
      assert.deepStrictEqual([saved.ref.label, saved.ref.subtitle], ["Renamed display", "2.0"])
      const old = yield* api.GetRevision({ refId: card.id, revisionId: card.headRevisionId })
      assert.deepStrictEqual([old.name, old.nickname, old.character_version], ["Display", "Model", "1.0"])
      yield* draft(api, card.id, textField(["name"]), "Pending display")
      const fork = yield* api.ForkCard({
        refId: card.id,
        name: "Fork display",
        nickname: "Model",
        characterVersion: "3.0",
        moveDrafts: true
      })
      const source = yield* api.OpenEditor({ refId: card.id })
      assert.strictEqual(source.drafts.find((d) => d.key.field === textField(["name"]))!.content, "Pending display")
      const forkDoc = yield* doc(api, fork.id)
      assert.deepStrictEqual(
        [forkDoc.name, forkDoc.nickname, forkDoc.character_version],
        ["Fork display", "Model", "3.0"]
      )
      const renamed = yield* api.RenameRef({
        refId: fork.id,
        label: "RPC rename",
        subtitle: "4.0",
        expectedRowVersion: fork.rowVersion
      })
      assert.notStrictEqual(renamed.headRevisionId, fork.headRevisionId)
      const url = yield* base
      const response = yield* Effect.promise(() =>
        fetch(`${url}/library/export`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refId: renamed.id, format: "card-v3-json" })
        })
      )
      const file = (yield* Effect.promise(() => response.json())) as {
        data: { name: string; nickname: string; character_version: string }
      }
      assert.deepStrictEqual(
        [file.data.name, file.data.nickname, file.data.character_version],
        ["RPC rename", "Model", "4.0"]
      )
    })
  )

  it.effect("a save names its draft: one that moved to a fork never takes over the new draft here", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Moved draft", name: "Moved draft" })
      const field = textField(["description"])
      const a = yield* api.SaveEditorDraft({
        expectedSession: null,
        refId: card.id,
        field,
        draftId: null,
        content: "base A",
        expectedRowVersion: null,
        baseRevisionId: card.headRevisionId
      })
      const variant = yield* api.ForkCard({
        refId: card.id,
        name: "Variant",
        nickname: "",
        characterVersion: "",
        moveDrafts: true
      })
      const b = yield* api.SaveEditorDraft({
        expectedSession: null,
        refId: card.id,
        field,
        draftId: null,
        content: "base B",
        expectedRowVersion: null,
        baseRevisionId: card.headRevisionId
      })
      // A's counters match B's: only the draft's id tells them apart.
      assert.deepStrictEqual([a.rowVersion, a.session], [b.rowVersion, b.session])
      const stale = yield* api.SaveEditorDraft({
        refId: card.id,
        field,
        draftId: a.id,
        content: "base A2",
        expectedRowVersion: a.rowVersion,
        expectedSession: a.session,
        baseRevisionId: card.headRevisionId
      })
      assert.strictEqual(stale.id, b.id)
      // B's text is one step back, and the commit sends it to the recovered texts.
      const saved = yield* api.CommitEditorDrafts({
        refId: card.id,
        expectedRowVersion: card.rowVersion,
        fields: [{ field, draftId: stale.id, expectedRowVersion: stale.rowVersion }],
        message: null
      })
      assert.strictEqual(saved.recovered, 1)
      const recovered = yield* api.ListRecoveredTexts({ limit: 100, before: null })
      assert.include(
        recovered.map((text) => text.content),
        "base B"
      )
      // A, in the variant, is as it was; and committing it by its old id here is stale.
      assert.strictEqual((yield* api.OpenEditor({ refId: variant.id })).drafts[0]!.content, "base A")
      assert.strictEqual(
        yield* outcome(
          api.CommitEditorDrafts({
            refId: variant.id,
            expectedRowVersion: variant.rowVersion,
            fields: [{ field, draftId: b.id, expectedRowVersion: a.rowVersion }],
            message: null
          })
        ),
        "StaleWrite"
      )
    })
  )

  it.effect("an active editor save crossing a commit keeps its revision base and conflicts", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ref = yield* api.CreateCard({ label: "Crossing commit", name: "Synthetic" })
      const field = textField(["description"])
      const first = yield* draft(api, ref.id, field, "hello")
      const b = yield* api.SaveEditorDraft({
        draftId: first.id,
        refId: ref.id,
        field,
        content: "hello B",
        expectedRowVersion: first.rowVersion,
        expectedSession: first.session,
        baseRevisionId: null
      })
      yield* api.CommitEditorDrafts({
        refId: ref.id,
        expectedRowVersion: ref.rowVersion,
        fields: [{ field, draftId: b.id, expectedRowVersion: b.rowVersion }],
        message: null
      })
      const a = yield* api.SaveEditorDraft({
        draftId: first.id,
        refId: ref.id,
        field,
        content: "hello A",
        expectedRowVersion: first.rowVersion,
        expectedSession: first.session,
        baseRevisionId: null
      })
      assert.strictEqual(a.baseRevision, first.baseRevision)
      assert.strictEqual(yield* outcome(commit(api, ref.id)), "EditConflict")
      assert.strictEqual((yield* doc(api, ref.id)).description, "hello B")
    })
  )

  it.effect("a card's fields edit through drafts and save as one revision", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      yield* draft(api, card.id, textField(["description"]), "A keeper.")
      yield* draft(api, card.id, textField(["description"]), "A lighthouse keeper.")
      yield* draft(api, card.id, valueField(["tags"]), '["sea","night"]')
      // A list with ids, here an older card's modules, which a new card no longer has.
      yield* draft(api, card.id, valueField(["modules"]), "[]")
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
      const firstPage = yield* api.ListRevisions({ refId: card.id, limit: 1 })
      const nextPage = yield* api.ListRevisions({ refId: card.id, limit: 1, before: firstPage[0]!.id })
      assert.deepStrictEqual([...firstPage, ...nextPage], revisions)
      assert.deepStrictEqual(yield* api.ListRevisions({ refId: card.id, limit: 1, before: nextPage[0]!.id }), [])
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
        draftId: wiped.id,
        seq: history[1]!.seq,
        expectedRowVersion: wiped.rowVersion
      })
      assert.strictEqual(restored.content, text)
      const after = yield* api.EditorDraftHistory({ refId: card.id, field, limit: 10 })
      assert.strictEqual(after[0]!.kind, "restore")
      // A stale tab can't restore over newer text.
      assert.strictEqual(
        yield* outcome(
          api.RestoreEditorDraft({
            refId: card.id,
            field,
            draftId: wiped.id,
            seq: history[1]!.seq,
            expectedRowVersion: wiped.rowVersion
          })
        ),
        "StaleWrite"
      )
      // Discarding sends the text to the bin's recovered texts; nothing is saved.
      const discarded = yield* api.DiscardEditorDraft({
        refId: card.id,
        field,
        draftId: restored.id,
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
        draftId: opened.drafts[0]!.id,
        expectedRowVersion: opened.drafts[0]!.rowVersion
      })
      yield* draft(api, card.id, valueField(["avatar_media_id"]), '"someone-elses-file"')
      assert.strictEqual(yield* outcome(commit(api, card.id)), "InvalidDocument")
      assert.strictEqual(
        yield* outcome(
          api.SaveEditorDraft({
            draftId: null,
            expectedSession: null,
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
      const variant = card
      yield* draft(api, variant.id, textField(["description"]), "Mine.")
      yield* draft(api, variant.id, textField(["personality"]), "Quiet.")
      const writer = yield* Writer
      const me = yield* api.Whoami()
      yield* writer.EditRef({
        userId: me.id,
        refId: card.id,
        doc: { ...(yield* doc(api, card.id)), description: "Theirs." },
        expectedRowVersion: card.rowVersion,
        message: null,
        commitDraft: null
      })
      const conflict = yield* Effect.flip(commit(api, variant.id))
      assert.strictEqual(conflict._tag, "EditConflict")
      assert.deepStrictEqual(conflict._tag === "EditConflict" ? conflict.fields : [], [
        { field: textField(["description"]), saved: "Theirs.", draft: "Mine." }
      ])
      // Keeping mine: the same text against the saved version as its new base.
      const opened = yield* api.OpenEditor({ refId: variant.id })
      const mine = opened.drafts.find((d) => d.key.field === textField(["description"]))!
      yield* api.SaveEditorDraft({
        draftId: mine.id,
        expectedSession: mine.session,
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

  it.effect("a fork is one action, taking unsaved drafts along; used-by counts the chats a change reaches", () =>
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
      const variant = yield* api.ForkCard({
        refId: card.id,
        name: "Noir",
        nickname: "",
        characterVersion: "rainy",
        moveDrafts: true
      })
      const opened = yield* api.OpenEditor({ refId: variant.id })
      assert.deepStrictEqual(
        opened.drafts.map((d) => [d.key.field, d.content]),
        [[textField(["description"]), "Unsaved."]]
      )
      assert.deepStrictEqual(
        opened.variants.map((v) => v.label),
        []
      )
      assert.strictEqual(opened.usedByChats, 0)
      assert.isEmpty((yield* api.OpenEditor({ refId: card.id })).drafts)
      // Swapping the card puts the fork to use in that chat.
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "Swap", entityId: variant.entityId, replaces: card.entityId }
      })
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

  it.effect("a card's regex scripts run only once allowed; a draft or a restore never allows them", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Scripted", name: "Scripted" })
      const script = {
        id: "strip",
        name: "Strip",
        find_regex: "/x/g",
        replace_string: "",
        trim_strings: [],
        placement: [2],
        disabled: false,
        markdown_only: false,
        prompt_only: false,
        run_on_edit: false,
        substitute_regex: "none",
        min_depth: null,
        max_depth: null
      }
      yield* draft(api, card.id, valueField(["regex"]), JSON.stringify([script]))
      const before = yield* commit(api, card.id)
      assert.isUndefined((yield* doc(api, card.id)).regex_approved)
      // A draft of the approval itself is refused, as the avatar's is.
      yield* draft(api, card.id, valueField(["regex_approved"]), "true")
      assert.strictEqual(yield* outcome(commit(api, card.id)), "InvalidDocument")
      const opened = yield* api.OpenEditor({ refId: card.id })
      const granting = opened.drafts.find(
        (d) => d.key.field === valueField(["regex_approved"]) && d.status === "active"
      )!
      yield* api.DiscardEditorDraft({
        refId: card.id,
        field: valueField(["regex_approved"]),
        draftId: granting.id,
        expectedRowVersion: granting.rowVersion
      })
      const discarded = yield* api.OpenEditor({ refId: card.id })
      yield* api.SetRegexApproval({ refId: card.id, approved: true, expectedRowVersion: discarded.ref.rowVersion })
      assert.isTrue((yield* doc(api, card.id)).regex_approved)
      // The user's own edit of a script keeps it.
      yield* draft(api, card.id, textField(["regex", "id=strip", "replace_string"]), "-")
      yield* commit(api, card.id)
      assert.isTrue((yield* doc(api, card.id)).regex_approved)
      // Restoring the revision from before brings other scripts back, never their approval.
      const current = yield* api.OpenEditor({ refId: card.id })
      yield* api.RestoreRevision({
        refId: card.id,
        revisionId: before.ref.headRevisionId,
        expectedRowVersion: current.ref.rowVersion
      })
      assert.isFalse((yield* doc(api, card.id)).regex_approved ?? false)
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
      yield* draft(api, note.id, valueField(["on_by_default"]), "true")
      yield* commit(api, note.id)
      const [listed] = yield* api.ListCardNotes({ cardRefId: card.id })
      assert.deepStrictEqual(listed!.doc, {
        schema_version: 1,
        title: "Outfit",
        content: "A grey coat.",
        placement: { mode: "tail", role: "user" },
        owner: { card: card.entityId },
        exportable: true,
        agent_editable: true,
        on_by_default: true
      })
      // ST's Character's Note is in-chat and on in every chat: the tail exports as its depth 0,
      // a note off by default or the card's section not at all.
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
      yield* draft(api, note.id, valueField(["on_by_default"]), "false")
      yield* commit(api, note.id)
      assert.isUndefined(yield* depthPrompt)
      yield* draft(api, note.id, valueField(["on_by_default"]), "true")
      yield* commit(api, note.id)
      yield* draft(api, note.id, valueField(["placement"]), '{"mode":"section","section":"card"}')
      yield* commit(api, note.id)
      assert.isUndefined(yield* depthPrompt)
      // The owner never moves to another card.
      yield* draft(api, note.id, valueField(["owner"]), JSON.stringify({ card: "elsewhere" }))
      assert.strictEqual(yield* outcome(commit(api, note.id)), "InvalidDocument")
      const binned = yield* api.DeleteNote({ noteRefId: note.id })
      assert.strictEqual(binned.kind, "entity")
      assert.isEmpty(yield* api.ListCardNotes({ cardRefId: card.id }))
      assert.strictEqual(yield* outcome(api.DeleteNote({ noteRefId: card.id })), "NotFound")
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
      // Only a whole PNG signature makes a PNG, for avatars as for imports.
      const broken = Uint8Array.from(image)
      broken.set([0, 0, 0, 0], 4)
      const half = yield* upload(`/library/avatar?ref=${card.id}&rowVersion=${card.rowVersion}`, broken)
      assert.strictEqual(half.status, 415)
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

  it.effect("another tab's field text a stale save goes over is kept, live or as a page closes", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const recovered = () =>
        Effect.flatMap(api.ListRecoveredTexts({ limit: 100, before: null }), (texts) =>
          Effect.forEach(texts, (text) => Effect.map(api.GetRecoveredText({ id: text.id }), (full) => full.content))
        )
      for (const kind of ["card", "preset"] as const) {
        for (const closing of [false, true]) {
          const refId =
            kind === "card"
              ? (yield* api.CreateCard({ label: "Two tabs", name: "Two tabs" })).id
              : (yield* importPreset(preset("default"))).ref.id
          const field =
            kind === "card" ? textField(["description"]) : textField(["prompts", "identifier=main", "content"])
          const mine = yield* draft(api, refId, field, `${kind} hello`)
          // The other tab read that, and typed on within the time typing coalesces...
          yield* draft(api, refId, field, `${kind} hello B${closing ? " closing" : ""}`)
          // ...and this tab, which hadn't seen it, saves its own.
          const stale = {
            draftId: mine.id,
            refId,
            field,
            content: `${kind} hello A`,
            expectedRowVersion: mine.rowVersion,
            expectedSession: mine.session,
            baseRevisionId: null
          }
          if (closing) assert.strictEqual((yield* post("/library/drafts", { drafts: [stale] })).status, 204)
          else yield* api.SaveEditorDraft(stale)
          yield* commit(api, refId)
          assert.include(yield* recovered(), `${kind} hello B${closing ? " closing" : ""}`)
        }
      }
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
      const added = Array.from({ length: 100 - before.prompts.length }, (_, i) => ({
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
      // ST's twelve and the newest-message marker, the group nudge, the impersonation and direction prompts.
      assert.strictEqual(imported.prompts.length, 16)
    })
  )
})

/** A card with a conflicting new import. */
const pendingVariant = (api: Api, name: string) =>
  Effect.gen(function* () {
    const card = yield* api.CreateCard({ label: name, name })
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id
    const source = yield* doc(api, card.id)
    const imported = (personality: string) => {
      const next = { ...source, personality }
      return writer.ImportFile({
        userId,
        intoRefId: card.id,
        kind: "card",
        label: name,
        schemaVersion: 1,
        docJson: JSON.stringify(next),
        docHash: docHash(next),
        searchText: searchText(next),
        sourceName: "synthetic.json",
        sourceHash: "0".repeat(64),
        media: [],
        noteDocJson: null
      })
    }
    yield* imported("")
    yield* draft(api, card.id, textField(["personality"]), "Quiet.")
    yield* commit(api, card.id)
    yield* imported("Loud.")
    const preview = yield* api.PreviewUpdate({ refId: card.id })
    assert.strictEqual(preview.outcome, "conflicts")
    const opened = yield* api.OpenEditor({ refId: card.id })
    return { card, variant: opened.ref, preview }
  })

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("what editing refuses", (it) => {
  it.effect("a resolved update must be pending, keep protected fields from a side, and grant nothing", () =>
    Effect.gen(function* () {
      const api = yield* client()
      // Nothing pending: there's nothing to resolve.
      const card = yield* api.CreateCard({ label: "Settled", name: "Settled" })
      const settled = card
      const opened = yield* api.OpenEditor({ refId: settled.id })
      assert.strictEqual(
        yield* outcome(
          api.ResolveUpdate({
            refId: settled.id,
            doc: opened.doc,
            theirsRevisionId: card.headRevisionId,
            expectedRowVersion: settled.rowVersion
          })
        ),
        "EditRefused"
      )

      const { variant, preview } = yield* pendingVariant(api, "Pending")
      const resolve = (doc: Record<string, unknown>) =>
        api.ResolveUpdate({
          refId: variant.id,
          doc,
          theirsRevisionId: preview.theirsRevisionId,
          expectedRowVersion: variant.rowVersion
        })
      // Another of the user's own files as the avatar: neither side has it.
      const other = yield* api.CreateCard({ label: "Pictured", name: "Pictured" })
      const uploaded = yield* upload(
        `/library/avatar?ref=${other.id}&rowVersion=${other.rowVersion}`,
        png(chunk("tEXt", new TextEncoder().encode("Comment\0other")))
      )
      assert.strictEqual(uploaded.status, 200)
      const media = (yield* doc(api, other.id)).avatar_media_id
      assert.strictEqual(yield* outcome(resolve({ ...preview.merged, avatar_media_id: media })), "InvalidDocument")
      assert.strictEqual(yield* outcome(resolve({ ...preview.merged, personality: 3 })), "InvalidDocument")
      // A module the agent may edit isn't granted by a resolution.
      const modules = [{ id: "m", title: "M", content: "", exportable: true, agent_editable: true }]
      yield* resolve({ ...preview.merged, modules })
      const resolved = yield* doc(api, variant.id)
      assert.deepStrictEqual(resolved.modules, [{ ...modules[0], agent_editable: false }])
      assert.isFalse((yield* api.OpenEditor({ refId: variant.id })).ref.updateAvailable)
    })
  )

  it.effect("a note's resolved update can't move it to another card", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Noted", name: "Noted" })
      const another = yield* api.CreateCard({ label: "Another", name: "Another" })
      const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "Note" })
      const variant = yield* api.ForkVariant({ refId: note.id, label: "Note variant", subtitle: "", moveDrafts: false })
      yield* draft(api, variant.id, textField(["content"]), "Mine.")
      yield* commit(api, variant.id)
      yield* draft(api, note.id, textField(["content"]), "Theirs.")
      yield* commit(api, note.id)
      const preview = yield* api.PreviewUpdate({ refId: variant.id })
      const opened = yield* api.OpenEditor({ refId: variant.id })
      const result = yield* Effect.flip(
        api.ResolveUpdate({
          refId: variant.id,
          doc: { ...preview.merged, owner: { card: another.entityId } },
          theirsRevisionId: preview.theirsRevisionId,
          expectedRowVersion: opened.ref.rowVersion
        })
      )
      assert.strictEqual(result._tag, "InvalidDocument")
      assert.include(result._tag === "InvalidDocument" ? result.problems.join() : "", "owner")
    })
  )

  it.effect("two valid edits that merge into an invalid preset leave the variant to resolve", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const refId = (yield* importPreset(preset("default"))).ref.id
      const before = (yield* doc(api, refId)) as unknown as PresetDoc
      const x = { ...before.prompts[0]!, identifier: "x", name: "X", system_prompt: false, marker: false }
      yield* draft(api, refId, valueField(["prompts", "identifier=x"]), JSON.stringify(x))
      yield* commit(api, refId)
      const variant = yield* api.ForkVariant({ refId, label: "Without X", subtitle: "", moveDrafts: false })
      yield* draft(api, variant.id, valueField(["prompts", "identifier=x"]), "null")
      yield* commit(api, variant.id)
      const variantDoc = yield* doc(api, variant.id)
      // The upstream puts X in its order; the variant deleted X.
      yield* draft(
        api,
        refId,
        valueField(["order"]),
        JSON.stringify([...before.order, { identifier: "x", enabled: true }])
      )
      const saved = yield* commit(api, refId)
      assert.deepStrictEqual(
        saved.followers.map((f) => f.outcome),
        ["conflicts"]
      )
      assert.deepStrictEqual(yield* doc(api, variant.id), variantDoc)
      const preview = yield* api.PreviewUpdate({ refId: variant.id })
      assert.deepStrictEqual(
        preview.conflicts.map((c) => c.path),
        [["order"]]
      )
      // Keeping the variant's order resolves it.
      const opened = yield* api.OpenEditor({ refId: variant.id })
      yield* api.ResolveUpdate({
        refId: variant.id,
        doc: { ...preview.merged, order: variantDoc.order },
        theirsRevisionId: preview.theirsRevisionId,
        expectedRowVersion: opened.ref.rowVersion
      })
      assert.isFalse((yield* api.OpenEditor({ refId: variant.id })).ref.updateAvailable)
    })
  )

  it.effect("text at a field the schema doesn't know is refused, and the draft keeps it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Unknown", name: "Unknown" })
      yield* draft(api, card.id, textField(["not_a_card_field"]), "My irreplaceable text")
      const refused = yield* Effect.flip(commit(api, card.id))
      assert.strictEqual(refused._tag, "InvalidDocument")
      const opened = yield* api.OpenEditor({ refId: card.id })
      assert.deepStrictEqual(
        opened.drafts.map((d) => [d.status, d.content]),
        [["active", "My irreplaceable text"]]
      )
      assert.strictEqual(opened.ref.headRevisionId, card.headRevisionId)
    })
  )

  it.effect("a list with ids is addressed by id, so a reorder can't send an edit to another element", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Indexed", name: "Indexed" })
      const modules = [
        { id: "x", title: "X", content: "same", exportable: false },
        { id: "y", title: "Y", content: "same", exportable: false }
      ]
      yield* draft(api, card.id, valueField(["modules"]), JSON.stringify(modules))
      yield* commit(api, card.id)
      yield* draft(api, card.id, textField(["modules", 0, "content"]), "intended for X")
      assert.strictEqual(yield* outcome(commit(api, card.id)), "InvalidDocument")
      assert.deepStrictEqual((yield* doc(api, card.id)).modules, modules)
    })
  )

  it.effect("a draft in something deleted since is set aside on save, its text recovered", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Removed", name: "Removed" })
      yield* draft(api, card.id, valueField(["modules"]), "[]")
      yield* draft(
        api,
        card.id,
        valueField(["modules", "id=x"]),
        JSON.stringify({ id: "x", title: "X", content: "", exportable: false })
      )
      yield* draft(api, card.id, textField(["modules", "id=x", "content"]), "Unsaved text")
      yield* draft(api, card.id, valueField(["modules", "id=x"]), "null")
      yield* draft(api, card.id, textField(["scenario"]), "Kept.")
      const saved = yield* commit(api, card.id)
      assert.deepStrictEqual(saved.setAside, [textField(["modules", "id=x", "content"])])
      const after = yield* doc(api, card.id)
      assert.deepStrictEqual([after.scenario, after.modules], ["Kept.", []])
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const recovered = yield* reader.ListRecoveredTexts({ userId: me.id, source: null, limit: 100, before: null })
      assert.include(
        recovered.map((r) => r.content),
        "Unsaved text"
      )
    })
  )

  it.effect("restoring an earlier revision never gives the agent back a permission taken away", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Permission", name: "Permission" })
      const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "N" })
      yield* draft(api, note.id, valueField(["agent_editable"]), "true")
      const allowed = yield* commit(api, note.id)
      yield* draft(api, note.id, valueField(["agent_editable"]), "false")
      const stopped = yield* commit(api, note.id)
      yield* api.RestoreRevision({
        refId: note.id,
        revisionId: allowed.ref.headRevisionId,
        expectedRowVersion: stopped.ref.rowVersion
      })
      assert.isFalse((yield* doc(api, note.id)).agent_editable)
    })
  )
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("every revision is valid", (it) => {
  it.effect("a file the schema would refuse never makes an invalid revision, and nothing stores one", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const refId = (yield* importPreset(preset("full"))).ref.id
      // A regex placement past the safe integers: the importer drops it.
      yield* importPreset(
        preset("full", (file) => {
          ;(file.extensions.regex_scripts[0] as { placement: Array<number> }).placement = [1e20]
        }),
        refId
      )
      const imported = yield* doc(api, refId)
      assert.isTrue(validateDoc("preset", imported).ok)
      // A write that skips the checks callers make still can't store an invalid document.
      const writer = yield* Writer
      const me = yield* api.Whoami()
      const opened = yield* api.OpenEditor({ refId })
      const exit = yield* Effect.exit(
        writer.EditRef({
          userId: me.id,
          refId,
          doc: { ...opened.doc, prompts: "arbitrary invalid replacement" },
          expectedRowVersion: opened.ref.rowVersion,
          message: null,
          commitDraft: null
        })
      )
      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(yield* doc(api, refId), imported)
    })
  )

  it.effect("a resolution is held to the schema too", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { variant, preview } = yield* pendingVariant(api, "Schema")
      assert.strictEqual(
        yield* outcome(
          api.ResolveUpdate({
            refId: variant.id,
            doc: { ...preview.merged, modules: "arbitrary invalid replacement" },
            theirsRevisionId: preview.theirsRevisionId,
            expectedRowVersion: variant.rowVersion
          })
        ),
        "InvalidDocument"
      )
    })
  )

  it.effect("a draft in something deleted since never conflicts: it's set aside, and the rest saves", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Orphan", name: "Orphan" })
      const module = { id: "x", title: "X", content: "old", exportable: false }
      yield* draft(api, card.id, valueField(["modules", "id=x"]), JSON.stringify(module))
      yield* commit(api, card.id)
      const variant = (yield* api.OpenEditor({ refId: card.id })).ref
      yield* draft(api, variant.id, textField(["modules", "id=x", "content"]), "valuable unsaved")
      // Another editor removes the module while the draft remains.
      const writer = yield* Writer
      yield* writer.EditRef({
        userId: (yield* api.Whoami()).id,
        refId: card.id,
        doc: { ...(yield* doc(api, card.id)), modules: [] },
        expectedRowVersion: variant.rowVersion,
        message: null,
        commitDraft: null
      })
      yield* draft(api, variant.id, textField(["scenario"]), "unrelated edit")
      const saved = yield* commit(api, variant.id)
      assert.deepStrictEqual(saved.setAside, [textField(["modules", "id=x", "content"])])
      assert.strictEqual((yield* doc(api, variant.id)).scenario, "unrelated edit")
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const recovered = yield* reader.ListRecoveredTexts({ userId: me.id, source: null, limit: 100, before: null })
      assert.include(
        recovered.map((r) => r.content),
        "valuable unsaved"
      )
    })
  )

  it.effect("following what it follows never gives a variant a permission taken away from it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Granted", name: "Granted" })
      const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "N" })
      yield* draft(api, note.id, valueField(["agent_editable"]), "true")
      yield* commit(api, note.id)
      yield* draft(api, note.id, valueField(["agent_editable"]), "false")
      yield* commit(api, note.id)
      const variant = yield* api.ForkVariant({ refId: note.id, label: "Revoked", subtitle: "", moveDrafts: false })
      yield* draft(api, note.id, valueField(["agent_editable"]), "true")
      const saved = yield* commit(api, note.id)
      assert.deepStrictEqual(
        saved.followers.map((f) => f.outcome),
        ["merged"]
      )
      assert.isFalse((yield* doc(api, variant.id)).agent_editable)
      // The same holds for a preset's regex approval.
      const presetId = (yield* importPreset(preset("full"))).ref.id
      const follower = yield* api.ForkVariant({ refId: presetId, label: "Unapproved", subtitle: "", moveDrafts: false })
      const opened = yield* api.OpenEditor({ refId: presetId })
      yield* api.SetRegexApproval({ refId: presetId, approved: true, expectedRowVersion: opened.ref.rowVersion })
      assert.isFalse((yield* doc(api, follower.id)).regex_approved)
    })
  )
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("an imported chat note", (it) => {
  it.effect("keeps the fields the editor doesn't show through an edit", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const me = yield* api.Whoami()
      const chat = yield* api.CreateChat({ title: "Harbor" })
      const note = {
        schema_version: 1,
        title: "Summary",
        content: "They met at the harbor.",
        placement: { mode: "section", section: "after_main_prompt" },
        owner: { chat: chat.id },
        exportable: false,
        kind: "imported_summary",
        interval: 3,
        template: "[Summary: {{summary}}]"
      }
      const { ref } = yield* writer.CreateEntity({
        userId: me.id,
        kind: "note",
        label: "Summary",
        subtitle: "",
        doc: note,
        schemaVersion: 1,
        origin: "import",
        sourcePath: null
      })
      yield* draft(api, ref.id, textField(["content"]), "They met at the harbor, at dusk.")
      yield* draft(api, ref.id, valueField(["placement"]), '{"mode":"none"}')
      yield* commit(api, ref.id)
      assert.deepStrictEqual(yield* doc(api, ref.id), {
        ...note,
        content: "They met at the harbor, at dusk.",
        placement: { mode: "none" }
      })
    })
  )
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("a card's imported note", (it) => {
  it.effect("is always valid: a depth past ST's limit is clamped and reported, and nothing stores an invalid one", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = (depth: number) => {
        const file = stCardV2()
        ;(file.data.extensions as { depth_prompt: { depth: number } }).depth_prompt.depth = depth
        return new TextEncoder().encode(JSON.stringify(file))
      }
      const imported = (bytes: Uint8Array, into?: RefId) =>
        Effect.gen(function* () {
          const response = yield* upload(`/library/import?name=wren.json${into ? `&into=${into}` : ""}`, bytes)
          return Schema.decodeUnknownSync(ImportResult)(yield* Effect.promise(() => response.json()))
        })
      const first = yield* imported(card(2))
      const again = yield* imported(card(10_001), first.library!.ref.id)
      assert.include(
        again.report.issues.map((issue) => issue.code),
        "card.character_note_depth"
      )
      const note = yield* api.OpenEditor({ refId: again.library!.note!.id })
      assert.deepStrictEqual(note.doc.placement, { mode: "depth", depth: 10_000, role: "system" })
      assert.isTrue(validateDoc("note", note.doc).ok)
      // An unrelated edit of the note saves.
      yield* draft(api, note.ref.id, textField(["content"]), "Still valid.")
      yield* commit(api, note.ref.id)

      // An import revision of a note is checked in the writer too.
      const writer = yield* Writer
      const me = yield* api.Whoami()
      const exit = yield* Effect.exit(
        writer.CreateEntity({
          userId: me.id,
          kind: "note",
          label: "Deep",
          subtitle: "",
          doc: { ...note.doc, placement: { mode: "depth", depth: 10_001, role: "system" } },
          schemaVersion: 1,
          origin: "import",
          sourcePath: null
        })
      )
      assert.isTrue(Exit.isFailure(exit))
    })
  )
})
