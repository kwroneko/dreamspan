// Library entries and inherited History at owner scale, using synthetic presets only.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { promptPreset } from "@dreamspan/shared/docs/preset.ts"
import type { RevisionId } from "@dreamspan/shared/library.ts"
import * as Database from "../src/db/Database.ts"
import { presetDoc } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

it.live("2,000 library entries and a 200-deep family keep listings, genealogy and History scoped", () =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const userId = (yield* writer.EnsureUser({ handle: "owner", displayName: "Owner" })).id
    const doc = promptPreset(presetDoc())
    const create = (label: string) =>
      writer.CreateEntity({
        userId,
        kind: "preset",
        label,
        subtitle: "",
        doc,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    const root = (yield* create("Original")).ref
    for (let i = 1; i < 2_000; i++) yield* create(`Unrelated ${i}`)
    let deep = root
    for (let i = 1; i <= 200; i++)
      deep = yield* writer.ForkRef({ userId, refId: deep.id, label: `Fork ${i}`, subtitle: "" })
    const listed = yield* reader.ListLibrary({ userId, kind: "preset", tag: null, archived: false })
    assert.lengthOf(listed, 2_200)
    assert.strictEqual(new Set(listed.map((r) => r.entityId)).size, 2_200)
    assert.isFalse(listed.some((r) => r.updateAvailable))
    const family = yield* reader.LibraryGenealogy({ userId, refId: deep.id })
    assert.lengthOf(family.members, 201)
    assert.strictEqual(family.rootRefId, root.id)
    assert.deepStrictEqual(yield* reader.LibraryGenealogy({ userId, refId: root.id }), family)
    const history = []
    let before: RevisionId | undefined
    for (;;) {
      const page = yield* reader.RefHistory({ userId, refId: deep.id, limit: 50, ...(before ? { before } : {}) })
      if (page.length === 0) break
      history.push(...page)
      before = page.at(-1)!.id
    }
    assert.lengthOf(history, 201)
    assert.deepStrictEqual(
      history.map((r) => r.number),
      Array.from({ length: 201 }, (_, i) => 201 - i)
    )
    assert.strictEqual(history.at(-1)!.id, root.headRevisionId)
    const later = yield* writer.EditRef({
      userId,
      refId: root.id,
      doc: { ...doc, prefill: { ...doc.prefill, assistant: "Written after every fork." } },
      expectedRowVersion: root.rowVersion,
      message: null,
      commitDraft: null
    })
    const rejected = yield* writer
      .RestoreRevision({
        userId,
        refId: deep.id,
        revisionId: later.ref.headRevisionId,
        expectedRowVersion: deep.rowVersion
      })
      .pipe(Effect.result)
    assert.strictEqual(rejected._tag, "Failure")
    const restored = yield* writer.RestoreRevision({
      userId,
      refId: deep.id,
      revisionId: root.headRevisionId,
      expectedRowVersion: deep.rowVersion
    })
    assert.strictEqual(restored.ref.entityId, deep.entityId)
    assert.deepStrictEqual((yield* reader.GetRef({ userId, refId: root.id })).ref, later.ref)
  }).pipe(
    Effect.provide(
      Database.layer({ dataDir: tempDir("library-fork-scale"), readers: 1, allowNetworkFs: false, ...testWorkers })
    )
  )
)
