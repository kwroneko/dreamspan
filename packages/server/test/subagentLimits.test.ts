// Subagents' limits and concurrency, milestone SA3 (spec/SUBAGENTS.md §6.2, §6.3): at 80% of a
// limit a subagent is told once to wrap up, at 100% its next request isn't sent and it ends
// "Stopped at its limit" with what it had; a model's own row can change its limits; a reply starts
// at most its per-reply count; and past the account's running count a subagent waits, queued, until
// a place frees. Synthetic data and a scripted loopback provider only.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Chat, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import {
  type Api,
  completions,
  isChild,
  liveChild,
  mockProvider,
  scripted,
  task,
  toolTexts,
  TRIGGER,
  watch
} from "./support/subagentScript.ts"

const WRAP_UP = "You're close to your limit"
const START = { name: "agent", args: { type: "research", task: "List the cards." }, id: "spawn" }
/** A subagent that never stops looking on its own. */
const forever = (done: number) => ({ name: "list_library", args: { kind: "card" }, id: `child-${done}` })

const setup = (script: ReturnType<typeof scripted>) =>
  Effect.gen(function* () {
    const mock = yield* mockProvider(script.handler)
    const api = yield* client()
    yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
    const chat: Chat = yield* api.CreateWorkshop({})
    const events = yield* watch(api, chat)
    return { api, chat, events, mock }
  })

const childBodies = (mock: { requests: () => ReadonlyArray<import("./support/mockProvider.ts").Recorded> }) =>
  completions(mock.requests()).filter(isChild)
const lastParent = (mock: { requests: () => ReadonlyArray<import("./support/mockProvider.ts").Recorded> }) =>
  completions(mock.requests())
    .filter((b) => !isChild(b) && JSON.stringify(b.messages).includes(TRIGGER))
    .at(-1)!

const rowOf = (api: Api, versionId: VersionId) =>
  Effect.map(
    api.GetRolloutSteps({ versionId }),
    (steps) => steps.flatMap((s) => (s.kind === "tool" && s.subagent ? [s.subagent] : []))[0]!
  )

