import type { ContextSnapshot, WireContext } from "../src/assembler/types.ts"
import type { AppConfigShape } from "../src/config.ts"
import type { EntityKind } from "@rp/shared/library.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ProviderRegistry } from "../src/providers/registry.ts"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import { Worker } from "node:worker_threads"
import { client, serverLayer, testConfig, posted, outcome } from "./support/config.ts"
import { generateReply, eventually, finished } from "./support/generation.ts"
import { startMockProvider, sse, completionChunks } from "./support/mockProvider.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { wireDigest } from "../src/assembler/wire.ts"
const key = "sk-synthetic-seam-secret-1234"
interface PayloadRow {
  context_snapshot_json: string
  sent_context_json: string | null
}
const readPayloads = (dataDir: string) =>
  Effect.promise(
    () =>
      new Promise<PayloadRow[]>((resolve, reject) => {
        const worker = new Worker(
          `const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData,{readOnly:true});try{parentPort.postMessage(db.prepare('SELECT * FROM rollout_payloads').all())}finally{db.close()}`,
          { eval: true, workerData: databaseFile(dataDir) }
        )
        let rows: PayloadRow[] = []
        worker.once("message", (r) => (rows = r))
        worker.once("error", reject)
        worker.once("exit", (c) => (c ? reject(new Error(`fixture worker exited ${c}`)) : resolve(rows)))
      })
  )
const setupScenario = (config: AppConfigShape, failBeforeCapture: boolean, duplicateBook: boolean) => {
  return Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((_req, res) =>
          sse(res, completionChunks([`Synthetic response ${key}.`], { prompt_tokens: 10, completion_tokens: 2 }))
        )
      ),
      (p) => Effect.promise(() => p.close())
    )
    const api = yield* client()
    const writer = yield* Writer
    const reader = yield* Reader
    const me = yield* api.Whoami()
    const { chat, events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: mock.url + "/v1", apiKey: key, cacheTtlS: 300 },
      model: {}
    })
    const create = (kind: EntityKind, label: string, doc: Record<string, unknown>) =>
      writer.CreateEntity({
        userId: me.id,
        kind,
        label,
        subtitle: "",
        doc,
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    const book = yield* create(
      "lorebook",
      "Seam book",
      loreBook(
        [
          loreEntry({ constant: true, content: `LORE ${key}` }),
          loreEntry({ keys: [key], content: "Keyword lore entry" }, 1)
        ],
        { name: `Seam book ${key}` }
      ).document
    )
    const note = yield* create("note", `Note ${key}`, {
      schema_version: 1,
      title: `Note ${key}`,
      content: `NOTE ${key}`,
      placement: { mode: "depth", depth: 0, role: "system" },
      owner: { chat: chat.id },
      exportable: false,
      interval: 1
    })
    const state = (data: StateEventData) =>
      writer.AddStateEvent({ userId: me.id, chatId: chat.id, slotId: null, versionId: null, scope: null, data })
    yield* state({ key: "note.activate", value: { note: note.entityId } })
    yield* state({ key: "lorebook.attach", value: { ref: book.ref.id } })
    if (duplicateBook) {
      const duplicate = yield* create(
        "lorebook",
        "Another entity",
        loreBook([loreEntry({ constant: true, content: "Distinct second book text" })], { name: `Seam book ${key}` })
          .document
      )
      yield* state({ key: "lorebook.attach", value: { ref: duplicate.ref.id } })
    }
    if (failBeforeCapture) {
      const registry = yield* ProviderRegistry
      yield* registry.transforms.register({
        id: "seam-failure",
        appliesTo: () => true,
        transform: () => {
          throw Error("synthetic transform failure")
        }
      })
    }
    const current = yield* api.GetChat({ chatId: chat.id })
    const { entry } = yield* posted(
      api.Generate({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false })
    )
    yield* eventually(() => finished(events, entry.version.id) !== undefined)
    const run = yield* api.GetRunContext({ versionId: entry.version.id })
    const rows = yield* readPayloads(config.dataDir)
    const row = rows.find(
      (r) => (JSON.parse(r.context_snapshot_json) as ContextSnapshot).inputs.versionId === entry.version.id
    )!
    return { api, writer, reader, me, chat, entry, run, row, mock, book, note }
  })
}
const scenario = <E>(
  check: (data: Effect.Success<ReturnType<typeof setupScenario>>) => Effect.Effect<void, E>,
  failBeforeCapture = false,
  duplicateBook = false
) => {
  const config = testConfig()
  return setupScenario(config, failBeforeCapture, duplicateBook).pipe(
    Effect.flatMap(check),
    Effect.scoped,
    Effect.provide(Layer.merge(serverLayer(config), ProviderBuiltins.layer))
  )
}

