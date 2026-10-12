import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { vi } from "vitest"
import { writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { setGlobalProxyFromEnv } from "node:http"
import { databaseFile } from "../src/db/connection.ts"
import { ProviderRegistry } from "../src/providers/registry.ts"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import { client, serverLayer, testConfig, posted } from "./support/config.ts"
import { generateReply, eventually, finished } from "./support/generation.ts"
import { startMockProvider, sse, completionChunks, json } from "./support/mockProvider.ts"
import { startHttpProxy } from "./support/proxies.ts"
// Audited in pinned pi-ai, OpenAI, Anthropic and Google sources; see ARCHITECTURE §6.
const SDK_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_CUSTOM_HEADERS",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "OPENAI_WEBHOOK_SECRET",
  "OPENAI_LOG",
  "OPENAI_API_VERSION",
  "AZURE_OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_WEBHOOK_SIGNING_KEY",
  "ANTHROPIC_LOG",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_SCOPE",
  "ANTHROPIC_ENVIRONMENT_ID",
  "ANTHROPIC_ENVIRONMENT_KEY",
  "ANTHROPIC_SESSION_ID",
  "ANTHROPIC_WORK_ID",
  "ANTHROPIC_WORK_SECRET",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_BEDROCK_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GOOGLE_GENAI_ACCESS_TOKEN",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_ENTERPRISE",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_VERTEX_BASE_URL",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_GENAI_DEBUG",
  "GOOGLE_SDK_NODE_LOGGING",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "google_application_credentials",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GCLOUD_PROJECT",
  "gcloud_project",
  "google_cloud_project",
  "CLOUDSDK_CONFIG",
  "PI_CACHE_RETENTION"
] as const

const resource = <A extends { close: () => Promise<void> }>(start: () => Promise<A>) =>
  Effect.acquireRelease(Effect.promise(start), (r) => Effect.promise(() => r.close()))
const response = (_r: unknown, res: Parameters<typeof sse>[0]) =>
  sse(res, completionChunks(["Synthetic answer."], { prompt_tokens: 120, completion_tokens: 6 }))
