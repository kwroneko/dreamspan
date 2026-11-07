// Synthetic catalogs only; no upstream provider is contacted.
import { Effect } from "effect"
import { startProvider } from "./provider.ts"
import type { Client } from "./rpc.ts"

export async function modelCatalog(options: { decisions?: boolean } = {}) {
  const providers = await Promise.all(
    [3000, 10, 40].map((count) =>
      startProvider({
        models: Array.from({ length: count }, (_, index) => ({
          id: `${["anthropic", "openai", "meta-llama", "qwen", "mistralai"][index % 5]}/story-${String(index).padStart(4, "0")}-v3.1`,
          name: `Storyteller ${String(index).padStart(4, "0")}`,
          context_length: 32768
        }))
      })
    )
  )
  return {
    providers,
    seed: (api: Client) =>
      Effect.gen(function* () {
        const lists = []
        for (const [i, provider] of providers.entries()) {
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: ["Router catalog", "Local ten", "Studio forty"][i]!,
              baseUrl: provider.baseUrl,
              compat: {},
              cacheTtlS: 300,
              maxConcurrent: null,
              presetOverrideRefId: null
            },
            apiKey: null
          })
          yield* api.RefreshModels({ connectionId: connection.id })
          const models = yield* api.ListModels({ connectionId: connection.id, includeHidden: false })
          lists.push({ connection, models })
        }
        const first = lists[0]!
        yield* api.ChangeGenerationDefaults({
          change: { model: { connection: first.connection.id, model: first.models[0]!.id } }
        })
        const chat = yield* api.CreateChat({ title: "Model picker synthetic review" })
        if (options.decisions === false) return { lists, chat, decision: first.connection }
        const decision = yield* api.CreateConnection({
          kind: "system-one",
          settings: {
            name: "Decision forty",
            baseUrl: `${providers[2]!.baseUrl}/decisions`,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          apiKey: null
        })
        for (const model of lists[2]!.models)
          yield* api.AddUserModel({
            connectionId: decision.id,
            key: model.key,
            overrides: { name: `Decision ${model.key}` }
          })
        return { lists, chat, decision }
      }),
    stop: () => Promise.all(providers.map((provider) => provider.stop()))
  }
}
