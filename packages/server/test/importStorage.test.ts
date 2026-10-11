// The import's storage operations through the real writer and readers (ARCHITECTURE.md
// §10): ImportFile and ExportSource. The HTTP upload and the parsing are tested in
// libraryImport.test.ts.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@rp/shared/domain.ts"
import type { Doc, RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { docHash, searchText } from "../src/db/documents.ts"

const fresh = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rp-import-"))
  return { dataDir, layer: Database.layer({ dataDir, readers: 1, allowNetworkFs: false, workers: "source" }) }
}

const sha = (char: string) => char.repeat(64)

/** A document as the format worker sends it. */
const encoded = (doc: Doc) => ({ docJson: JSON.stringify(doc), docHash: docHash(doc), searchText: searchText(doc) })

const card = (description: string) => ({
  schema_version: 1,
  name: "Mira",
  description,
  avatar_media_id: null,
  assets: [{ type: "icon", uri: "embeded://assets/main.png", name: "main", ext: "png" }],
  modules: [],
  extensions: {}
})

const noteJson = (content: string) =>
  JSON.stringify({
    schema_version: 1,
    title: "Character's Note",
    content,
    placement: { mode: "depth", depth: 2, role: "system" },
    exportable: true
  })

const avatar = (hash: string) => ({
  role: "avatar" as const,
  uri: "ccdefault:",
  sha256: hash,
  mime: "image/png",
  byteSize: 10,
  width: 1,
  height: 1
})

/** The tag of the error an operation fails with. */
const tag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((e) => e._tag)
  )

const setup = Effect.gen(function* () {
  const writer = yield* Database.Writer
  const reader = yield* Database.Reader
  const ana = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id
  const ben = (yield* writer.EnsureUser({ handle: "ben", displayName: "Ben" })).id
  const importCard = (userId: UserId, description: string, into: RefId | null = null, note = "Wears a red coat.") =>
    writer.ImportFile({
      userId,
      intoRefId: into,
      kind: "card",
      label: "Mira",
      ...encoded(card(description)),
      schemaVersion: 1,
      sourceName: "mira.png",
      sourceHash: sha(description.length % 2 === 0 ? "a" : "b"),
      media: [avatar(sha("c")), { ...avatar(sha("d")), role: "asset", uri: "__proto__" }],
      noteDocJson: noteJson(note)
    })
  return { writer, reader, ana, ben, importCard }
})