const googleResponse = (_r: unknown, res: Parameters<typeof sse>[0]) =>
  sse(
    res,
    [
      {
        candidates: [{ content: { role: "model", parts: [{ text: "Synthetic answer" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 }
      }
    ],
    { done: false }
  )
const echo = (registry: import("../src/providers/registry.ts").ProviderRegistryShape, values: string[]) =>
  registry.transforms.register({
    id: "inventory-echo",
    appliesTo: () => true,
    transform: (p) => ({
      ...p,
      messages: (p.messages as Array<{ role: string; content: string }>).map((m, i) =>
        i === 0 ? { ...m, content: m.content + " " + values.join(" | ") } : m
      )
    })
  })
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

for (const kind of ["openai-chat", "openai-responses", "anthropic", "google"]) {
  it.live(`${kind} ignores ambient SDK authentication, headers and routing`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource(() =>
        startMockProvider((r, res) => json(res, 401, { error: { message: "Rejected " + JSON.stringify(r.headers) } }))
      )
      const key = "synthetic-selected-key"
      const api = yield* client()
      const baseline = yield* generateReply(api, { connection: { kind, baseUrl: mock.url, apiKey: key }, model: {} })
      const baselineSent = mock.requests().at(-1)!
      const baselineRun = yield* api.GetRunContext({ versionId: baseline.version.id })
      const env = Object.fromEntries(SDK_ENV.map((name) => [name, "synthetic-env-" + name]))
      Object.assign(env, {
        OPENAI_CUSTOM_HEADERS: "Authorization: Bearer synthetic-ambient-key\nX-Ambient: synthetic-ambient-header",
        ANTHROPIC_CUSTOM_HEADERS: "x-api-key: synthetic-ambient-key",
        OPENAI_ORG_ID: "synthetic-org",
        OPENAI_PROJECT_ID: "synthetic-project",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GOOGLE_GENAI_USE_ENTERPRISE: "true",
        OPENAI_LOG: "debug",
        ANTHROPIC_LOG: "debug",
        GOOGLE_GENAI_DEBUG: "true",
        PI_CACHE_RETENTION: "long",
        ANTHROPIC_CONFIG_DIR: config.dataDir + "/no-sdk-config",
        ANTHROPIC_IDENTITY_TOKEN_FILE: config.dataDir + "/no-identity-token",
        GOOGLE_APPLICATION_CREDENTIALS: config.dataDir + "/no-google-credentials",
        google_application_credentials: config.dataDir + "/no-google-credentials",
        CLOUDSDK_CONFIG: config.dataDir + "/no-gcloud-config"
      })
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
        }),
        () => Effect.sync(() => vi.unstubAllEnvs())
      )
      const { version, events, chat } = yield* generateReply(api, {
        connection: { kind, baseUrl: mock.url, apiKey: key },
        model: {}
      })
      assert.equal(version.status, "failed")
      assert.isAbove(mock.requests().length, 0, JSON.stringify(version.error))
      const headers = mock.requests().at(-1)!.headers
      assert.equal(
        headers[kind === "anthropic" ? "x-api-key" : kind === "google" ? "x-goog-api-key" : "authorization"],
        kind.startsWith("openai") ? "Bearer " + key : key
      )
      assert.isUndefined(headers["x-ambient"])
      assert.isUndefined(headers["openai-organization"])
      assert.isUndefined(headers["openai-project"])
      assert.notInclude(JSON.stringify(mock.requests().at(-1)!.body), '"prompt_cache_retention":"24h"')
      for (const [name, value] of Object.entries(env))
        assert.equal(process.env[name], value, "SDK isolation must not mutate the host environment")
      const run = yield* api.GetRunContext({ versionId: version.id })
      const sent = mock.requests().at(-1)!
      assert.equal(sent.path, baselineSent.path, "environment must not change endpoint selection")
      assert.deepEqual(
        JSON.parse(JSON.stringify(sent.body).replaceAll(chat.id, "session")),
        JSON.parse(JSON.stringify(baselineSent.body).replaceAll(baseline.chat.id, "session")),
        "environment must not change the outgoing request"
      )
      const display = (context: typeof run) =>
        context.messages.map(({ role, name, content }) => ({ role, name, content }))
      assert.deepEqual(display(run), display(baselineRun), "environment must not change the recorded mapping")
      assert.deepEqual(run.samplers, baselineRun.samplers)

      for (const value of [
        ...Object.values(env).filter((value) => value.startsWith("synthetic-env-") || value.startsWith(config.dataDir)),
        key,
        "synthetic-ambient-key",
        "synthetic-ambient-header",
        "synthetic-org",
        "synthetic-project"
      ])
        assert.notInclude(JSON.stringify({ run, events, stored: yield* savedContexts(config.dataDir) }), value)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
}
for (const scheme of ["Bearer", "Basic"])
  it.live(`${scheme} components are scrubbed in capture and ordinary Version errors`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* resource(() => startMockProvider(response))
      const api = yield* client()
      const registry = yield* ProviderRegistry
      const username = "synthetic-basic-user",
        password = "synthetic-basic-password",
        token = "synthetic-bearer-token"
      const encoded = Buffer.from(username + ":" + password).toString("base64")
      const value = scheme === "Bearer" ? "Bearer " + token : "Basic " + encoded
      const parts = scheme === "Bearer" ? [token] : [username, password, encoded, username + ":" + password]
      const { chat, connection, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: mock.url + "/v1" },
        model: {}
      })
      yield* api.SetConnectionHeaders({
        connectionId: connection.id,
        expectedRowVersion: connection.rowVersion,
        headers: { Authorization: value }
      })
      yield* echo(registry, [value, ...parts])
      for (const fail of [false, true]) {
        if (fail) mock.setHandler((_r, res) => json(res, 401, { error: { message: "Rejected " + parts.join(" | ") } }))
        const current = yield* api.GetChat({ chatId: chat.id })
        const { entry } = yield* posted(
          api.Generate({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false })
        )
        yield* eventually(() => finished(events, entry.version.id) !== undefined)
        assert.equal(finished(events, entry.version.id)!.status, fail ? "failed" : "complete")
        const run = yield* api.GetRunContext({ versionId: entry.version.id })
        const outputs = JSON.stringify({ run, events, stored: yield* savedContexts(config.dataDir) })
        for (const part of [value, ...parts]) assert.notInclude(outputs, part)
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), ProviderBuiltins.layer)))
  })
