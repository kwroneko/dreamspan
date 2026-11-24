// Subagents' models, milestone SA2 (spec/SUBAGENTS.md §5): the `agent` tool lists the models the
// chat's subagents may use, by alias with the user's note; a subagent runs on the one its call
// names (else its type's default), and only on one of them; the chat's lock keeps its own picks
// as the model chip's lock does; "summary" is the chat's summary model, as `fast`. Synthetic data
// and scripted loopback providers only.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Chat } from "@dreamspan/shared/chat.ts"
import { Reader } from "../src/db/Database.ts"
import type { SubagentModelsAt } from "../src/db/subagentSettings.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import {
  agentDescription,
  type Api,
  completions,
  isChild,
  mockProvider,
  scripted,
  task,
  toolTexts,
  TRIGGER,
  watch
} from "./support/subagentScript.ts"
import { sse, completionChunks, type Recorded } from "./support/mockProvider.ts"
import type { ServerResponse } from "node:http"

const LIST = { name: "list_library", args: { kind: "card" }, id: "child-list" }
const agentCall = (id: string, model?: string) => ({
  name: "agent",
  args: { type: "research", task: "List the cards in the library.", ...(model ? { model } : {}) },
  id
})

/** A second connection, on its own loopback provider, with one model: where `cheap` sends. */
const secondConnection = (api: Api, url: string) =>
  Effect.gen(function* () {
    const connection = yield* api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Second",
        baseUrl: `${url}/v1`,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      }
    })
    const model = yield* api.AddUserModel({ connectionId: connection.id, key: "cheap-model", overrides: {} })
    return { connection, model, pick: `${connection.id} ${model.id}` }
  })

/** Everything the second provider answers as a subagent would: one lookup, then its report. */
const secondHandler = (request: Recorded, res: ServerResponse) => {
  const body = request.body as { messages: ReadonlyArray<{ role: string }> }
  const done = body.messages.filter((m) => m.role === "tool").length
  if (done === 0)
    return sse(res, [
      {
        id: "c",
        object: "chat.completion.chunk",
        model: "m",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                { index: 0, id: LIST.id, type: "function", function: { name: LIST.name, arguments: '{"kind":"card"}' } }
              ]
            },
            finish_reason: null
          }
        ]
      },
      {
        id: "c",
        object: "chat.completion.chunk",
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
      }
    ])
  sse(res, completionChunks(["Cheap report."], {}))
}

