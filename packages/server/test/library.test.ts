// Layered library documents through the real storage operations (DESIGN §4,
// DATA-MODEL §3.2, spec/LIBRARY-FORKS.md): edits, forks, re-imports and merges.
import { assert, describe, it } from "@effect/vitest"
import { DraftKey } from "@dreamspan/shared/drafts.ts"
import { newSharedNote, valueField, type FieldPath } from "@dreamspan/shared/editing.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { Doc, EntityKind, RefId } from "@dreamspan/shared/library.ts"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"
import { docHash, searchText } from "../src/db/documents.ts"
import { promptPreset } from "@dreamspan/shared/docs/preset.ts"
import { cardDoc, docFor, presetDoc } from "./support/docs.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const database = () =>
  Database.layer({
    dataDir: tempDir("lib"),
    readers: 2,
    allowNetworkFs: false,
    ...testWorkers
  })

/**
 * A prompt preset. `prefill` stands in for a single setting both sides can change, as the
 * temperature did before model settings left the preset.
 */
const preset = (main: string, extra: ReadonlyArray<{ identifier: string; content: string }> = [], prefill = 1) => {
  const doc = promptPreset(presetDoc([{ identifier: "main", content: main }, ...extra]))
  return { ...doc, prefill: { ...doc.prefill, assistant: String(prefill) } }
}

/**
 * A document imported into an upstream ref, as an uploaded file is (ImportFile): what the
 * upstream did with it, and the change that flowed on to its followers.
 */
const importInto = (
  writer: Database.Writer["Service"],
  userId: UserId,
  refId: RefId,
  kind: EntityKind,
  doc: Doc,
  schemaVersion = 1
) =>
  writer
    .ImportFile({
      userId,
      intoRefId: refId,
      kind,
      label: "",
      docJson: JSON.stringify(doc),
      docHash: docHash(doc),
      searchText: searchText(doc),
      schemaVersion,
      sourceName: "file.json",
      sourceHash: "0".repeat(64),
      media: [],
      noteDocJson: null
    })
    .pipe(
      Effect.map((result) => ({ outcome: result.outcome!, change: { ref: result.ref, followers: result.followers } }))
    )

/** The tag of the error an operation fails with. */
const tag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((e) => e._tag)
  )

const MAIN = "You are {{char}}. Write vivid prose. Do not impersonate {{user}} or speak for them."

const setup = (handle = "ana") =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const user = yield* writer.EnsureUser({ handle, displayName: handle })
    const userId = user.id
    const imported = yield* writer.CreateEntity({
      userId,
      kind: "preset",
      label: "Narrator",
      subtitle: "upstream",
      doc: preset(MAIN),
      schemaVersion: 1,
      origin: "import",
      sourcePath: "/presets/narrator.json"
    })
    const get = (refId: RefId) => reader.GetRef({ userId, refId })
    const doc = (refId: RefId) => get(refId).pipe(Effect.map((r) => r.doc as ReturnType<typeof preset>))
    const rowVersion = (refId: RefId) => get(refId).pipe(Effect.map((r) => r.ref.rowVersion))
    const edit = (refId: RefId, d: Doc) =>
      Effect.flatMap(rowVersion(refId), (expectedRowVersion) =>
        writer.EditRef({ userId, refId, doc: d, expectedRowVersion, message: null, commitDraft: null })
      )
    const reimport = (d: Doc, schemaVersion = 1) =>
      importInto(writer, userId, imported.ref.id, "preset", d, schemaVersion)
    return { writer, reader, userId, upstream: imported.ref, get, doc, rowVersion, edit, reimport }
  })

