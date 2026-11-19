import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { startMockProvider, completionChunks, sse } from "./support/mockProvider.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"

it.live(
  "a submitted request records its estimate and reported cached input, calibrating later local counts",
  () =>
    Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) =>
            sse(
              res,
              completionChunks(["Seen."], {
                prompt_tokens: 200,
                completion_tokens: 2,
                total_tokens: 202,
                prompt_tokens_details: { cached_tokens: 120 }
              })
            )
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const reader = yield* Reader
      const generated = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        modelKey: "gpt-4o",
        model: {}
      })
      const userId = (yield* api.Whoami()).id as UserId
      const calibration = yield* reader.GetTextCalibration({
        userId,
        connectionId: generated.connection.id,
        modelKey: "gpt-4o",
        tokenizer: "openai-encodings"
      })
      assert.isNotNull(calibration)
      assert.equal(calibration!.samples, 1)
      const inspector = yield* api.GetRunContext({ versionId: generated.version.id })
      const request = inspector.requests[0]!
      assert.equal(request.usageSource, "reported")
      assert.equal(request.counts.inputUncached, 80)
      assert.equal(request.counts.cacheRead, 120)
      assert.isAbove(request.estimatedInput ?? 0, 0)
      assert.approximately(calibration!.ratio, Math.max(0.25, Math.min(4, 200 / request.estimatedInput!)), 0.0001)
      const counted = yield* api.CountTokens({ texts: ["Hello world", ""] })
      assert.deepStrictEqual(counted.counts, [Math.ceil(2 * calibration!.ratio), 0])
      assert.isFalse(counted.tokenizer.exact)
      assert.include(counted.tokenizer.note ?? "", "Calibrated from 1")
      // Raw cached fields are corrected once, even on repeated reads.
      assert.deepStrictEqual((yield* api.CountTokens({ texts: ["Hello world", ""] })).counts, counted.counts)
      assert.equal(inspector.tokenizer?.id, "openai-encodings")
      assert.isUndefined(inspector.tokenizer?.note)
      const next = yield* api.GetNextContext({ chatId: generated.chat.id, leafSlotId: generated.sent.slotId })
      assert.isAbove(next.budget?.countedInput ?? 0, 0)
      assert.include(next.budget?.tokenizer?.note ?? "", "Calibrated from 1")
      assert.lengthOf(mock.requests(), 1)
      assert.isNull(
        yield* reader.GetTextCalibration({
          userId,
          connectionId: generated.connection.id,
          modelKey: "different-model",
          tokenizer: "openai-encodings"
        })
      )
      assert.isNull(
        yield* reader.GetTextCalibration({
          userId,
          connectionId: generated.connection.id,
          modelKey: "gpt-4o",
          tokenizer: "qwen2"
        })
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
  60_000
)
