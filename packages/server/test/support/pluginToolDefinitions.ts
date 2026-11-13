import { Effect } from "effect"
import { ExecutionRegistry } from "../../src/execution.ts"
import { makePluginAuthoring, type PluginAuthorDeps } from "../../src/agent/tools/plugins.ts"

/** Serializer-only tests use the real definitions without starting the host or executing tools. */
export const installPluginToolDefinitions = Effect.gen(function* () {
  const registry = yield* ExecutionRegistry
  const unavailable = () => {
    throw new Error("Definition-only plugin fixture must never execute tools")
  }
  const deps = new Proxy({} as PluginAuthorDeps, { get: () => unavailable })
  for (const tool of makePluginAuthoring(deps).tools) yield* registry.rolloutTools.register(tool)
  return registry
})
