// Connections, models and the usage ledger (spec/PROVIDERS.md), through the real workers.
import { assert, describe, it } from "@effect/vitest"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { type ConnectionId, type ConnectionSettings, type CredentialId, resolveModel } from "@rp/shared/providers.ts"
import { type LlmRequest, type LlmRequestId, unknownCounts } from "@rp/shared/usage.ts"
import { Effect, Exit } from "effect"
import * as Database from "../src/db/Database.ts"
import { tempDir } from "./support/tempDir.ts"

const database = () =>
  Database.layer({
    dataDir: tempDir("providers"),
    readers: 1,
    allowNetworkFs: false,
    workers: "source"
  })

const settings = (name = "Local"): ConnectionSettings => ({
  name,
  baseUrl: "http://127.0.0.1:8081/v1",
  compat: {},
  cacheTtlS: null,
  maxConcurrent: null,
  presetOverrideRefId: null
})

const bytes = (text: string) => new TextEncoder().encode(text)

const setup = Effect.gen(function* () {
  const writer = yield* Database.Writer
  const reader = yield* Database.Reader
  const ana = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id
  const bo = (yield* writer.EnsureUser({ handle: "bo", displayName: "Bo" })).id
  const create = (userId: UserId, name?: string) =>
    writer.CreateConnection({
      userId,
      connectionId: uuidv7() as ConnectionId,
      kind: "openai-chat",
      api: "openai-completions",
      settings: settings(name),
      credential: { existing: null }
    })
  return { writer, reader, ana, bo, create }
})

const fails = <A, E, R>(effect: Effect.Effect<A, E, R>, tag: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    assert.isTrue(Exit.isFailure(exit), `expected ${tag}`)
    if (Exit.isFailure(exit)) assert.include(JSON.stringify(exit.cause), tag)
  })

