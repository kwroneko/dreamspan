// Layered library documents through the real storage operations (DESIGN §4,
// DATA-MODEL §3.2): edits, variants, chat overrides, re-imports and merges.
import { assert, describe, it } from "@effect/vitest"
import { DraftKey } from "@rp/shared/drafts.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { Doc, EntityKind, RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"
import { docHash, searchText } from "../src/db/documents.ts"
import { cardDoc, presetDoc } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"

const database = () =>
  Database.layer({
    dataDir: tempDir("lib"),
    readers: 2,
    allowNetworkFs: false,
    workers: "source"
  })

const preset = (main: string, extra: ReadonlyArray<{ identifier: string; content: string }> = [], temperature = 1) =>
  presetDoc([{ identifier: "main", content: main }, ...extra], { temperature })

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

  it.live("a re-import flows into variants: untouched ones fast-forward, edited ones merge (DESIGN §4)", () =>
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

      // Upstream v2 rewrites the first sentence and lowers the temperature.
      const v2 = preset(MAIN.replace("You are {{char}}.", "You are {{char}}, the narrator."), [], 0.8)
      const { change } = yield* reimport(v2)
      assert.deepStrictEqual(
        change.followers.map((f) => [f.refId, f.outcome]),
        [
          [pristine.id, "fast_forward"],
          [mine.id, "merged"]
        ]
      )

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

      assert.deepStrictEqual(
        change.followers.map((f) => f.outcome),
        ["conflicts"]
      )
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
      assert.strictEqual((preview.merged as ReturnType<typeof preset>).samplers.temperature, 0.8)

      // The user keeps their wording and commits.
      const resolved = yield* writer.ResolveMerge({
        userId,
        refId: mine.id,
        doc: preview.merged,
        theirsRevisionId: preview.theirsRevisionId,
        expectedRowVersion: yield* rowVersion(mine.id)
      })
      assert.isFalse(resolved.ref.updateAvailable)
      assert.strictEqual((yield* doc(mine.id)).samplers.temperature, 0.8)
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

  it.live("changes cascade from upstream through a variant to a chat override, and an override can be promoted", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, upstream, doc, edit, reimport, rowVersion } = yield* setup()
      const variant = yield* writer.ForkRef({ userId, refId: upstream.id, label: "Narrator", subtitle: "noir" })
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "",
        participants: [],
        greeting: null
      })
      const override = yield* writer.CreateChatOverride({ userId, refId: variant.id, chatId: chat.id })
      // A story change for this chat only.
      yield* edit(override.id, preset(MAIN, [{ identifier: "scene", content: "It is raining." }]))

      const { change } = yield* reimport(preset(MAIN, [], 0.5))
      assert.deepStrictEqual(
        change.followers.map((f) => [f.refId, f.outcome]),
        [
          [variant.id, "fast_forward"],
          [override.id, "merged"]
        ]
      )
      const overridden = yield* doc(override.id)
      assert.strictEqual(overridden.samplers.temperature, 0.5)
      assert.deepStrictEqual(
        overridden.prompts.map((p) => p.identifier),
        ["main", "scene"]
      )

      // Overrides aren't library entries until promoted.
      assert.deepStrictEqual(
        (yield* reader.ListChatOverrides({ userId, chatId: chat.id })).map((r) => r.id),
        [override.id]
      )
      assert.strictEqual((yield* reader.ListLibrary({ userId, kind: "preset", tag: null, archived: false })).length, 2)
      const promoted = yield* writer.PromoteOverride({
        userId,
        refId: override.id,
        label: "Narrator",
        subtitle: "rainy",
        expectedRowVersion: yield* rowVersion(override.id)
      })
      assert.strictEqual(promoted.refKind, "variant")
      assert.isNull(promoted.chatId)
      assert.strictEqual((yield* reader.ListLibrary({ userId, kind: "preset", tag: null, archived: false })).length, 3)
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
      const chat = yield* ana.writer.CreateChat({
        userId: ana.userId,
        kind: "rp",
        status: "active",
        title: "",
        participants: [],
        greeting: null
      })
      const override = yield* ana.writer.CreateChatOverride({ userId: ana.userId, refId: variant.id, chatId: chat.id })

      assert.strictEqual(
        yield* tag(ana.writer.ForkRef({ userId: ana.userId, refId: override.id, label: "x", subtitle: "" })),
        "RefOperationRefused"
      )
      assert.strictEqual(
        yield* tag(importInto(ana.writer, ana.userId, variant.id, "preset", {})),
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
        yield* tag(bob.writer.CreateChatOverride({ userId: bob.userId, refId: bob.upstream.id, chatId: chat.id })),
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
      assert.deepStrictEqual(
        merged.change.followers.map((f) => [f.refId, f.outcome]),
        [[variant.id, "fast_forward"]]
      )
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
      assert.deepStrictEqual(
        protoChange.change.followers.map((f) => f.outcome),
        ["merged"]
      )
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

      // Untouched upstream: the variant would have fast-forwarded into version 2.
      assert.strictEqual(yield* tag(reimport(v2, 2)), "RefOperationRefused")
      assert.deepStrictEqual(yield* history(variant.id), [upstream.headRevisionId])

      // Upstream with its own edits: they'd have been stranded behind an unmergeable import.
      yield* edit(upstream.id, preset(MAIN, [], 0.7))
      const before = yield* history(upstream.id)
      assert.strictEqual(yield* tag(reimport(v2, 2)), "RefOperationRefused")
      assert.deepStrictEqual(yield* history(upstream.id), before)
      assert.isFalse((yield* reader.GetRef({ userId, refId: upstream.id })).ref.updateAvailable)

      // The same content at the library's version still merges, and flows on.
      const accepted = yield* reimport(v2)
      assert.strictEqual(accepted.outcome, "merged")
      assert.deepStrictEqual(
        accepted.change.followers.map((f) => f.outcome),
        ["fast_forward"]
      )
      assert.deepStrictEqual(yield* doc(variant.id), { ...v2, samplers: { ...v2.samplers, temperature: 0.7 } })
    }).pipe(Effect.provide(database()))
  )

  it.live("a first import equal to a user-created document only records the import", () =>
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
      const variant = yield* writer.ForkRef({ userId, refId: created.ref.id, label: "Mira", subtitle: "v" })
      const reimport = (d: Doc) => importInto(writer, userId, created.ref.id, "card", d)

      const same = yield* reimport(cardDoc("Mira"))
      assert.strictEqual(same.outcome, "up_to_date")
      assert.deepStrictEqual(same.change.followers, [])
      assert.isFalse(same.change.ref.updateAvailable)
      const origins = (refId: RefId) =>
        reader.RefHistory({ userId, refId, limit: 10 }).pipe(Effect.map((revs) => revs.map((r) => r.origin)))
      assert.deepStrictEqual(yield* origins(created.ref.id), ["user"])
      assert.deepStrictEqual(yield* origins(variant.id), ["user"])

      // That import is now the merge base, so the next one merges cleanly.
      const next = yield* reimport(cardDoc("Mira Vale"))
      assert.strictEqual(next.outcome, "merged")
      assert.deepStrictEqual((yield* reader.GetRef({ userId, refId: variant.id })).doc, cardDoc("Mira Vale"))
    }).pipe(Effect.provide(database()))
  )

  it.live("an edit that changes nothing still commits its draft", () =>
    Effect.gen(function* () {
      const { writer, reader, userId, upstream, rowVersion } = yield* setup()
      const key = new DraftKey({ targetKind: "entity_field", targetId: upstream.id, field: "/name" })
      const draft = yield* writer.SaveDraft({
        userId,
        key,
        content: "Narrator",
        expectedRowVersion: null,
        baseRevision: upstream.headRevisionId
      })
      yield* writer.EditRef({
        userId,
        refId: upstream.id,
        doc: preset(MAIN),
        expectedRowVersion: yield* rowVersion(upstream.id),
        message: null,
        commitDraft: { draftId: draft.id, session: draft.session, content: draft.content }
      })
      assert.strictEqual((yield* reader.GetDraft({ userId, key }))?.status, "committed")
    }).pipe(Effect.provide(database()))
  )

  it.live("binned entities and chats can't be tagged, archived or overridden", () =>
    Effect.gen(function* () {
      const { writer, userId, upstream } = yield* setup()
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "",
        participants: [],
        greeting: null
      })
      yield* writer.DeleteChat({ userId, chatId: chat.id })
      assert.strictEqual(
        yield* tag(writer.CreateChatOverride({ userId, refId: upstream.id, chatId: chat.id })),
        "NotFound"
      )

      yield* writer.DeleteEntity({ userId, entityId: upstream.entityId })
      assert.strictEqual(
        yield* tag(writer.SetEntityTags({ userId, entityId: upstream.entityId, tags: ["x"] })),
        "NotFound"
      )
      assert.strictEqual(
        yield* tag(writer.SetEntityArchived({ userId, entityId: upstream.entityId, archived: true })),
        "NotFound"
      )
    }).pipe(Effect.provide(database()))
  )
})
