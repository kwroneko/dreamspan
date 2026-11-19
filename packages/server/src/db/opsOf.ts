// How code types itself from an operation group (ARCHITECTURE.md §3.2).
import type { Effect, Layer, Scope } from "effect"
import { type Rpc, RpcGroup } from "effect/rpc"

/** What every helper here takes: a group, read only through its `requests` map. */
export interface OpsGroup {
  readonly requests: ReadonlyMap<string, Rpc.Any>
}

/**
 * A group's operations, read off its `requests` map. Never use `RpcClient.FromGroup` or
 * `RpcGroup.Rpcs` on the storage groups, and never let a group's operations be inferred by passing
 * it where an `RpcGroup<Rpcs>` is expected (`RpcClient.make(group)`, `RpcServer.layer(group)`,
 * `group.merge(...)`): those match the group against the whole `RpcGroup` interface, which passes
 * TypeScript's instantiation limit (TS2589) past about 200 operations in one group, and every
 * user of the result then sees `unknown`. Read this way the cost is linear in the operations.
 * `test/opsTyping.test.ts` keeps the inferring forms out of the sources and checks the headroom.
 */
export type OpsOf<Group> = Group extends { readonly requests: ReadonlyMap<string, infer R extends Rpc.Any> } ? R : never

/** A group as `RpcGroup` over its `OpsOf` union, for the APIs that take one, without inferring. */
export const asGroup = <Group extends OpsGroup>(group: Group) => group as unknown as RpcGroup.RpcGroup<OpsOf<Group>>

/**
 * Several groups as one, typed as the union of their operations. What `RpcGroup.merge` does,
 * without its `RpcGroup.Rpcs` inference over each merged group.
 */
export const mergeOps = <const Groups extends ReadonlyArray<OpsGroup>>(
  ...groups: Groups
): RpcGroup.RpcGroup<OpsOf<Groups[number]>> =>
  RpcGroup.make().merge(...(groups as unknown as ReadonlyArray<RpcGroup.Any>)) as unknown as RpcGroup.RpcGroup<
    OpsOf<Groups[number]>
  >

/**
 * The handlers a worker serves a group with: one per operation, keyed by tag, each returning an
 * effect that may need `Services` (provided where the handlers are built, as with `toLayer`).
 */
export type HandlersOf<Group, Services = never> = {
  readonly [Current in OpsOf<Group> as Current["_tag"]]: Rpc.ToHandlerFn<Current, Services>
}

/** The services a handler set's effects need, read off each handler once (no streams, no middleware). */
type ServicesOf<Handlers> = {
  readonly [K in keyof Handlers]: Handlers[K] extends (
    ...args: ReadonlyArray<never>
  ) => Effect.Effect<infer _A, infer _E, infer R>
    ? R
    : never
}[keyof Handlers]

/**
 * The layer serving `group` with handlers built by `build`: `RpcGroup.toLayer`, whose handler
 * inference (`HandlersServices`) is quadratic in the group's operations, typed in linear time.
 * Handlers for other groups' operations may come along; only the group's are registered.
 */
export const serveOps = <Group extends OpsGroup, Handlers extends HandlersOf<Group, unknown>, EX = never, RX = never>(
  group: Group,
  build: Effect.Effect<Handlers, EX, RX>
): Layer.Layer<Rpc.ToHandler<OpsOf<Group>>, EX, Exclude<RX | ServicesOf<Handlers>, Scope.Scope>> =>
  (group as unknown as RpcGroup.RpcGroup<Rpc.Any>).toLayer(build as never) as never
