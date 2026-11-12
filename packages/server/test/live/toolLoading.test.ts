// Live: dynamic tool loading (spec/TOOL-LOADING.md §8) against each provider's own API, through the
// app's workshop. One reply runs six requests: two before any load, the load, then two after it.
// The check that matters: the request after the load reads the earlier prefix from the cache.
// Providers without a measured loading wire send every tool from the start; for them the same run
// shows the tool loop caches with the full tool list.
import { describe } from "@effect/vitest"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { VersionId } from "@rp/shared/chat.ts"
import { Effect, Stream } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { posted } from "../support/config.ts"
import { findings, LIVE, liveEnabled, liveKey, lore, wireUsage } from "./support/live.ts"
import { type CacheDialect, liveTest, wireCounts } from "./support/scenarios.ts"

const f = findings("toolLoading")

interface Target {
  readonly id: string
  readonly kind: string
  readonly route: string
  readonly provider: string
  readonly model: string
  readonly dialect: CacheDialect
  /** Whether the app defers tools for this target (a registered, matching wire). */
  readonly loads: boolean
  readonly loreTokens: number
}

// Support is per model: the current Claude models, each with enough lore to pass any cache minimum.
const claude = (version: string, model: string): Target => ({
  id: `anthropic ${version}`,
  kind: "anthropic",
  route: "anthropic",
  provider: "anthropic",
  model,
  dialect: "anthropic",
  loads: true,
  loreTokens: 6000
})

const targets: ReadonlyArray<Target> = [
  claude("sonnet-5.5", "claude-sonnet-5-5"),
  claude("opus-5.5", "claude-opus-5-5"),
  claude("haiku-5.5", "claude-haiku-5-5"),
  {
    id: "anthropic haiku-4.5",
    kind: "anthropic",
    route: "anthropic",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    dialect: "anthropic",
    loads: true,
    loreTokens: 6000
  },
  {
    id: "anthropic sonnet-4.5",
    kind: "anthropic",
    route: "anthropic",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    dialect: "anthropic",
    loads: true,
    loreTokens: 3000
  },
  {
    id: "openai responses gpt-5.4-mini",
    kind: "openai-responses",
    route: "openai/v1",
    provider: "openai",
    model: "gpt-5.4-mini",
    dialect: "responses",
    loads: true,
    loreTokens: 3000
  },
  {
    id: "openrouter anthropic",
    kind: "openrouter",
    route: "openrouter/v1",
    provider: "openrouter",
    model: "anthropic/claude-haiku-4.5",
    dialect: "openrouter",
    loads: false,
    loreTokens: 6000
  },
  {
    id: "openrouter openai",
    kind: "openrouter",
    route: "openrouter/v1",
    provider: "openrouter",
    model: "openai/gpt-5.4-nano",
    dialect: "openrouter",
    loads: false,
    loreTokens: 3000
  },
  {
    id: "deepseek",
    kind: "deepseek",
    route: "deepseek/v1",
    provider: "deepseek",
    model: "deepseek-flash",
    dialect: "deepseek",
    loads: false,
    loreTokens: 3000
  }
]
const only = process.env.RP_LIVE_TOOL_LOADING?.split(",")

const steps = (loads: boolean) =>
  [
    "Work through these steps one tool call at a time, in this order, writing no text between them:",
    "1. Call list_library.",
    "2. Call list_library again.",
    ...(loads
      ? [
          '3. Call load_skill with the name "cards".',
          '4. Call read_card for the card "Assistant".',
          '5. Call read_card for "Assistant" again.'
        ]
      : ['3. Call read_card for the card "Assistant".', '4. Call read_card for "Assistant" again.']),
    "Then reply with the one word: done."
  ].join("\n")