describe("connections", () => {
  it.effect("are visible to their owner only", () =>
    Effect.gen(function* () {
      const { writer, reader, ana, bo, create } = yield* setup
      const conn = yield* create(ana)
      assert.strictEqual(conn.api, "openai-completions")
      assert.deepStrictEqual(
        (yield* reader.ListConnections({ userId: ana })).map((c) => c.id),
        [conn.id]
      )
      assert.deepStrictEqual(yield* reader.ListConnections({ userId: bo }), [])
      // Every operation on someone else's connection is NotFound, so it isn't even confirmed to exist.
      yield* fails(reader.GetConnection({ userId: bo, connectionId: conn.id }), "NotFound")
      yield* fails(reader.ResolveConnection({ userId: bo, connectionId: conn.id }), "NotFound")
      yield* fails(reader.ListModels({ userId: bo, connectionId: conn.id, includeHidden: true }), "NotFound")
      yield* fails(
        writer.SetConnectionCredential({ userId: bo, connectionId: conn.id, credentialId: null }),
        "NotFound"
      )
      yield* fails(
        writer.UpdateConnection({ userId: bo, connectionId: conn.id, settings: settings("x"), expectedRowVersion: 1 }),
        "NotFound"
      )
      yield* fails(writer.DeleteConnection({ userId: bo, connectionId: conn.id }), "NotFound")
      yield* fails(
        writer.SyncFetchedModels({ userId: bo, connectionId: conn.id, models: [], fetchedAt: 1 }),
        "NotFound"
      )
      yield* fails(writer.AddUserModel({ userId: bo, connectionId: conn.id, key: "m", overrides: {} }), "NotFound")
      const model = yield* writer.AddUserModel({ userId: ana, connectionId: conn.id, key: "m", overrides: {} })
      yield* fails(reader.GetModel({ userId: bo, modelId: model.id }), "NotFound")
      yield* fails(
        writer.EditModel({ userId: bo, modelId: model.id, overrides: {}, expectedRowVersion: 1 }),
        "NotFound"
      )
      yield* fails(writer.SetModelHidden({ userId: bo, modelId: model.id, hidden: true }), "NotFound")
    }).pipe(Effect.provide(database()))
  )

  it.effect("credentials are their owner's alone", () =>
    Effect.gen(function* () {
      const { writer, reader, ana, bo, create } = yield* setup
      const credential = yield* writer.CreateCredential({
        userId: ana,
        credentialId: uuidv7() as CredentialId,
        name: "Ana's key",
        key: { enc: bytes("x"), hint: "abcd" },
        origins: []
      })
      const bos = yield* create(bo)
      assert.deepStrictEqual(yield* reader.ListCredentials({ userId: bo }), [])
      yield* fails(reader.ResolveCredential({ userId: bo, credentialId: credential.id }), "NotFound")
      yield* fails(
        writer.SetConnectionCredential({ userId: bo, connectionId: bos.id, credentialId: credential.id }),
        "NotFound"
      )
      yield* fails(
        writer.CreateConnection({
          userId: bo,
          connectionId: uuidv7() as ConnectionId,
          kind: "openai-chat",
          api: "openai-completions",
          settings: settings("Bo's"),
          credential: { existing: credential.id }
        }),
        "NotFound"
      )
      yield* fails(writer.RenameCredential({ userId: bo, credentialId: credential.id, name: "mine" }), "NotFound")
      yield* fails(
        writer.ReplaceCredentialKey({
          userId: bo,
          credentialId: credential.id,
          key: { enc: bytes("y"), hint: "efgh" },
          origins: []
        }),
        "NotFound"
      )
      yield* fails(
        writer.AddCredentialOrigin({ userId: bo, credentialId: credential.id, origin: "https://evil.example" }),
        "NotFound"
      )
      yield* fails(writer.DeleteCredential({ userId: bo, credentialId: credential.id }), "NotFound")
    }).pipe(Effect.provide(database()))
  )

  it.effect("keep secrets write-only: only a hint and header names come back", () =>
    Effect.gen(function* () {
      const { writer, reader, ana, create } = yield* setup
      const conn = yield* create(ana)
      const credential = yield* writer.CreateCredential({
        userId: ana,
        credentialId: uuidv7() as CredentialId,
        name: "Local key",
        key: { enc: bytes("ciphertext"), hint: "1234" },
        origins: ["http://127.0.0.1:8081"]
      })
      const keyed = yield* writer.SetConnectionCredential({
        userId: ana,
        connectionId: conn.id,
        credentialId: credential.id
      })
      assert.isTrue(keyed.hasKey)
      assert.strictEqual(keyed.keyHint, "1234")
      assert.strictEqual(keyed.credentialName, "Local key")
      assert.strictEqual(keyed.rowVersion, conn.rowVersion + 1)
      const headed = yield* writer.SetConnectionHeaders({
        userId: ana,
        connectionId: conn.id,
        expectedRowVersion: keyed.rowVersion,
        headers: { enc: bytes("header ciphertext"), names: ["X-Gateway-Token"], origin: "https://gw.example" }
      })
      assert.deepStrictEqual(headed.headerNames, ["X-Gateway-Token"])
      const listed = JSON.stringify(yield* reader.ListConnections({ userId: ana }))
      assert.notInclude(listed, "ciphertext")
      // The provider layer gets the ciphertext, to decrypt on the main thread.
      const resolved = yield* reader.ResolveConnection({ userId: ana, connectionId: conn.id })
      assert.strictEqual(new TextDecoder().decode(resolved.credential!.keyEnc), "ciphertext")
      assert.deepStrictEqual(resolved.credential!.origins, ["http://127.0.0.1:8081"])
      assert.notInclude(JSON.stringify(yield* reader.ListCredentials({ userId: ana })), "ciphertext")
      const cleared = yield* writer.SetConnectionCredential({ userId: ana, connectionId: conn.id, credentialId: null })
      assert.isFalse(cleared.hasKey)
      assert.isNull(cleared.keyHint)
    }).pipe(Effect.provide(database()))
  )

  it.effect("store a proxy URL only for a custom proxy", () =>
    Effect.gen(function* () {
      const { writer, reader, ana, create } = yield* setup
      const conn = yield* create(ana)
      const direct = yield* writer.SetConnectionProxy({
        userId: ana,
        connectionId: conn.id,
        mode: "direct",
        urlEnc: bytes("ignored")
      })
      assert.strictEqual(direct.proxyMode, "direct")
      assert.isNull((yield* reader.ResolveConnection({ userId: ana, connectionId: conn.id })).proxyUrlEnc)
      yield* writer.SetConnectionProxy({ userId: ana, connectionId: conn.id, mode: "custom", urlEnc: bytes("socks") })
      assert.isNotNull((yield* reader.ResolveConnection({ userId: ana, connectionId: conn.id })).proxyUrlEnc)
    }).pipe(Effect.provide(database()))
  )

  it.effect("refuse a stale settings update", () =>
    Effect.gen(function* () {
      const { writer, ana, create } = yield* setup
      const conn = yield* create(ana)
      const renamed = yield* writer.UpdateConnection({
        userId: ana,
        connectionId: conn.id,
        settings: settings("Renamed"),
        expectedRowVersion: conn.rowVersion
      })
      assert.strictEqual(renamed.name, "Renamed")
      yield* fails(
        writer.UpdateConnection({
          userId: ana,
          connectionId: conn.id,
          settings: settings("Stale tab"),
          expectedRowVersion: conn.rowVersion
        }),
        "StaleWrite"
      )
    }).pipe(Effect.provide(database()))
  )

  it.effect("go through the recycle bin, and a purge keeps a tombstone without secrets", () =>
    Effect.gen(function* () {
      const { writer, reader, ana, create } = yield* setup
      const conn = yield* create(ana)
      const credential = yield* writer.CreateCredential({
        userId: ana,
        credentialId: uuidv7() as CredentialId,
        name: "k",
        key: { enc: bytes("k"), hint: "abcd" },
        origins: []
      })
      yield* writer.SetConnectionCredential({ userId: ana, connectionId: conn.id, credentialId: credential.id })
      const item = yield* writer.DeleteConnection({ userId: ana, connectionId: conn.id })
      assert.strictEqual(item.kind, "connection")
      assert.strictEqual(item.title, "Local")
      assert.deepStrictEqual(yield* reader.ListConnections({ userId: ana }), [])
      yield* writer.RestoreBinItem({ userId: ana, itemId: item.id })
      assert.isTrue((yield* reader.GetConnection({ userId: ana, connectionId: conn.id })).hasKey)

      const again = yield* writer.DeleteConnection({ userId: ana, connectionId: conn.id })
      yield* writer.PurgeBinItem({ userId: ana, itemId: again.id })
      yield* fails(reader.GetConnection({ userId: ana, connectionId: conn.id }), "NotFound")
    }).pipe(Effect.provide(database()))
  )
})

