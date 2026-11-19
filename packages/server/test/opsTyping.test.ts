// How code types itself from operation groups (src/db/opsOf.ts, ARCHITECTURE.md §3.2).
import { assert, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, type Layer, Schema } from "effect"
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc"
import { ReadOps, WriteOps } from "../src/db/ops.ts"
import { mergeOps, type OpsOf, serveOps } from "../src/db/opsOf.ts"

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

const packages = fileURLToPath(new URL("../..", import.meta.url))
const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })

it("types every client from a group's requests, never through RpcGroup.Rpcs", () => {
  assert.isFunction(tags)
  assert.isObject(needsClock)
  assert.isAbove(AllOps.requests.size, WriteOps.requests.size)
  // Also any storage group passed where its operations would be inferred against `RpcGroup`.
  const inferring =
    /RpcClient\.FromGroup<|RpcGroup\.Rpcs<|\b(ReadOps|WriteOps\w*)\.(merge|toLayer|toHandlers)\(|(RpcServer\.layer|RpcClient\.make)\((ReadOps|WriteOps)\b/
  const offenders = ["shared/src", "server/src", "client/src"]
    .flatMap((dir) => sources(join(packages, dir)))
    .filter((path) => inferring.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(packages.length))
  assert.deepStrictEqual(offenders, [], "type it with OpsOf, mergeOps, serveOps or asGroup (server/src/db/opsOf.ts)")
})
