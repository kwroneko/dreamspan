// The agent RPCs (@rp/shared/agentApi.ts). Storage checks the version or chat is the caller's.
import { foldState } from "@rp/shared/state.ts"
import { ACTIVITY_PAGE } from "@rp/shared/agent.ts"
import { type AgentApi } from "@rp/shared/agentApi.ts"
import { CurrentUser } from "@rp/shared/api.ts"
import { Effect } from "effect"
import { Reader } from "../db/Database.ts"
import { ExecutionRegistry } from "../execution.ts"
import { internal } from "./internal.ts"

export const makeAgentHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  const registry = yield* ExecutionRegistry
  return {
    GetRolloutSteps: ({ versionId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.RolloutSteps({ userId: user.id, versionId })).pipe(
        internal("GetRolloutSteps")
      ),
    GetRunTranscript: ({ versionId }) =>
      Effect.flatMap(CurrentUser, (user) => reader.RolloutTranscript({ userId: user.id, versionId })).pipe(
        internal("GetRunTranscript")
      ),
    // As registered now: a plugin's mode or tool shows here as the built-ins do. External tools
    // are never offered in a reply (spec/AGENTIC.md §4.1), so they aren't listed.
    ListReplyModes: () =>
      Effect.sync(() => {
        const tools = registry.rolloutTools.list().filter((tool) => tool.effect !== "external")
        const registered = new Set(tools.map((tool) => tool.id))
        return {
          modes: registry.orchestrationModes.list().map((mode) => {
            const plan = mode.plan({ state: foldState([]), config: undefined })
            return {
              id: mode.id,
              label: mode.label,
              description: mode.description,
              agentic: plan.strategy !== "reply",
              tools: plan.tools.filter((id) => registered.has(id))
            }
          }),
          tools: tools.map((tool) => ({
            id: tool.id,
            label: tool.label,
            explanation: tool.explanation ?? tool.label,
            effect: tool.effect
          }))
        }
      }),
    ListActivity: ({ chatId, before, limit }) =>
      Effect.flatMap(CurrentUser, (user) =>
        reader.ListActivity({
          userId: user.id,
          chatId,
          limit: limit ?? ACTIVITY_PAGE,
          ...(before === undefined ? {} : { before })
        })
      ).pipe(internal("ListActivity"))
  } satisfies Parameters<typeof AgentApi.of>[0]
})
