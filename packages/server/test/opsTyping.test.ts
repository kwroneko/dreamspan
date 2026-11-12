// How code types itself from operation groups (src/db/opsOf.ts, ARCHITECTURE.md §3.2).
import { assert, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { RpcClient, RpcClientError } from "effect/rpc"
import { ReadOps, WriteOps } from "../src/db/ops.ts"
import type { OpsOf } from "../src/db/opsOf.ts"

// One client over every storage operation must type-check: if this file reports TS2589, the
// way clients are typed has to change again, not the groups' sizes.
class AllOps extends WriteOps.merge(ReadOps) {}
type AllClient = RpcClient.RpcClient<OpsOf<typeof AllOps>, RpcClientError.RpcClientError>
const tags = (client: AllClient) => [client.MergeChat, client.SwitchBranch, client.PreviewChatMerge]

const packages = fileURLToPath(new URL("../..", import.meta.url))
const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })

it("types every client from a group's requests, never through RpcGroup.Rpcs", () => {
  assert.isFunction(tags)
  assert.isAbove(AllOps.requests.size, WriteOps.requests.size)
  const inferring = /RpcClient\.FromGroup<|RpcGroup\.Rpcs</
  const offenders = ["shared/src", "server/src", "client/src"]
    .flatMap((dir) => sources(join(packages, dir)))
    .filter((path) => inferring.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(packages.length))
  assert.deepStrictEqual(offenders, [], "type the client with OpsOf (server/src/db/opsOf.ts) instead")
})
