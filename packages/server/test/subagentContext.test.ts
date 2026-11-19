// Subagents, milestone SA7 (spec/SUBAGENTS.md §2.3, §10): a long subagent is summarized as it
// goes, with the same request-boundary compaction a workshop reply uses. Synthetic data and a
// scripted loopback provider only.
import type { ServerResponse } from "node:http"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Chat, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { newCardDoc } from "@dreamspan/shared/editing.ts"
import { Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>
interface Message {
  readonly role: string
  readonly content?: unknown
}
interface Body {
  readonly model?: string
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string } }>
}

const TRIGGER = "Workshop task:"
const CHILD = "You are a subagent"
const MEMORY = "SAVED CHILD MEMORY: the keeper was read; nothing changed."
const RAW = "RAW OLD LOOKUP"

const toolCall = (name: string, args: unknown, id: string) => [
  {
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
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
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]

const text = (body: Body) => JSON.stringify(body.messages)
const isSummary = (body: Body) => !Array.isArray(body.tools) || body.tools.length === 0
const isChild = (body: Body) => !isSummary(body) && JSON.stringify(body.messages[0]?.content ?? "").includes(CHILD)

const workshop = (handler: (request: Recorded, res: ServerResponse) => void) =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider(handler)),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
    const chat = yield* api.CreateWorkshop({})
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    return { mock, api, chat, events }
  })

const task = (api: Api, chat: Chat, content: string) =>
  Effect.gen(function* () {
    const current = yield* api.GetChat({ chatId: chat.id })
    const sent = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: current.activeLeafSlotId,
        branch: false,
        content: `${TRIGGER} ${content}`
      })
    )
    const generated = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
    return generated.entry.version.id as VersionId
  })

const completions = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)

describe("subagent context (SA7)", () => {
  it.live("a long subagent is summarized as it goes, as a workshop reply is", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let childRequests = 0
      const READS = 6
      const handler = (request: Recorded, res: ServerResponse) => {
        const body = request.body as unknown as Body
        if (!body?.messages) return sse(res, completionChunks(["Ready."], {}))
        if (isSummary(body)) return sse(res, completionChunks([MEMORY], {}))
        if (isChild(body)) {
          const n = childRequests++
          return sse(
            res,
            n < READS
              ? toolCall("read_card", { card: `Synthetic keeper ${n}`, fields: ["description"] }, `child-read-${n}`)
              : completionChunks(["Report: the keeper's description is long."], {})
          )
        }
        if (!text(body).includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
        const answered = body.messages.some((m) => m.role === "tool")
        return sse(
          res,
          answered
            ? completionChunks(["Done."], {})
            : toolCall("agent", { type: "research", task: "Read the six keepers' descriptions." }, "spawn")
        )
      }
      const { api, chat, events, mock } = yield* workshop(handler)
      const me = yield* api.Whoami()
      for (let n = 0; n < READS; n++)
        yield* (yield* Writer).CreateEntity({
          userId: me.id,
          kind: "card",
          label: `Synthetic keeper ${n}`,
          subtitle: "",
          schemaVersion: 1,
          origin: "user",
          sourcePath: null,
          doc: {
            ...newCardDoc(`Synthetic keeper ${n}`),
            description: `${RAW} ` + Array.from({ length: 420 }, (_, i) => `word${i}`).join(" ")
          }
        })
      // The workshop's own summary sizes, small enough that six reads pass the recent maximum.
      yield* api.ChangeLcmSettings({
        chatId: chat.id,
        change: { recentTarget: 1000, recentMax: 2200, leafInput: 500, leafTarget: 150, when: "next-reply" }
      })
      const versionId = yield* task(api, chat, "read the keeper through a subagent")
      yield* eventually(() => finished(events, versionId) !== undefined, 60_000)
      assert.strictEqual(finished(events, versionId)!.status, "complete")

      const bodies = completions(mock.requests())
      const children = bodies.filter(isChild)
      assert.lengthOf(children, READS + 1)
      // Summary requests were made for the child's own steps, as a reply's are summarized.
      const summaries = bodies.filter((b) => isSummary(b) && text(b).includes("child-read-0"))
      assert.isAbove(summaries.length, 0, "the child's transcript was summarized")
      // The child's last request carries the summary instead of every read it made.
      const last = children.at(-1)!
      assert.include(text(last), MEMORY.slice(0, 20))
      const raws = text(last).split(RAW).length - 1
      assert.isBelow(raws, READS, "summarized reads aren't sent again")
      assert.include(text(last), "child-read-5", "the newest read is sent as it came")
      // The summary is saved in the child's own transcript, append-only.
      const [rows] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT p.transcript_json AS t FROM rollouts r JOIN rollout_payloads p ON p.rollout_id = r.id WHERE r.spawned_by_rollout_id IS NOT NULL"
          }
        ],
        { readOnly: true }
      )
      const transcript = JSON.parse(String(rows![0]!["t"])) as ReadonlyArray<AgentMessage>
      assert.isTrue(transcript.some((m) => m.role === "rpCompaction"))
      assert.strictEqual(
        transcript.filter((m) => m.role === "toolResult").length,
        READS,
        "every original result is kept"
      )
      // The row is done, its report back with the reply.
      const steps = yield* api.GetRolloutSteps({ versionId })
      const spawn = steps.find((s) => s.kind === "tool" && s.id === "spawn")
      assert.strictEqual(spawn?.kind === "tool" ? spawn.subagent?.status : undefined, "done")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
