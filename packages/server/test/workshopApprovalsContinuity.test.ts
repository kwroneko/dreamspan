// Approvals and undo with several messages and carried turns (spec/WORKSHOP.md §2.3–§2.4, §3.4,
// §3.6; W4 on W5): a call waits in the message whose step it is and survives a reload, Stop and a
// restart there; each change is recorded once and listed from the message that made it on; a
// carried turn asks again rather than replaying an earlier answer; an undo makes the next turn
// rebuild; turning a capability off rebuilds too. Synthetic data and a scripted provider only.
import type { ServerResponse } from "node:http"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { ApprovalPrompt } from "@dreamspan/shared/agent.ts"
import type { Chat, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Reader } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

type Api = Effect.Success<ReturnType<typeof client>>
interface Body {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>
  readonly tools?: ReadonlyArray<{ readonly function: { readonly name: string } }>
}
const TRIGGER = "Workshop task:"
const call = (name: string, args: unknown, id: string) => [
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
type Step = { readonly name: string; readonly args: unknown; readonly id: string }
/**
 * Calls these tools in turn after the latest task, one a request; then answers. A task whose text
 * doesn't include "make" only answers.
 */
const scripted =
  (steps: ReadonlyArray<Step>, answer = "Done.") =>
  (request: Recorded, res: ServerResponse) => {
    const messages = (request.body as unknown as Body).messages
    if (!JSON.stringify(messages).includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
    const lastTask = messages.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content).includes(TRIGGER))
    const making = JSON.stringify(messages[lastTask]?.content).includes("make")
    const step = making ? steps[messages.slice(lastTask).filter((m) => m.role === "tool").length] : undefined
    sse(res, step ? call(step.name, step.args, step.id) : completionChunks([answer], {}))
  }

const watch = (api: Api, chat: Chat) =>
  Effect.gen(function* () {
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    return events
  })
/**
 * The version whose latest steps show this call waiting, with what it asks; `besides`: not in that
 * run (a stopped run's last steps still show its old wait).
 */
const waitingCall = (events: ReadonlyArray<ChatEvent>, toolCallId: string, besides?: string) => {
  const latest = new Map<string, ChatEvent & { _tag: "Steps" }>()
  for (const e of events) if (e._tag === "Steps") latest.set(e.versionId, e)
  for (const [versionId, e] of latest) {
    const step = e.steps.find((s) => s.kind === "tool" && s.id === toolCallId)
    if (step?.kind === "tool" && step.status === "waiting" && step.approval && step.approval.rolloutId !== besides)
      return { versionId: versionId as VersionId, approval: step.approval }
  }
  return undefined
}
const awaitCall = (events: ReadonlyArray<ChatEvent>, toolCallId: string, besides?: string) =>
  Effect.gen(function* () {
    yield* eventually(() => waitingCall(events, toolCallId, besides) !== undefined)
    return waitingCall(events, toolCallId, besides)!
  })
const answer = (api: Api, prompt: ApprovalPrompt, reply: "allow" | "allow_chat" | "deny") =>
  api.AnswerToolApproval({
    rolloutId: prompt.rolloutId,
    toolCallId: prompt.toolCallId,
    digest: prompt.digest,
    answer: reply
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
    return generated.entry.version.id
  })
const path = (api: Api, chat: Chat) =>
  Effect.gen(function* () {
    const current = yield* api.GetChat({ chatId: chat.id })
    return (yield* api.ReadPath({
      chatId: chat.id,
      leafSlotId: current.activeLeafSlotId,
      range: { _tag: "Bottom" },
      limit: 100
    })).entries
  })
const cards = (api: Api, label: string) =>
  Effect.map(api.ListLibrary({ kind: "card" }), (refs) => refs.filter((r) => r.label === label).length)
const resume = (api: Api, chat: Chat, versionId: VersionId) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const entry = (yield* path(api, chat)).find((e) => e.version.id === versionId)!
    const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId: entry.slotId })
    return yield* api.ResumeVersion({ versionId, expectedRowVersion: slot.entry.rowVersion })
  })
const approvals = (dataDir: string, toolCallId: string) =>
  Effect.map(
    fixtureSql(
      dataDir,
      [
        {
          sql: `SELECT rollout_id, status FROM tool_approvals WHERE tool_call_id = '${toolCallId}' ORDER BY created_at`
        }
      ],
      { readOnly: true }
    ),
    ([rows]) => rows as unknown as ReadonlyArray<{ rollout_id: string; status: string }>
  )
