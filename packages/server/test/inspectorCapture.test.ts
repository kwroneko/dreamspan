import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Worker } from "node:worker_threads"
import { wireDigest } from "../src/assembler/wire.ts"
import { Reader } from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { ProviderRegistry } from "../src/providers/registry.ts"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import { client, serverLayer, testConfig, posted } from "./support/config.ts"
import { generateReply, eventually, finished } from "./support/generation.ts"
import { startMockProvider, sse, completionChunks } from "./support/mockProvider.ts"
import { startHttpProxy } from "./support/proxies.ts"
type Message = { role: string; content: string; name?: string }

const resource = <A extends { close: () => Promise<void> }>(start: () => Promise<A>) =>
  Effect.acquireRelease(Effect.promise(start), (r) => Effect.promise(() => r.close()))
const provider = () =>
  resource(() =>
    startMockProvider((_r, res) =>
      sse(
        res,
        completionChunks(["Synthetic answer."], {
          prompt_tokens: 120,
          completion_tokens: 6,
          prompt_tokens_details: { cached_tokens: 100 }
        })
      )
    )
  )

const savedContexts = (dataDir: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        const worker = new Worker(
          `const {parentPort,workerData}=require('node:worker_threads'); const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(workerData,{readOnly:true}); try { parentPort.postMessage(JSON.stringify(db.prepare('SELECT sent_context_json FROM rollout_payloads').all())) } finally { db.close() }`,
          { eval: true, workerData: databaseFile(dataDir) }
        )
        let value = ""
        worker.once("message", (message) => {
          value = message
        })
        worker.once("error", reject)
        worker.once("exit", (code) =>
          code === 0 ? resolve(value) : reject(new Error(`fixture worker exited ${code}`))
        )
      })
  )

it.live("review: unchanged prefix stays warm with an ordinary short header value", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* provider()
    const api = yield* client()
    const { chat, connection, events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: mock.url + "/v1", cacheTtlS: 300 },
      model: {}
    })
    yield* api.SetConnectionHeaders({
      connectionId: connection.id,
      expectedRowVersion: connection.rowVersion,
      headers: { "Accept-Language": "en" }
    })
    const current = yield* api.GetChat({ chatId: chat.id })
    const { entry } = yield* posted(
      api.Generate({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false })
    )
    yield* eventually(() => finished(events, entry.version.id) !== undefined)
    const me = yield* api.Whoami()
    const warmth = yield* (yield* Reader).CacheWarmth({ userId: me.id, chatId: chat.id })
    const run = yield* api.GetRunContext({ versionId: entry.version.id })
    assert.include(run.messages.map((m) => m.content).join(" "), "[redacted]")
    assert.notInclude(JSON.stringify(run), "digest")
    const previousSent = mock.requests().at(-1)!.body!.messages as Message[]
    const again = yield* api.GetChat({ chatId: chat.id })
    const third = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: again.activeLeafSlotId, branch: false }))
    yield* eventually(() => finished(events, third.entry.version.id) !== undefined)
    const nextSent = mock.requests().at(-1)!.body!.messages as Message[]
    assert.deepEqual(
      nextSent.slice(0, previousSent.length),
      previousSent,
      "actual next request preserves every message in the previous prefix"
    )
    assert.isNull(warmth?.changed)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("review: final capture excludes transport fields and scrubs all request secrets", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* provider()
    const proxy = yield* resource(startHttpProxy)
    const api = yield* client()
    const registry = yield* ProviderRegistry
    const password = "synthetic-instance-proxy password"
    const username = "synthetic-instance-proxy user"
    const proxyUrl = proxy.url.replace(
      "http://",
      "http://" + encodeURIComponent(username) + ":" + encodeURIComponent(password) + "@"
    )
    const proxyValues = [
      proxyUrl,
      new URL(proxyUrl).href,
      username,
      password,
      encodeURIComponent(username),
      encodeURIComponent(password),
      Buffer.from(username + ":" + password).toString("base64")
    ]
    yield* api.SetNetworkSettings({ proxyUrl, bypass: [], forceProxy: false })
    const key = "sk-synthetic-final-key"
    const headers = { "x-api-key": "synthetic-header-token", "x-gateway-secret": "synthetic-second-header" }
    const { chat, connection, events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: mock.url + "/v1", apiKey: key },
      model: {}
    })
    yield* api.SetConnectionHeaders({ connectionId: connection.id, expectedRowVersion: connection.rowVersion, headers })
    const secretValues = [key, ...Object.values(headers), ...proxyValues]
    yield* registry.transforms.register({
      id: "review-final-secret-echo",
      appliesTo: (t) => t.api === "openai-completions",
      transform: (p) => ({
        ...p,
        headers: { authorization: key },
        api_key: key,
        proxy: { url: proxyUrl },
        private_field: password,
        messages: (p.messages as Message[]).map((m, i) =>
          i === 0 ? { ...m, name: key, content: m.content + " " + secretValues.join(" ") } : m
        )
      })
    })
    const current = yield* api.GetChat({ chatId: chat.id })
    const { entry } = yield* posted(
      api.Generate({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false })
    )
    yield* eventually(() => finished(events, entry.version.id) !== undefined)
    const version = finished(events, entry.version.id)!
    assert.equal(version.status, "complete")
    assert.isAbove(proxy.tunnels().length, 0)
    const run = yield* api.GetRunContext({ versionId: version.id })
    const stored = yield* savedContexts(config.dataDir)
    const saved = (JSON.parse(stored) as Array<{ sent_context_json: string }>).at(-1)!.sent_context_json
    const parsed = JSON.parse(saved)
    assert.deepEqual(Object.keys(parsed).sort(), ["cache", "display", "mapping", "messages", "samplers"])
    assert.deepEqual(parsed.cache, { ttlS: null, fixed: false, source: null })
    assert.isUndefined((run as unknown as Record<string, unknown>).cache)
    const actual = mock.requests().at(-1)!.body!.messages as Message[]
    assert.equal(parsed.messages[0].digest, wireDigest(actual[0]! as Parameters<typeof wireDigest>[0]))
    assert.notInclude(JSON.stringify(run), parsed.messages[0].digest)
    assert.notInclude(saved, key)
    assert.notInclude(saved, "authorization")
    assert.notInclude(saved, "private_field")
    for (const value of secretValues) {
      assert.notInclude(saved, value)
      assert.notInclude(JSON.stringify(run), value)
    }
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), ProviderBuiltins.layer)))
})

