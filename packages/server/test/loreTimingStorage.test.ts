import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { type SlotId, NewVersion, type VersionId } from "@dreamspan/shared/chat.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import type { ConnectionId } from "@dreamspan/shared/providers.ts"
import { type ContextSnapshot, generationOf } from "../src/assembler/types.ts"
import * as Database from "../src/db/Database.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { json, run } from "./formats/support.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const database = () =>
  Database.layer({ dataDir: tempDir("lore-timing"), readers: 1, allowNetworkFs: false, ...testWorkers })

describe("lorebook activation receipts in the selected history", () => {
  it.live("persists admissions, shares sibling state, isolates forks and freezes inspector replay", () =>
    Effect.gen(function* () {
      const writer = yield* Database.Writer
      const reader = yield* Database.Reader
      const userId = (yield* writer.EnsureUser({ handle: "timers", displayName: "Timers" })).id
      const create = (kind: "card" | "lorebook" | "preset", label: string, doc: object) =>
        writer.CreateEntity({
          userId,
          kind,
          label,
          subtitle: "",
          doc: doc as never,
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
      const card = yield* create(
        "card",
        "Alice",
        run(importCard(json({ name: "Alice", description: "Synthetic character" }))).card
      )
      const book = yield* create(
        "lorebook",
        "Timers",
        loreBook([loreEntry({ keys: ["cat"], content: "ACTIVE LORE", sticky: 3, cooldown: 2, scan_depth: 1 })]).document
      )
      const preset = yield* create("preset", "Preset", importStPreset('{"main_prompt":"Write as {{char}}."}').document!)
      const chat = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Timers",
        participants: [card.entityId],
        greeting: null
      })
      const state = (data: Parameters<typeof writer.AddStateEvent>[0]["data"]) =>
        writer.AddStateEvent({ userId, chatId: chat.id, slotId: null, versionId: null, scope: null, data })
      yield* state({ key: "lcm.settings", value: { enabled: false } })
      yield* state({ key: "lorebook.attach", value: { ref: book.ref.id } })
      yield* state({ key: "preset.binding", value: { ref: preset.ref.id } })
      const connectionId = uuidv7() as ConnectionId
      yield* writer.CreateConnection({
        userId,
        connectionId,
        kind: "openai-chat",
        api: "openai-completions",
        settings: {
          name: "Mock",
          baseUrl: null,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        credential: { existing: null }
      })
      const model = yield* writer.AddUserModel({
        userId,
        connectionId,
        key: "mock",
        overrides: { context: 8192, maxOutput: 256 }
      })
      yield* state({ key: "model.binding", value: { connection: connectionId, model: model.id } })
      const version = (content: string, generating = false) =>
        new NewVersion({
          speakerEntityId: card.entityId,
          writer: generating ? "model" : "human",
          content,
          status: generating ? "generating" : "complete",
          macroMode: "verbatim",
          origin: generating ? "generated" : "user_written"
        })
      const append = (parentSlotId: SlotId | null, content: string, generating = false, branch = false) =>
        writer.AppendMessage({
          userId,
          chatId: chat.id,
          parentSlotId,
          branch,
          version: version(content, generating),
          commitDraft: null
        })
      const build = (slotId: SlotId, versionId: VersionId) =>
        reader
          .AssembleContext({
            userId,
            chatId: chat.id,
            slotId,
            versionId,
            now: 100000,
            timeZone: "UTC",
            model: { connection: connectionId, model: model.id },
            frozen: null
          })
          .pipe(Effect.map((r) => JSON.parse(r.snapshot) as ContextSnapshot))
      const save = Effect.fnUntraced(function* (snapshot: ContextSnapshot) {
        const generation = generationOf(snapshot)
        yield* writer.StartRollout({
          userId,
          chatId: chat.id,
          slotId: snapshot.inputs.slotId as SlotId,
          versionId: snapshot.inputs.versionId as VersionId,
          rolloutId: uuidv7(),
          leafSlotId: snapshot.inputs.leafSlotId as SlotId | null,
          connectionId,
          modelId: model.id,
          snapshot: JSON.stringify(snapshot),
          issues: generation.issues,
          variables: generation.variables,
          frozenMessages: []
        })
        yield* writer.FinishGeneration({
          userId,
          versionId: snapshot.inputs.versionId as VersionId,
          content: "dog",
          status: "complete",
          error: null
        })
      })
      const root = yield* append(null, "cat")
      const first = yield* append(root.slotId, "", true)
      const initial = yield* build(first.slotId, first.version.id)
      assert.lengthOf(initial.loreTiming!, 1)
      yield* save(initial)
      const continued = yield* writer.AddVersion({
        userId,
        slotId: first.slotId,
        version: new NewVersion({ ...version("", true), sourceVersionId: first.version.id }),
        select: true,
        commitDraft: null
      })
      const continuation = yield* build(first.slotId, continued.id)
      assert.strictEqual(continuation.inputs.type, "continue")
      assert.strictEqual(continuation.sources!.loreStates![0]!.state.count, 2)
      assert.include(JSON.stringify(continuation.request), "ACTIVE LORE")
      yield* save(continuation)
      const sent = yield* append(first.slotId, "dog")
      const second = yield* append(sent.slotId, "", true)
      const active = yield* build(second.slotId, second.version.id)
      assert.include(JSON.stringify(active.request), "ACTIVE LORE")
      assert.deepStrictEqual(active.sources!.loreStates![0]!.state.count, 3)
      assert.ok(
        active.pieces.some(
          (p) =>
            p.source.kind === "lorebook" &&
            p.source.activation.status === "activated" &&
            p.source.activation.why.kind === "sticky"
        )
      )
      // Previewing twice does not start or extend effects.
      assert.deepStrictEqual((yield* build(second.slotId, second.version.id)).loreTiming, active.loreTiming)
      yield* save(active)
      const swipe = yield* writer.AddVersion({
        userId,
        slotId: second.slotId,
        version: version("", true),
        select: true,
        commitDraft: null
      })
      const sibling = yield* build(second.slotId, swipe.id)
      assert.deepStrictEqual(sibling.sources!.loreStates, active.sources!.loreStates)
      assert.include(JSON.stringify(sibling.request), "ACTIVE LORE")
      yield* writer.FinishGeneration({ userId, versionId: swipe.id, content: "dog", status: "complete", error: null })
      const branch = yield* append(root.slotId, "dog", false, true)
      const branchUser = yield* append(branch.slotId, "dog")
      const branchTarget = yield* append(branchUser.slotId, "", true)
      const other = yield* build(branchTarget.slotId, branchTarget.version.id)
      assert.notInclude(JSON.stringify(other.request), "ACTIVE LORE")
      assert.deepStrictEqual(other.sources!.loreStates![0]!.state.effects, [])
      const rebuilt = yield* reader.RebuildContext({ userId, snapshot: JSON.stringify(active) })
      assert.strictEqual(rebuilt._tag, "Rebuilt")
      if (rebuilt._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), active)
    }).pipe(Effect.provide(database()))
  )
})