describe("review regressions", () => {
  it.effect("refuses another user's preset as an override, without confirming it exists", () =>
    Effect.gen(function* () {
      const { writer, ana, bo, create } = yield* setup
      const preset = yield* writer.CreateEntity({
        userId: ana,
        kind: "preset",
        label: "Ana's preset",
        subtitle: "",
        doc: {},
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const borrowed = { ...settings("Bo's"), presetOverrideRefId: preset.ref.id }
      yield* fails(
        writer.CreateConnection({
          userId: bo,
          connectionId: uuidv7() as ConnectionId,
          kind: "openai-chat",
          api: "openai-completions",
          settings: borrowed,
          credential: { existing: null }
        }),
        "NotFound"
      )
      // A ref id that doesn't exist looks exactly the same.
      yield* fails(
        writer.CreateConnection({
          userId: bo,
          connectionId: uuidv7() as ConnectionId,
          kind: "openai-chat",
          api: "openai-completions",
          settings: { ...borrowed, presetOverrideRefId: preset.ref.id.replace(/.$/, "0") as typeof preset.ref.id },
          credential: { existing: null }
        }),
        "NotFound"
      )
      const bos = yield* create(bo)
      yield* fails(
        writer.UpdateConnection({
          userId: bo,
          connectionId: bos.id,
          settings: borrowed,
          expectedRowVersion: bos.rowVersion
        }),
        "NotFound"
      )
      // Ana may use her own.
      const anas = yield* writer.CreateConnection({
        userId: ana,
        connectionId: uuidv7() as ConnectionId,
        kind: "openai-chat",
        api: "openai-completions",
        settings: { ...settings("Ana's"), presetOverrideRefId: preset.ref.id },
        credential: { existing: null }
      })
      assert.strictEqual(anas.presetOverrideRefId, preset.ref.id)
    }).pipe(Effect.provide(database()))
  )

  it.effect("syncs a model list that repeats a key", () =>
    Effect.gen(function* () {
      const { writer, reader, ana, create } = yield* setup
      const conn = yield* create(ana)
      const result = yield* writer.SyncFetchedModels({
        userId: ana,
        connectionId: conn.id,
        models: [
          { key: "m", upstream: { name: "first" } },
          { key: "m", upstream: { name: "second" } }
        ],
        fetchedAt: 1
      })
      assert.deepStrictEqual(result, { added: 1, updated: 0, missing: 0 })
      const [model] = yield* reader.ListModels({ userId: ana, connectionId: conn.id, includeHidden: true })
      assert.strictEqual(model!.upstream.name, "second")
    }).pipe(Effect.provide(database()))
  )

  it.effect("pages the ledger without skipping requests that started in the same millisecond", () =>
    Effect.gen(function* () {
      const { writer, reader, ana, create } = yield* setup
      const conn = yield* create(ana)
      for (const id of ["a", "b", "c"]) {
        yield* writer.OpenLlmRequest({
          userId: ana,
          request: {
            id: id as LlmRequestId,
            connectionId: conn.id,
            modelId: null,
            chatId: null,
            rolloutId: null,
            versionId: null,
            purpose: "decision",
            api: "openai-completions",
            provider: "openai",
            modelKey: "m",
            startedAt: 5_000
          }
        })
      }
      const seen: Array<string> = []
      let before: { startedAt: number; id: string } | null = null
      for (let page = 0; page < 5; page++) {
        const rows: ReadonlyArray<LlmRequest> = yield* reader.ListLlmRequests({ userId: ana, limit: 1, before })
        if (rows.length === 0) break
        seen.push(rows[0]!.id)
        before = { startedAt: rows[0]!.startedAt, id: rows[0]!.id }
      }
      assert.deepStrictEqual(seen, ["c", "b", "a"])
    }).pipe(Effect.provide(database()))
  )
})

describe("models", () => {
  it.effect("sync from a fetched list without ever touching user edits or deleting rows", () =>
    Effect.gen(function* () {
      const { writer, reader, ana, create } = yield* setup
      const conn = yield* create(ana)
      const first = yield* writer.SyncFetchedModels({
        userId: ana,
        connectionId: conn.id,
        models: [
          { key: "alpha", upstream: { name: "Alpha", context: 32_000 } },
          { key: "beta", upstream: { context: 8_000 } }
        ],
        fetchedAt: 100
      })
      assert.deepStrictEqual(first, { added: 2, updated: 0, missing: 0 })
      const manual = yield* writer.AddUserModel({
        userId: ana,
        connectionId: conn.id,
        key: "hand-added",
        overrides: { context: 4_096 }
      })
      yield* fails(
        writer.AddUserModel({ userId: ana, connectionId: conn.id, key: "alpha", overrides: {} }),
        "ModelKeyTaken"
      )

      const [alpha] = (yield* reader.ListModels({ userId: ana, connectionId: conn.id, includeHidden: false })).filter(
        (m) => m.key === "alpha"
      )
      const edited = yield* writer.EditModel({
        userId: ana,
        modelId: alpha!.id,
        overrides: { context: 64_000, vision: true },
        expectedRowVersion: alpha!.rowVersion
      })
      yield* fails(
        writer.EditModel({ userId: ana, modelId: alpha!.id, overrides: {}, expectedRowVersion: alpha!.rowVersion }),
        "StaleWrite"
      )

      // The next refresh reports new upstream data for alpha and drops beta.
      const second = yield* writer.SyncFetchedModels({
        userId: ana,
        connectionId: conn.id,
        models: [{ key: "alpha", upstream: { name: "Alpha 2", context: 128_000 } }],
        fetchedAt: 200
      })
      assert.deepStrictEqual(second, { added: 0, updated: 1, missing: 1 })
      const models = yield* reader.ListModels({ userId: ana, connectionId: conn.id, includeHidden: false })
      const byKey = new Map(models.map((m) => [m.key, m]))
      assert.deepStrictEqual(byKey.get("alpha")!.overrides, edited.overrides)
      assert.strictEqual(byKey.get("alpha")!.upstream.name, "Alpha 2")
      assert.strictEqual(byKey.get("beta")!.missingSince, 200)
      // A model only ever added by hand was never listed, so it isn't missing.
      assert.isNull(byKey.get("hand-added")!.missingSince)
      assert.strictEqual(byKey.get("hand-added")!.id, manual.id)

      const effective = resolveModel("alpha", byKey.get("alpha")!.upstream, byKey.get("alpha")!.overrides)
      assert.deepStrictEqual(effective.context, { value: 64_000, source: "user" })
      assert.deepStrictEqual(effective.name, { value: "Alpha 2", source: "upstream" })
      assert.deepStrictEqual(effective.tools, { value: false, source: "unknown" })

      yield* writer.SetModelHidden({ userId: ana, modelId: byKey.get("beta")!.id, hidden: true })
      const visible = yield* reader.ListModels({ userId: ana, connectionId: conn.id, includeHidden: false })
      assert.notInclude(
        visible.map((m) => m.key),
        "beta"
      )
    }).pipe(Effect.provide(database()))
  )
})

describe("usage ledger", () => {
  it.effect("records a request from open to close, and a crash leaves it interrupted, never missing", () =>
    Effect.gen(function* () {
      const { writer, reader, ana, bo, create } = yield* setup
      const conn = yield* create(ana)
      const card = yield* writer.CreateEntity({
        userId: ana,
        kind: "card",
        label: "Mira",
        subtitle: "",
        doc: {},
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const chat = yield* writer.CreateChat({
        userId: ana,
        kind: "rp",
        status: "active",
        title: "Harbor",
        participants: [card.entityId],
        greeting: null
      })
      const open = (id: string, chatId: typeof chat.id | null = chat.id, userId = ana) =>
        writer.OpenLlmRequest({
          userId,
          request: {
            id: id as LlmRequestId,
            connectionId: conn.id,
            modelId: null,
            chatId,
            rolloutId: null,
            versionId: null,
            purpose: "generation",
            api: "openai-completions",
            provider: "openai",
            modelKey: "alpha",
            startedAt: 1_000
          }
        })
      yield* open("r1")
      yield* writer.CloseLlmRequest({
        userId: ana,
        request: {
          id: "r1" as LlmRequestId,
          status: "complete",
          endedAt: 2_000,
          firstTokenAt: 1_200,
          responseModel: "alpha-2026",
          upstream: null,
          counts: { ...unknownCounts, inputUncached: 10, cacheRead: 990, output: 50 },
          usageSource: "reported",
          rawUsage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 990 } },
          reportedCost: null,
          cost: { amount: 0.0012, currency: "USD", formula: "builtin:pi-ai" },
          error: null
        }
      })
      yield* open("r2")
      // Another user can neither use this connection nor attribute to this chat.
      yield* fails(open("r3", null, bo), "NotFound")

      assert.deepStrictEqual(yield* writer.InterruptRunningLlmRequests(), { interrupted: 1 })
      const [r2, r1] = yield* reader.ListLlmRequests({ userId: ana, limit: 10, before: null })
      assert.strictEqual(r1!.status, "complete")
      assert.strictEqual(r1!.counts.cacheRead, 990)
      assert.isNull(r1!.counts.cacheWrite)
      assert.deepStrictEqual(r1!.cost, { amount: 0.0012, currency: "USD", formula: "builtin:pi-ai" })
      assert.strictEqual(r2!.status, "interrupted")
      assert.strictEqual(r2!.usageSource, "none")
      assert.deepStrictEqual(yield* reader.ListLlmRequests({ userId: bo, limit: 10, before: null }), [])
    }).pipe(Effect.provide(database()))
  )
})