describe("library import storage", () => {
  it.live("a card file becomes an entity, an upstream ref, an import revision, its media and its note", () => {
    const { dataDir, layer } = fresh()
    return Effect.gen(function* () {
      const { reader, ana, importCard } = yield* setup
      const imported = yield* importCard(ana, "A cartographer.")
      assert.isTrue(imported.created)
      assert.strictEqual(imported.ref.refKind, "upstream")

      const { doc } = yield* reader.GetRef({ userId: ana, refId: imported.ref.id })
      assert.isString(doc.avatar_media_id)
      assert.deepStrictEqual(Object.keys(doc.asset_media_ids as object), ["__proto__"])
      const note = yield* reader.GetRef({ userId: ana, refId: imported.note!.id })
      assert.deepStrictEqual(note.doc.owner, { card: imported.ref.entityId })
      assert.strictEqual(note.ref.kind, "note")

      const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
      const ref = db.prepare("SELECT source_path, source_hash FROM entity_refs WHERE id = ?").get(imported.ref.id)
      assert.deepStrictEqual({ ...ref }, { source_path: "mira.png", source_hash: sha("b") })
      const revision = db
        .prepare("SELECT origin, origin_ref FROM entity_revisions WHERE id = ?")
        .get(imported.ref.headRevisionId)
      assert.strictEqual(revision!.origin, "import")
      assert.deepStrictEqual(JSON.parse(revision!.origin_ref as string), { file: "mira.png", sha256: sha("b") })
      const media = db.prepare("SELECT sha256, path FROM media_assets ORDER BY sha256").all()
      assert.deepStrictEqual(
        media.map((m) => m.path),
        [`media/cc/${sha("c")}`, `media/dd/${sha("d")}`]
      )
      db.close()
    }).pipe(Effect.provide(layer))
  })

  it.live("a re-import merges into the upstream and its variants, and into the note", () =>
    Effect.gen(function* () {
      const { writer, reader, ana, importCard } = yield* setup
      const first = yield* importCard(ana, "A cartographer. She maps the coast.")
      const variant = yield* writer.ForkRef({ userId: ana, refId: first.ref.id, label: "Mira", subtitle: "older" })
      yield* writer.EditRef({
        userId: ana,
        refId: variant.id,
        doc: { ...card("A retired cartographer. She maps the coast."), avatar_media_id: "kept" },
        expectedRowVersion: variant.rowVersion,
        message: null,
        commitDraft: null
      })
      const noteRef = first.note!
      yield* writer.EditRef({
        userId: ana,
        refId: noteRef.id,
        doc: {
          ...(yield* reader.GetRef({ userId: ana, refId: noteRef.id })).doc,
          title: "Outfit"
        },
        expectedRowVersion: noteRef.rowVersion,
        message: null,
        commitDraft: null
      })

      const second = yield* importCard(
        ana,
        "A cartographer. She maps the coast at night.",
        first.ref.id,
        "A blue coat."
      )
      assert.isFalse(second.created)
      assert.strictEqual(second.outcome, "fast_forward")
      assert.deepStrictEqual(
        second.followers.map((f) => [f.label, f.outcome]),
        [["Mira", "merged"]]
      )
      const merged = yield* reader.GetRef({ userId: ana, refId: variant.id })
      assert.strictEqual(merged.doc.description, "A retired cartographer. She maps the coast at night.")
      // The same note was updated, with the user's own title kept.
      assert.strictEqual(second.note!.id, noteRef.id)
      const note = yield* reader.GetRef({ userId: ana, refId: noteRef.id })
      assert.deepStrictEqual([note.doc.title, note.doc.content], ["Outfit", "A blue coat."])
      assert.lengthOf(yield* reader.ListLibrary({ userId: ana, kind: "note", tag: null, archived: false }), 1)
    }).pipe(Effect.provide(fresh().layer))
  )

  it.live("an import goes only into the user's own upstream of the same kind", () =>
    Effect.gen(function* () {
      const { writer, ana, ben, importCard } = yield* setup
      const mine = yield* importCard(ana, "A cartographer.")
      assert.strictEqual(yield* tag(importCard(ben, "Hijacked.", mine.ref.id)), "NotFound")
      const variant = yield* writer.ForkRef({ userId: ana, refId: mine.ref.id, label: "v", subtitle: "" })
      assert.strictEqual(yield* tag(importCard(ana, "Again.", variant.id)), "RefOperationRefused")
      const preset = writer.ImportFile({
        userId: ana,
        intoRefId: mine.ref.id,
        kind: "preset",
        label: "p",
        ...encoded({}),
        schemaVersion: 1,
        sourceName: "p.json",
        sourceHash: sha("e"),
        media: [],
        noteDocJson: null
      })
      assert.strictEqual(yield* tag(preset), "RefOperationRefused")
    }).pipe(Effect.provide(fresh().layer))
  )

  it.live("the same bytes are stored once, and an export gets only the user's own media", () => {
    const { dataDir, layer } = fresh()
    return Effect.gen(function* () {
      const { writer, reader, ana, ben, importCard } = yield* setup
      const anas = yield* importCard(ana, "A cartographer.")
      const bens = yield* importCard(ben, "A cartographer.")
      const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
      assert.strictEqual(db.prepare("SELECT count(*) AS n FROM media_assets").get()!.n, 2)
      assert.strictEqual(db.prepare("SELECT count(*) AS n FROM media_refs").get()!.n, 4)
      db.close()

      const source = yield* reader.ExportSource({ userId: ana, refId: anas.ref.id })
      assert.strictEqual(source.avatar?.path, `media/cc/${sha("c")}`)
      assert.deepStrictEqual(
        source.assets.map((a) => a.uri),
        ["__proto__"]
      )
      assert.include(source.noteDocJson ?? "", "Wears a red coat.")

      // Ben's card names a file only Ana holds: his export doesn't get it.
      const solo = yield* writer.ImportFile({
        userId: ana,
        intoRefId: null,
        kind: "card",
        label: "Solo",
        ...encoded(card("solo")),
        schemaVersion: 1,
        sourceName: "solo.png",
        sourceHash: sha("f"),
        media: [avatar(sha("9"))],
        noteDocJson: null
      })
      const soloMedia = (yield* reader.GetRef({ userId: ana, refId: solo.ref.id })).doc.avatar_media_id
      assert.isString(soloMedia)
      const edited = yield* reader.GetRef({ userId: ben, refId: bens.ref.id })
      yield* writer.EditRef({
        userId: ben,
        refId: bens.ref.id,
        doc: { ...edited.doc, avatar_media_id: soloMedia, asset_media_ids: { x: soloMedia } },
        expectedRowVersion: edited.ref.rowVersion,
        message: null,
        commitDraft: null
      })
      const stolen = yield* reader.ExportSource({ userId: ben, refId: bens.ref.id })
      assert.isNull(stolen.avatar)
      assert.deepStrictEqual(stolen.assets, [])
      assert.strictEqual(yield* tag(reader.ExportSource({ userId: ben, refId: anas.ref.id })), "NotFound")
    }).pipe(Effect.provide(layer))
  })
})
