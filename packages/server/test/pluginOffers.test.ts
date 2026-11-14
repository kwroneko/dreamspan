import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Reader } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { offeredByGrants } from "../src/agent/approvals.ts"
import { planToolLoading } from "../src/agent/loadingPlan.ts"
import { PLUGIN_TOOLS } from "../src/agent/tools/plugins.ts"
import { installPluginToolDefinitions } from "./support/pluginToolDefinitions.ts"

it.effect("plugin offers respect both capabilities and role in every tool transport", () =>
  Effect.gen(function* () {
    const execution = yield* installPluginToolDefinitions
    const tools = PLUGIN_TOOLS.map((id) => execution.rolloutTools.get(id)!)
    for (const role of ["admin", "user"] as const)
      for (const off of [[], ["plugins.write"], ["plugins.apply"], ["plugins.write", "plugins.apply"]])
        for (const mode of ["native", "dispatcher", "every"] as const) {
          const reader = {
            WorkshopOperationInfo: () => Effect.succeed({ user: { role } }),
            WorkshopGrants: () => Effect.succeed(off.map((capability) => ({ capability, mode: "off" })))
          } as unknown as Reader["Service"]
          const admitted = yield* offeredByGrants(
            {
              registries: execution,
              reader,
              userId: "synthetic",
              chatId: "synthetic"
            },
            tools
          )
          const result = yield* planToolLoading(
            { execution, reader, userId: "synthetic" as never },
            {
              kind: "workshop",
              tools: admitted.tools,
              cards: [],
              model: {
                kind: "anthropic",
                api: "anthropic-messages",
                key: "claude-sonnet-4-5",
                toolLoading: mode === "native" ? "auto" : mode
              } as never
            }
          )
          const expected = tools.filter((t) => !off.includes(t.capability!) && (!t.adminOnly || role === "admin"))
          const ids = result.offer.tools.filter((t) => PLUGIN_TOOLS.includes(t.id as never)).map((t) => t.id)
          assert.deepStrictEqual(ids.slice().sort(), expected.map((t) => t.id).sort())
          if (mode === "every") assert.strictEqual(result.offer.deferred.size, 0)
          else {
            assert.isTrue(ids.every((id) => result.offer.deferred.has(id)))
            assert.strictEqual(
              result.cardSkills.some((s) => s.id === "plugins"),
              expected.length > 0
            )
          }
        }
  }).pipe(Effect.provide(ExecutionRegistry.layer))
)
