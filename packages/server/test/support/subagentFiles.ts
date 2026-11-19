// A loopback workshop for subagents that work on files (spec/SUBAGENTS.md §3.3): the reply makes
// its calls in turn, and each subagent (a fork too) runs the script its task names (`[[name]]`),
// then reports. A subagent's request can be held after n of its results. Synthetic data only.
import type { ServerResponse } from "node:http"
import { execFileSync } from "node:child_process"
import { Effect, Stream } from "effect"
import type { Chat, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { client, posted } from "./config.ts"
import { eventually, finished, generateReply } from "./generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./mockProvider.ts"
import { unquoteToolData } from "./toolData.ts"

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
}

const TRIGGER = "Workshop task:"
const CHILD = "You are a subagent"
/** A fork's task (subagents.ts `forkTask`). */
export const FORK = "From here on you are a subagent"

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

const text = (m: Message | undefined) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""))
/** Where a subagent's own run starts in its request: its task (a fork's comes after the reply's conversation). */
const ownStart = (messages: ReadonlyArray<Message>) => {
  const fork = messages.findLastIndex((m) => text(m).includes(FORK))
  return fork >= 0 ? fork : text(messages[0]).includes(CHILD) ? 1 : -1
}
const isChild = (body: Body) => ownStart(body.messages) >= 0
const childName = (body: Body) => /\[\[(\w+)\]\]/.exec(text(body.messages[ownStart(body.messages)]))?.[1] ?? ""

/**
 * The reply calls `parent` in turn; each child runs the script its task names, then reports.
 * `hold(name, n)`: that child's request after n of its results waits until `release()`.
 */
export const scripted = (parent: ReadonlyArray<Call>, children: Readonly<Record<string, ReadonlyArray<Call>>>) => {
  let holding: { readonly name: string; readonly at: number } | null = null
  let held: (() => void) | null = null
  const handler = (request: Recorded, res: ServerResponse) => {
    const body = request.body as unknown as Body
    if (!body?.messages) return sse(res, completionChunks(["Ready."], {}))
    const messages = body.messages
    if (isChild(body)) {
      const name = childName(body)
      const done = messages.slice(ownStart(messages)).filter((m) => m.role === "tool").length
      const step = children[name]?.[done]
      const answer = () => {
        // A request the reply's stop cut off meanwhile gets no answer.
        if (res.destroyed || res.writableEnded) return
        sse(res, step ? toolCall(step.name, step.args, `${name}-${done}`) : completionChunks([`Report ${name}.`], {}))
      }
      if (holding && holding.name === name && holding.at === done) {
        held = answer
        return
      }
      return answer()
    }
    if (!JSON.stringify(messages).includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
    const last = messages.findLastIndex((m) => m.role === "user" && text(m).includes(TRIGGER))
    const done = messages.slice(last).filter((m) => m.role === "tool").length
    const step = parent[done]
    sse(res, step ? toolCall(step.name, step.args, `parent-${done}`) : completionChunks(["Done."], {}))
  }
  return {
    handler,
    hold: (name: string, at: number) => {
      holding = { name, at }
    },
    isHeld: () => held !== null,
    release: () => {
      holding = null
      const answer = held
      held = null
      answer?.()
    }
  }
}

/** A workshop on the scripted provider, its chat's events collected. */
export const filesWorkshop = (handler: (request: Recorded, res: ServerResponse) => void) =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider(handler)),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
      model: { context: 200000 }
    })
    const chat = yield* api.CreateWorkshop({})
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const me = yield* api.Whoami()
    return { mock, api, chat, events, me }
  })

/** Sends `Workshop task: <content>` and asks for the reply; doesn't wait for it. */
export const startTask = (api: Api, chat: Chat, content: string) =>
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

/** Runs a task to its end. */
export const runTask = (api: Api, chat: Chat, events: ReadonlyArray<ChatEvent>, content: string) =>
  Effect.gen(function* () {
    const versionId = yield* startTask(api, chat, content)
    yield* eventually(() => finished(events, versionId) !== undefined, 120_000)
    return versionId
  })

const bodies = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as unknown as Body)
/** A request's tool results, unquoted. */
export const results = (body: Body) =>
  body.messages.filter((m) => m.role === "tool").map((m) => unquoteToolData(text(m)))
/** A child's own tool results in a request, unquoted: a fork's from its task on. */
export const ownResults = (body: Body) => results({ messages: body.messages.slice(ownStart(body.messages)) })
/** The requests of the child whose task names `name`. */
export const childOf = (requests: ReadonlyArray<Recorded>, name: string) =>
  bodies(requests).filter((b) => isChild(b) && childName(b) === name)
/** The reply's own results so far (its last request's). */
export const parentResults = (requests: ReadonlyArray<Recorded>) => {
  const last = bodies(requests)
    .filter((b) => !isChild(b) && JSON.stringify(b.messages).includes(TRIGGER))
    .at(-1)
  return last ? last.messages.filter((m) => m.role === "tool").map(text) : []
}

export const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { encoding: "utf8" }).trim()
