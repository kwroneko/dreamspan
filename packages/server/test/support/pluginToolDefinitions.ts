import { Effect } from "effect"
import { ExecutionRegistry } from "../../src/execution.ts"
import { makePluginAuthoring, type PluginAuthorDeps } from "../../src/agent/tools/plugins.ts"
import { makeFileTools, type FileToolDeps } from "../../src/agent/tools/files.ts"

/**
 * Serializer-only tests use the real definitions without starting the host or executing tools:
 * the plugin authoring tools and the workshop's file and command tools.
 */
export const installPluginToolDefinitions = Effect.gen(function* () {
  const registry = yield* ExecutionRegistry
  const unavailable = () => {
    throw new Error("Definition-only plugin fixture must never execute tools")
  }
  const deps = new Proxy({} as PluginAuthorDeps, { get: () => unavailable })
  for (const tool of makePluginAuthoring(deps).tools) yield* registry.rolloutTools.register(tool)
  // The file tools read their limits when made; every other dependency is used only by a call.
  const fileDeps = new Proxy({} as FileToolDeps, { get: (_, key) => (key === "limits" ? undefined : unavailable) })
  for (const tool of makeFileTools(fileDeps).tools) yield* registry.rolloutTools.register(tool)
  return registry
})
