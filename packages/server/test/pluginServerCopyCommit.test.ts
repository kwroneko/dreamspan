// A server plugin's working copy (spec/FILES-AND-ENVIRONMENT.md §5.3) sits in the admin's Files,
// which commands change: committing it with `plugin_commit from: "files"` always asks, even where
// plugins may be changed without asking, shows every file it changes, and takes only this one
// call's Allow (never "Allow in this workshop"). Real agent, workers and plugin host; a scripted
// model and synthetic data.
import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ApprovalPrompt } from "@dreamspan/shared/agent.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider, type Recorded } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { unquoteToolData } from "./support/toolData.ts"

interface Body {
  messages: Array<{ role: string; content?: string }>
}
const call = (name: string, args: unknown, id: string) => [
  {
    id: "tool",
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
    id: "tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]
const waiting = (events: ReadonlyArray<ChatEvent>, id: string): ApprovalPrompt | undefined => {
  const step = events
    .flatMap((e) => (e._tag === "Steps" && e.versionId === id ? e.steps : []))
    .filter((s) => s.kind === "tool" && s.status === "waiting")
    .at(-1)
  return step?.kind === "tool" ? step.approval : undefined
}
const copy = "/files/Plugins/Server/notes-hook"

it.live(
  "a server plugin's working copy is committed only with the admin's approval of this call, after its changes",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const requests: Array<Body> = []
      const steps: Array<[string, unknown]> = [
        ["plugin_create", { id: "notes-hook", name: "Notes hook", runs: "server" }],
        ["write_file", { path: `${copy}/NOTES.md`, content: "from the working copy\n" }],
        ["plugin_commit", { plugin: "instance:notes-hook", message: "From files", from: "files" }]
      ]
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider(async (r: Recorded, res) => {
            const b = r.body as unknown as Body
            if (!JSON.stringify(b.messages).includes("SERVER COPY")) return sse(res, completionChunks(["Ready."], {}))
            requests.push(b)
            const from = b.messages.findLastIndex((m) => m.role === "user" && m.content?.includes("SERVER COPY"))
            const done = b.messages.slice(from).filter((m) => m.role === "tool").length
            const step = steps[done]
            if (!step) return sse(res, completionChunks(["Done."], {}))
            sse(res, call(step[0], step[1], `server_copy_${done}`))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
        model: { context: 200000 }
      })
      assert.strictEqual((yield* api.Whoami()).role, "admin")
      const chat = yield* api.CreateWorkshop({ title: "Server copy" })
      // Plugins may be changed here without asking: the commit from Files still asks.
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "plugins.write", mode: "allow" })
      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const sent = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: chat.activeLeafSlotId,
          branch: false,
          content: "SERVER COPY: commit the server plugin from its working copy."
        })
      )
      const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      const id = reply.entry.version.id
      yield* eventually(() => waiting(events, id) !== undefined, 90_000)
      const approval = waiting(events, id)!
      assert.isTrue(approval.once)
      assert.include(approval.title, "notes-hook")
      const change = approval.changes?.find((c) => c.field === "NOTES.md")
      assert.deepStrictEqual(change, { field: "NOTES.md", before: "", after: "from the working copy\n" })
      // No standing answer for this question.
      const standing = yield* api.AnswerToolApproval({ ...approval, answer: "allow_chat" }).pipe(Effect.flip)
      assert.strictEqual(standing._tag, "ApprovalRefused")
      yield* api.AnswerToolApproval({ ...approval, answer: "allow" })
      yield* eventually(() => finished(events, id) !== undefined, 90_000)
      const results = requests
        .at(-1)!
        .messages.filter((m) => m.role === "tool")
        .map((m) => unquoteToolData(m.content ?? ""))
      assert.match(results[2]!, /"commit":"[a-f0-9]{40}"/)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  },
  180_000
)
