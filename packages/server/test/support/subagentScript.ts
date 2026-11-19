// A scripted loopback provider for subagent tests (spec/SUBAGENTS.md): the reply calls the tools
// it's scripted to, in turn, then answers; a subagent (its first message is its instructions)
// calls its own, then reports. Every answer can carry token usage, and a subagent's request can be
// held until the test releases it. Synthetic data only.
import type { ServerResponse } from "node:http"
import { Effect, Stream } from "effect"
import type { RolloutStep } from "@dreamspan/shared/agent.ts"
import type { Chat, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { client } from "./config.ts"
import { posted } from "./config.ts"
import { eventually } from "./generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./mockProvider.ts"

export type Api = Effect.Success<ReturnType<typeof client>>
interface Message {
  readonly role: string
  readonly content?: unknown
}
export interface Body {
  readonly model?: string
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string; readonly description?: string } }>
}
export interface Call {
  readonly name: string
  readonly args: unknown
  readonly id: string
}

export const TRIGGER = "Workshop task:"
const CHILD = "You are a subagent"

export const isChild = (body: Body) => JSON.stringify(body.messages[0]?.content ?? "").includes(CHILD)

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
 * `parent`: the reply's calls, in turn; `child(n, body)`: the subagent's n-th answer (a call, or
 * undefined to report). `usage`: what each subagent answer reports. `hold()` holds the next
 * subagent request until `release()`.
 */
export const scripted = (options: {
  readonly parent: ReadonlyArray<Call>
  readonly child: (done: number, body: Body) => Call | undefined
  readonly report?: string
  readonly answer?: string
  readonly usage?: Record<string, unknown>
}) => {
  let holding = false
  const held: Array<() => void> = []
  const usage = options.usage ?? {}
  const handler = (request: Recorded, res: ServerResponse) => {
    const body = request.body as unknown as Body
    const messages = body.messages
    if (isChild(body)) {
      const done = messages.filter((m) => m.role === "tool").length
      const answer = () => {
        const step = options.child(done, body)
        sse(res, step ? toolCall(step, usage) : completionChunks([options.report ?? "Report."], usage))
      }
      if (holding) {
        holding = false
        held.push(answer)
        return
      }
      return answer()
    }
    if (!JSON.stringify(messages).includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
    const lastTask = messages.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content).includes(TRIGGER))
    const done = messages.slice(lastTask).filter((m) => m.role === "tool").length
    const step = options.parent[done]
    sse(res, step ? toolCall(step, {}) : completionChunks([options.answer ?? "Done."], {}))
  }
  return {
    handler,
    hold: () => {
      holding = true
    },
    heldCount: () => held.length,
    release: () => held.splice(0).forEach((answer) => answer())
  }
}

export const mockProvider = (handler: (request: Recorded, res: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

export const watch = (api: Api, chat: Chat) =>
  Effect.gen(function* () {
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    return events
  })

const lastSteps = (events: ReadonlyArray<ChatEvent>, versionId: string): ReadonlyArray<RolloutStep> =>
  events.flatMap((e) => (e._tag === "Steps" && e.versionId === versionId ? [e.steps] : [])).at(-1) ?? []

/** The subagent row the call `callId` shows live, if any. */
export const liveChild = (events: ReadonlyArray<ChatEvent>, versionId: string, callId: string) => {
  const step = lastSteps(events, versionId).find((s) => s.kind === "tool" && s.id === callId)
  return step?.kind === "tool" ? step.subagent : undefined
}

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

export const completions = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)

export const toolTexts = (body: Body) =>
  body.messages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))

/** The `agent` tool's description as a request offered it. */
export const agentDescription = (body: Body) =>
  body.tools?.find((t) => t.function.name === "agent")?.function.description ?? null
