// How code types itself from operation groups (src/db/opsOf.ts, ARCHITECTURE.md §3.2).
import { assert, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc"
import { ReadOps, WriteOps } from "../src/db/ops.ts"
import { handlerProblem, mergeOps, type OpsOf, serveOps } from "../src/db/opsOf.ts"

// One client over every storage operation must type-check: if this file reports TS2589, the
// way clients are typed has to change again, not the groups' sizes.
class AllOps extends mergeOps(WriteOps, ReadOps) {}
type AllClient = RpcClient.RpcClient<OpsOf<typeof AllOps>, RpcClientError.RpcClientError>
const tags = (client: AllClient) => [client.MergeChat, client.SwitchBranch, client.PreviewChatMerge]

// `serveOps` keeps what `toLayer` typed: the handlers' own services are the layer's requirements,
// a wrong result or a missing handler doesn't check.
class Clock extends Context.Service<Clock, { readonly now: number }>()("test/opsTyping/Clock") {}
const Tiny = RpcGroup.make(Rpc.make("Now", { payload: { plus: Schema.Number }, success: Schema.Number }))
const served = serveOps(
  Tiny,
  Effect.succeed({
    Now: ({ plus }: { readonly plus: number }) =>
      Effect.gen(function* () {
        return (yield* Clock).now + plus
      })
  })
)
const needsClock: Layer.Layer<Rpc.ToHandler<OpsOf<typeof Tiny>>, never, Clock> = served
// @ts-expect-error a handler with the wrong result
serveOps(Tiny, Effect.succeed({ Now: () => Effect.succeed("now") }))
// @ts-expect-error a missing handler
serveOps(Tiny, Effect.succeed({}))

// The real groups must reject a missing handler too, and their operations must not degrade.
type IsNever<T> = [T] extends [never] ? true : false
type IsAny<T> = 0 extends 1 & T ? true : false
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const typed = <T extends true>(): T | undefined => undefined
typed<Same<IsNever<OpsOf<typeof ReadOps>>, false>>()
typed<Same<IsAny<OpsOf<typeof ReadOps>>, false>>()
typed<Same<IsNever<OpsOf<typeof WriteOps>>, false>>()
typed<Same<IsAny<OpsOf<typeof WriteOps>>, false>>()
typed<"MergeChat" extends OpsOf<typeof WriteOps>["_tag"] ? true : false>()
// @ts-expect-error ReadOps with no handlers
serveOps(ReadOps, Effect.succeed({}))
// @ts-expect-error WriteOps with no handlers
serveOps(WriteOps, Effect.succeed({}))

// Streaming and middleware operations are refused: their services would vanish from the layer type.
const Streamy = RpcGroup.make(Rpc.make("Feed", { success: Schema.Number, stream: true }))
// @ts-expect-error a streaming operation
serveOps(Streamy, Effect.succeed({ Feed: () => Effect.succeed(1) }))

const packages = fileURLToPath(new URL("../..", import.meta.url))
const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })

it("serveOps names missing and extra handlers when it builds", () => {
  assert.strictEqual(handlerProblem(["A", "B"], { A: () => 1, B: () => 2 }), undefined)
  assert.strictEqual(handlerProblem(["A", "B"], { A: () => 1 }), "missing handlers: B")
  assert.strictEqual(handlerProblem(["A", "B"], { A: () => 1, B: 5 }), "missing handlers: B")
  assert.strictEqual(handlerProblem(["A"], { A: () => 1, C: () => 3 }), "extra handlers: C")
  assert.strictEqual(handlerProblem(["A", "B"], { C: () => 1 }), "missing handlers: A, B; extra handlers: C")
})

it.effect("serveOps fails the layer build on a wrong handler set", () =>
  Effect.gen(function* () {
    const bad = serveOps(Tiny, Effect.succeed({} as never))
    const exit = yield* Effect.exit(Layer.build(bad).pipe(Effect.scoped))
    assert.isTrue(Exit.isFailure(exit))
    assert.include(String(exit), "missing handlers: Now")
    const extra = serveOps(Tiny, Effect.succeed({ Now: () => Effect.succeed(1), Stray: () => Effect.void } as never))
    const exit2 = yield* Effect.exit(Layer.build(extra).pipe(Effect.scoped))
    assert.include(String(exit2), "extra handlers: Stray")
    const ok = serveOps(Tiny, Effect.succeed({ Now: () => Effect.succeed(1) }))
    assert.isTrue(Exit.isSuccess(yield* Effect.exit(Layer.build(ok).pipe(Effect.scoped))))
  })
)

it("types every client from a group's requests, never through RpcGroup.Rpcs", () => {
  assert.isFunction(tags)
  assert.isObject(needsClock)
  assert.isAbove(AllOps.requests.size, WriteOps.requests.size)
  // Also any storage group passed where its operations would be inferred against `RpcGroup`.
  const inferring =
    /RpcClient\.FromGroup<|RpcGroup\.Rpcs<|\b(ReadOps|WriteOps\w*)\.(merge|toLayer|toHandlers)\(|(RpcServer\.layer|RpcClient\.make)\((ReadOps|WriteOps)\b/
  // Aliasing a storage group (`const g = ReadOps`) would hide the calls above from the scan.
  const aliasing = /(?<![=!<>])=\s*(ReadOps|WriteOps\w*)\s*(?![.\w(])|\b(ReadOps|WriteOps\w*)\s+as\s/
  const offenders = ["shared/src", "server/src", "client/src"]
    .flatMap((dir) => sources(join(packages, dir)))
    .filter((path) => {
      const text = readFileSync(path, "utf8")
      return inferring.test(text) || aliasing.test(text)
    })
    .map((path) => path.slice(packages.length))
  assert.deepStrictEqual(offenders, [], "type it with OpsOf, mergeOps, serveOps or asGroup (server/src/db/opsOf.ts)")
})