it.live("lore/note content redaction, final digests, exact replay, and bin inspector guards", () =>
  scenario(({ api, reader, me, entry, run, row, mock }) =>
    Effect.gen(function* () {
      assert.isTrue(run.messages.some((m) => m.content.includes("LORE [redacted]")))
      assert.isTrue(run.messages.some((m) => m.content.includes("NOTE [redacted]")))
      assert.isFalse(run.messages.some((m) => m.content.includes(key)))
      assert.equal(run.capture, "captured")
      assert.notInclude(JSON.stringify(run), "digest")
      const sent = JSON.parse(row.sent_context_json!) as WireContext
      const actual = mock.requests().at(-1)!.body!.messages as Array<{
        role: "system" | "user" | "assistant"
        content: string
      }>
      assert.deepStrictEqual(
        sent.messages.map((m) => m.digest),
        actual.map(wireDigest)
      )
      const snapshot: ContextSnapshot = { ...(JSON.parse(row.context_snapshot_json) as ContextSnapshot), wire: sent }
      const rebuilt = yield* reader.RebuildContext({ userId: me.id, snapshot: JSON.stringify(snapshot) })
      if (rebuilt._tag !== "Rebuilt") return yield* Effect.die(new Error("expected current snapshot replay"))
      assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), snapshot)
      const item = yield* api.DeleteMessage({ slotId: entry.slotId })
      assert.equal(yield* outcome(api.GetRunContext({ versionId: entry.version.id })), "NotFound")
      yield* api.RestoreBinItem({ itemId: item.id })
      assert.deepStrictEqual(yield* api.GetRunContext({ versionId: entry.version.id }), run)
    })
  )
)
it.live("inspector scrubs lore/note source labels with the request inventory", () =>
  scenario(({ run, writer, me, note, api, entry }) =>
    Effect.gen(function* () {
      assert.notInclude(JSON.stringify(run), key)
      yield* writer.RenameRef({
        userId: me.id,
        refId: note.ref.id,
        label: "Renamed after capture",
        subtitle: "",
        expectedRowVersion: note.ref.rowVersion
      })
      yield* writer.AddStateEvent({
        userId: me.id,
        chatId: run.chatId,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "note.deactivate", value: { note: note.entityId } }
      })
      assert.deepStrictEqual(yield* api.GetRunContext({ versionId: entry.version.id }), run)
    })
  )
)
it.live("inspector exposes activation reasons for every activated lore entry and note", () =>
  scenario(({ run, row }) =>
    Effect.sync(() => {
      const snapshot = JSON.parse(row.context_snapshot_json) as ContextSnapshot
      const lore = snapshot.pieces.filter(
        (p) => p.source.kind === "lorebook" && p.source.activation.status === "activated"
      )
      assert.lengthOf(lore, 2)
      const sources = run.messages.flatMap((m) => m.sources)
      assert.isTrue(sources.some((s) => s.kind === "lorebook" && s.label.includes("entry 0")))
      assert.isTrue(sources.some((s) => s.kind === "note"))

      assert.deepStrictEqual(
        sources.filter((s) => s.kind === "lorebook").map((s) => s.activation),
        [
          { kind: "lorebook", status: "activated", step: 0, why: { kind: "constant" } },
          {
            kind: "lorebook",
            status: "activated",
            step: 0,
            why: { kind: "keys", primaryKey: "[redacted]", secondaryKeys: [] }
          }
        ]
      )
      assert.deepStrictEqual(sources.find((s) => s.kind === "note")!.activation, {
        kind: "note",
        activation: "explicit",
        interval: 1,
        userMessages: null,
        due: true
      })
    })
  )
)

it.live("a pre-capture provider failure returns an unavailable projection", () =>
  scenario(
    ({ run, row }) =>
      Effect.sync(() => {
        assert.equal(run.status, "failed")
        assert.isNull(row.sent_context_json)

        assert.equal(run.capture, "unavailable")
        assert.deepStrictEqual(run.messages, [])
        assert.notInclude(JSON.stringify(run), key)
      }),
    true
  )
)

it.live("distinct lorebooks with equal names and entry UIDs retain distinct inspector sources", () =>
  scenario(
    ({ run, row }) =>
      Effect.sync(() => {
        const snapshot = JSON.parse(row.context_snapshot_json) as ContextSnapshot
        const pieceSources = snapshot.pieces.filter(
          (p) => p.source.kind === "lorebook" && p.source.activation.status === "activated"
        )
        assert.lengthOf(pieceSources, 3)
        const message = run.messages.find((m) => m.content.includes("Distinct second book text"))!
        assert.include(message.content, "LORE [redacted]")
        const shown = message.sources.filter((s) => s.kind === "lorebook")

        assert.lengthOf(shown, 3)
        assert.equal(new Set(shown.map((s) => s.id)).size, 3)
        assert.equal(new Set(shown.map((s) => s.label)).size, 2)
      }),
    false,
    true
  )
)