it.live("catalog header credentials enter the inventory before capture and errors", () => {
  const config = testConfig(),
    secret = "synthetic-catalog-secret"
  return Effect.gen(function* () {
    const mock = yield* resource(() => startMockProvider(response))
    const api = yield* client()
    const registry = yield* ProviderRegistry
    const kind = registry.kinds.get("openai-chat")!
    yield* registry.kinds.register({
      ...kind,
      catalog: async () => ({
        "mock-model": {
          id: "mock-model",
          name: "Mock",
          api: "openai-completions",
          provider: "openai",
          baseUrl: mock.url,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 512,
          headers: { "x-catalog-secret": secret }
        }
      })
    })
    yield* echo(registry, [secret])
    const { version, chat, events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: mock.url + "/v1" },
      model: {}
    })
    assert.equal(version.status, "complete")
    assert.equal(mock.requests().at(-1)!.headers["x-catalog-secret"], secret)
    const run = yield* api.GetRunContext({ versionId: version.id })
    assert.notInclude(JSON.stringify({ run, stored: yield* savedContexts(config.dataDir) }), secret)
    mock.setHandler((_r, res) => json(res, 401, { error: { message: "Rejected " + secret } }))
    const current = yield* api.GetChat({ chatId: chat.id })
    const { entry } = yield* posted(
      api.Generate({ chatId: chat.id, parentSlotId: current.activeLeafSlotId, branch: false })
    )
    yield* eventually(() => finished(events, entry.version.id) !== undefined)
    assert.equal(finished(events, entry.version.id)!.status, "failed")
    assert.notInclude(JSON.stringify(events), secret)
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), ProviderBuiltins.layer)))
})
it.live("authenticated endpoint route components are scrubbed", () => {
  const config = testConfig(),
    secret = "synthetic-route-token"
  return Effect.gen(function* () {
    const mock = yield* resource(() =>
      startMockProvider((r, res) =>
        r.path.startsWith("/" + secret + "/") ? response(r, res) : json(res, 401, { error: { message: "wrong route" } })
      )
    )
    const api = yield* client()
    const registry = yield* ProviderRegistry
    const baseUrl = mock.url + "/" + secret + "/v1"
    yield* echo(registry, [secret, baseUrl])
    const { version } = yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl }, model: {} })
    assert.equal(version.status, "complete")
    const run = yield* api.GetRunContext({ versionId: version.id })
    for (const value of [secret, baseUrl])
      assert.notInclude(JSON.stringify({ run, stored: yield* savedContexts(config.dataDir) }), value)
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), ProviderBuiltins.layer)))
})
it.live("Google ignores Node's ambient proxy and uses the configured transport", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const ambient = yield* resource(startHttpProxy)
    yield* Effect.acquireRelease(
      Effect.sync(() => setGlobalProxyFromEnv({ HTTP_PROXY: ambient.url, HTTPS_PROXY: ambient.url, NO_PROXY: "" })),
      (restore) => Effect.sync(restore)
    )
    const mock = yield* resource(() => startMockProvider(googleResponse))
    const api = yield* client()
    const first = yield* generateReply(api, {
      connection: { kind: "google", baseUrl: mock.url, apiKey: "synthetic-google-key" },
      model: {}
    })
    assert.equal(first.version.status, "complete", JSON.stringify(first.version.error))
    assert.notInclude(
      ambient.tunnels(),
      new URL(mock.url).host,
      "Node environment proxy must never carry provider requests"
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("Google uses the pinned transport in a fresh Node process with environment proxies enabled", () =>
  Effect.gen(function* () {
    const mock = yield* resource(() => startMockProvider(googleResponse))
    const ambient = yield* resource(startHttpProxy)
    const configured = yield* resource(startHttpProxy)
    const config = testConfig()
    const moduleUrl = (path: string) => new URL(path, import.meta.url).href
    const source = `
      import { Effect, Layer } from ${JSON.stringify(import.meta.resolve("effect"))};
      import * as Database from ${JSON.stringify(moduleUrl("../src/db/Database.ts"))};
      import * as Network from ${JSON.stringify(moduleUrl("../src/net/Network.ts"))};
      import { Secrets, makeSecrets } from ${JSON.stringify(moduleUrl("../src/secrets.ts"))};
      import { googleGenerativeAIApi } from ${JSON.stringify(moduleUrl("../src/providers/sdk.ts"))};
      await Effect.runPromise(Effect.gen(function*(){
        const network = yield* Network.Network;
        yield* network.setInstance({proxyUrl:process.argv[3],bypass:[],forceProxy:false});
        const model = {id:'mock-model',name:'Mock',api:'google-generative-ai',provider:'google',baseUrl:process.argv[2],reasoning:false,input:['text'],contextWindow:4096,maxTokens:100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
        const events = googleGenerativeAIApi().streamSimple(model,{messages:[{role:'user',content:'Synthetic input',timestamp:0}]},{apiKey:'synthetic-google-key',env:{},fetch:network.fetchFor({mode:'inherit'})});
        const result = yield* Effect.promise(async()=>{for await (const event of events) {} return await events.result()});
        if(result.stopReason==='error') throw new Error(result.errorMessage);
      }).pipe(Effect.scoped,Effect.provide(Network.layer.pipe(Layer.provide(Database.layer({dataDir:process.argv[4],readers:1,allowNetworkFs:false,workers:'source'})),Layer.provide(Layer.succeed(Secrets)(makeSecrets('synthetic-child-secret')))))));
    `
    const script = config.dataDir + "/google-probe.mjs"
    writeFileSync(script, source)
    const proxy = ambient.url.replace("http://", "http://synthetic-user:synthetic-ambient-password@")
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--no-wasm-code-gc", "--use-env-proxy", script, mock.url, configured.url, config.dataDir],
            {
              cwd: fileURLToPath(new URL("../../../", import.meta.url)),
              env: {
                ...process.env,
                NODE_USE_ENV_PROXY: "1",
                HTTP_PROXY: proxy,
                HTTPS_PROXY: proxy,
                http_proxy: proxy,
                https_proxy: proxy,
                NO_PROXY: "",
                no_proxy: ""
              },
              stdio: ["ignore", "pipe", "pipe"]
            }
          )
          let output = ""
          child.stdout.on("data", (data) => {
            output += data
          })
          child.stderr.on("data", (data) => {
            output += data
          })
          const timer = setTimeout(() => child.kill("SIGTERM"), 20000)
          child.once("error", (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.once("exit", (code) => {
            clearTimeout(timer)
            if (code === 0) resolve()
            else reject(new Error(output))
          })
        })
    )
    assert.deepEqual(ambient.tunnels(), [])
    assert.include(configured.tunnels(), new URL(mock.url).host)
    assert.equal(mock.requests().at(-1)!.headers["x-goog-api-key"], "synthetic-google-key")
  }).pipe(Effect.scoped)
)

