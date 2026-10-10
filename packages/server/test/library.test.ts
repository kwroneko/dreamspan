// Layered library documents through the real storage operations (DESIGN §4,
// DATA-MODEL §3.2): edits, variants, chat overrides, re-imports and merges.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import type { Doc, RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import * as Database from "../src/db/Database.ts"

const database = () =>
  Database.layer({
    dataDir: mkdtempSync(join(tmpdir(), "rp-lib-")),
    readers: 2,
    allowNetworkFs: false,
    workers: "source"
  })

const preset = (main: string, extra: ReadonlyArray<{ identifier: string; content: string }> = [], temperature = 1) => ({
  name: "Narrator",
  samplers: { temperature },
  prompts: [{ identifier: "main", content: main }, ...extra]
})

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
    const reimport = (d: Doc) =>
      writer.ImportUpstream({ userId, refId: imported.ref.id, doc: d, sourcePath: null, sourceHash: null })
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
      const change = yield* reimport(v2)
      assert.deepStrictEqual(
        change.followers.map((f) => [f.refId, f.outcome]),
        [
          [pristine.id, "fast_forward"],
          [mine.id, "merged"]
        ]
      )

      assert.deepStrictEqual(yield* doc(pristine.id), v2)
      assert.deepStrictEqual(yield* doc(mine.id), {
        name: "Narrator",
        samplers: { temperature: 0.8 },
        prompts: [
          {
            identifier: "main",
            content: "You are {{char}}, the narrator. Write vivid prose. Avoid speaking for {{user}} unless asked."
          },
          { identifier: "summary", content: "{{summary}}" }
        ]
      })
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
      const change = yield* reimport(preset(theirMain, [], 0.8))

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

      const change = yield* reimport(preset(MAIN, [], 0.5))
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
      const tag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((e) => e._tag)
        )
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
        yield* tag(
          ana.writer.ImportUpstream({
            userId: ana.userId,
            refId: variant.id,
            doc: {},
            sourcePath: null,
            sourceHash: null
          })
        ),
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
          doc: { name },
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
})
