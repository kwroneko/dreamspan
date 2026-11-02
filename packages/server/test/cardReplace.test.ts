// "Import a new version…" of a card (ARCHITECTURE.md §11.1): a preview that stores nothing,
// and Replace, the file's content as one revision with what a file can't carry kept, the
// import line set so a later re-import of the same file is up to date. Synthetic cards over
// the real upload route, with the database and format workers.
import { DatabaseSync } from "node:sqlite"
import { assert, layer } from "@effect/vitest"
import { CardReplacePreview } from "@rp/shared/cardReplace.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { ImportResult } from "@rp/shared/libraryImport.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { Effect, Schema } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { cardChunk, png, stCardV2 } from "./formats/support.ts"
import { client, outcome, serverLayer, serverPort, testConfig } from "./support/config.ts"

const config = testConfig()

const send = (bytes: Uint8Array, query: Record<string, string>) =>
  Effect.flatMap(serverPort, (port) =>
    Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}/library/import?${new URLSearchParams(query)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      })
    )
  )

const ok = (response: Response) =>
  Effect.gen(function* () {
    assert.strictEqual(response.status, 200, yield* Effect.promise(() => response.clone().text()))
    return yield* Effect.promise(() => response.json())
  })

const script = { id: "s1", scriptName: "Stars", findRegex: "/\\*/g", replaceString: "", placement: [2] }

/** A synthetic ST card PNG: Wren, with a description, a Character's Note and a regex script. */
const wren = (change: { description?: string; note?: string; scripts?: Array<unknown>; fav?: boolean } = {}) => {
  const card = stCardV2()
  card.data.description = change.description ?? "A lighthouse keeper."
  card.data.extensions = {
    ...card.data.extensions,
    fav: change.fav ?? false,
    depth_prompt: { prompt: change.note ?? "Wren smells of oil.", depth: 4, role: "system" },
    regex_scripts: change.scripts ?? [script]
  } as typeof card.data.extensions
  return png(cardChunk("chara", card))
}

