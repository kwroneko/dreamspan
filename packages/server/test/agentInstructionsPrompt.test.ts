// The preset's Agent instructions prompt (owner, 2026-11-17) and the story reply's request cap
// (`agent.request_cap`): what reaches the provider, with the scripted mock provider.
import { assert, describe, it } from "@effect/vitest"
import { Type } from "@earendil-works/pi-ai"
import type { VersionId } from "@rp/shared/chat.ts"
import { agentInstructionsPrompt } from "@rp/shared/presetOrder.ts"
import { Effect } from "effect"
import { DatabaseSync } from "node:sqlite"
import { agentInstructions } from "../src/agent/modes.ts"
import { WRITE_NOW } from "../src/agent/session.ts"
import type { RolloutTool } from "../src/agent/tools.ts"
import { databaseFile } from "../src/db/connection.ts"
import { Reader } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { builtinPreset } from "../src/db/assemblySources.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

type Message = { readonly role: string; readonly content: string }
type Body = { readonly messages: ReadonlyArray<Message>; readonly tools?: ReadonlyArray<unknown> }

const toolCall = (name: string, args: unknown, id: string) => [
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  },
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [],
    usage: { prompt_tokens: 50, completion_tokens: 3 }
  }
]

const bodies = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)

/** The ST default preset the fixtures import, which has no Agent instructions. */
const stPreset = importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!

/** That preset with the Agent instructions prompt, `content`, placed by `place`. */
const withPrompt = (content: string, place: "end" | "beforeHistory" | "off") => {
  const entry = { identifier: agentInstructionsPrompt.identifier, enabled: place !== "off" }
  const history = stPreset.order.findIndex((e) => e.identifier === "chatHistory")
  return {
    prompts: [...stPreset.prompts, { ...agentInstructionsPrompt, content }],
    order:
      place === "beforeHistory"
        ? [...stPreset.order.slice(0, history), entry, ...stPreset.order.slice(history)]
        : [...stPreset.order, entry]
  }
}

const lookup: RolloutTool<{ readonly topic: string }> = {
  id: "look_up",
  label: "Looked something up",
  effect: "read",
  description: "Looks up a detail of the story.",
  parameters: Type.Object({ topic: Type.String() }),
  summarize: ({ topic }) => topic,
  execute: (_context, { topic }) => Effect.succeed({ text: `The ${topic} keeper is called Ansel.` })
}

/** The first request of an agent reply (it sends at once) with these preset fields. */
const firstRequest = (presetFields?: Record<string, unknown>, agent = true) =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider((request, res) =>
          request.body?.tools
            ? sse(res, toolCall("send_message", { message: "Hi." }, "send"))
            : sse(res, completionChunks(["Hi."], { prompt_tokens: 20, completion_tokens: 1 }))
        )
      ),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const { version } = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      ...(presetFields ? { presetFields } : {}),
      state: agent ? [{ key: "agent.enabled", value: { on: true } }] : []
    })
    assert.strictEqual(version.content, "Hi.")
    return bodies(mock.requests())[0]!
  })

/** The default the narrator gets, with the built-in tools and the default contract. */
const OFFERED = [
  "expand_summary",
  "search_summaries",
  "search_chat",
  "read_messages",
  "lookup_lore",
  "list_notes",
  "write_note",
  "edit_note",
  "switch_note",
  "set_presence",
  "edit_card"
]

