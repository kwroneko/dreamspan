import { assert, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Reader } from "../src/db/Database.ts"
import { Formats } from "../src/importer/Formats.ts"
import { StImportPlans } from "../src/importer/StImportPlans.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })(
  "preview start lifetime",
  (it) => {
    it.effect("serializes overlapping starts before they read and replace the active plan", () =>
      Effect.gen(function* () {
        const api = yield* client()
        const user = yield* api.Whoami()
        const reader = yield* Reader
        const formats = yield* Formats
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let reads = 0
        const gated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            reads++
            if (reads === 1) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
            return yield* effect
          })
        const proxy = new Proxy(reader, {
          get(target, key) {
            if (key === "StImportPlanStamp")
              return (input: Parameters<typeof reader.StImportPlanStamp>[0]) => gated(reader.StImportPlanStamp(input))
            if (key === "StImportSources")
              return (input: Parameters<typeof reader.StImportSources>[0]) => gated(reader.StImportSources(input))
            return Reflect.get(target, key)
          }
        })
        yield* Effect.gen(function* () {
          const plans = yield* StImportPlans
          const first = yield* Effect.forkScoped(plans.start(user, { mode: "upload" }, []))
          yield* Deferred.await(entered)
          const second = yield* Effect.forkScoped(plans.start(user, { mode: "upload" }, []))
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          assert.strictEqual(reads, 1, "a replacement must wait for the earlier start to register its work")
          yield* Deferred.succeed(release, undefined)
          const a = yield* Fiber.join(first)
          const b = yield* Fiber.join(second)
          assert.notStrictEqual(a.plan.planId, b.plan.planId)
          assert.strictEqual((yield* plans.get(user, a.plan.planId).pipe(Effect.flip))._tag, "NotFound")
          assert.strictEqual((yield* plans.get(user, b.plan.planId)).planId, b.plan.planId)
        }).pipe(
          Effect.provide(
            Layer.fresh(StImportPlans.layer).pipe(
              Layer.provide(Layer.mergeAll(Layer.succeed(Reader)(proxy), Layer.succeed(Formats)(formats)))
            )
          ),
          Effect.scoped
        )
      })
    )
  }
)