describe("subagent limits", () => {
  it.live(
    "at 80% of its token limit it's told to wrap up; at the limit it stops, and the reply gets what it had",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const script = scripted({
          parent: [START],
          child: forever,
          usage: { prompt_tokens: 4500, completion_tokens: 0, total_tokens: 4500 }
        })
        const { api, chat, events, mock } = yield* setup(script)
        yield* api.ChangeSubagentSettings({ limits: { tokens: 10_000 } })
        const versionId = yield* task(api, chat, "look")
        yield* eventually(() => finished(events, versionId) !== undefined)
        assert.strictEqual(finished(events, versionId)!.status, "complete")
        const children = childBodies(mock)
        // Once, at the boundary after 80%; never again.
        const warned = children.filter((b) => JSON.stringify(b.messages).includes(WRAP_UP))
        assert.isAtLeast(warned.length, 1)
        assert.isTrue(JSON.stringify(warned[0]!.messages).includes(WRAP_UP))
        const firstWarned = children.findIndex((b) => JSON.stringify(b.messages).includes(WRAP_UP))
        assert.isAtLeast(firstWarned, 2, "not before 80%")
        // Stopped well before its 30-request cap: the next request after the limit wasn't sent.
        assert.isAtMost(children.length, 5)
        const result = toolTexts(lastParent(mock))[0]!
        assert.include(result, "Stopped at its limit")
        assert.include(result, "&quot;status&quot;:&quot;limit&quot;")
        const row = yield* rowOf(api, versionId)
        assert.strictEqual(row.status, "limit")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("a model's own row sets its limits: two requests, the last for its report", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted({ parent: [START], child: (done) => (done === 0 ? forever(0) : undefined) })
      const { api, chat, events, mock } = yield* setup(script)
      yield* api.ChangeSubagentSettings({ rows: { same: { alias: "same", note: "", caps: { requests: 2 } } } })
      const versionId = yield* task(api, chat, "look")
      yield* eventually(() => finished(events, versionId) !== undefined)
      const children = childBodies(mock)
      assert.lengthOf(children, 2)
      assert.include(JSON.stringify(children[1]!.messages), "Write your report now.")
      assert.strictEqual((yield* rowOf(api, versionId)).status, "done")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("known charges still cap the reply's combined spend after an unpriced child", () =>
    Effect.gen(function* () {
      const script = scripted({
        parent: [
          { ...START, id: "unpriced", args: { ...START.args, model: "same" } },
          { ...START, id: "priced", args: { ...START.args, model: "priced" } },
          { ...START, id: "last", args: { ...START.args, model: "priced", task: "Keep looking." } }
        ],
        child: (done, body) => (JSON.stringify(body.messages).includes("Keep looking.") ? forever(done) : undefined),
        usage: { prompt_tokens: 3000, completion_tokens: 0, total_tokens: 3000 }
      })
      const { api, chat, events, mock } = yield* setup(script)
      const writer = yield* Writer
      const userId = (yield* api.GetSession()).user.id
      const connectionId = (yield* api.GetGenerationDefaults()).model!.connection
      const model = yield* writer.AddUserModel({
        userId,
        connectionId,
        key: "priced-model",
        overrides: {},
        upstream: { price: { input: 100, output: 0 } }
      })
      const pick = `${connectionId} ${model.id}`
      yield* api.ChangeSubagentSettings({
        picks: ["same", pick],
        rows: { [pick]: { alias: "priced", note: "" } },
        limits: { cost: 0.5, runCostTimes: 1 }
      })
      const versionId = yield* task(api, chat, "look")
      yield* eventually(() => finished(events, versionId) !== undefined)
      assert.strictEqual(finished(events, versionId)?.status, "complete")
      assert.deepStrictEqual(
        childBodies(mock).map((body) => body.model),
        ["mock-model", "priced-model", "priced-model"]
      )
      assert.include(toolTexts(lastParent(mock))[2], "Stopped at its limit")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("a reply starts at most its per-reply count", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted({ parent: [START, { ...START, id: "again" }], child: () => undefined })
      const { api, chat, events, mock } = yield* setup(script)
      yield* api.ChangeSubagentSettings({ limits: { perRun: 1 } })
      const versionId = yield* task(api, chat, "look")
      yield* eventually(() => finished(events, versionId) !== undefined)
      const results = toolTexts(lastParent(mock))
      assert.include(results[0], "Report.")
      assert.include(results[1], "started as many subagents as it may")
      assert.lengthOf(childBodies(mock), 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a resumed reply can start a child after a lookup reuses a discarded spawn's ID", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const look = { name: "list_library", args: { kind: "card" }, id: "before" }
      const parent = [look, START]
      const script = scripted({ parent, child: () => undefined })
      const { api, chat, events, mock } = yield* setup(script)
      yield* api.ChangeSubagentSettings({ limits: { perRun: 1 } })
      const versionId = yield* task(api, chat, "look")
      yield* eventually(() => finished(events, versionId)?.status === "complete")
      assert.lengthOf(childBodies(mock), 1)

      parent[1] = { ...look, id: START.id }
      parent.push({ ...START, id: "fresh" })
      const slot = yield* (yield* Reader).GetSlot({
        userId: (yield* api.Whoami()).id,
        slotId: (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId!
      })
      const resumed = yield* api.ResumeFromStep({ versionId, step: 0, expectedRowVersion: slot.entry.rowVersion })
      yield* eventually(() => finished(events, resumed.version.id)?.status === "complete")
      assert.lengthOf(childBodies(mock), 2)
      assert.include(toolTexts(lastParent(mock)).at(-1), "Report.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("past the account's running count a subagent waits, queued, and runs once a place frees", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted({ parent: [START], child: () => undefined })
      const { api, chat, events, mock } = yield* setup(script)
      yield* api.ChangeSubagentSettings({ limits: { accountConcurrent: 1 } })
      const other: Chat = yield* api.CreateWorkshop({})
      const otherEvents: Array<ChatEvent> = yield* watch(api, other)
      script.hold()
      const first = yield* task(api, chat, "first")
      yield* eventually(() => script.heldCount() === 1)
      const second = yield* task(api, other, "second")
      yield* eventually(() => liveChild(otherEvents, second, "spawn")?.status === "queued")
      // Still queued: nothing of it was sent while the first one holds the account's place.
      assert.lengthOf(childBodies(mock), 1)
      script.release()
      yield* eventually(() => finished(events, first) !== undefined && finished(otherEvents, second) !== undefined)
      assert.strictEqual(finished(otherEvents, second)!.status, "complete")
      assert.strictEqual((yield* rowOf(api, second)).status, "done")
      assert.lengthOf(childBodies(mock), 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("its wall-time limit stops it even while a request is open", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted({ parent: [START], child: () => undefined })
      const { api, chat, events, mock } = yield* setup(script)
      yield* api.ChangeSubagentSettings({ limits: { minutes: 0.1 } })
      script.hold()
      const versionId = yield* task(api, chat, "look")
      yield* eventually(() => finished(events, versionId) !== undefined, 30_000)
      assert.include(toolTexts(lastParent(mock))[0], "Stopped at its limit")
      assert.strictEqual((yield* rowOf(api, versionId)).status, "limit")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
