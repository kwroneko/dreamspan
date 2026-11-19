// The reply contract's ending check (spec/REPLY-CONTRACT.md milestone 3): when the nudges run out,
// the refusal judge reads what the model wrote instead of a reply, only if the user turned that on
// beside choosing a judge (nothing else reaches the judge's model). Observe-only: it marks the
// failed version. Scripted providers only.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, json, sse, startMockProvider, type Recorded } from "./support/mockProvider.ts"

type Body = { readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }> }

const isJudge = (body: Body) => JSON.stringify(body.messages[0]?.content ?? "").includes("You check whether")

const judgeRequests = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions" && isJudge(r.body as unknown as Body))

const TOOLS_ON = [
  { key: "agent.enabled", value: { on: true } },
  { key: "agent.tools", value: { tools: [] } }
] as const

const mockProvider = Effect.acquireRelease(
  Effect.promise(() =>
    startMockProvider((request, res) => {
      if (request.path !== "/v1/chat/completions") return json(res, 404, { error: { message: "no" } })
      const answer = isJudge(request.body as unknown as Body) ? "REFUSED" : "I won't write this scene."
      sse(res, completionChunks([answer], { prompt_tokens: 50, completion_tokens: 3 }))
    })
  ),
  (m) => Effect.promise(() => m.close())
)

describe("the ending check", () => {
  it.live("with a judge chosen but the check off, nothing goes to the judge", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: TOOLS_ON,
        before: () =>
          Effect.gen(function* () {
            const defaults = yield* api.GetGenerationDefaults()
            yield* api.ChangeGenerationDefaults({ change: { judge: defaults.model } })
          }).pipe(Effect.orDie)
      })
      assert.strictEqual(version.error?.class, "contract")
      // Give a stray judgment time to happen.
      yield* Effect.sleep("300 millis")
      assert.lengthOf(judgeRequests(mock.requests()), 0)
      assert.isNull(version.mark)
      assert.isUndefined((yield* api.GetGenerationDefaults()).judgeEndings)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("turned on, the judge reads the text written instead and marks the failed reply", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* mockProvider
      const api = yield* client()
      const { version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: TOOLS_ON,
        before: () =>
          Effect.gen(function* () {
            const defaults = yield* api.GetGenerationDefaults()
            yield* api.ChangeGenerationDefaults({ change: { judge: defaults.model, judgeEndings: true } })
          }).pipe(Effect.orDie)
      })
      assert.strictEqual(version.status, "failed")
      assert.strictEqual(version.error?.class, "contract")
      assert.isTrue((yield* api.GetGenerationDefaults()).judgeEndings)
      yield* eventually(() => finished(events, version.id)?.mark === "refused")
      const judged = judgeRequests(mock.requests())
      assert.lengthOf(judged, 1)
      const asked = JSON.stringify((judged[0]!.body as unknown as Body).messages)
      assert.include(asked, "I won't write this scene.")
      assert.include(asked, "never sent a reply")
      // The failure stays as it was: the mark is observe-only.
      assert.strictEqual(finished(events, version.id)?.status, "failed")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