describe("library", () => {
  it.live("an edit is a new revision on the ref; an edit that changes nothing isn't", () =>
    Effect.gen(function* () {
      const { reader, userId, upstream, edit } = yield* setup()
      const first = yield* edit(upstream.id, preset(MAIN, [], 0.7))
      assert.notStrictEqual(first.ref.headRevisionId, upstream.headRevisionId)
      const same = yield* edit(upstream.id, preset(MAIN, [], 0.7))
      assert.strictEqual(same.ref.headRevisionId, first.ref.headRevisionId)

      const history = yield* reader.RefHistory({ userId, refId: upstream.id, limit: 10 })
      assert.deepStrictEqual(
        history.map((r) => r.origin),
        ["user", "import"]
      )
      assert.deepStrictEqual(history[0]!.parents, [upstream.headRevisionId])
    }).pipe(Effect.provide(database()))
  )

  it.live("a re-import leaves forks unchanged until each explicitly merges", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, upstream, doc, edit, reimport } = yield* setup()
      const pristine = yield* writer.ForkRef({ userId, refId: upstream.id, label: "Narrator", subtitle: "as is" })
      const mine = yield* writer.ForkRef({ userId, refId: upstream.id, label: "Narrator", subtitle: "mine" })
      // The owner's edits: a softer impersonation rule and a summary prompt.
      yield* edit(
        mine.id,
        preset(
          MAIN.replace("Do not impersonate {{user}} or speak for them.", "Avoid speaking for {{user}} unless asked."),
          [{ identifier: "summary", content: "{{summary}}" }]
        )
      )

      // Upstream v2 rewrites the first sentence and changes the prefill.
      const v2 = preset(MAIN.replace("You are {{char}}.", "You are {{char}}, the narrator."), [], 0.8)
      const { change } = yield* reimport(v2)
      assert.deepStrictEqual(change.followers, [])
      assert.deepStrictEqual(yield* doc(pristine.id), preset(MAIN))
      assert.isTrue((yield* reader.GetRef({ userId, refId: pristine.id })).ref.updateAvailable)
      yield* writer.MergeFollowed({ userId, refId: pristine.id })
      yield* writer.MergeFollowed({ userId, refId: mine.id })

      assert.deepStrictEqual(yield* doc(pristine.id), v2)
      assert.deepStrictEqual(
        yield* doc(mine.id),
        preset(
          "You are {{char}}, the narrator. Write vivid prose. Avoid speaking for {{user}} unless asked.",
          [{ identifier: "summary", content: "{{summary}}" }],
          0.8
        )
      )
      // The merge is a revision with both parents, and the variant is up to date.
      const [merge] = yield* reader.RefHistory({ userId, refId: mine.id, limit: 1 })
      assert.strictEqual(merge!.origin, "merge")
      assert.strictEqual(merge!.parents[1], change.ref.headRevisionId)
      const library = yield* reader.ListLibrary({ userId, kind: "preset", tag: null, archived: false })
      assert.isTrue(library.every((ref) => !ref.updateAvailable))
      assert.strictEqual(library.length, 3)
    }).pipe(Effect.provide(database()))
  )

  it.live("a conflicting re-import leaves the variant alone until the user resolves it", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, upstream, doc, edit, reimport, rowVersion } = yield* setup()
      const mine = yield* writer.ForkRef({ userId, refId: upstream.id, label: "Narrator", subtitle: "mine" })
      const myMain = MAIN.replace(
        "Do not impersonate {{user}} or speak for them.",
        "Avoid speaking for {{user}} unless asked."
      )
      yield* edit(mine.id, preset(myMain))
      const theirMain = MAIN.replace(
        "Do not impersonate {{user}} or speak for them.",
        "Never write {{user}}'s actions."
      )
      const { change } = yield* reimport(preset(theirMain, [], 0.8))

      assert.deepStrictEqual(change.followers, [])
      assert.strictEqual((yield* doc(mine.id)).prompts[0]!.content, myMain)
      const [listed] = (yield* reader.ListLibrary({ userId, kind: "preset", tag: null, archived: false })).filter(
        (r) => r.id === mine.id
      )
      assert.isTrue(listed!.updateAvailable)

      // The resolver sees the conflict and a merge of everything else.
      const preview = yield* reader.PreviewMerge({ userId, refId: mine.id })
      assert.strictEqual(preview.outcome, "conflicts")
      assert.deepStrictEqual(
        preview.conflicts.map((c) => c.path),
        [["prompts", "identifier=main", "content"]]
      )
      assert.strictEqual((preview.merged as ReturnType<typeof preset>).prefill.assistant, "0.8")

      // The user keeps their wording and commits.
      const resolved = yield* writer.ResolveMerge({
        userId,
        refId: mine.id,
        doc: preview.merged,
        theirsRevisionId: preview.theirsRevisionId,
        expectedRowVersion: yield* rowVersion(mine.id)
      })
      assert.isFalse(resolved.ref.updateAvailable)
      assert.strictEqual((yield* doc(mine.id)).prefill.assistant, "0.8")
      assert.strictEqual((yield* reader.PreviewMerge({ userId, refId: mine.id })).outcome, "up_to_date")
    }).pipe(Effect.provide(database()))
  )

  it.live("a resolution against an upstream that moved again is refused", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, upstream, edit, reimport, rowVersion } = yield* setup()
      const mine = yield* writer.ForkRef({ userId, refId: upstream.id, label: "Narrator", subtitle: "mine" })
      yield* edit(mine.id, preset("Mine."))
      yield* reimport(preset("Theirs, v2."))
      const preview = yield* reader.PreviewMerge({ userId, refId: mine.id })
      yield* reimport(preset("Theirs, v3."))
      const refused = yield* writer
        .ResolveMerge({
          userId,
          refId: mine.id,
          doc: preview.merged,
          theirsRevisionId: preview.theirsRevisionId,
          expectedRowVersion: yield* rowVersion(mine.id)
        })
        .pipe(Effect.flip)
      assert.strictEqual(refused._tag, "RefOperationRefused")
    }).pipe(Effect.provide(database()))
  )

  it.live(
    "a fork is an entry of its own: its history runs on through the original's, and archiving it leaves the original",
    () =>
      Effect.gen(function* () {
        const { writer, reader, userId, upstream, doc, edit, reimport } = yield* setup()
        const variant = yield* writer.ForkRef({ userId, refId: upstream.id, label: "Narrator", subtitle: "noir" })
        assert.notStrictEqual(variant.entityId, upstream.entityId)
        assert.strictEqual(variant.parentEntityId, upstream.entityId)
        assert.isNull(upstream.parentEntityId)
        assert.isFalse(variant.hasImport)
        assert.deepStrictEqual(yield* doc(variant.id), preset(MAIN))

        // A git branch's log (owner, 2026-11-06): the fork's revisions, then the original's.
        const history = yield* reader.RefHistory({ userId, refId: variant.id, limit: 10 })
        assert.deepStrictEqual(
          history.map((r) => [r.origin, r.parents, r.message, r.number, r.entry?.refId ?? null]),
          [
            ["user", [], "Forked from Narrator · upstream", 2, null],
            ["import", [], history[1]!.message, 1, upstream.id]
          ]
        )
        assert.deepStrictEqual(history[0]!.forkedFrom, {
          revisionId: upstream.headRevisionId,
          entityId: upstream.entityId,
          refId: upstream.id,
          label: "Narrator",
          subtitle: "upstream"
        })

        // A fork of a fork merges from its own parent, not from the original.
        const child = yield* writer.ForkRef({ userId, refId: variant.id, label: "Narrator", subtitle: "noir, rainy" })
        assert.strictEqual(child.parentEntityId, variant.entityId)
        yield* edit(variant.id, preset(MAIN, [{ identifier: "scene", content: "It is raining." }]))
        yield* reimport(preset(MAIN, [], 0.5))
        const listed = yield* reader.ListLibrary({ userId, kind: "preset", tag: null, archived: false })
        const available = new Map(listed.map((r) => [r.id, r.updateAvailable]))
        assert.deepStrictEqual(
          [available.get(upstream.id), available.get(variant.id), available.get(child.id)],
          [false, true, true]
        )
        yield* writer.MergeFollowed({ userId, refId: child.id })
        assert.deepStrictEqual(
          (yield* doc(child.id)).prompts.map((p) => p.identifier),
          ["main", "scene"]
        )
        assert.strictEqual((yield* doc(child.id)).prefill.assistant, "1")

        // Archiving a fork archives that fork only.
        yield* writer.SetEntityArchived({ userId, entityId: variant.entityId, archived: true })
        const live = yield* reader.ListLibrary({ userId, kind: "preset", tag: null, archived: false })
        assert.sameMembers(
          live.map((r) => r.id),
          [upstream.id, child.id]
        )
        assert.deepStrictEqual(
          (yield* reader.ListLibrary({ userId, kind: "preset", tag: null, archived: true })).map((r) => r.id),
          [variant.id]
        )
      }).pipe(Effect.provide(database()))
  )

  it.live(
    "a fork's History runs back through every fork to the first original; restoring an inherited revision makes the fork's own",
    () =>
      Effect.gen(function* () {
        const { writer, reader, userId, upstream, doc, rowVersion, edit } = yield* setup()
        const r1 = upstream.headRevisionId
        const r2 = (yield* edit(upstream.id, preset("Second."))).ref.headRevisionId
        const r3 = (yield* edit(upstream.id, preset("Third."))).ref.headRevisionId
        const variant = yield* writer.ForkRef({ userId, refId: upstream.id, label: "Narrator", subtitle: "noir" })
        // The original's later revisions aren't the fork's.
        const r4 = (yield* edit(upstream.id, preset("Fourth."))).ref.headRevisionId
        const v2 = (yield* edit(variant.id, preset("Noir."))).ref.headRevisionId
        const child = yield* writer.ForkRef({ userId, refId: variant.id, label: "Narrator", subtitle: "rainy" })
        const c2 = (yield* edit(child.id, preset("Rain."))).ref.headRevisionId

        const history = yield* reader.RefHistory({ userId, refId: child.id, limit: 10 })
        assert.deepStrictEqual(
          history.map((r) => [r.id, r.number, r.entry?.refId ?? null, r.forkedFrom?.revisionId ?? null]),
          [
            [c2, 7, null, null],
            [child.headRevisionId, 6, null, v2],
            [v2, 5, variant.id, null],
            [variant.headRevisionId, 4, variant.id, r3],
            [r3, 3, upstream.id, null],
            [r2, 2, upstream.id, null],
            [r1, 1, upstream.id, null]
          ]
        )
        assert.deepStrictEqual(
          [history[1]!.forkedFrom!.refId, history[1]!.forkedFrom!.subtitle, history[3]!.forkedFrom!.refId],
          [variant.id, "noir", upstream.id]
        )
        assert.isFalse(history.some((r) => r.id === r4))

        // Pages run across the fork points.
        const pages = []
        let before: (typeof history)[number]["id"] | undefined
        for (;;) {
          const page = yield* reader.RefHistory({ userId, refId: child.id, limit: 3, ...(before ? { before } : {}) })
          if (page.length === 0) break
          pages.push(page.map((r) => r.number))
          before = page.at(-1)!.id
        }
        assert.deepStrictEqual(pages, [[7, 6, 5], [4, 3, 2], [1]])

        // Restoring the first original's revision makes a new revision of the fork, never of the
        // revision's own entry.
        const restored = yield* writer.RestoreRevision({
          userId,
          refId: child.id,
          revisionId: r2,
          expectedRowVersion: yield* rowVersion(child.id)
        })
        assert.deepStrictEqual(yield* doc(child.id), preset("Second."))
        const [top] = yield* reader.RefHistory({ userId, refId: child.id, limit: 1 })
        assert.deepStrictEqual(
          [top!.id, top!.parents, top!.number, top!.entry],
          [restored.ref.headRevisionId, [c2], 8, undefined]
        )
        assert.deepStrictEqual(
          [(yield* reader.GetRef({ userId, refId: upstream.id })).ref.headRevisionId, yield* doc(upstream.id)],
          [r4, preset("Fourth.")]
        )
        assert.strictEqual((yield* reader.GetRef({ userId, refId: variant.id })).ref.headRevisionId, v2)

        // An inherited revision's message is its own entry's to set, not the fork's.
        assert.strictEqual(
          yield* tag(writer.SetRevisionMessage({ userId, refId: child.id, revisionId: r2, message: "Mine" })),
          "NotFound"
        )
        yield* writer.SetRevisionMessage({ userId, refId: upstream.id, revisionId: r2, message: "Second draft" })
        const relabelled = yield* reader.RefHistory({ userId, refId: child.id, limit: 10 })
        assert.strictEqual(relabelled.find((r) => r.id === r2)!.message, "Second draft")

        // Another entry's revision, off the fork's line, is neither a page start nor restorable.
        const stranger = yield* writer.CreateEntity({
          userId,
          kind: "preset",
          label: "Other",
          subtitle: "",
          doc: preset("Other."),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        assert.strictEqual(
          yield* tag(reader.RefHistory({ userId, refId: child.id, limit: 3, before: stranger.ref.headRevisionId })),
          "NotFound"
        )
        assert.strictEqual(
          yield* tag(
            writer.RestoreRevision({
              userId,
              refId: child.id,
              revisionId: stranger.ref.headRevisionId,
              expectedRowVersion: yield* rowVersion(child.id)
            })
          ),
          "NotFound"
        )
      }).pipe(Effect.provide(database()))
  )

  for (const operation of ["restore", "page"] as const)
    it.live(`a fork cannot ${operation} from a parent's revision outside its inherited line`, () =>
      Effect.gen(function* () {
        const { writer, reader, userId, upstream, edit, rowVersion } = yield* setup()
        const variant = yield* writer.ForkRef({ userId, refId: upstream.id, label: "Variant", subtitle: "" })
        const child = yield* writer.ForkRef({ userId, refId: variant.id, label: "Child", subtitle: "" })
        const later = (yield* edit(upstream.id, preset("After the fork."))).ref
        yield* edit(upstream.id, preset("Later still."))
        const before = yield* reader.RefHistory({ userId, refId: child.id, limit: 10 })
        assert.isFalse(before.some((r) => r.id === later.headRevisionId))
        const result =
          operation === "restore"
            ? yield* writer
                .RestoreRevision({
                  userId,
                  refId: child.id,
                  revisionId: later.headRevisionId,
                  expectedRowVersion: yield* rowVersion(child.id)
                })
                .pipe(Effect.result)
            : yield* reader
                .RefHistory({ userId, refId: child.id, limit: 10, before: later.headRevisionId })
                .pipe(Effect.result)
        assert.strictEqual(result._tag, "Failure")
        assert.deepStrictEqual(yield* reader.RefHistory({ userId, refId: child.id, limit: 10 }), before)
      }).pipe(Effect.provide(database()))
    )

  for (const kind of ["lorebook", "note"] as const)
    it.live(`${kind} forks are entries of their own and wait for an explicit merge`, () =>
      Effect.gen(function* () {
        const writer = yield* Database.Writer
        const reader = yield* Database.Reader
        const userId = (yield* writer.EnsureUser({ handle: "owner", displayName: "Owner" })).id
        const textField = kind === "note" ? "content" : "description"
        const nameField = kind === "note" ? "title" : "name"
        const original = {
          ...(kind === "note" ? newSharedNote("Synthetic", "") : docFor(kind, "Synthetic")),
          [textField]: "Original text."
        }
        const { ref: upstream } = yield* writer.CreateEntity({
          userId,
          kind,
          label: "Synthetic",
          subtitle: "",
          doc: original,
          schemaVersion: 1,
          origin: "import",
          sourcePath: "synthetic.json"
        })
        const variant = yield* writer.ForkRef({ userId, refId: upstream.id, label: "Variant", subtitle: "" })
        assert.strictEqual(variant.parentEntityId, upstream.entityId)
        yield* writer.EditRef({
          userId,
          refId: variant.id,
          expectedRowVersion: variant.rowVersion,
          doc: { ...original, [nameField]: "Local name" },
          message: null,
          commitDraft: null
        })
        const result = yield* importInto(writer, userId, upstream.id, kind, {
          ...original,
          [textField]: "Changed file text."
        })
        assert.deepStrictEqual(result.change.followers, [])
        const waiting = yield* reader.GetRef({ userId, refId: variant.id })
        assert.strictEqual(waiting.doc[textField], "Original text.")
        assert.isTrue(waiting.ref.updateAvailable)
        yield* writer.MergeFollowed({ userId, refId: variant.id })
        const merged = yield* reader.GetRef({ userId, refId: variant.id })
        assert.strictEqual(merged.doc[textField], "Changed file text.")
        assert.strictEqual(merged.doc[nameField], "Local name")
        assert.isFalse(merged.ref.updateAvailable)
        assert.strictEqual((yield* reader.ListLibrary({ userId, kind, tag: null, archived: false })).length, 2)
      }).pipe(Effect.provide(database()))
    )

  it.live("refuses operations that don't apply, stale edits, and other users' refs", () =>
    Effect.gen(function* () {
      const ana = yield* setup("ana")
      const bob = yield* setup("bob")
      const variant = yield* ana.writer.ForkRef({
        userId: ana.userId,
        refId: ana.upstream.id,
        label: "N",
        subtitle: "v"
      })
      const card = yield* ana.writer.CreateEntity({
        userId: ana.userId,
        kind: "card",
        label: "Mira",
        subtitle: "",
        doc: cardDoc("Mira"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })

      assert.strictEqual(
        yield* tag(ana.writer.ForkRef({ userId: ana.userId, refId: card.ref.id, label: "x", subtitle: "" })),
        "RefOperationRefused"
      )
      assert.strictEqual(
        yield* tag(
          ana.writer.EditRef({
            userId: ana.userId,
            refId: variant.id,
            doc: { a: 1 },
            expectedRowVersion: 99,
            message: null,
            commitDraft: null
          })
        ),
        "StaleWrite"
      )
      assert.strictEqual(yield* tag(bob.reader.GetRef({ userId: bob.userId, refId: ana.upstream.id })), "NotFound")
      assert.strictEqual(
        yield* tag(bob.writer.ForkRef({ userId: bob.userId, refId: variant.id, label: "x", subtitle: "" })),
        "NotFound"
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("tags make folders, the persona folder included, and archived entities leave the library", () =>
    Effect.gen(function* () {
      const { writer, reader, userId } = yield* setup()
      const card = (name: string) =>
        writer.CreateEntity({
          userId,
          kind: "card",
          label: name,
          subtitle: "",
          doc: cardDoc(name),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
      const me = yield* card("Me")
      const mira = yield* card("Mira")
      assert.deepStrictEqual(
        yield* writer.SetEntityTags({ userId, entityId: me.entityId, tags: ["persona", " fantasy ", "persona"] }),
        ["fantasy", "persona"]
      )
      const list = (tag: string | null, archived = false) =>
        reader.ListLibrary({ userId, kind: "card", tag, archived }).pipe(Effect.map((refs) => refs.map((r) => r.label)))
      assert.deepStrictEqual(yield* list("persona"), ["Me"])
      assert.deepStrictEqual(yield* list(null), ["Me", "Mira"])

      yield* writer.SetEntityArchived({ userId, entityId: mira.entityId, archived: true })
      assert.deepStrictEqual(yield* list(null), ["Me"])
      assert.deepStrictEqual(yield* list(null, true), ["Mira"])
    }).pipe(Effect.provide(database()))
  )

  it.live("a re-import merges with edits made on the upstream itself; a conflict waits for the user", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, upstream, doc, edit, reimport, rowVersion } = yield* setup()
      const variant = yield* writer.ForkRef({ userId, refId: upstream.id, label: "Narrator", subtitle: "as is" })
      const summary = { identifier: "summary", content: "{{summary}}" }
      yield* edit(upstream.id, preset(MAIN, [summary]))

      const v2 = MAIN.replace("You are {{char}}.", "You are {{char}}, the narrator.")
      const merged = yield* reimport(preset(v2))
      assert.strictEqual(merged.outcome, "merged")
      assert.deepStrictEqual(yield* doc(upstream.id), preset(v2, [summary]))
      assert.deepStrictEqual(merged.change.followers, [])
      assert.deepStrictEqual(yield* doc(variant.id), preset(MAIN))
      yield* writer.MergeFollowed({ userId, refId: variant.id })
      assert.deepStrictEqual(yield* doc(variant.id), preset(v2, [summary]))

      // The user rewrites a sentence that the next version rewrites too.
      const mine = v2.replace("Write vivid prose.", "Write terse prose.")
      yield* edit(upstream.id, preset(mine, [summary]))
      const conflicted = yield* reimport(preset(v2.replace("Write vivid prose.", "Write lush prose.")))
      assert.strictEqual(conflicted.outcome, "conflicts")
      assert.deepStrictEqual(conflicted.change.followers, [])
      assert.isTrue(conflicted.change.ref.updateAvailable)
      assert.deepStrictEqual(yield* doc(upstream.id), preset(mine, [summary]))

      const preview = yield* reader.PreviewMerge({ userId, refId: upstream.id })
      assert.deepStrictEqual(
        preview.conflicts.map((c) => c.path),
        [["prompts", "identifier=main", "content"]]
      )
      const resolved = yield* writer.ResolveMerge({
        userId,
        refId: upstream.id,
        doc: preview.merged,
        theirsRevisionId: preview.theirsRevisionId,
        expectedRowVersion: yield* rowVersion(upstream.id)
      })
      assert.isFalse(resolved.ref.updateAvailable)
      assert.deepStrictEqual(yield* doc(upstream.id), preset(mine, [summary]))
      // The import it resolved against is now the base: importing it again changes nothing.
      const again = yield* reimport(preset(v2.replace("Write vivid prose.", "Write lush prose.")))
      assert.strictEqual(again.outcome, "up_to_date")
      assert.strictEqual(again.change.ref.headRevisionId, resolved.ref.headRevisionId)
    }).pipe(Effect.provide(database()))
  )

  it.live("keys named like Object.prototype members merge as plain data", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, doc, edit } = yield* setup()
      const entity = (d: Doc) =>
        writer.CreateEntity({
          userId,
          kind: "preset_overlay",
          label: "Card",
          subtitle: "",
          doc: d,
          schemaVersion: 1,
          origin: "import",
          sourcePath: null
        })
      const reimport = (refId: RefId, d: Doc) => importInto(writer, userId, refId, "preset_overlay", d)

      // JSON.parse makes `__proto__` an own key, as it is in an imported file.
      const proto = yield* entity(JSON.parse('{"ext":{"__proto__":{"a":1},"k":1}}'))
      const protoVariant = yield* writer.ForkRef({ userId, refId: proto.ref.id, label: "Card", subtitle: "v" })
      yield* edit(protoVariant.id, JSON.parse('{"ext":{"__proto__":{"a":2},"k":1}}'))
      const protoChange = yield* reimport(proto.ref.id, JSON.parse('{"ext":{"__proto__":{"a":1},"k":2}}'))
      assert.deepStrictEqual(protoChange.change.followers, [])
      yield* writer.MergeFollowed({ userId, refId: protoVariant.id })
      assert.strictEqual(JSON.stringify(yield* doc(protoVariant.id)), '{"ext":{"__proto__":{"a":2},"k":2}}')

      const named = yield* entity({ x: 1 })
      const namedVariant = yield* writer.ForkRef({ userId, refId: named.ref.id, label: "Card", subtitle: "v" })
      yield* edit(namedVariant.id, { x: 1, constructor: "mine", toString: "mine", valueOf: "mine" })
      yield* reimport(named.ref.id, { x: 1, constructor: "theirs", toString: "theirs", valueOf: "theirs" })
      const preview = yield* reader.PreviewMerge({ userId, refId: namedVariant.id })
      assert.deepStrictEqual(
        preview.conflicts.map((c) => [c.path, c.base, c.ours, c.theirs]),
        [
          [["constructor"], undefined, "mine", "theirs"],
          [["toString"], undefined, "mine", "theirs"],
          [["valueOf"], undefined, "mine", "theirs"]
        ]
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("an import of another schema version is refused before anything is written", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, upstream, doc, edit, reimport } = yield* setup()
      const variant = yield* writer.ForkRef({ userId, refId: upstream.id, label: "Narrator", subtitle: "as is" })
      const history = (refId: RefId) =>
        reader.RefHistory({ userId, refId, limit: 10 }).pipe(Effect.map((revs) => revs.map((r) => r.id)))
      const v2 = preset(MAIN, [{ identifier: "style", content: "Short paragraphs." }])
      const forked = yield* history(variant.id)

      // Untouched upstream: nothing new for the variant to merge.
      assert.strictEqual(yield* tag(reimport(v2, 2)), "RefOperationRefused")
      assert.deepStrictEqual(yield* history(variant.id), forked)
      assert.isFalse((yield* reader.GetRef({ userId, refId: variant.id })).ref.updateAvailable)

      // Upstream with its own edits: they'd have been stranded behind an unmergeable import.
      yield* edit(upstream.id, preset(MAIN, [], 0.7))
      const before = yield* history(upstream.id)
      assert.strictEqual(yield* tag(reimport(v2, 2)), "RefOperationRefused")
      assert.deepStrictEqual(yield* history(upstream.id), before)
      assert.isFalse((yield* reader.GetRef({ userId, refId: upstream.id })).ref.updateAvailable)

      // The same content at the library's version still merges, and flows on.
      const accepted = yield* reimport(v2)
      assert.strictEqual(accepted.outcome, "merged")
      assert.deepStrictEqual(accepted.change.followers, [])
      yield* writer.MergeFollowed({ userId, refId: variant.id })
      assert.deepStrictEqual(yield* doc(variant.id), { ...v2, prefill: { ...v2.prefill, assistant: "0.7" } })
    }).pipe(Effect.provide(database()))
  )

  it.live("a first import equal to a user-created document records a merge without changing content", () =>
    Effect.gen(function* () {
      const { writer, reader, userId } = yield* setup()
      const created = yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Mira",
        subtitle: "",
        doc: cardDoc("Mira"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const variant = yield* writer.ForkCard({
        userId,
        refId: created.ref.id,
        name: "Mira",
        nickname: "",
        characterVersion: "v"
      })
      const reimport = (d: Doc) => importInto(writer, userId, created.ref.id, "card", d)

      const same = yield* reimport(cardDoc("Mira"))
      assert.strictEqual(same.outcome, "up_to_date")
      assert.deepStrictEqual(same.change.followers, [])
      assert.isFalse(same.change.ref.updateAvailable)
      const origins = (refId: RefId) =>
        reader.RefHistory({ userId, refId, limit: 10 }).pipe(Effect.map((revs) => revs.map((r) => r.origin)))
      assert.deepStrictEqual(yield* origins(created.ref.id), ["merge", "user"])
      // The fork: its own first revision, then the one it was forked from; not the import since.
      assert.deepStrictEqual(yield* origins(variant.id), ["user", "user"])

      // That import is now the merge base, so the next one merges cleanly.
      const next = yield* reimport(cardDoc("Mira Vale"))
      assert.strictEqual(next.outcome, "merged")
      assert.deepStrictEqual(
        (yield* reader.GetRef({ userId, refId: variant.id })).doc,
        cardDoc("Mira", { nickname: "", character_version: "v" })
      )
    }).pipe(Effect.provide(database()))
  )

  it.live("an edit that changes nothing still commits its draft", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, upstream, rowVersion } = yield* setup()
      const key = new DraftKey({
        targetKind: "entity_field",
        targetId: upstream.id,
        field: JSON.stringify(["prompts", "identifier=main", "content"])
      })
      const draft = yield* writer.SaveDraft({
        draftId: null,
        expectedSession: null,
        userId,
        key,
        content: MAIN,
        expectedRowVersion: null,
        baseRevision: upstream.headRevisionId
      })
      yield* writer.EditRef({
        userId,
        refId: upstream.id,
        doc: preset(MAIN),
        expectedRowVersion: yield* rowVersion(upstream.id),
        message: null,
        commitDraft: { draftId: draft.id, session: draft.session }
      })
      assert.strictEqual((yield* reader.GetDraft({ userId, key }))?.status, "committed")
    }).pipe(Effect.provide(database()))
  )

  it.live("discard recovers lorebook entry keys one per line and leaves settings out of the bin", () =>
    Effect.gen(function* () {
      const { writer, reader, userId } = yield* setup()
      const book = loreBook([loreEntry({}, 1)]).document
      const { ref: lorebook } = yield* writer.CreateEntity({
        userId,
        kind: "lorebook",
        label: "Book",
        subtitle: "",
        doc: book,
        schemaVersion: book.schema_version,
        origin: "user",
        sourcePath: null
      })
      const card = cardDoc("Card", { character_book: book })
      const { ref: embedded } = yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Card",
        subtitle: "",
        doc: card,
        schemaVersion: card.schema_version,
        origin: "user",
        sourcePath: null
      })
      const end = (ref: typeof lorebook, path: FieldPath, content: string) =>
        Effect.gen(function* () {
          const key = new DraftKey({ targetKind: "entity_field", targetId: ref.id, field: valueField(path) })
          const draft = yield* writer.SaveDraft({
            draftId: null,
            expectedSession: null,
            userId,
            key,
            content,
            expectedRowVersion: null,
            baseRevision: ref.headRevisionId
          })
          const ended = yield* writer.ClearDraft({
            userId,
            key,
            draftId: draft.id,
            outcome: "discarded",
            expectedRowVersion: draft.rowVersion
          })
          const texts = yield* reader.ListRecoveredTexts({ userId, source: key, limit: 10, before: null })
          return { recovered: ended.recovered, texts: texts.map((text) => text.content) }
        })
      assert.deepStrictEqual(yield* end(lorebook, ["entries", "uid=1", "keys"], '["dragon","new key"]'), {
        recovered: 1,
        texts: ["dragon\nnew key"]
      })
      assert.deepStrictEqual(
        yield* end(embedded, ["character_book", "entries", "uid=1", "secondary_keys"], '["cave","mountain"]'),
        { recovered: 1, texts: ["cave\nmountain"] }
      )
      assert.deepStrictEqual(yield* end(lorebook, ["entries", "uid=1", "triggers"], '["normal","continue"]'), {
        recovered: 0,
        texts: []
      })
    }).pipe(Effect.provide(database()))
  )

  it.live("a revision cannot commit field text absent from its stored document", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, upstream, rowVersion } = yield* setup()
      const key = new DraftKey({
        targetKind: "entity_field",
        targetId: upstream.id,
        field: JSON.stringify(["prompts", "identifier=main", "content"])
      })
      const draft = yield* writer.SaveDraft({
        userId,
        key,
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        content: "Unstored text",
        baseRevision: upstream.headRevisionId
      })
      yield* writer.EditRef({
        userId,
        refId: upstream.id,
        doc: preset(MAIN),
        expectedRowVersion: yield* rowVersion(upstream.id),
        message: null,
        commitDraft: { draftId: draft.id, session: draft.session }
      })
      assert.strictEqual((yield* reader.GetDraft({ userId, key }))?.content, draft.content)
    }).pipe(Effect.provide(database()))
  )

  it.live("binned entities can't be tagged, archived or forked", () =>
    Effect.gen(function* () {
      const { writer, userId, upstream } = yield* setup()
      yield* writer.DeleteEntity({ userId, entityId: upstream.entityId })
      assert.strictEqual(
        yield* tag(writer.SetEntityTags({ userId, entityId: upstream.entityId, tags: ["x"] })),
        "NotFound"
      )
      assert.strictEqual(
        yield* tag(writer.SetEntityArchived({ userId, entityId: upstream.entityId, archived: true })),
        "NotFound"
      )
      assert.strictEqual(
        yield* tag(writer.ForkRef({ userId, refId: upstream.id, label: "x", subtitle: "" })),
        "NotFound"
      )
    }).pipe(Effect.provide(database()))
  )
})