const setup = (parent: ReadonlyArray<ReturnType<typeof agentCall>>) =>
  Effect.gen(function* () {
    const script = scripted({ parent, child: (done) => (done === 0 ? LIST : undefined), report: "Same report." })
    const first = yield* mockProvider(script.handler)
    const second = yield* mockProvider(secondHandler)
    const api = yield* client()
    yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${first.url}/v1` }, model: {} })
    const other = yield* secondConnection(api, second.url)
    const chat: Chat = yield* api.CreateWorkshop({})
    const events = yield* watch(api, chat)
    return { api, chat, events, first, second, other }
  })

const parentBodies = (requests: ReadonlyArray<Recorded>) =>
  completions(requests).filter((b) => !isChild(b) && JSON.stringify(b.messages).includes(TRIGGER))

describe("subagent models", () => {
  it.live("the agent tool lists the allowed models; a subagent runs on the one its call names, and no other", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, chat, events, first, second, other } = yield* setup([
        agentCall("strong", "strong"),
        agentCall("cheap", "cheap")
      ])
      yield* api.ChangeSubagentSettings({
        picks: ["same", other.pick],
        rows: { [other.pick]: { alias: "cheap", note: "For lookups." } }
      })
      const versionId = yield* task(api, chat, "look through my cards")
      yield* eventually(() => finished(events, versionId) !== undefined)
      assert.strictEqual(finished(events, versionId)!.status, "complete")

      const parents = parentBodies(first.requests())
      const description = agentDescription(parents[0]!)!
      assert.include(description, "- same: mock-model. The model you're running on.")
      assert.include(description, "- cheap: cheap-model. For lookups.")
      // An alias not on the list is a tool error naming the allowed ones.
      const results = toolTexts(parents.at(-1)!)
      assert.include(results[0], "no subagent model “strong” here. Use one of: same, cheap.")
      assert.include(results[1], "Cheap report.")
      // The subagent's requests went to the model it named, never to the chat's.
      assert.lengthOf(completions(first.requests()).filter(isChild), 0)
      assert.lengthOf(completions(second.requests()), 2)
      const steps = yield* api.GetRolloutSteps({ versionId })
      const row = steps.flatMap((s) => (s.kind === "tool" && s.subagent ? [s.subagent] : []))[0]!
      assert.strictEqual(row.alias, "cheap")
      assert.strictEqual(row.model, "cheap-model")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "a chat locked to its own picks keeps them, as the model chip's lock does; unlocked, it follows the account",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const { api, chat, events, first, second, other } = yield* setup([agentCall("cheap", "cheap")])
        yield* api.ChangeSubagentSettings({
          picks: ["same", other.pick],
          rows: { [other.pick]: { alias: "cheap", note: "" } }
        })
        const at = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId
        const locked = yield* api.ChangeCast({
          chatId: chat.id,
          slotId: at,
          change: { _tag: "SubagentModels", picks: ["same"] }
        })
        assert.deepStrictEqual(locked.subagentModels, ["same"])
        const one = yield* task(api, chat, "first")
        yield* eventually(() => finished(events, one) !== undefined)
        const lockedRun = parentBodies(first.requests())
        assert.notInclude(agentDescription(lockedRun[0]!)!, "- cheap:")
        assert.include(toolTexts(lockedRun.at(-1)!)[0], "Use one of: same.")
        assert.lengthOf(completions(second.requests()), 0)

        // Unlocked: the account's picks again.
        const leaf = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId
        const unlocked = yield* api.ChangeCast({
          chatId: chat.id,
          slotId: leaf,
          change: { _tag: "SubagentModels", picks: null }
        })
        assert.isUndefined(unlocked.subagentModels)
        const before = parentBodies(first.requests()).length
        const two = yield* task(api, chat, "second")
        yield* eventually(() => finished(events, two) !== undefined)
        assert.include(agentDescription(parentBodies(first.requests())[before]!)!, "- cheap: cheap-model.")
        assert.lengthOf(completions(second.requests()), 2)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("`summary` is the chat's summary model, named fast, and the research type's default", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, chat, events, first, second, other } = yield* setup([agentCall("plain")])
      yield* api.ChangeSubagentSettings({ picks: ["same", "summary"] })
      const at = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: at,
        change: { _tag: "SummaryModel", model: { connection: other.connection.id, model: other.model.id } }
      })
      const versionId = yield* task(api, chat, "look")
      yield* eventually(() => finished(events, versionId) !== undefined)
      const description = agentDescription(parentBodies(first.requests())[0]!)!
      assert.include(description, "- fast: cheap-model. Cheaper and faster; for lookups and reading.")
      assert.include(description, `"research": `)
      assert.include(description, "Default model: fast.")
      // No `model` in the call: the type's default, the summary model.
      assert.lengthOf(completions(second.requests()), 2)
      assert.lengthOf(completions(first.requests()).filter(isChild), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("subagent model consent at a shared slot follows the requested fork", () =>
    Effect.gen(function* () {
      const { api, chat, other } = yield* setup([])
      const reader = yield* Reader
      const userId = (yield* api.GetSession()).user.id
      const { entry } = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: chat.activeLeafSlotId,
          branch: false,
          content: "A shared message."
        })
      )
      const slotId = entry.slotId
      const forkId = (yield* api.GetChat({ chatId: chat.id })).currentForkId!
      yield* api.ChangeCast({ chatId: chat.id, slotId, forkId, change: { _tag: "SubagentModels", picks: ["same"] } })
      const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: forkId, atSlotId: slotId })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId,
        forkId: fork.id,
        change: { _tag: "SubagentModels", picks: [other.pick] }
      })
      const picksAt = (forkId: Chat["currentForkId"]) =>
        reader
          .SubagentModelsAt({ userId, chatId: chat.id, forkId, leafSlotId: slotId })
          .pipe(Effect.map((json) => (JSON.parse(json) as SubagentModelsAt).entries.map((entry) => entry.pick)))
      assert.deepStrictEqual(yield* picksAt(fork.id), [other.pick])
      assert.deepStrictEqual(yield* picksAt(forkId), ["same"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("settings refuse two models with one name; `same` keeps its own", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const refused = yield* api
        .ChangeSubagentSettings({
          rows: { summary: { alias: "dup", note: "" }, "c m": { alias: "dup", note: "" } }
        })
        .pipe(Effect.flip)
      assert.strictEqual(refused._tag, "SubagentSettingsRejected")
      yield* api.ChangeSubagentSettings({ rows: { same: { alias: "renamed", note: "Mine." } } })
      const settings = yield* api.GetSubagentSettings({})
      assert.deepStrictEqual(settings.models.rows["same"], { alias: "same", note: "Mine." })
      assert.deepStrictEqual(settings.models.picks, ["same"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