/** A client; with a provider's address, its model set up as the account default. */
const setup = (url?: string) =>
  Effect.gen(function* () {
    const api = yield* client()
    if (url)
      yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${url}/v1` },
        model: {},
        preset: { openai_max_context: 32768 }
      })
    return api
  })
const material = (api: Api, versionId: string) =>
  Effect.gen(function* () {
    const me = yield* api.Whoami()
    const stored = yield* (yield* Reader).RolloutMaterial({ userId: me.id, versionId: versionId as VersionId })
    return JSON.parse(stored.snapshot).continuity as { readonly parent?: unknown; readonly reason?: string }
  })
const provider = (handler: (request: Recorded, res: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

describe("workshop approvals with several messages and carried turns", () => {
  it.live(
    "a call waits in its own message; Stop cancels it there, Resume asks again, and each change is listed once from its message on",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const handler = scripted([
          { name: "create_card", args: { name: "First keeper" }, id: "m1" },
          { name: "send_message", args: { message: "Made the first keeper." }, id: "s1" },
          { name: "create_card", args: { name: "Second keeper" }, id: "m2" }
        ])
        const mock = yield* provider(handler)
        const api = yield* setup(mock.url)
        const chat = yield* api.CreateWorkshop({})
        const events = yield* watch(api, chat)
        yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
        const working = yield* task(api, chat, "make two keepers")
        const first = yield* awaitCall(events, "m1")
        assert.strictEqual(first.versionId, working)
        yield* answer(api, first.approval, "allow")
        // The second call waits in the second message, not the first.
        const second = yield* awaitCall(events, "m2")
        assert.notStrictEqual(second.versionId, working)
        const late = yield* watch(api, chat)
        const hello = late.find((e) => e._tag === "Hello")
        assert.isTrue(
          hello?._tag === "Hello" &&
            hello.live.some(
              (l) =>
                l.versionId === second.versionId &&
                l.steps?.some((s) => s.kind === "tool" && s.id === "m2" && s.status === "waiting")
            ),
          "a reload sees the wait in its message"
        )
        yield* api.StopGeneration({ versionId: second.versionId })
        yield* eventually(() => finished(events, second.versionId) !== undefined)
        assert.deepStrictEqual(
          (yield* approvals(config.dataDir, "m2")).map((r) => r.status),
          ["cancelled"]
        )
        assert.strictEqual(yield* cards(api, "Second keeper"), 0)
        const resumed = yield* resume(api, chat, second.versionId)
        const again = yield* awaitCall(events, "m2", second.approval.rolloutId)
        assert.strictEqual(again.versionId, resumed.version.id)
        assert.isFalse(again.approval.uncertain)
        yield* answer(api, again.approval, "allow")
        yield* eventually(() => finished(events, resumed.version.id) !== undefined)
        assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")

        // Each change once, on the run and call that made it.
        const all = yield* api.ListRolloutEffects({ chatId: chat.id })
        assert.deepStrictEqual(all.map((e) => e.toolCallId).sort(), ["m1", "m2"])
        assert.strictEqual(all.find((e) => e.toolCallId === "m1")!.rolloutId, first.approval.rolloutId)
        assert.strictEqual(all.find((e) => e.toolCallId === "m2")!.rolloutId, again.approval.rolloutId)
        // The first message's own call is done there; the stopped run's unanswered call shows
        // as failed in that run's tail, so its change appears once, under the message that made it.
        const replies = (yield* path(api, chat)).filter((e) => e.side === "assistant")
        const firstMessage = replies.find((e) => e.version.id === working)!
        const firstSteps = (yield* api.GetRolloutSteps({ versionId: firstMessage.version.id })).flatMap((s) =>
          s.kind === "tool" ? [[s.id, s.status]] : []
        )
        assert.deepStrictEqual(firstSteps[0], ["m1", "done"])
        assert.isFalse(firstSteps.some(([id, status]) => id === "m2" && status === "done"))
        assert.deepStrictEqual(
          (yield* api.GetRolloutSteps({ versionId: resumed.version.id })).flatMap((s) =>
            s.kind === "tool" && s.status === "done" ? [s.id] : []
          ),
          ["m2"]
        )
        assert.deepStrictEqual(
          (yield* api.ListVersionEffects({ versionId: resumed.version.id })).map((e) => e.toolCallId),
          ["m2"],
          "the second message's warning leaves out the first message's change"
        )
        assert.deepStrictEqual(
          (yield* api.ListVersionEffects({ versionId: firstMessage.version.id })).map((e) => e.toolCallId),
          ["m1"],
          "the first message lists its own change; the second call ran in a resumed run of the second message"
        )
        assert.strictEqual(yield* cards(api, "First keeper"), 1)
        assert.strictEqual(yield* cards(api, "Second keeper"), 1)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live(
    "a new version of the k-th message keeps its own calls, undoes nothing and makes later changes again only when asked",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const handler = scripted([
          { name: "create_card", args: { name: "Earlier keeper" }, id: "k1" },
          { name: "send_message", args: { message: "Made the earlier keeper." }, id: "ks" },
          { name: "create_card", args: { name: "Later keeper" }, id: "k2" }
        ])
        const mock = yield* provider(handler)
        const api = yield* setup(mock.url)
        const chat = yield* api.CreateWorkshop({})
        const events = yield* watch(api, chat)
        const working = yield* task(api, chat, "make keepers")
        yield* eventually(() =>
          events.some((e) => e._tag === "Version" && e.version.content === "Done." && e.version.status === "complete")
        )
        const replies = (yield* path(api, chat)).filter((e) => e.side === "assistant")
        const firstMessage = replies.find((e) => e.version.id === working)!
        const last = replies.at(-1)!
        assert.deepStrictEqual(
          (yield* api.ListVersionEffects({ versionId: firstMessage.version.id })).map((e) => e.toolCallId),
          ["k2", "k1"],
          "the first message's changes and the run's later ones"
        )
        assert.deepStrictEqual(
          (yield* api.ListVersionEffects({ versionId: last.version.id })).map((e) => e.toolCallId),
          ["k2"]
        )
        const before = yield* api.ListRolloutEffects({ chatId: chat.id })
        const user = yield* api.Whoami()
        const reader = yield* Reader
        const visibleAt = (leafSlotId: typeof last.slotId) =>
          reader.LibraryAccess({
            userId: user.id,
            chatId: chat.id,
            forkId: chat.currentForkId,
            leafSlotId,
            rolloutId: "next-reply",
            entities: [],
            refs: [],
            card: null
          })
        const earlier = before.find((effect) => effect.toolCallId === "k1")!.targetId
        const later = before.find((effect) => effect.toolCallId === "k2")!.targetId
        assert.sameMembers([...(yield* visibleAt(firstMessage.slotId)).inView], [earlier])
        assert.sameMembers([...(yield* visibleAt(last.slotId)).inView], [earlier, later])

        yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
        // The last message's new version keeps its own call (only the answer is written again).
        const lastAgain = yield* api.Regenerate({ slotId: last.slotId, expectedRowVersion: last.rowVersion })
        yield* eventually(() => finished(events, lastAgain.version.id) !== undefined)
        assert.strictEqual(finished(events, lastAgain.version.id)!.status, "complete")
        assert.isUndefined(waitingCall(events, "k2"), "its kept call didn't ask or run again")
        assert.deepStrictEqual(yield* api.ListRolloutEffects({ chatId: chat.id }), before)
        // The first message's new version keeps its own call; the run carries on after it and
        // makes the later change again only if allowed. Nothing was undone.
        const firstAgain = yield* api.Regenerate({
          slotId: firstMessage.slotId,
          expectedRowVersion: firstMessage.rowVersion
        })
        const asked = yield* awaitCall(events, "k2", before[0]!.rolloutId)
        assert.notStrictEqual(asked.approval.rolloutId, before[0]!.rolloutId)
        assert.deepStrictEqual(
          (yield* api.ListRolloutEffects({ chatId: chat.id })).map((e) => e.undoneAt),
          before.map(() => null)
        )
        yield* answer(api, asked.approval, "deny")
        yield* eventually(() => finished(events, asked.versionId) !== undefined)
        assert.deepStrictEqual(yield* api.ListRolloutEffects({ chatId: chat.id }), before)
        assert.deepStrictEqual(
          (yield* api.ListVersionEffects({ versionId: firstAgain.version.id })).map((e) => e.toolCallId),
          ["k1"],
          "the new first message kept the earlier change; the denied call made none"
        )
        assert.strictEqual(yield* cards(api, "Earlier keeper"), 1)
        assert.strictEqual(yield* cards(api, "Later keeper"), 1)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("a call in a carried turn asks again rather than reusing an earlier answer, and survives a restart", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const handler = scripted([{ name: "create_card", args: { name: "Carried keeper" }, id: "c1" }])
      const mock = yield* provider(handler)
      const parked = yield* Effect.gen(function* () {
        const api = yield* setup(mock.url)
        const chat = yield* api.CreateWorkshop({})
        const events = yield* watch(api, chat)
        yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
        const turn1 = yield* task(api, chat, "make one keeper")
        const first = yield* awaitCall(events, "c1")
        yield* answer(api, first.approval, "allow")
        yield* eventually(() => finished(events, turn1 as VersionId) !== undefined)
        // The next turn carries the first on and uses the same call id: it asks again.
        const turn2 = yield* task(api, chat, "make another keeper")
        const asked = yield* awaitCall(events, "c1", first.approval.rolloutId)
        assert.strictEqual(asked.versionId, turn2)
        assert.isDefined((yield* material(api, turn2)).parent, "the second turn is carried")
        return { chat, turn2: turn2 as VersionId }
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
      // A process that dies leaves the approval pending (a clean shutdown cancels it).
      yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE tool_approvals SET status = 'pending' WHERE status = 'cancelled' AND tool_call_id = 'c1'" }
      ])
      yield* Effect.gen(function* () {
        const api = yield* setup()
        const events = yield* watch(api, parked.chat)
        const entry = (yield* path(api, parked.chat)).find((e) => e.version.id === parked.turn2)!
        assert.strictEqual(entry.version.status, "interrupted")
        const resumed = yield* resume(api, parked.chat, parked.turn2)
        const again = yield* awaitCall(events, "c1")
        assert.strictEqual(again.versionId, resumed.version.id)
        assert.isFalse(again.approval.uncertain, "a call that only waited never ran")
        yield* answer(api, again.approval, "deny")
        yield* eventually(() => finished(events, resumed.version.id) !== undefined)
        assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")
        assert.strictEqual(yield* cards(api, "Carried keeper"), 1)
        assert.isFalse(
          (yield* api.ListWorkshopCapabilities({ chatId: parked.chat.id })).some(
            (c) => c.id === "library.write" && c.mode === "allow"
          ),
          "allowing once saved no grant"
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }).pipe(Effect.scoped)
  })

  it.live("an undo from Changes and an Off choice each make the next turn rebuild; nothing is replayed", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const handler = scripted([{ name: "create_card", args: { name: "Undone keeper" }, id: "u1" }])
      const mock = yield* provider(handler)
      const api = yield* setup(mock.url)
      const chat = yield* api.CreateWorkshop({})
      const events = yield* watch(api, chat)
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
      const turn1 = yield* task(api, chat, "make one keeper")
      const first = yield* awaitCall(events, "u1")
      yield* answer(api, first.approval, "allow")
      yield* eventually(() => finished(events, turn1 as VersionId) !== undefined)
      const turn2 = yield* task(api, chat, "say hello")
      yield* eventually(() => finished(events, turn2 as VersionId) !== undefined)
      assert.isDefined((yield* material(api, turn2)).parent, "a plain turn carries the first on")

      // Undo from Changes: the next turn is put together again, and its call asks again.
      yield* api.UndoRolloutEffect((yield* api.ListRolloutEffects({ chatId: chat.id }))[0]!)
      assert.strictEqual(yield* cards(api, "Undone keeper"), 0)
      const before = mock.requests().length
      const turn3 = yield* task(api, chat, "make it again")
      const asked = yield* awaitCall(events, "u1", first.approval.rolloutId)
      assert.strictEqual(asked.versionId, turn3)
      const rebuilt = yield* material(api, turn3)
      assert.isUndefined(rebuilt.parent)
      assert.match(rebuilt.reason ?? "", /undone/i)
      const body = JSON.stringify(mock.requests()[before]!.body)
      assert.include(body, "make it again", "the new message survives the rebuild")
      assert.notInclude(body, '"tool_call_id":"u1"', "the undone call's result is not carried")
      yield* answer(api, asked.approval, "deny")
      yield* eventually(() => finished(events, turn3 as VersionId) !== undefined)
      assert.strictEqual(yield* cards(api, "Undone keeper"), 0)
      assert.lengthOf(yield* api.ListRolloutEffects({ chatId: chat.id }), 1, "no change was made or replayed")

      // Turning the capability off rebuilds the next turn, with instructions that say so.
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "off" })
      const offAt = mock.requests().length
      const turn4 = yield* task(api, chat, "say hello again")
      yield* eventually(() => finished(events, turn4 as VersionId) !== undefined)
      assert.match((yield* material(api, turn4)).reason ?? "", /may do here changed/)
      const off = mock.requests()[offAt]!.body as unknown as Body
      assert.notInclude(
        (off.tools ?? []).map((t) => t.function.name),
        "create_card"
      )
      assert.include(JSON.stringify(off.messages), "Turned off in this workshop: Create and edit library items.")
      assert.notInclude(JSON.stringify(off.messages), "Turned off in this workshop: nothing.")
      // Back to the default: the next turn rebuilds once more, and the one after carries on.
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: null })
      const turn5 = yield* task(api, chat, "one more hello")
      yield* eventually(() => finished(events, turn5 as VersionId) !== undefined)
      assert.match((yield* material(api, turn5)).reason ?? "", /may do here changed/)
      const turn6 = yield* task(api, chat, "and another")
      yield* eventually(() => finished(events, turn6 as VersionId) !== undefined)
      assert.isDefined((yield* material(api, turn6)).parent)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
