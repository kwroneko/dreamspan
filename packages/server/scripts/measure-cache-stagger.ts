// Opt-in paid measurement through the same SDK, gate and usage ledger as generation.
// Reads only the named key environment variable; all prompts/storage are synthetic.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { resolve, join } from "node:path"
import { parseArgs } from "node:util"
import { randomUUID } from "node:crypto"
import { Effect, Layer, Schema, Stream } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import type { UserId } from "@rp/shared/domain.ts"
import { providerRequest } from "../src/assembler/wire.ts"
import type { AssembledRequest, ModelInput } from "../src/assembler/types.ts"
import * as Database from "../src/db/Database.ts"
import * as Network from "../src/net/Network.ts"
import { scrubProviderEnvironment } from "../src/providerEnvironment.ts"
import { ProviderRegistry } from "../src/providers/registry.ts"
import { makeSecrets, Secrets } from "../src/secrets.ts"

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    provider: { type: "string" },
    model: { type: "string" },
    "key-env": { type: "string" },
    "base-url": { type: "string" },
    requests: { type: "string", default: "4" },
    release: { type: "string", default: "first-chunk" },
    "timeout-ms": { type: "string", default: "10000" },
    scratch: { type: "string", default: ".cache-stagger-measurements" }
  }
})
if (!values.live || process.env.CI) {
  throw new Error(
    "Live measurement is opt-in and forbidden in CI. Use --live --provider anthropic --model MODEL --key-env ANTHROPIC_API_KEY (also: --requests 4 --release first-chunk|complete --timeout-ms 10000 --base-url URL)."
  )
}
const config = Schema.decodeUnknownSync(
  Schema.Struct({
    kind: Schema.NonEmptyString,
    model: Schema.NonEmptyString,
    keyEnv: Schema.NonEmptyString,
    requests: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 8 })),
    after: Schema.Literals(["first-chunk", "complete"]),
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 }))
  })
)({
  kind: values.provider,
  model: values.model,
  keyEnv: values["key-env"],
  requests: Number(values.requests),
  after: values.release,
  timeoutMs: Number(values["timeout-ms"])
})
const key = process.env[config.keyEnv]
if (!key) throw new Error(`Set ${config.keyEnv} to the key to use.`)
scrubProviderEnvironment()
const Builtins = await import("../src/providers/builtins.ts")
const { Providers, layer: providersLayer } = await import("../src/providers/Providers.ts")
const scratch = resolve(values.scratch!)
mkdirSync(scratch, { recursive: true })
const dataDir = mkdtempSync(join(scratch, "run-"))

const layer = providersLayer({ retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }).pipe(
  Layer.provideMerge(Network.layer),
  Layer.provideMerge(Builtins.layer),
  Layer.provideMerge(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, workers: "source" })),
  Layer.provide(Layer.succeed(Secrets)(makeSecrets(randomUUID())))
)

const program = Effect.gen(function* () {
  const providers = yield* Providers
  const reader = yield* Database.Reader
  const writer = yield* Database.Writer
  const registry = yield* ProviderRegistry
  const kind = registry.kinds.get(config.kind)
  if (!kind) return yield* Effect.die(new Error(`Unknown provider ${config.kind}`))
  yield* registry.kinds.register({ ...kind, cacheRelease: { after: config.after, timeoutMs: config.timeoutMs } })
  const userId = (yield* writer.EnsureUser({ handle: "synthetic-measurement", displayName: "Synthetic measurement" }))
    .id as UserId
  const connection = yield* providers.createConnection({
    userId,
    kind: config.kind,
    apiKey: key,
    settings: {
      name: "Synthetic cache measurement",
      baseUrl: values["base-url"] ?? null,
      compat: {},
      cacheTtlS: null,
      maxConcurrent: null,
      presetOverrideRefId: null
    }
  })
  const explicit =
    kind.api === "anthropic-messages" || (config.kind === "openrouter" && config.model.includes("claude"))
  const model = yield* writer.AddUserModel({
    userId,
    connectionId: connection.id,
    key: config.model,
    overrides: { cacheBreakpoints: explicit ? "explicit" : "auto" }
  })
  // Nonce at the head guarantees a fresh prefix. About 10k synthetic tokens exceeds
  // common caching minimums. No owner cards, chats or production databases are read.
  const request: AssembledRequest = {
    messages: [
      {
        role: "system",
        content:
          `Synthetic cache measurement ${randomUUID()}.\n` +
          "The imaginary harbor has a blue bridge, a stone pier, and a lantern. Record only fictional observations.\n".repeat(
            450
          )
      },
      { role: "user", content: "Reply with the word ready." }
    ],
    prefill: null,
    useSystemPrompt: true,
    names: { user: "", char: "", group: [] },
    breakpoints: [{ message: 0, reason: "prefix" }],
    samplers: {
      temperature: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      top_p: 1,
      top_k: 0,
      top_a: 0,
      min_p: 0,
      repetition_penalty: 1,
      max_tokens: 32,
      seed: -1
    }
  }
  const input: ModelInput = {
    connectionId: connection.id,
    modelId: model.id,
    kind: config.kind,
    api: kind.api,
    key: config.model,
    cacheBreakpoints: explicit ? "explicit" : "auto",
    prefill: "none",
    context: null,
    presetOverride: null
  }
  const wire = providerRequest(request, input)
  const started = Date.now()
  const outcomes = yield* Effect.forEach(
    Array.from({ length: config.requests }, (_, i) => i),
    (i) =>
      Effect.gen(function* () {
        let sentMs: number | null = null
        let waitingAt: number | null = null
        let heldMs = 0
        const events = yield* providers
          .stream({
            userId,
            connectionId: connection.id,
            modelId: model.id,
            context: wire.context,
            inspection: { request, model: input },
            options: {
              payload: wire.payload,
              breakpoints: wire.breakpoints,
              maxTokens: 32,
              sessionId: "synthetic-cache-measurement"
            },
            attribution: { purpose: i === 0 ? "summarize" : "generation" }
          })
          .pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                if (event.type === "route") sentMs ??= Date.now() - started
                if (event.type === "waiting-cache") {
                  if (event.waiting) waitingAt = Date.now()
                  else if (waitingAt !== null) heldMs += Date.now() - waitingAt
                }
              })
            ),
            Stream.runCollect
          )
        return { index: i, sentMs, heldMs, requestId: events.find((e) => e.type === "done")?.requestId }
      }),
    { concurrency: "unbounded" }
  )
  const rows = yield* reader.ListLlmRequests({ userId, limit: 100, before: null })
  const report = outcomes.map((o) => {
    const row = rows.find((r) => r.id === o.requestId)!
    return {
      ...o,
      role: row.cacheStagger ? "follower" : "leader",
      release: row.cacheStagger?.release ?? null,
      hit: row.cacheStagger?.hit ?? null,
      cacheRead: row.counts.cacheRead,
      cacheWrite: row.counts.cacheWrite,
      usageSource: row.usageSource
    }
  })
  const followers = report.filter((r) => r.role === "follower")
  console.log(
    JSON.stringify(
      {
        provider: config.kind,
        model: config.model,
        policy: { after: config.after, timeoutMs: config.timeoutMs },
        followers: followers.length,
        followerHits: followers.filter((r) => r.hit === true).length,
        requests: report
      },
      null,
      2
    )
  )
}).pipe(
  Effect.provide(layer),
  Effect.scoped,
  Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true })))
)

NodeRuntime.runMain(program)