const counts = (db: DatabaseSync) => ({
  revisions: (db.prepare("SELECT count(*) AS n FROM entity_revisions").get() as { n: number }).n,
  media: (db.prepare("SELECT count(*) AS n FROM media_refs").get() as { n: number }).n,
  refs: (db.prepare("SELECT count(*) AS n FROM entity_refs").get() as { n: number }).n
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("import a new version", (it) => {
  it.effect("stages a creator update for Merge and commits it through the shared RPCs", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const first = Schema.decodeUnknownSync(ImportResult)(
        yield* ok(yield* send(wren(), { name: "merge-1.png" }))
      ).library!
      const refId = first.ref.id
      const opened = yield* api.OpenEditor({ refId })
      const staged = Schema.decodeUnknownSync(ImportResult)(
        yield* ok(
          yield* send(wren({ description: "Creator update", note: "Updated note sidecar" }), {
            name: "merge-2.png",
            into: refId,
            mode: "merge"
          })
        )
      ).library!
      assert.isDefined(staged.stagedRevisionId)
      assert.strictEqual(staged.ref.headRevisionId, opened.ref.headRevisionId)
      assert.isNull(staged.outcome)
      assert.strictEqual((yield* api.OpenEditor({ refId })).doc.description, "A lighthouse keeper.")
      const preview = yield* api.PreviewForkMerge({ refId, theirsRevisionId: staged.stagedRevisionId! })
      yield* api.CommitForkMerge({
        refId,
        theirsRevisionId: preview.theirsRevisionId,
        baseRevisionId: preview.baseRevisionId,
        expectedRowVersion: preview.ref.rowVersion,
        selection: { excluded: [], resolutions: [] },
        message: "Take creator description"
      })
      assert.strictEqual((yield* api.OpenEditor({ refId })).doc.description, "Creator update")
      assert.strictEqual((yield* api.ListCardNotes({ cardRefId: refId }))[0]!.doc.content, "Wren smells of oil.")
      assert.strictEqual((yield* api.ForkMergeStatus({ refId })).records.length, 1)
    })
  )

  it.effect("previews without storing, then replaces wholesale keeping what a file can't carry", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const reader = yield* Reader
      const userId = (yield* api.Whoami()).id as UserId
      const first = Schema.decodeUnknownSync(ImportResult)(yield* ok(yield* send(wren(), { name: "wren.png" })))
      const refId = first.library!.ref.id
      const entityId = first.library!.ref.entityId as EntityId
      // What the card has here that a file can't carry: a cutout, a favourite, approved scripts.
      let opened = yield* api.OpenEditor({ refId })
      yield* api.SetRegexApproval({ refId, approved: true, expectedRowVersion: opened.ref.rowVersion })
      opened = yield* api.OpenEditor({ refId })
      const crop = { x: 0, y: 0, width: 1, height: 1 }
      yield* api.SetCardAvatarCrop({ refId, crop, expectedRowVersion: opened.ref.rowVersion })
      yield* api.SetCardFavourite({ entityId, favourite: true })
      opened = yield* api.OpenEditor({ refId })
      const before = opened.doc
      const pinnedRevision = opened.ref.headRevisionId

      // Two chats: one follows the card, one is bound to its current revision.
      const chat = () =>
        api.StartChat({
          cards: [entityId],
          persona: null,
          greeting: 0,
          first: { _tag: "Send", content: "Hello", speakerEntityId: null }
        })
      yield* chat()
      const pinned = yield* chat()
      yield* writer.AddStateEvent({
        userId,
        chatId: pinned.chat.id,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "card.binding", value: { entity: entityId, ref: undefined, revision: pinnedRevision } }
      })

      const file = wren({ description: "A retired lighthouse keeper.", note: "Wren smells of salt." })
      const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
      const stored = counts(db)
      const preview = Schema.decodeUnknownSync(CardReplacePreview)(
        yield* ok(yield* send(file, { name: "wren-2.png", into: refId, mode: "preview" }))
      )
      assert.deepStrictEqual(counts(db), stored, "a preview stores nothing")
      assert.strictEqual(JSON.parse(preview.docJson!).description, "A retired lighthouse keeper.")
      assert.include(preview.noteDocJson!, "Wren smells of salt.")
      assert.isNotNull(preview.avatar?.base64)
      const card = preview.card!
      assert.strictEqual(card.headRevisionId, pinnedRevision)
      assert.strictEqual(card.noteContent, "Wren smells of oil.")
      assert.deepStrictEqual([card.followingChats, card.pinnedChats], [1, 1])
      assert.isTrue(card.hasImport)
      assert.isTrue(card.favourite)
      assert.strictEqual(card.avatarSha256, preview.avatar!.sha256)

      // A head that moved since the preview is refused, and nothing changes.
      const stale = yield* send(file, {
        name: "wren-2.png",
        into: refId,
        mode: "replace",
        head: first.library!.ref.headRevisionId
      })
      assert.strictEqual(stale.status, 409)
      assert.deepStrictEqual(counts(db), stored)

      const replaced = Schema.decodeUnknownSync(ImportResult)(
        yield* ok(yield* send(file, { name: "wren-2.png", into: refId, mode: "replace", head: card.headRevisionId }))
      ).library!
      assert.strictEqual(replaced.outcome, "merged")
      // Two revisions: the file on the import line, and the card's one new revision.
      assert.strictEqual(counts(db).revisions, stored.revisions + 2)
      opened = yield* api.OpenEditor({ refId })
      const after = opened.doc
      assert.strictEqual(after.description, "A retired lighthouse keeper.")
      assert.deepStrictEqual(after.avatar_crop, before.avatar_crop, "the cutout stays with the same picture")
      assert.strictEqual(after.avatar_media_id, before.avatar_media_id)
      assert.isTrue(after.regex_approved, "identical scripts stay allowed")
      const head = db
        .prepare("SELECT parents, origin, message FROM entity_revisions WHERE id = ?")
        .get(opened.ref.headRevisionId) as { parents: string; origin: string; message: string }
      assert.strictEqual(JSON.parse(head.parents)[0], pinnedRevision)
      assert.include(head.message, "wren-2.png")
      const history = yield* api.ListRevisions({ refId, limit: 10 })
      assert.strictEqual(history[0]!.id, opened.ref.headRevisionId)
      // The notes and the favourite are the card's own.
      const [note] = yield* api.ListCardNotes({ cardRefId: refId })
      assert.strictEqual(note!.doc.content, "Wren smells of oil.")
      const favourites = db.prepare("SELECT value_json FROM user_settings WHERE key = 'cards.favourites'").get() as {
        value_json: string
      }
      assert.include(JSON.parse(favourites.value_json).on, entityId)

      // The chat bound to a fixed revision keeps it; the other reads the new version.
      const shown = (chatId: typeof pinned.chat.id) =>
        Effect.map(api.GetChat({ chatId }), (c) => c.activeLeafSlotId).pipe(
          Effect.flatMap((slotId) => api.ListChatCards({ chatId, slotId, entityIds: [entityId] })),
          Effect.map(([c]) => c!.definition.description)
        )
      assert.strictEqual(yield* shown(pinned.chat.id), "A lighthouse keeper.")

      // A later ordinary re-import of the same file finds the card up to date.
      const again = Schema.decodeUnknownSync(ImportResult)(
        yield* ok(yield* send(file, { name: "wren-2.png", into: refId }))
      ).library!
      assert.strictEqual(again.outcome, "up_to_date")
      assert.strictEqual(again.ref.headRevisionId, opened.ref.headRevisionId)
      assert.isFalse(again.ref.updateAvailable)

      // Changed scripts arrive not allowed.
      opened = yield* api.OpenEditor({ refId })
      const changed = wren({ description: "A retired lighthouse keeper.", scripts: [{ ...script, findRegex: "/_/g" }] })
      yield* ok(
        yield* send(changed, { name: "wren-3.png", into: refId, mode: "replace", head: opened.ref.headRevisionId })
      )
      assert.notStrictEqual((yield* api.OpenEditor({ refId })).doc.regex_approved, true)

      // Another user's card: NotFound, at the read and at the write.
      const other = "019a0000-0000-7000-8000-000000000000" as UserId
      assert.strictEqual(yield* outcome(reader.CardReplaceSource({ userId: other, refId })), "NotFound")
      const latest = yield* api.OpenEditor({ refId })
      assert.strictEqual(
        yield* outcome(
          writer.ImportFile({
            userId: other,
            intoRefId: refId as RefId,
            kind: "card",
            label: "Wren",
            docJson: JSON.stringify(latest.doc),
            docHash: "x",
            searchText: "",
            schemaVersion: 1,
            sourceName: "wren.json",
            sourceHash: "0".repeat(64),
            media: [],
            noteDocJson: null,
            replace: { expectedHeadRevisionId: latest.ref.headRevisionId as RevisionId }
          })
        ),
        "NotFound"
      )
      db.close()
    })
  )

  it.effect("a card made here takes a new version, which starts its import line", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const made = { ref: yield* api.CreateCard({ label: "Wren", name: "Wren" }) }
      const opened = yield* api.OpenEditor({ refId: made.ref.id })
      const file = wren({ description: "From a file." })
      const preview = Schema.decodeUnknownSync(CardReplacePreview)(
        yield* ok(yield* send(file, { name: "wren.png", into: made.ref.id, mode: "preview" }))
      )
      assert.isFalse(preview.card!.hasImport)
      const replaced = Schema.decodeUnknownSync(ImportResult)(
        yield* ok(
          yield* send(file, { name: "wren.png", into: made.ref.id, mode: "replace", head: opened.ref.headRevisionId })
        )
      ).library!
      assert.isTrue(replaced.ref.hasImport)
      assert.isFalse(replaced.ref.updateAvailable)
      assert.strictEqual((yield* api.OpenEditor({ refId: made.ref.id })).doc.description, "From a file.")
      // A preset isn't replaced in place.
      const refused = yield* send(file, { name: "wren.png", mode: "preview" })
      assert.strictEqual(refused.status, 400)
    })
  )
})