describe("the Agent instructions prompt", () => {
  it.live("a preset without it still gets the default at the end of the request", () =>
    Effect.gen(function* () {
      const body = yield* firstRequest()
      const last = body.messages.at(-1)!
      assert.strictEqual(last.role, "user")
      assert.isTrue(last.content.endsWith(`\n${agentInstructions(OFFERED, "both")}`), last.content)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("empty and last in the order, the request is byte-identical to the fallback", () =>
    Effect.gen(function* () {
      const fallback = yield* firstRequest()
      const held = yield* firstRequest(withPrompt("", "end"))
      assert.strictEqual(JSON.stringify(held), JSON.stringify(fallback))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("the built-in preset holds it last and empty, so its requests are as they were without it", () =>
    Effect.gen(function* () {
      const without = yield* firstRequest({
        prompts: builtinPreset.prompts.filter((p) => p.identifier !== agentInstructionsPrompt.identifier),
        order: builtinPreset.order.filter((e) => e.identifier !== agentInstructionsPrompt.identifier)
      })
      const builtin = yield* firstRequest({ prompts: builtinPreset.prompts, order: builtinPreset.order })
      assert.strictEqual(builtinPreset.order.at(-1)?.identifier, agentInstructionsPrompt.identifier)
      assert.strictEqual(JSON.stringify(builtin), JSON.stringify(without))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("edited, its text replaces the default, with macros expanded", () =>
    Effect.gen(function* () {
      const body = yield* firstRequest(withPrompt("Check your notes first, {{char}}.", "end"))
      const last = body.messages.at(-1)!
      assert.isTrue(last.content.endsWith("\nCheck your notes first, Mira."), last.content)
      assert.notInclude(JSON.stringify(body.messages), "Use them only when they help.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("moved above the chat history, it's its own message there", () =>
    Effect.gen(function* () {
      const body = yield* firstRequest(withPrompt("Tools first.", "beforeHistory"))
      const at = body.messages.findIndex((m) => m.content === "Tools first.")
      assert.isAtLeast(at, 0, JSON.stringify(body.messages))
      assert.strictEqual(body.messages[at]!.role, "system")
      assert.isBelow(at, body.messages.length - 2)
      assert.notInclude(body.messages.at(-1)!.content, "Tools first.")
      assert.notInclude(body.messages.at(-1)!.content, "Use them only when they help.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("turned off, nothing is sent; a plain reply never sends it", () =>
    Effect.gen(function* () {
      const off = yield* firstRequest(withPrompt("Tools first.", "off"))
      assert.notInclude(JSON.stringify(off.messages), "Tools first.")
      assert.notInclude(JSON.stringify(off.messages), "Use them only when they help.")
      const plain = yield* firstRequest(withPrompt("Tools first.", "beforeHistory"), false)
      assert.notInclude(JSON.stringify(plain.messages), "Tools first.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})

const rolloutOf = (dataDir: string, versionId: VersionId) => {
  const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
  try {
    return db
      .prepare(
        `SELECT r.id, p.context_snapshot_json AS snapshot FROM versions v JOIN rollouts r ON r.id = v.rollout_id
           JOIN rollout_payloads p ON p.rollout_id = r.id WHERE v.id = ?`
      )
      .get(versionId) as { id: string; snapshot: string }
  } finally {
    db.close()
  }
}

describe("the request cap (agent.request_cap)", () => {
  /** Calls the tool whenever tools are offered, else answers. */
  const looksUp = (request: Recorded, res: import("node:http").ServerResponse) => {
    const body = request.body as unknown as Body
    if (body.tools?.length) sse(res, toolCall("look_up", { topic: "lighthouse" }, `call_${body.messages.length}`))
    else sse(res, completionChunks(["Done."], { prompt_tokens: 20, completion_tokens: 1 }))
  }

  it.live("the chat's cap decides how many requests a reply makes, and is frozen with the run", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register(lookup as RolloutTool<never>)
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(looksUp)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [
          { key: "agent.enabled", value: { on: true } },
          { key: "agent.tools", value: { tools: ["look_up"] } },
          { key: "agent.request_cap", value: { cap: 3 } }
        ]
      })
      assert.strictEqual(version.content, "Done.")
      const sent = bodies(mock.requests())
      assert.lengthOf(sent, 3)
      assert.isEmpty(sent[2]!.tools ?? [])
      assert.deepStrictEqual(sent[2]!.messages.at(-1), { role: "user", content: WRITE_NOW })
      const snapshot = JSON.parse(rolloutOf(config.dataDir, version.id).snapshot) as { agent: { turnCap: number } }
      assert.strictEqual(snapshot.agent.turnCap, 3)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("without the setting a reply makes at most 12 requests", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register(lookup as RolloutTool<never>)
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(looksUp)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [
          { key: "agent.enabled", value: { on: true } },
          { key: "agent.tools", value: { tools: ["look_up"] } }
        ]
      })
      assert.strictEqual(version.content, "Done.")
      assert.lengthOf(bodies(mock.requests()), 12)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("Resume keeps the run's own cap, whatever the chat's cap is now", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register(lookup as RolloutTool<never>)
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(looksUp)),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const { chat, version, events } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [
          { key: "agent.enabled", value: { on: true } },
          { key: "agent.tools", value: { tools: ["look_up"] } },
          { key: "agent.request_cap", value: { cap: 3 } }
        ]
      })
      assert.lengthOf(bodies(mock.requests()), 3)
      // The chat's cap changes after the run; the run is then taken as cut off before it ended.
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: version.slotId,
        change: { _tag: "RequestCap", cap: 10 }
      })
      const db = new DatabaseSync(databaseFile(config.dataDir))
      db.exec("PRAGMA busy_timeout = 5000")
      db.prepare("UPDATE rollouts SET status = 'interrupted' WHERE id = ?").run(
        rolloutOf(config.dataDir, version.id).id
      )
      db.close()
      const me = yield* api.Whoami()
      const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: version.slotId })
      const entry = yield* api.ResumeVersion({ versionId: version.id, expectedRowVersion: slot.entry.rowVersion })
      yield* eventually(() => finished(events, entry.version.id) !== undefined)
      const sent = bodies(mock.requests())
      // The finished last turn is written again as the run's third request: no tools, as its cap says.
      assert.lengthOf(sent, 4)
      assert.isEmpty(sent[3]!.tools ?? [])
      assert.strictEqual(finished(events, entry.version.id)!.content, "Done.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