it.live("review: inserted provider messages do not steal source labels from unchanged messages", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* provider()
    const api = yield* client()
    const registry = yield* ProviderRegistry
    yield* registry.transforms.register({
      id: "review-prefix-insertion",
      appliesTo: (t) => t.api === "openai-completions",
      transform: (p) => ({
        ...p,
        messages: [{ role: "system", content: "Independent transform instructions." }, ...(p.messages as Message[])]
      })
    })
    const { version, chat } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: mock.url + "/v1", cacheTtlS: 300 },
      model: {}
    })
    const run = yield* api.GetRunContext({ versionId: version.id })
    const me = yield* api.Whoami()
    const warmth = yield* (yield* Reader).CacheWarmth({ userId: me.id, chatId: chat.id })
    assert.isNotNull(warmth!.changed, "unassigned transform messages still participate in prefix comparison")
    assert.deepEqual(run.messages[0]!.sources, [])
    const card = run.messages.find((m) => m.content.includes("keeps the ledger"))!
    assert.isTrue(card.sources.some((s) => s.label.includes("Mira") && s.label.includes("description")))
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), ProviderBuiltins.layer)))
})

it.live("review: custom proxy credentials are scrubbed from the final stored projection", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* provider()
    const proxy = yield* resource(startHttpProxy)
    const api = yield* client()
    const registry = yield* ProviderRegistry
    const { chat, connection, events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: mock.url + "/v1" },
      model: {}
    })
    const password = "synthetic-custom-proxy password"
    const username = "synthetic-custom-proxy user"
    const proxyUrl = proxy.url.replace(
      "http://",
      "http://" + encodeURIComponent(username) + ":" + encodeURIComponent(password) + "@"
    )
    const proxyValues = [
      proxyUrl,
      new URL(proxyUrl).href,
      username,
      password,
      encodeURIComponent(username),
      encodeURIComponent(password),
      Buffer.from(username + ":" + password).toString("base64")
    ]
    yield* api.SetConnectionProxy({ connectionId: connection.id, mode: "custom", url: proxyUrl })
    yield* registry.transforms.register({
      id: "review-custom-proxy-echo",
      appliesTo: (t) => t.api === "openai-completions",
      transform: (p) => ({
        ...p,
        headers: { "proxy-authorization": password },
        proxy: { url: proxyUrl },
        messages: (p.messages as Message[]).map((m, i) =>
          i === 0 ? { ...m, name: password, content: m.content + " " + proxyValues.join(" ") } : m
        )
      })
    })
    const current = yield* api.GetChat({ chatId: chat.id })
    const { entry } = yield* posted(
      api.Generate({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false })
    )
    yield* eventually(() => finished(events, entry.version.id) !== undefined)
    assert.equal(finished(events, entry.version.id)!.status, "complete")
    assert.isAbove(proxy.tunnels().length, 0)
    const run = yield* api.GetRunContext({ versionId: entry.version.id })
    const saved = yield* savedContexts(config.dataDir)
    for (const value of [...proxyValues, "proxy-authorization"]) {
      assert.notInclude(saved, value)
      assert.notInclude(JSON.stringify(run), value)
    }
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), ProviderBuiltins.layer)))
})
