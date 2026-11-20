// A synthetic catalog shaped like a daily user's: a gateway whose models have no display
// names (their ids are their names), a router with named models, a small local box, a few
// pins across connections and some recent choices. No upstream provider is contacted.
import { Effect } from "effect"
import { startProvider } from "./provider.ts"
import type { Connection, Model } from "@dreamspan/shared/providers.ts"
import type { Client } from "./rpc.ts"

const elements = ["argon", "carbon", "helium", "hydrogen", "neon", "xenon", "krypton", "radon"]
const gateway = [
  ...elements.flatMap((element) => [`uno.gemini-4-${element}`, `uno.gemini-4-${element}-lite`]),
  ...Array.from({ length: 24 }, (_, i) => `uno.claude-story-${Math.floor(i / 4) + 3}.${i % 4}`),
  ...Array.from({ length: 20 }, (_, i) => `uno.gpt-tale-${i + 1}`)
].map((id) => ({ id, context_length: 1_000_000 }))
const authors = ["anthropic", "openai", "meta-llama", "qwen", "mistralai", "deepseek"]
const router = Array.from({ length: 150 }, (_, i) => {
  const author = authors[i % authors.length]!
  const n = String(i).padStart(3, "0")
  return {
    id: `${author}/story-${n}-v3.1`,
    name: `${author[0]!.toUpperCase()}${author.slice(1)}: Storyteller ${n}`,
    context_length: [32768, 131072, 200000][i % 3]!
  }
})
const local = ["llama-3.3-70b-instruct", "qwen-3-32b", "mistral-small-24b", "gemma-3-27b", "phi-5", "neon-7b"].map(
  (id) => ({ id, context_length: 8192 })
)

export async function pickerCatalog() {
  const providers = await Promise.all([gateway, router, local].map((models) => startProvider({ models })))
  return {
    providers,
    seed: (api: Client) =>
      Effect.gen(function* () {
        const lists: Array<{ connection: Connection; models: ReadonlyArray<Model> }> = []
        for (const [i, provider] of providers.entries()) {
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: ["Gateway UNO", "Router catalog", "Local box"][i]!,
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
        const value = (list: number, key: string) => {
          const entry = lists[list]!
          return `${entry.connection.id} ${entry.models.find((model) => model.key === key)!.id}`
        }
        const now = Date.now()
        const pins = [value(0, "uno.gemini-4-argon"), value(1, "anthropic/story-000-v3.1"), value(2, "qwen-3-32b")]
        const recent = [
          value(0, "uno.claude-story-4.2"),
          value(1, "qwen/story-003-v3.1"),
          value(0, "uno.gpt-tale-7"),
          value(1, "deepseek/story-011-v3.1")
        ]
        yield* api.SetDisplayPrefs({
          prefs: {
            modelSort: "name",
            modelPins: Object.fromEntries(pins.map((pin) => [pin, true])),
            modelRecent: Object.fromEntries(recent.map((id, i) => [id, now - (i + 1) * 3_600_000 * (i + 1)]))
          }
        })
        const first = lists[0]!
        yield* api.ChangeGenerationDefaults({
          change: {
            model: {
              connection: first.connection.id,
              model: first.models.find((model) => model.key === "uno.gemini-4-carbon")!.id
            }
          }
        })
        const chat = yield* api.CreateChat({ title: "Model picker synthetic review" })
        return { lists, chat, pins, recent, value }
      }),
    stop: () => Promise.all(providers.map((provider) => provider.stop()))
  }
}
