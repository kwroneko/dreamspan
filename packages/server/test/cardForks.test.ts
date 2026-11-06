// Card forks (spec/CARD-FORKS-DELTA.md §2, §9 unit 1; ARCHITECTURE.md §3.9) at the real
// boundary: a fork is a card of its own, a copy of its parent's head with its own names,
// tags and notes, and only the relationship ties the two. Cross-user probes are in
// isolation.test.ts; the triggers on a bare connection in schema.test.ts.
import { assert, layer } from "@effect/vitest"
import type { EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { textField, valueField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc, docFor, presetDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

const config = testConfig()

type Api = Effect.Success<ReturnType<typeof client>>

const me = (api: Api) => Effect.map(api.Whoami(), (user) => user.id as UserId)

/** A card made through the writer, with whatever fields the test needs. */
const card = (api: Api, name: string, fields: Parameters<typeof cardDoc>[1] = {}, sourcePath: string | null = null) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    return yield* writer.CreateEntity({
      userId: yield* me(api),
      kind: "card",
      label: name,
      subtitle: "",
      doc: cardDoc(name, fields),
      schemaVersion: 1,
      origin: sourcePath === null ? "user" : "import",
      sourcePath
    })
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

/** Commits the ref's active drafts of these fields, or all of them. */
const commit = (api: Api, refId: RefId, only?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const opened = yield* api.OpenEditor({ refId })
    return yield* api.CommitEditorDrafts({
      refId,
      expectedRowVersion: opened.ref.rowVersion,
      fields: opened.drafts
        .filter((d) => d.status === "active" && (only === undefined || only.includes(d.key.field)))
        .map((d) => ({ field: d.key.field, draftId: d.id, expectedRowVersion: d.rowVersion })),
      message: null
    })
  })

const fork = (api: Api, refId: RefId, characterVersion: string, name?: string) =>
  Effect.gen(function* () {
    const parent = yield* api.OpenEditor({ refId })
    return yield* api.ForkCard({
      refId,
      name: name ?? parent.ref.label,
      nickname: typeof parent.doc.nickname === "string" ? parent.doc.nickname : "",
      characterVersion
    })
  })

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("card forks", (it) => {
  it.effect("a copied card note keeps the draft's original base and detects concurrent edits", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const userId = yield* me(api)
      const parent = yield* card(api, "Note conflict")
      const note = yield* api.CreateCardNote({ cardRefId: parent.ref.id, title: "Weather" })
      const start = note.headRevisionId
      yield* draft(api, note.id, textField(["content"]), "Unsaved fog.")
      const opened = yield* api.OpenEditor({ refId: note.id })
      yield* writer.EditRef({
        userId,
        refId: note.id,
        expectedRowVersion: opened.ref.rowVersion,
        doc: { ...opened.doc, content: "Saved rain." },
        message: null,
        commitDraft: null
      })
      const forked = yield* fork(api, parent.ref.id, "fork")
      const [copy] = yield* api.ListCardNotes({ cardRefId: forked.id })
      assert.strictEqual(yield* outcome(commit(api, copy!.ref.id), () => "allowed"), "EditConflict")
      const carried = (yield* api.OpenEditor({ refId: copy!.ref.id })).drafts.find((d) => d.status === "active")!
      assert.strictEqual(carried.baseRevision, start)
      assert.strictEqual((yield* api.GetRevision({ refId: copy!.ref.id, revisionId: start })).content, "")
      const copiedAgain = yield* fork(api, forked.id, "next fork")
      const [nextNote] = yield* api.ListCardNotes({ cardRefId: copiedAgain.id })
      assert.strictEqual(yield* outcome(commit(api, nextNote!.ref.id), () => "allowed"), "EditConflict")
    })
  )

  it.effect("a fork of a fork carries an older draft base and keeps its conflict", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const userId = yield* me(api)
      const parent = yield* card(api, "Nested draft", { description: "A cook." })
      const start = parent.ref.headRevisionId
      yield* draft(api, parent.ref.id, textField(["description"]), "A chef.")
      const opened = yield* api.OpenEditor({ refId: parent.ref.id })
      yield* writer.EditRef({
        userId,
        refId: parent.ref.id,
        expectedRowVersion: opened.ref.rowVersion,
        doc: { ...opened.doc, description: "A baker." },
        message: null,
        commitDraft: null
      })
      const child = yield* fork(api, parent.ref.id, "child")
      const grandchild = yield* fork(api, child.id, "grandchild")
      const carried = (yield* api.OpenEditor({ refId: grandchild.id })).drafts.find(
        (d) => d.key.field === textField(["description"]) && d.status === "active"
      )!
      assert.strictEqual(carried.content, "A chef.")
      assert.strictEqual(carried.baseRevision, start)
      assert.strictEqual((yield* api.GetRevision({ refId: grandchild.id, revisionId: start })).description, "A cook.")
      yield* api.SaveEditorDraft({
        refId: grandchild.id,
        draftId: carried.id,
        field: carried.key.field,
        content: "A chef, typed on.",
        expectedRowVersion: carried.rowVersion,
        expectedSession: carried.session,
        baseRevisionId: start
      })
      assert.strictEqual(yield* outcome(commit(api, grandchild.id), () => "allowed"), "EditConflict")
      assert.isUndefined((yield* api.OpenEditor({ refId: child.id })).drafts.find((d) => d.status === "active"))
    })
  )

  it.effect(
    "restoring a parent's revision on a fork makes the fork's own revision, with the fork's names and notes' card",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const parent = yield* card(api, "Lio", { nickname: "Lio", character_version: "dawn", scenario: "Calm seas." })
        const note = yield* api.CreateCardNote({ cardRefId: parent.ref.id, title: "Ship" })
        yield* draft(api, parent.ref.id, textField(["scenario"]), "Storm season.")
        yield* commit(api, parent.ref.id)
        const before = yield* api.OpenEditor({ refId: parent.ref.id })
        const forked = yield* api.ForkCard({
          refId: parent.ref.id,
          name: "Lio",
          nickname: "Captain Lio",
          characterVersion: "noir"
        })
        yield* draft(api, forked.id, textField(["description"]), "Weathered.")
        yield* commit(api, forked.id)
        const history = yield* api.ListRevisions({ refId: forked.id, limit: 10 })
        assert.deepStrictEqual(
          history.map((r) => [r.number, r.entry?.refId ?? null, r.forkedFrom?.revisionId ?? null]),
          [
            [4, null, null],
            [3, null, before.ref.headRevisionId],
            [2, parent.ref.id, null],
            [1, parent.ref.id, null]
          ]
        )
        const opened = yield* api.OpenEditor({ refId: forked.id })
        assert.strictEqual(opened.revisionNumber, 4)

        // The parent's first revision: its text comes back; the fork's names stay the fork's.
        yield* api.RestoreRevision({
          refId: forked.id,
          revisionId: history[3]!.id,
          expectedRowVersion: opened.ref.rowVersion
        })
        const restored = yield* api.OpenEditor({ refId: forked.id })
        assert.deepStrictEqual(
          [
            restored.doc.scenario,
            restored.doc.description,
            restored.doc.name,
            restored.doc.nickname,
            restored.doc.character_version
          ],
          ["Calm seas.", before.doc.description, "Lio", "Captain Lio", "noir"]
        )
        assert.deepStrictEqual([restored.ref.label, restored.ref.subtitle, restored.revisionNumber], ["Lio", "noir", 5])
        const [top] = yield* api.ListRevisions({ refId: forked.id, limit: 1 })
        assert.deepStrictEqual([top!.parents, top!.entry], [[opened.ref.headRevisionId], undefined])
        const unchanged = yield* api.OpenEditor({ refId: parent.ref.id })
        assert.deepStrictEqual(
          [unchanged.ref.headRevisionId, unchanged.doc.scenario],
          [before.ref.headRevisionId, "Storm season."]
        )
        assert.strictEqual(
          yield* outcome(api.SetRevisionMessage({ refId: forked.id, revisionId: history[2]!.id, message: "Mine" })),
          "NotFound"
        )

        // A note the fork copied: the parent note's revision comes back owned by the fork's card.
        const [copy] = yield* api.ListCardNotes({ cardRefId: forked.id })
        yield* draft(api, copy!.ref.id, textField(["content"]), "A schooner.")
        yield* commit(api, copy!.ref.id)
        const noteHistory = yield* api.ListRevisions({ refId: copy!.ref.id, limit: 10 })
        assert.deepStrictEqual(
          noteHistory.map((r) => r.entry?.refId ?? null),
          [null, null, note.id]
        )
        yield* api.RestoreRevision({
          refId: copy!.ref.id,
          revisionId: noteHistory[2]!.id,
          expectedRowVersion: (yield* api.OpenEditor({ refId: copy!.ref.id })).ref.rowVersion
        })
        const [back] = yield* api.ListCardNotes({ cardRefId: forked.id })
        assert.deepStrictEqual([back!.doc.content, back!.doc.owner], ["", { card: forked.entityId }])
        assert.deepStrictEqual(
          (yield* api.ListCardNotes({ cardRefId: parent.ref.id })).map((n) => n.ref.id),
          [note.id]
        )
      })
  )

  it.effect("fork names accept the same unbounded strings as card fields", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const parent = yield* card(api, "Long name parent")
      const name = "N".repeat(301)
      const nickname = "I".repeat(601)
      const characterVersion = "V".repeat(601)
      const fork = yield* api.ForkCard({ refId: parent.ref.id, name, nickname, characterVersion })
      const opened = yield* api.OpenEditor({ refId: fork.id })
      assert.strictEqual(opened.doc.name, name)
      assert.strictEqual(opened.doc.nickname, nickname)
      assert.strictEqual(opened.doc.character_version, characterVersion)
    })
  )

  it.effect("cards refuse the label-only variant operations: they fork with their names", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const userId = yield* me(api)
      const parent = yield* card(api, "Independent")
      assert.strictEqual(
        yield* outcome(api.ForkVariant({ refId: parent.ref.id, label: "Legacy", subtitle: "", moveDrafts: true })),
        "EditRefused"
      )
      assert.strictEqual(
        yield* outcome(writer.ForkRef({ userId, refId: parent.ref.id, label: "Legacy", subtitle: "" })),
        "RefOperationRefused:Cards fork with their names (ForkCard)."
      )
      assert.deepStrictEqual(
        (yield* api.CardFamily({ entityId: parent.entityId })).members.map((m) => m.entityId),
        [parent.entityId]
      )
    })
  )

  it.effect(
    "a fork copies its parent's document, tags and notes, not its source; its History runs on through the parent's",
    () =>
      Effect.gen(function* () {
        const api = yield* client()
        const writer = yield* Writer
        const userId = yield* me(api)
        const lore = docFor("lorebook", "Harbor lore")
        const parent = yield* card(
          api,
          "Mira",
          {
            nickname: "Mira Vey",
            character_version: "harbor",
            description: "A lighthouse keeper.",
            avatar_media_id: "media-avatar",
            asset_media_ids: { "embeded://map.png": "media-map" },
            character_book: lore as never,
            extensions: { world: "Harbor" },
            modules: [
              { id: "m1", title: "Secrets", content: "She hides a key.", exportable: false, agent_editable: true }
            ]
          },
          "Mira.png"
        )
        yield* writer.SetEntityTags({ userId, entityId: parent.entityId, tags: ["harbor", "persona"] })
        const note = yield* api.CreateCardNote({ cardRefId: parent.ref.id, title: "Outfit" })
        const noteDoc = (yield* api.ListCardNotes({ cardRefId: parent.ref.id }))[0]!.doc
        yield* writer.SetEntityTags({ userId, entityId: note.entityId, tags: ["wardrobe"] })
        // An earlier revision, which the fork's History lists as its parent's.
        yield* draft(api, parent.ref.id, textField(["scenario"]), "Storm season.")
        yield* commit(api, parent.ref.id)
        const head = yield* api.OpenEditor({ refId: parent.ref.id })

        const forked = yield* api.ForkCard({
          refId: parent.ref.id,
          name: "Mira",
          nickname: "Captain Vey",
          characterVersion: "noir"
        })
        assert.notStrictEqual(forked.entityId, parent.entityId)
        assert.deepStrictEqual(
          [forked.kind, forked.parentEntityId, forked.label, forked.subtitle],
          ["card", parent.entityId, "Mira", "noir"]
        )
        assert.strictEqual(head.ref.modelName, "Mira Vey")
        assert.strictEqual(forked.modelName, "Captain Vey")
        assert.isTrue(head.ref.hasImport)
        assert.isFalse(forked.hasImport)
        assert.isFalse(forked.updateAvailable)
        const opened = yield* api.OpenEditor({ refId: forked.id })
        assert.deepStrictEqual(opened.doc, { ...head.doc, nickname: "Captain Vey", character_version: "noir" })
        assert.deepStrictEqual(
          opened.variants.map((v) => v.id),
          []
        )

        // Its History is a git branch's log (owner, 2026-11-06): its first revision, naming the
        // revision it copied, then the parent's line down from that one.
        const history = yield* api.ListRevisions({ refId: forked.id, limit: 10 })
        assert.deepStrictEqual(
          history.map((r) => [r.parents.length, r.origin, r.number, r.entry?.refId ?? null]),
          [
            [0, "user", 3, null],
            [1, "user", 2, parent.ref.id],
            [0, "import", 1, parent.ref.id]
          ]
        )
        assert.deepStrictEqual(
          [history[0]!.forkedFrom?.revisionId, history[0]!.forkedFrom?.refId, history[1]!.id],
          [head.ref.headRevisionId, parent.ref.id, head.ref.headRevisionId]
        )
        const [[row]] = (yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: `SELECT r.source_path, r.source_hash, v.origin_ref, e.forked_from_entity_id, e.forked_from_revision_id,
                    e.forked_in_chat_id, e.archived_at, r.last_used_at
                  FROM entity_refs r JOIN entities e ON e.id = r.entity_id JOIN entity_revisions v ON v.id = r.head_revision_id
                  WHERE r.id = ?`,
              params: [forked.id]
            }
          ],
          { readOnly: true }
        )) as unknown as [[Record<string, unknown>]]
        assert.deepStrictEqual(row, {
          source_path: null,
          source_hash: null,
          origin_ref: JSON.stringify({ forked: head.ref.headRevisionId }),
          forked_from_entity_id: parent.entityId,
          forked_from_revision_id: head.ref.headRevisionId,
          forked_in_chat_id: null,
          archived_at: null,
          last_used_at: null
        })

        // Tags, the persona folder included.
        for (const tag of ["harbor", "persona"]) {
          const tagged = yield* (yield* Reader).ListLibrary({ userId, kind: "card", tag, archived: false })
          assert.isTrue(
            tagged.some((ref) => ref.id === forked.id),
            tag
          )
        }
        // Its own copy of each note: the same content, owned by the fork; the parent's stays its own.
        const copies = yield* api.ListCardNotes({ cardRefId: forked.id })
        assert.strictEqual(copies.length, 1)
        assert.notStrictEqual(copies[0]!.ref.entityId, note.entityId)
        assert.deepStrictEqual(copies[0]!.doc, { ...noteDoc, owner: { card: forked.entityId } })
        assert.strictEqual(copies[0]!.ref.label, "Outfit")
        const wardrobe = yield* (yield* Reader).ListLibrary({ userId, kind: "note", tag: "wardrobe", archived: false })
        assert.isTrue(wardrobe.some((r) => r.id === copies[0]!.ref.id))
        const own = yield* api.ListCardNotes({ cardRefId: parent.ref.id })
        assert.deepStrictEqual(
          own.map((n) => [n.ref.id, n.doc]),
          [[note.id, noteDoc]]
        )
        // Editing the copy leaves the parent's note alone.
        yield* draft(api, copies[0]!.ref.id, textField(["content"]), "A raincoat.")
        yield* commit(api, copies[0]!.ref.id)
        assert.deepStrictEqual((yield* api.ListCardNotes({ cardRefId: parent.ref.id }))[0]!.doc, noteDoc)

        const family = yield* api.CardFamily({ entityId: forked.entityId })
        assert.strictEqual(family.rootEntityId, parent.entityId)
        const member = family.members.find((m) => m.entityId === forked.entityId)!
        assert.deepStrictEqual(
          [member.parentEntityId, member.forkedFromRevisionId, member.forkedInChatId, member.refId, member.state],
          [parent.entityId, head.ref.headRevisionId, null, forked.id, "live"]
        )
        assert.isNumber(member.forkedAt)
      })
  )

  it.effect("a copied note's condition names the fork where it named the card, and keeps the others", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const parent = yield* card(api, "Ethan")
      const other = yield* card(api, "Mira")
      const note = yield* api.CreateCardNote({ cardRefId: parent.ref.id, title: "Outfit" })
      yield* draft(
        api,
        note.id,
        valueField(["condition"]),
        JSON.stringify({ when: "turn", cards: [parent.entityId, other.entityId] })
      )
      yield* commit(api, note.id)
      const forked = yield* fork(api, parent.ref.id, "winter")
      const [copy] = yield* api.ListCardNotes({ cardRefId: forked.id })
      assert.deepStrictEqual(copy!.doc["condition"], { when: "turn", cards: [forked.entityId, other.entityId] })
      // The parent's note still names the parent.
      const [own] = yield* api.ListCardNotes({ cardRefId: parent.ref.id })
      assert.deepStrictEqual(own!.doc["condition"], { when: "turn", cards: [parent.entityId, other.entityId] })
    })
  )

  it.effect("the parent and its chats are untouched after editing either", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const persona = yield* card(api, "Sam")
      const parent = yield* card(api, "Ana", { description: "A sailor.", first_mes: "Ahoy." })
      const started = yield* api.StartChat({
        cards: [parent.entityId],
        persona: persona.entityId,
        greeting: null,
        first: { _tag: "Send", content: "Hello.", speakerEntityId: persona.entityId }
      })
      const chatId = started.chat.id
      const before = yield* api.OpenEditor({ refId: parent.ref.id })
      const forked = yield* fork(api, parent.ref.id, "retired")

      const chats = (entityId: EntityId) =>
        Effect.map(api.ListChats({ limit: 50, before: null, entityId }), (list) => list.map((c) => c.id))
      const cast = Effect.map(api.ListChatCards({ chatId, slotId: null, entityIds: [parent.entityId] }), ([entry]) => [
        entry!.entityId,
        entry!.refId,
        entry!.definition.description
      ])
      assert.deepStrictEqual(yield* chats(parent.entityId), [chatId])
      assert.deepStrictEqual(yield* chats(forked.entityId), [])
      assert.deepStrictEqual(yield* cast, [parent.entityId, parent.ref.id, "A sailor."])

      // Editing the fork: the parent and the chat read what they did.
      yield* draft(api, forked.id, textField(["description"]), "A retired sailor.")
      yield* commit(api, forked.id)
      const parentAfter = yield* api.OpenEditor({ refId: parent.ref.id })
      assert.deepStrictEqual(
        [parentAfter.ref.headRevisionId, parentAfter.ref.rowVersion, parentAfter.doc, parentAfter.usedByChats],
        [before.ref.headRevisionId, before.ref.rowVersion, before.doc, 1]
      )
      assert.deepStrictEqual(yield* cast, [parent.entityId, parent.ref.id, "A sailor."])
      assert.deepStrictEqual(yield* chats(parent.entityId), [chatId])

      // Editing the parent: the fork keeps its content; only the explicit merge offers the change.
      const forkBefore = yield* api.OpenEditor({ refId: forked.id })
      yield* draft(api, parent.ref.id, textField(["description"]), "An old sailor.")
      const saved = yield* commit(api, parent.ref.id)
      assert.deepStrictEqual(saved.followers, [])
      const forkAfter = yield* api.OpenEditor({ refId: forked.id })
      assert.deepStrictEqual(
        [forkAfter.ref.headRevisionId, forkAfter.doc.description, forkAfter.ref.updateAvailable, forkAfter.usedByChats],
        [forkBefore.ref.headRevisionId, "A retired sailor.", false, 0]
      )
      assert.deepStrictEqual(yield* chats(forked.entityId), [])
      const family = yield* api.CardFamily({ entityId: parent.entityId })
      assert.deepStrictEqual(
        family.members.map((m) => [m.entityId, m.chats]),
        [
          [parent.entityId, 1],
          [forked.entityId, 0]
        ]
      )
    })
  )

  it.effect("the family is the same tree from every member, binned and purged members included", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const userId = yield* me(api)
      const a = yield* card(api, "Root")
      const b = yield* fork(api, a.ref.id, "b")
      const c = yield* fork(api, b.id, "c")
      const d = yield* fork(api, a.ref.id, "d")
      const e = yield* fork(api, c.id, "e")
      // Another family, which never shows up in this one.
      const other = yield* card(api, "Stranger")
      yield* fork(api, other.ref.id, "x")

      const ids = [a.entityId, b.entityId, c.entityId, d.entityId, e.entityId]
      const from = (entityId: EntityId) => api.CardFamily({ entityId })
      const first = yield* from(a.entityId)
      assert.strictEqual(first.rootEntityId, a.entityId)
      assert.deepStrictEqual(
        first.members.map((m) => [m.entityId, m.parentEntityId, m.subtitle]),
        [
          [a.entityId, null, ""],
          [b.entityId, a.entityId, "b"],
          [c.entityId, b.entityId, "c"],
          [d.entityId, a.entityId, "d"],
          [e.entityId, c.entityId, "e"]
        ]
      )
      for (const id of ids) assert.deepStrictEqual(yield* from(id), first, id)

      // An archived member stays; one in the bin stays, marked, and its fork still names it.
      yield* writer.SetEntityArchived({ userId, entityId: d.entityId, archived: true })
      const archived = yield* api.ListLibrary({ kind: "card", archived: true })
      assert.strictEqual(archived.find((ref) => ref.id === d.id)?.modelName, "Root")
      const binned = yield* writer.DeleteEntity({ userId, entityId: c.entityId })
      const withBin = yield* from(a.entityId)
      assert.deepStrictEqual(
        withBin.members.map((m) => [m.entityId, m.state, m.parentEntityId]),
        [
          [a.entityId, "live", null],
          [b.entityId, "live", a.entityId],
          [c.entityId, "binned", b.entityId],
          [d.entityId, "archived", a.entityId],
          [e.entityId, "live", c.entityId]
        ]
      )
      assert.strictEqual(withBin.members[2]!.label, "Root")
      for (const id of [a.entityId, b.entityId, d.entityId, e.entityId]) {
        assert.deepStrictEqual(yield* from(id), withBin, id)
      }
      // A card in the bin can't be asked for, as anything else in it.
      assert.strictEqual(yield* outcome(from(c.entityId), () => "allowed"), "NotFound")

      // Deleted for good: still in the tree, without its names or the revision its fork copied.
      yield* api.PurgeBinItem({ itemId: binned.id })
      const purged = yield* from(e.entityId)
      assert.deepStrictEqual(
        purged.members.map((m) => [m.entityId, m.state, m.refId, m.label]),
        [
          [a.entityId, "live", a.ref.id, "Root"],
          [b.entityId, "live", b.id, "Root"],
          [c.entityId, "purged", null, ""],
          [d.entityId, "archived", d.id, "Root"],
          [e.entityId, "live", e.id, "Root"]
        ]
      )
      assert.deepStrictEqual(
        [purged.members[4]!.parentEntityId, purged.members[4]!.forkedFromRevisionId],
        [c.entityId, null]
      )
      for (const id of [a.entityId, b.entityId, d.entityId]) assert.deepStrictEqual(yield* from(id), purged, id)
    })
  )

  it.effect("Mark as a fork of… and Unlink, refusing itself, cycles and other kinds", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const userId = yield* me(api)
      const original = yield* card(api, "Duplicate", { character_version: "st" })
      const copy = yield* card(api, "Duplicate", { character_version: "st copy" })
      const docBefore = (yield* api.OpenEditor({ refId: copy.ref.id })).doc

      const marked = yield* api.SetCardParent({ entityId: copy.entityId, parentEntityId: original.entityId })
      assert.strictEqual(marked.rootEntityId, original.entityId)
      const member = marked.members.find((m) => m.entityId === copy.entityId)!
      assert.deepStrictEqual([member.parentEntityId, member.forkedFromRevisionId], [original.entityId, null])
      // Neither card's content changes.
      const after = yield* api.OpenEditor({ refId: copy.ref.id })
      assert.deepStrictEqual([after.doc, after.ref.headRevisionId], [docBefore, copy.ref.headRevisionId])
      assert.deepStrictEqual(yield* api.CardFamily({ entityId: original.entityId }), marked)
      // Marking again changes nothing, not even when.
      assert.deepStrictEqual(
        yield* api.SetCardParent({ entityId: copy.entityId, parentEntityId: original.entityId }),
        marked
      )

      const refusal = (attempt: Effect.Effect<unknown, { readonly _tag: string }>) => outcome(attempt, () => "allowed")
      // Itself, its own fork, or a fork of a fork.
      const grandchild = yield* fork(api, copy.ref.id, "deep")
      assert.strictEqual(
        yield* refusal(api.SetCardParent({ entityId: copy.entityId, parentEntityId: copy.entityId })),
        "EditRefused"
      )
      assert.strictEqual(
        yield* refusal(api.SetCardParent({ entityId: original.entityId, parentEntityId: copy.entityId })),
        "EditRefused"
      )
      assert.strictEqual(
        yield* refusal(api.SetCardParent({ entityId: original.entityId, parentEntityId: grandchild.entityId })),
        "EditRefused"
      )
      // Something that isn't a card, a card in the bin, and a note as the child.
      const note = yield* api.CreateCardNote({ cardRefId: original.ref.id, title: "Note" })
      const preset = yield* writer.CreateEntity({
        userId,
        kind: "preset",
        label: "Preset",
        subtitle: "",
        doc: presetDoc(),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const gone = yield* card(api, "Gone")
      yield* writer.DeleteEntity({ userId, entityId: gone.entityId })
      for (const parentEntityId of [note.entityId, preset.entityId, gone.entityId]) {
        assert.strictEqual(
          yield* refusal(api.SetCardParent({ entityId: original.entityId, parentEntityId })),
          "NotFound",
          parentEntityId
        )
      }
      assert.strictEqual(
        yield* refusal(api.SetCardParent({ entityId: note.entityId, parentEntityId: original.entityId })),
        "NotFound"
      )
      // Nothing refused changed the family.
      const family = yield* api.CardFamily({ entityId: original.entityId })
      assert.deepStrictEqual(
        family.members.map((m) => [m.entityId, m.parentEntityId]),
        [
          [original.entityId, null],
          [copy.entityId, original.entityId],
          [grandchild.entityId, copy.entityId]
        ]
      )

      // Unlink: the copy is a family of its own again, keeping its fork; the original stands alone.
      const unlinked = yield* api.SetCardParent({ entityId: copy.entityId, parentEntityId: null })
      assert.strictEqual(unlinked.rootEntityId, copy.entityId)
      assert.deepStrictEqual(
        unlinked.members.map((m) => [m.entityId, m.parentEntityId, m.forkedAt === null]),
        [
          [copy.entityId, null, true],
          [grandchild.entityId, copy.entityId, false]
        ]
      )
      assert.deepStrictEqual(
        (yield* api.CardFamily({ entityId: original.entityId })).members.map((m) => m.entityId),
        [original.entityId]
      )
    })
  )

  it.effect("moves the drafts but its names, which the dialog decides; a moved draft commits on the fork", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const userId = yield* me(api)
      const parent = yield* card(api, "Lio", {
        nickname: "Lio",
        character_version: "1",
        personality: "Calm.",
        description: "A cook."
      })
      const start = parent.ref.headRevisionId
      // Started on the first revision, then another field saved: an older base.
      yield* draft(api, parent.ref.id, textField(["personality"]), "Calm, then furious.")
      yield* draft(api, parent.ref.id, textField(["first_mes"]), "Dinner?")
      yield* commit(api, parent.ref.id, [textField(["first_mes"])])
      // A draft whose field the parent changed since it started: a conflict on the fork too.
      yield* draft(api, parent.ref.id, textField(["description"]), "A chef.")
      const head = yield* api.OpenEditor({ refId: parent.ref.id })
      yield* writer.EditRef({
        userId,
        refId: parent.ref.id,
        doc: { ...head.doc, description: "A baker." },
        expectedRowVersion: head.ref.rowVersion,
        message: null,
        commitDraft: null
      })
      // Started on the head the fork copies.
      yield* draft(api, parent.ref.id, textField(["scenario"]), "A kitchen fire.")
      for (const key of ["name", "nickname", "character_version"]) {
        yield* draft(api, parent.ref.id, textField([key]), `pending ${key}`)
      }
      const bases = new Map(
        (yield* api.OpenEditor({ refId: parent.ref.id })).drafts.map((d) => [d.key.field, d.baseRevision])
      )
      assert.strictEqual(bases.get(textField(["personality"])), start)

      const forked = yield* api.ForkCard({
        refId: parent.ref.id,
        name: "Lio",
        nickname: "Chef Lio",
        characterVersion: "2"
      })
      const active = (refId: RefId) =>
        Effect.map(api.OpenEditor({ refId }), (opened) =>
          opened.drafts
            .filter((d) => d.status === "active")
            .map((d) => [d.key.field, d.content, d.baseRevision])
            .toSorted()
        )
      assert.deepStrictEqual(
        yield* active(parent.ref.id),
        ["character_version", "name", "nickname"]
          .map((key) => [textField([key]), `pending ${key}`, bases.get(textField([key]))])
          .toSorted()
      )
      const copied = (yield* api.OpenEditor({ refId: parent.ref.id })).ref.headRevisionId
      assert.deepStrictEqual(
        yield* active(forked.id),
        [
          [textField(["description"]), "A chef.", bases.get(textField(["description"]))],
          [textField(["personality"]), "Calm, then furious.", start],
          [textField(["scenario"]), "A kitchen fire.", forked.headRevisionId]
        ].toSorted()
      )
      assert.strictEqual(bases.get(textField(["scenario"])), copied)
      // The fork's names are the dialog's.
      const opened = yield* api.OpenEditor({ refId: forked.id })
      assert.deepStrictEqual(
        [opened.doc.name, opened.doc.nickname, opened.doc.character_version],
        ["Lio", "Chef Lio", "2"]
      )

      // The description changed since its draft started, here as on the parent.
      const conflict = yield* outcome(commit(api, forked.id), () => "allowed")
      assert.strictEqual(conflict, "EditConflict")
      const saved = yield* commit(api, forked.id, [textField(["personality"]), textField(["scenario"])])
      const doc = (yield* api.OpenEditor({ refId: saved.ref.id })).doc
      assert.deepStrictEqual(
        [doc.personality, doc.scenario, doc.description],
        ["Calm, then furious.", "A kitchen fire.", "A baker."]
      )
      // The parent kept its own content.
      const parentDoc = (yield* api.OpenEditor({ refId: parent.ref.id })).doc
      assert.deepStrictEqual([parentDoc.personality, parentDoc.scenario], ["Calm.", ""])
    })
  )

  it.effect("a moved draft with an older base keeps saving and comparing on the fork, as the editor does", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const parent = yield* card(api, "Wren", { character_version: "1", personality: "Shy." })
      const start = parent.ref.headRevisionId
      const typed = yield* draft(api, parent.ref.id, textField(["personality"]), "Shy, then bold.")
      yield* draft(api, parent.ref.id, textField(["first_mes"]), "Hello.")
      yield* commit(api, parent.ref.id, [textField(["first_mes"])])
      const forked = yield* api.ForkCard({
        refId: parent.ref.id,
        name: "Wren",
        nickname: "",
        characterVersion: "2"
      })
      const moved = (yield* api.OpenEditor({ refId: forked.id })).drafts.find(
        (d) => d.key.field === textField(["personality"])
      )!
      // The fork's own draft now, with the text and its base; the parent went back to its revision.
      assert.notStrictEqual(moved.id, typed.id)
      assert.strictEqual(moved.content, "Shy, then bold.")
      assert.strictEqual(moved.baseRevision, start)
      const left = (yield* api.OpenEditor({ refId: parent.ref.id })).drafts.find((d) => d.id === typed.id)!
      assert.notStrictEqual(left.status, "active")
      // The editor's save dialog compares a draft with the revision it started from.
      const base = yield* api.GetRevision({ refId: forked.id, revisionId: start })
      assert.strictEqual(base.personality, "Shy.")
      // Typing on, the editor sends the draft's own base with the text.
      const saved = yield* api.SaveEditorDraft({
        draftId: moved.id,
        expectedSession: null,
        refId: forked.id,
        field: moved.key.field,
        content: "Shy, then bold, then kind.",
        expectedRowVersion: moved.rowVersion,
        baseRevisionId: start
      })
      assert.strictEqual(saved.content, "Shy, then bold, then kind.")
      assert.strictEqual(saved.baseRevision, start)
      const committed = yield* commit(api, forked.id)
      assert.strictEqual(
        (yield* api.OpenEditor({ refId: committed.ref.id })).doc.personality,
        "Shy, then bold, then kind."
      )
      // Another card's revisions stay out of reach, the parent's included once unlinked.
      yield* api.SetCardParent({ entityId: forked.entityId, parentEntityId: null })
      assert.strictEqual(
        yield* outcome(api.GetRevision({ refId: forked.id, revisionId: start }), () => "allowed"),
        "NotFound"
      )
      const other = yield* card(api, "Other")
      assert.strictEqual(
        yield* outcome(api.GetRevision({ refId: forked.id, revisionId: other.ref.headRevisionId }), () => "allowed"),
        "NotFound"
      )
    })
  )

  it.effect("a fork's display name and version must differ from every other card's", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const userId = yield* me(api)
      const parent = yield* card(api, "Nell", { character_version: "1.0" })
      const archived = yield* card(api, "Nell", { character_version: "archived" })
      yield* writer.SetEntityArchived({ userId, entityId: archived.entityId, archived: true })
      const binned = yield* card(api, "Nell", { character_version: "binned" })
      yield* writer.DeleteEntity({ userId, entityId: binned.entityId })
      const attempt = (characterVersion: string, name = "Nell") =>
        outcome(api.ForkCard({ refId: parent.ref.id, name, nickname: "", characterVersion }), (ref) => ref.subtitle)
      // The parent's own pair, and an archived card's.
      assert.strictEqual(yield* attempt("1.0"), "EditRefused")
      assert.strictEqual(yield* attempt("archived"), "EditRefused")
      // A card in the bin isn't in the way, as the client's check has it.
      assert.strictEqual(yield* attempt("binned"), "binned")
      assert.strictEqual(yield* attempt("1.0", "Nell (noir)"), "1.0")
      assert.strictEqual(yield* attempt("binned"), "EditRefused")
      // Nothing was made by a refusal.
      const family = yield* api.CardFamily({ entityId: parent.entityId })
      assert.deepStrictEqual(
        family.members.map((m) => [m.label, m.subtitle]),
        [
          ["Nell", "1.0"],
          ["Nell", "binned"],
          ["Nell (noir)", "1.0"]
        ]
      )
      // Only cards fork this way.
      const preset = yield* writer.CreateEntity({
        userId,
        kind: "preset",
        label: "Preset",
        subtitle: "",
        doc: presetDoc(),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      assert.strictEqual(
        yield* outcome(
          api.ForkCard({ refId: preset.ref.id, name: "P", nickname: "", characterVersion: "" }),
          () => "allowed"
        ),
        "EditRefused"
      )
    })
  )
})
