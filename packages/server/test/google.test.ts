// Native Gemini through the registered provider, real workers and a local HTTP server.
// Discovery, transport/retry and image fixtures also live in providerStream/messageImages.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { sse, startMockProvider } from "./support/mockProvider.ts"

it.live(
  "Google captures the sent transcript and accounts for cached and thought tokens without an invented TTL",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_r, res) =>
            sse(
              res,
              [
                {
                  candidates: [{ content: { parts: [{ text: "The tide is out." }] }, finishReason: "STOP" }],
                  usageMetadata: {
                    promptTokenCount: 3000,
                    cachedContentTokenCount: 2000,
                    candidatesTokenCount: 10,
                    thoughtsTokenCount: 5,
                    totalTokenCount: 3015
                  }
                }
              ],
              { done: false }
            )
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const reply = yield* generateReply(api, {
        connection: {
          provider: "google",
          kind: "google",
          baseUrl: `${mock.url}/v1beta`,
          apiKey: "synthetic-google-key"
        },
        modelKey: "gemini-2.5-pro",
        model: {},
        preset: { reasoning_effort: "none" },
        mira: { description: "Mira keeps the lighthouse log. ".repeat(400) }
      })
      assert.equal(reply.version.status, "complete", JSON.stringify(reply.version.error))
      const sent = mock.requests().at(-1)!
      assert.equal(sent.path, "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse")
      assert.equal(sent.headers["x-goog-api-key"], "synthetic-google-key")
      const body = sent.body!
      assert.notInclude(JSON.stringify(body), "cache_control")
      assert.isUndefined(body.cachedContent)
      assert.notEqual(
        (body.generationConfig as { thinkingConfig: { thinkingBudget: number } }).thinkingConfig.thinkingBudget,
        0
      )
      const run = yield* api.GetRunContext({ versionId: reply.version.id })
      const text = (content: { parts: Array<{ text?: string }> }) => content.parts.map((p) => p.text ?? "").join("")
      const wire = [
        ...(body.systemInstruction
          ? [{ role: "system", content: text(body.systemInstruction as Parameters<typeof text>[0]) }]
          : []),
        ...(body.contents as Array<Parameters<typeof text>[0] & { role: string }>).map((c) => ({
          role: c.role,
          content: text(c)
        }))
      ]
      assert.deepEqual(
        run.messages.map((m) => ({ role: m.role, content: m.content })),
        wire
      )
      assert.isTrue(run.messages.some((m) => m.sources.length > 0))
      const row = (yield* api.ListLlmRequests({ limit: 5, before: null })).find(
        (r) => r.versionId === reply.version.id
      )!
      assert.equal(row.provider, "google")
      assert.equal(row.usageSource, "reported")
      assert.equal(row.counts.inputUncached, 1000)
      assert.equal(row.counts.cacheRead, 2000)
      assert.equal(row.counts.cacheWrite, 0)
      assert.equal(row.counts.output, 15)
      assert.equal(row.counts.reasoning, 5)
      assert.closeTo(row.cost!.amount, (1000 * 1.25 + 2000 * 0.125 + 15 * 10) / 1e6, 1e-12)
      const reader = yield* Reader
      const me = yield* api.Whoami()
      const warmth = (yield* reader.CacheWarmth({ userId: me.id, chatId: reply.chat.id })).warmth!
      assert.isNull(warmth, "no warmth countdown without a known lifetime")
      assert.notInclude(JSON.stringify(run), "synthetic-google-key")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  }
)