it.live("URL userinfo and query credentials are scrubbed from capture and Version errors", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* resource(() => startMockProvider(response))
    const api = yield* client()
    const registry = yield* ProviderRegistry
    const url = new URL(mock.url + "/v1?access_token=synthetic-query-token")
    url.username = "synthetic-route-user"
    url.password = "synthetic-route-password"
    const values = [url.href, url.username, url.password, "synthetic-query-token"]
    yield* echo(registry, values)
    const { version, events } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: url.href },
      model: {}
    })
    assert.equal(version.status, "failed", "fetch refuses URL userinfo; the failure still needs redaction")
    const run = yield* api.GetRunContext({ versionId: version.id })
    for (const value of values)
      assert.notInclude(JSON.stringify({ run, events, stored: yield* savedContexts(config.dataDir) }), value)
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), ProviderBuiltins.layer)))
})
it.live("Google captures and Version errors scrub the configured proxy's credentials", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const mock = yield* resource(() =>
      startMockProvider((_r, res) => json(res, 401, { error: { message: "Rejected synthetic-google-proxy-password" } }))
    )
    const proxy = yield* resource(startHttpProxy)
    const api = yield* client()
    const registry = yield* ProviderRegistry
    const proxyUrl = proxy.url.replace("http://", "http://synthetic-user:synthetic-google-proxy-password@")
    yield* api.SetNetworkSettings({ proxyUrl, bypass: [], forceProxy: false })
    yield* registry.transforms.register({
      id: "google-proxy-echo",
      appliesTo: (t) => t.api === "google-generative-ai",
      transform: (p) => ({
        ...p,
        config: { ...(p.config as object), systemInstruction: proxyUrl + " synthetic-google-proxy-password" }
      })
    })
    const { version, events } = yield* generateReply(api, {
      connection: { kind: "google", baseUrl: mock.url, apiKey: "synthetic-google-key" },
      model: {}
    })
    assert.equal(version.status, "failed")
    assert.include(proxy.tunnels(), new URL(mock.url).host)
    const run = yield* api.GetRunContext({ versionId: version.id })
    for (const value of [proxyUrl, "synthetic-google-proxy-password"])
      assert.notInclude(JSON.stringify({ run, events, stored: yield* savedContexts(config.dataDir) }), value)
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(config), ProviderBuiltins.layer)))
})
