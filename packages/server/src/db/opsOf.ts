// How code types itself from an operation group (ARCHITECTURE.md §3.2).
import type { Rpc } from "effect/rpc"

/**
 * A group's operations, read off its `requests` map. Never use `RpcClient.FromGroup` or
 * `RpcGroup.Rpcs` on the storage groups: they infer the union by matching the group against the
 * whole `RpcGroup` interface, which passes TypeScript's instantiation limit (TS2589) past about
 * 200 operations in one group, and every user of the result then sees `unknown`. Read this way, one
 * client over 364 operations checks. `test/opsTyping.test.ts` keeps the two out of the sources.
 */
export type OpsOf<Group> = Group extends { readonly requests: ReadonlyMap<string, infer R extends Rpc.Any> } ? R : never
