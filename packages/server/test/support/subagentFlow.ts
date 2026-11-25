// A loopback workshop for subagent flow tests (spec/SUBAGENTS.md): the reply's turns and each
// subagent's come from functions of the request's messages (a turn may wait on a promise the test
// settles), a subagent's request can be held after n of its results, and a second connection on its
// own loopback provider stands for a model the user may pick for subagents. Synthetic data only.
import { OPEN_LIBRARY } from "./libraryGrants.ts"
import type { ServerResponse } from "node:http"
import { Effect, Stream } from "effect"
import type { Chat, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Reader } from "../../src/db/Database.ts"
import { client, posted } from "./config.ts"
import { eventually, generateReply } from "./generation.ts"
import { fixtureSql } from "./lcmFixtures.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./mockProvider.ts"

export type Api = Effect.Success<ReturnType<typeof client>>
export interface Message {
  readonly role: string
  readonly content?: unknown
}
export interface Body {
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string } }>
}
export interface Call {
  readonly name: string
  readonly args: unknown
  readonly id: string
}
/** A turn: a tool call, or text that ends it. */
export type Reply = { readonly call: Call } | string

const TRIGGER = "Workshop task:"
const CHILD = "You are a subagent"

const isChild = (body: Body) => JSON.stringify(body.messages[0]?.content ?? "").includes(CHILD)
export const text = (m: Message) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))
/** The reply's messages since the last task. */
const sinceTask = (messages: ReadonlyArray<Message>) =>
  messages.slice(messages.findLastIndex((m) => m.role === "user" && text(m).includes(TRIGGER)))
export const toolResults = (messages: ReadonlyArray<Message>) => messages.filter((m) => m.role === "tool").map(text)
export const toolsDone = (messages: ReadonlyArray<Message>) => messages.filter((m) => m.role === "tool").length

const toolCall = (call: Call, usage: Record<string, unknown>) => [
  {
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) }
            }
          ]
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
  },
  { id: "cmpl-tool", object: "chat.completion.chunk", model: "mock", choices: [], usage }
]

/**
 * A loopback provider. `parent(messages)`: the reply's next turn, from its messages since the task
 * (a promise waits); `child(messages)`: a subagent's. `holdChild(at)` holds a subagent's request
 * after `at` of its results until `holdChild(null)`; `usage`: what each subagent answer reports.
 */
export const scripted = (options: {
  readonly parent: (messages: ReadonlyArray<Message>) => Reply | Promise<Reply>
  readonly child: (messages: ReadonlyArray<Message>) => Reply
  readonly usage?: Record<string, unknown>
}) => {
  let holdAt: number | null = null
  let held = false
  let release: (() => void) | null = null
  const usage = options.usage ?? {}
  const send = (res: ServerResponse, r: Reply, u: Record<string, unknown>) => {
    if (res.destroyed || res.writableEnded) return
    sse(res, typeof r === "string" ? completionChunks([r], u) : toolCall(r.call, u))
  }
  const handler = (request: Recorded, res: ServerResponse) => {
    const body = request.body as unknown as Body
    if (isChild(body)) {
      if (holdAt === toolsDone(body.messages)) {
        held = true
        release = () => send(res, options.child(body.messages), usage)
        return
      }
      return send(res, options.child(body.messages), usage)
    }
    if (!JSON.stringify(body.messages).includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
    void Promise.resolve(options.parent(sinceTask(body.messages))).then((r) => send(res, r, {}))
  }
  return {
    handler,
    holdChild: (at: number | null) => {
      holdAt = at
      held = false
      if (at === null) {
        const answer = release
        release = null
        answer?.()
      }
    },
    isHeld: () => held
  }
}

/** A promise the test settles: a reply's turn waits on it. */
export const gate = () => {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

export const mockProvider = (handler: (request: Recorded, res: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

/** A workshop on the scripted provider, its chat's events collected, and a story to read. */
export const workshop = (handler: (request: Recorded, res: ServerResponse) => void) =>
  Effect.gen(function* () {
    const mock = yield* mockProvider(handler)
    const api = yield* client()
    const story = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
      model: {}
    })
    const chat = yield* api.CreateWorkshop({ grants: OPEN_LIBRARY })
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    return { mock, api, chat, events, story: story.chat }
  })

/** A second connection with one model (`cheap-model`), on its own provider: a pick for subagents. */
export const secondConnection = (api: Api, url: string) =>
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

/** Sends `Workshop task: <content>` and asks for the reply. */
export const task = (api: Api, chat: Chat, content: string) =>
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

/** Resumes the reply as the chat shows it now. */
export const resume = (api: Api, chat: Chat, versionId: VersionId) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const slotId = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId!
    const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId })
    const resumed = yield* api.ResumeVersion({ versionId, expectedRowVersion: slot.entry.rowVersion })
    return resumed.version.id as VersionId
  })

/** Carries the reply on from one of its steps, as the chat shows it now. */
export const resumeFromStep = (api: Api, chat: Chat, versionId: VersionId, step: number) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const slotId = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId!
    const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId })
    const carried = yield* api.ResumeFromStep({ versionId, step, expectedRowVersion: slot.entry.rowVersion })
    return carried.version.id as VersionId
  })

/** Cuts a stopped reply's saved transcript just after the call, as a crash before its result was saved leaves it. */
export const cutAfterCall = (dataDir: string, versionId: VersionId, callId: string) =>
  Effect.gen(function* () {
    const [rows] = yield* fixtureSql(
      dataDir,
      [
        {
          sql: "SELECT p.rollout_id, p.transcript_json FROM rollout_payloads p JOIN versions v ON v.rollout_id = p.rollout_id WHERE v.id = ?",
          params: [versionId]
        }
      ],
      { readOnly: true }
    )
    const row = rows![0]!
    const messages = JSON.parse(String(row["transcript_json"])) as Array<{ role: string; toolCallId?: string }>
    const at = messages.findIndex((m) => m.role === "toolResult" && m.toolCallId === callId)
    yield* fixtureSql(dataDir, [
      {
        sql: "UPDATE rollout_payloads SET transcript_json = ? WHERE rollout_id = ?",
        params: [JSON.stringify(messages.slice(0, at)), String(row["rollout_id"])]
      }
    ])
  })

/** The subagents' rollouts, oldest first. */
export const childRollouts = (dataDir: string) =>
  Effect.map(
    fixtureSql(
      dataDir,
      [
        {
          sql: "SELECT id, status, agent_handle, spawned_by_call_id, parent_rollout_id, connection_id FROM rollouts WHERE spawned_by_rollout_id IS NOT NULL ORDER BY created_at, id"
        }
      ],
      { readOnly: true }
    ),
    ([rows]) => rows!
  )

const completions = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)
export const parents = (requests: ReadonlyArray<Recorded>) =>
  completions(requests).filter((b) => !isChild(b) && JSON.stringify(b.messages).includes(TRIGGER))
export const children = (requests: ReadonlyArray<Recorded>) => completions(requests).filter(isChild)

export const stepsEvents = (events: ReadonlyArray<ChatEvent>) => events.flatMap((e) => (e._tag === "Steps" ? [e] : []))
/** The newest row the call `id` showed, on any message. */
export const liveRow = (events: ReadonlyArray<ChatEvent>, id: string) =>
  stepsEvents(events)
    .map((e) => {
      const step = e.steps.find((s) => s.kind === "tool" && s.id === id)
      return step?.kind === "tool" ? step.subagent : undefined
    })
    .filter((r) => r !== undefined)
    .at(-1)