// RP_LIVE_TOOL_LOADING (target ids, comma-separated) runs these even where the environment sets CI.
describe.skipIf(!liveEnabled && !(LIVE.keyDir && only))("live tool loading", () => {
  for (const t of targets.filter((t) => !only || only.includes(t.id)))
    liveTest(`workshop tool loading keeps the cache: ${t.id}`, f, ({ api, recorder }) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          provider: t.provider,
          kind: t.kind,
          settings: {
            name: `Live ${t.id}`,
            baseUrl: `${recorder.url}/${t.route}`,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          apiKey: liveKey(t.route)
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: t.model, overrides: {} })
        yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: model.id } } })
        const chat = yield* api.CreateWorkshop({})
        const events: Array<ChatEvent> = []
        yield* api.SubscribeChat({ chatId: chat.id }).pipe(
          Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
          Effect.forkScoped
        )
        const nonce = crypto.randomUUID().slice(0, 8)
        const sent = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: chat.activeLeafSlotId,
            branch: false,
            content: `Background notes for later; don't summarize them.\n${lore(nonce, t.loreTokens)}\n\n${steps(t.loads)}`
          })
        )
        const from = recorder.exchanges.length
        const { entry } = yield* posted(
          api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false })
        )
        const versionId = entry.version.id as VersionId
        const done = () =>
          events.some((e) => e._tag === "Version" && e.version.id === versionId && e.version.status !== "generating")
        const deadline = Date.now() + 600_000
        while (!done() && Date.now() < deadline) yield* Effect.sleep(200)
        const version = events
          .flatMap((e) => (e._tag === "Version" && e.version.id === versionId ? [e.version] : []))
          .at(-1)
        const exchanges = recorder.exchanges.slice(from).filter((e) => !e.path.endsWith("/models"))
        const rows = exchanges.map((e, i) => {
          const body = JSON.stringify(e.request ?? {})
          const counts = wireCounts(t.dialect, wireUsage(e.body))
          const read = counts?.read ?? 0
          const write = counts?.write ?? 0
          const uncached = counts?.uncached ?? 0
          return {
            request: i + 1,
            status: e.status,
            input: uncached + read + (t.dialect === "anthropic" ? write : 0),
            read,
            write,
            // The first request whose history carries a load: Anthropic's reference, Responses' output item.
            loaded: body.includes('"tool_reference"') || body.includes('"tool_search_output"'),
            tools: Array.isArray(e.request?.tools) ? (e.request.tools as Array<unknown>).length : 0,
            toolsBytes: JSON.stringify(e.request?.tools ?? null).length
          }
        })
        mkdirSync(LIVE.out, { recursive: true })
        writeFileSync(
          join(LIVE.out, `toolLoading-${t.id.replace(/[^a-z0-9]+/gi, "-")}.json`),
          JSON.stringify({ target: t, status: version?.status, error: version?.error, rows }, null, 2)
        )
        process.stdout.write(`[live] ${t.id} ${JSON.stringify(rows)}\n`)
        f.check(t.id, "the reply finished", version?.status === "complete", {
          actual: { status: version?.status, error: version?.error }
        })
        f.check(
          t.id,
          "every request succeeded",
          rows.every((r) => r.status === 200),
          { actual: rows.map((r) => r.status) }
        )
        const at = rows.findIndex((r) => r.loaded)
        if (t.loads) {
          f.check(t.id, "a load happened mid-run", at > 0, { actual: rows })
          if (at > 0) {
            const before = rows[at - 1]!
            const after = rows[at]!
            // The request after the load reads what the request before it sent.
            f.check(
              t.id,
              "the request after the load reads the earlier prefix from the cache",
              after.read >= before.input * 0.8,
              {
                expected: `read ≥ 80% of ${before.input}`,
                actual: { before, after }
              }
            )
            if (t.dialect === "anthropic")
              f.check(
                t.id,
                "the tool list is the same bytes on every request",
                new Set(rows.map((r) => r.toolsBytes)).size === 1,
                {
                  actual: rows.map((r) => r.toolsBytes)
                }
              )
          }
        }
        // Before any load, and for targets that send everything: each request reads the one before.
        const pairs = rows
          .slice(1)
          .map((r, i) => ({ r, prev: rows[i]! }))
          .filter(({ r }) => !r.loaded || !t.loads || r.request !== at + 1)
        f.check(
          t.id,
          "each tool-loop request reads the previous request's prefix",
          pairs.every(({ r, prev }) => r.read >= prev.input * 0.8),
          { actual: rows }
        )
      })
    )
})
