import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Doc, RefId } from "@rp/shared/library.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { textField } from "@rp/shared/editing.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import type { MergeSelection } from "@rp/shared/forkMerge.ts"
import * as Database from "../src/db/Database.ts"
import { docHash, searchText } from "../src/db/documents.ts"
import { cardDoc } from "./support/docs.ts"
import { testWorkers } from "./support/bundles.ts"
import { tempDir } from "./support/tempDir.ts"

const database = () =>
  Database.layer({ dataDir: tempDir("forkmerge"), readers: 1, allowNetworkFs: false, ...testWorkers })
const setup = Effect.gen(function* () {
  const writer = yield* Database.Writer
  const reader = yield* Database.Reader
  const userId = (yield* writer.EnsureUser({ handle: "owner", displayName: "Owner" })).id
  const make = (doc: Doc) =>
    writer.CreateEntity({
      userId,
      kind: "preset_overlay",
      label: "Synthetic",
      subtitle: "",
      doc,
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
  const get = (refId: RefId) => reader.GetRef({ userId, refId })
  const edit = (refId: RefId, doc: Doc) =>
    Effect.gen(function* () {
      const ref = (yield* get(refId)).ref
      return yield* writer.EditRef({
        userId,
        refId,
        doc,
        expectedRowVersion: ref.rowVersion,
        message: null,
        commitDraft: null
      })
    })
  const merge = (refId: RefId, selection: MergeSelection = { excluded: [], resolutions: [] }) =>
    Effect.gen(function* () {
      const p = yield* reader.PreviewForkMerge({ userId, refId })
      return yield* writer.CommitForkMerge({
        userId,
        refId,
        theirsRevisionId: p.theirsRevisionId,
        baseRevisionId: p.baseRevisionId,
        expectedRowVersion: p.ref.rowVersion,
        selection,
        message: null
      })
    })
  return { writer, reader, userId, make, get, edit, merge }
})
const stage = (
  writer: Database.Writer["Service"],
  userId: UserId,
  refId: RefId,
  kind: "card" | "preset_overlay",
  doc: Doc
) =>
  writer.ImportFile({
    userId,
    intoRefId: refId,
    kind,
    label: "",
    docJson: JSON.stringify(doc),
    docHash: docHash(doc),
    searchText: searchText(doc),
    schemaVersion: 1,
    sourceName: "synthetic.json",
    sourceHash: "0".repeat(64),
    media: [],
    noteDocJson: null,
    stageMerge: true
  })

describe("explicit library merges", () => {
  it.live("fork point, historical choice, exclusions, base advancement, records, undo and re-merge", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, make, get, edit, merge } = yield* setup
      const parent = (yield* make({ a: "base", b: 0 })).ref
      const child = yield* writer.ForkRef({ userId, refId: parent.id, label: "Child", subtitle: "" })
      const grandchild = yield* writer.ForkRef({ userId, refId: child.id, label: "Grandchild", subtitle: "" })
      yield* edit(child.id, { a: "ours", b: 0 })
      const v2 = (yield* edit(parent.id, { a: "theirs", b: 2 })).ref
      yield* edit(parent.id, { a: "latest", b: 3 })
      assert.deepStrictEqual((yield* get(child.id)).doc, { a: "ours", b: 0 })
      const status = yield* reader.ForkMergeStatus({ userId, refId: child.id })
      assert.strictEqual(status.baseRevisionId, parent.headRevisionId)
      assert.strictEqual(status.versions.length, 2)
      const preview = yield* reader.PreviewForkMerge({ userId, refId: child.id, theirsRevisionId: v2.headRevisionId })
      assert.deepStrictEqual(
        preview.conflicts.map((c) => c.path),
        [["a"]]
      )
      const selection = { excluded: [["a"]], resolutions: [] }
      const committed = yield* writer.CommitForkMerge({
        userId,
        refId: child.id,
        theirsRevisionId: preview.theirsRevisionId,
        baseRevisionId: preview.baseRevisionId,
        expectedRowVersion: preview.ref.rowVersion,
        selection,
        message: "Keep my wording"
      })
      assert.deepStrictEqual((yield* get(child.id)).doc, { a: "ours", b: 2 })
      assert.deepStrictEqual((yield* get(grandchild.id)).doc, { a: "base", b: 0 })
      const after = yield* reader.ForkMergeStatus({ userId, refId: child.id })
      assert.strictEqual(after.baseRevisionId, v2.headRevisionId)
      assert.strictEqual(after.versions.length, 1)
      assert.deepStrictEqual(after.records[0]!.selection, selection)
      const [revision] = yield* reader.RefHistory({ userId, refId: child.id, limit: 1 })
      assert.deepStrictEqual(revision!.parents, [preview.oursRevisionId, v2.headRevisionId])
      const undone = yield* writer.UndoForkMerge({
        userId,
        refId: child.id,
        mergeRevisionId: committed.ref.headRevisionId,
        expectedRowVersion: committed.ref.rowVersion
      })
      assert.deepStrictEqual((yield* get(child.id)).doc, { a: "ours", b: 0 })
      const reset = yield* reader.ForkMergeStatus({ userId, refId: child.id })
      assert.strictEqual(reset.baseRevisionId, parent.headRevisionId)
      assert.strictEqual(reset.records[0]!.undoneByRevisionId, undone.ref.headRevisionId)
      const again = yield* merge(child.id, { excluded: [], resolutions: [{ path: ["a"], value: "resolved" }] })
      assert.deepStrictEqual((yield* get(child.id)).doc, { a: "resolved", b: 3 })
      yield* edit(child.id, { a: "later", b: 3 })
      const refusal = yield* writer
        .UndoForkMerge({
          userId,
          refId: child.id,
          mergeRevisionId: again.ref.headRevisionId,
          expectedRowVersion: (yield* get(child.id)).ref.rowVersion
        })
        .pipe(Effect.flip)
      assert.strictEqual(refusal._tag, "RefOperationRefused")
    }).pipe(Effect.provide(database()))
  )

  it.live("included conflicts must be resolved; stale previews and foreign revisions never write", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, make, get, edit, merge } = yield* setup
      const parent = (yield* make({ text: "base" })).ref
      const child = yield* writer.ForkRef({ userId, refId: parent.id, label: "Child", subtitle: "" })
      yield* edit(child.id, { text: "ours" })
      yield* edit(parent.id, { text: "theirs" })
      assert.strictEqual((yield* merge(child.id).pipe(Effect.flip))._tag, "RefOperationRefused")
      const preview = yield* reader.PreviewForkMerge({ userId, refId: child.id })
      const foreign = (yield* make({ text: "unrelated" })).ref
      assert.strictEqual(
        (yield* reader
          .PreviewForkMerge({ userId, refId: child.id, theirsRevisionId: foreign.headRevisionId })
          .pipe(Effect.flip))._tag,
        "RefOperationRefused"
      )
      yield* edit(child.id, { text: "changed" })
      assert.strictEqual(
        (yield* writer
          .CommitForkMerge({
            userId,
            refId: child.id,
            theirsRevisionId: preview.theirsRevisionId,
            baseRevisionId: preview.baseRevisionId,
            expectedRowVersion: preview.ref.rowVersion,
            selection: { excluded: [["text"]], resolutions: [] },
            message: null
          })
          .pipe(Effect.flip))._tag,
        "StaleWrite"
      )
      assert.deepStrictEqual((yield* get(child.id)).doc, { text: "changed" })
      const otherId = (yield* writer.EnsureUser({ handle: "other", displayName: "Other" })).id
      assert.strictEqual(
        (yield* reader.ForkMergeStatus({ userId: otherId, refId: child.id }).pipe(Effect.flip))._tag,
        "NotFound"
      )
      assert.strictEqual(
        (yield* reader.PreviewForkMerge({ userId: otherId, refId: child.id }).pipe(Effect.flip))._tag,
        "NotFound"
      )
      assert.strictEqual(
        (yield* reader.LibraryGenealogy({ userId: otherId, refId: child.id }).pipe(Effect.flip))._tag,
        "NotFound"
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("genealogy is the same from every member and merges wait for drafts", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, make, edit } = yield* setup
      const parent = (yield* make({ text: "base" })).ref
      const child = yield* writer.ForkRef({ userId, refId: parent.id, label: "Child", subtitle: "" })
      const peer = yield* writer.ForkRef({ userId, refId: parent.id, label: "Peer", subtitle: "" })
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Synthetic",
        participants: [],
        greeting: null
      })
      const override = yield* writer.CreateChatOverride({ userId, refId: child.id, chatId: chat.id })
      const family = yield* reader.LibraryGenealogy({ userId, refId: override.id })
      assert.deepStrictEqual(
        new Set(family.members.map((m) => m.refId)),
        new Set([parent.id, child.id, peer.id, override.id])
      )
      assert.deepStrictEqual(yield* reader.LibraryGenealogy({ userId, refId: peer.id }), family)
      yield* edit(parent.id, { text: "new" })
      yield* writer.SaveDraft({
        userId,
        key: new DraftKey({ targetKind: "entity_field", targetId: child.id, field: textField(["text"]) }),
        content: "unsaved",
        images: [],
        baseRevision: child.headRevisionId,
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null
      })
      assert.strictEqual(
        (yield* reader.PreviewForkMerge({ userId, refId: child.id }).pipe(Effect.flip))._tag,
        "RefOperationRefused"
      )
      assert.strictEqual(
        (yield* writer.MergeFollowed({ userId, refId: child.id }).pipe(Effect.flip))._tag,
        "RefOperationRefused"
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("staged creator imports leave local content alone; cards share the merge and genealogy APIs", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, get } = yield* setup
      const original = cardDoc("Synthetic", { description: "original", personality: "base" })
      const card = (yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Synthetic",
        subtitle: "",
        doc: original,
        schemaVersion: 1,
        origin: "import",
        sourcePath: "synthetic.json"
      })).ref
      const child = yield* writer.ForkCard({
        userId,
        refId: card.id,
        name: "Child",
        nickname: "",
        characterVersion: ""
      })
      yield* writer.EditRef({
        userId,
        refId: card.id,
        expectedRowVersion: card.rowVersion,
        doc: { ...original, personality: "local" },
        message: null,
        commitDraft: null
      })
      yield* stage(writer, userId, card.id, "card", { ...original, description: "creator update" })
      assert.strictEqual((yield* get(card.id)).doc.description, "original")
      const preview = yield* reader.PreviewForkMerge({ userId, refId: card.id })
      assert.strictEqual(preview.baseRevisionId, card.headRevisionId)
      assert.strictEqual(preview.merged.description, "creator update")
      const result = yield* writer.CommitForkMerge({
        userId,
        refId: card.id,
        theirsRevisionId: preview.theirsRevisionId,
        baseRevisionId: preview.baseRevisionId,
        expectedRowVersion: preview.ref.rowVersion,
        selection: { excluded: [], resolutions: [] },
        message: null
      })
      assert.strictEqual((yield* get(card.id)).doc.personality, "local")
      assert.strictEqual((yield* get(child.id)).doc.description, "original")
      const childPreview = yield* reader.PreviewForkMerge({ userId, refId: child.id })
      assert.strictEqual(childPreview.baseRevisionId, card.headRevisionId)
      assert.strictEqual(childPreview.theirsRevisionId, result.ref.headRevisionId)
      const family = yield* reader.LibraryGenealogy({ userId, refId: child.id })
      assert.strictEqual(family.members.length, 2)
      assert.deepStrictEqual(yield* reader.LibraryGenealogy({ userId, refId: card.id }), family)
      const unrelated = (yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Other",
        subtitle: "",
        doc: cardDoc("Other"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })).ref
      yield* writer.SetCardParent({ userId, entityId: child.entityId, parentEntityId: unrelated.entityId })
      assert.strictEqual(
        (yield* reader.PreviewForkMerge({ userId, refId: child.id }).pipe(Effect.flip))._tag,
        "RefOperationRefused"
      )
      // A second creator import uses the last imported version, never the local merge result.
      yield* stage(writer, userId, card.id, "card", { ...original, description: "creator third" })
      assert.strictEqual(
        (yield* reader.PreviewForkMerge({ userId, refId: card.id })).baseRevisionId,
        preview.theirsRevisionId
      )
    }).pipe(Effect.provide(database()))
  )
})
