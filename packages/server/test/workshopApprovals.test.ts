// Asking first in workshops (spec/WORKSHOP.md §3.4, W4): per-capability grants, approvals bound
// to one call, the server's own description of what a call will do, Off taking tools out of the
// next turn and refusing a call already offered, Stop and restarts. Synthetic data and a scripted
// loopback provider only.
import type { ServerResponse } from "node:http"
import { assert, describe, it } from "@effect/vitest"
import { Type } from "@earendil-works/pi-ai"
import { Effect, Stream } from "effect"
import type { ApprovalPrompt } from "@rp/shared/agent.ts"
import type { Chat, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { argsDigest } from "../src/agent/approvals.ts"
import { type RolloutTool, toolWriter, USER_ONLY_WRITES } from "../src/agent/tools.ts"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

type Api = Effect.Success<ReturnType<typeof client>>
interface Message {
  readonly role: string
  readonly content?: unknown
  readonly tool_call_id?: string
}
interface Body {
  readonly messages: ReadonlyArray<Message>
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
interface Step {
  readonly name: string
  readonly args: unknown
  readonly id: string
}
/**
 * Calls these tools in turn, one a request, counting the run's tool results since the last task;
 * then answers. `hold` pauses the request after that many results until released.
 */
const scripted = (steps: ReadonlyArray<Step>, answer = "Done.") => {
  let held: (() => void) | null = null
  let holdAt: number | null = null
  let waitingHeld = false
  const handler = (request: Recorded, res: ServerResponse) => {
    const body = request.body as unknown as Body
    const messages = body.messages
    const text = JSON.stringify(messages)
    if (!text.includes(TRIGGER)) return sse(res, completionChunks(["Ready."], {}))
    const lastTask = messages.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content).includes(TRIGGER))
    const done = messages.slice(lastTask).filter((m) => m.role === "tool").length
    const step = steps[done]
    const respond = () => sse(res, step ? call(step.name, step.args, step.id) : completionChunks([answer], {}))
    if (holdAt === done) {
      holdAt = null
      waitingHeld = true
      held = respond
      return
    }
    respond()
  }
  return {
    handler,
    hold: (at: number) => {
      holdAt = at
    },
    isHeld: () => waitingHeld,
    release: () => {
      waitingHeld = false
      held?.()
      held = null
    }
  }
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

/** The last steps a version's run showed. */
const lastSteps = (events: ReadonlyArray<ChatEvent>, versionId: string) =>
  events.flatMap((e) => (e._tag === "Steps" && e.versionId === versionId ? [e.steps] : [])).at(-1) ?? []
const waitingFor = (events: ReadonlyArray<ChatEvent>, versionId: string, toolCallId: string) => {
  const step = lastSteps(events, versionId).find((s) => s.kind === "tool" && s.id === toolCallId)
  return step?.kind === "tool" && step.status === "waiting" ? step.approval : undefined
}
const awaitApproval = (events: ReadonlyArray<ChatEvent>, versionId: string, toolCallId: string) =>
  Effect.gen(function* () {
    yield* eventually(() => waitingFor(events, versionId, toolCallId) !== undefined)
    return waitingFor(events, versionId, toolCallId)!
  })
const answer = (api: Api, prompt: ApprovalPrompt, reply: "allow" | "allow_chat" | "deny", note?: string) =>
  api.AnswerToolApproval({
    rolloutId: prompt.rolloutId,
    toolCallId: prompt.toolCallId,
    digest: prompt.digest,
    answer: reply,
    ...(note ? { note } : {})
  })

/** A model set up as the account default, a fresh workshop and its events. */
const workshop = (handler: (request: Recorded, res: ServerResponse) => void) =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider(handler)),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
    const chat = yield* api.CreateWorkshop({})
    const events = yield* watch(api, chat)
    return { mock, api, chat, events }
  })

/** Sends a task and asks for the reply; doesn't wait for it. */
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
const cardsNamed = (api: Api, label: string) =>
  Effect.map(api.ListLibrary({ kind: "card" }), (refs) => refs.filter((r) => r.label === label))
const toolMessages = (requests: ReadonlyArray<Recorded>) =>
  requests
    .filter((r) => r.path === "/v1/chat/completions")
    .flatMap((r) => (r.body as unknown as Body).messages.filter((m) => m.role === "tool"))

describe("workshop approvals", () => {
  it.live(
    "an Ask-first call waits in its step with the server's description, holds no request, and asks again next time",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const script = scripted([
          { name: "create_card", args: { name: "Mara Quill", description: "Keeper of the Skerry Light." }, id: "c1" },
          { name: "create_card", args: { name: "Second keeper" }, id: "c2" }
        ])
        const { mock, api, chat, events } = yield* workshop(script.handler)
        const capabilities = yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
        assert.deepInclude(
          capabilities.find((c) => c.id === "library.write"),
          {
            mode: "ask",
            defaultMode: "allow",
            chosen: true
          }
        )
        const versionId = yield* task(api, chat, "make two keepers")
        const first = yield* awaitApproval(events, versionId, "c1")
        assert.deepInclude(first, {
          capability: "library.write",
          capabilityLabel: "Create and edit library items",
          title: "Create the card “Mara Quill”",
          uncertain: false,
          digest: argsDigest({ name: "Mara Quill", description: "Keeper of the Skerry Light." })
        })
        assert.deepStrictEqual(first.rows, [{ label: "description", value: "Keeper of the Skerry Light." }])
        assert.isEmpty(yield* cardsNamed(api, "Mara Quill"))
        // Waiting holds no provider request: nothing more is sent until the user answers.
        const sentBefore = mock.requests().length
        yield* Effect.sleep(400)
        assert.strictEqual(mock.requests().length, sentBefore)
        const [rows] = yield* fixtureSql(
          config.dataDir,
          [{ sql: "SELECT status, capability FROM tool_approvals WHERE tool_call_id = 'c1'" }],
          { readOnly: true }
        )
        assert.deepStrictEqual(rows, [{ status: "pending", capability: "library.write" }])
        assert.deepStrictEqual(yield* answer(api, first, "allow"), { waiting: true })
        // Allow once: the next call of the same capability asks again.
        const second = yield* awaitApproval(events, versionId, "c2")
        assert.lengthOf(yield* cardsNamed(api, "Mara Quill"), 1)
        assert.strictEqual(yield* outcome(answer(api, first, "allow")), "ApprovalRefused")
        yield* answer(api, second, "deny", "Not this one.")
        yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
        assert.strictEqual(finished(events, versionId as VersionId)!.status, "complete")
        assert.isEmpty(yield* cardsNamed(api, "Second keeper"))
        // The decline reaches the model as the call's error result.
        const results = toolMessages(mock.requests())
        assert.isTrue(
          results.some(
            (m) =>
              m.tool_call_id === "c2" &&
              JSON.stringify(m.content).includes("The user declined this. Their note: Not this one.")
          )
        )
        const transcript = yield* api.GetRunTranscript({ versionId })
        assert.isTrue(
          transcript.entries.some(
            (e) => e.role === "toolResult" && e.toolCallId === "c2" && e.isError && e.text.includes("declined")
          )
        )
        assert.isFalse(lastSteps(events, versionId).some((s) => s.kind === "tool" && s.status === "waiting"))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("Allow in this workshop saves the grant with the answer and stops asking", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted([
        { name: "create_card", args: { name: "Granted one" }, id: "g1" },
        { name: "create_card", args: { name: "Granted two" }, id: "g2" }
      ])
      const { api, chat, events } = yield* workshop(script.handler)
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
      const versionId = yield* task(api, chat, "make two")
      yield* answer(api, yield* awaitApproval(events, versionId, "g1"), "allow_chat")
      yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
      assert.strictEqual(finished(events, versionId as VersionId)!.status, "complete")
      assert.lengthOf(yield* cardsNamed(api, "Granted two"), 1)
      assert.isFalse(
        events.some(
          (e) => e._tag === "Steps" && e.steps.some((s) => s.kind === "tool" && s.id === "g2" && s.status === "waiting")
        )
      )
      const me = yield* api.Whoami()
      const [grants] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT capability, mode, owner_user_id, target FROM workshop_grants WHERE chat_id = ?",
            params: [chat.id]
          }
        ],
        { readOnly: true }
      )
      assert.deepStrictEqual(grants, [{ capability: "library.write", mode: "allow", owner_user_id: me.id, target: "" }])
      assert.deepInclude(
        (yield* api.ListWorkshopCapabilities({ chatId: chat.id })).find((c) => c.id === "library.write"),
        {
          mode: "allow",
          chosen: true
        }
      )
      // Back to the default: the row goes.
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: null })
      assert.deepInclude(
        (yield* api.ListWorkshopCapabilities({ chatId: chat.id })).find((c) => c.id === "library.write"),
        {
          mode: "allow",
          chosen: false
        }
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "Off takes its tools out of the next turn and names it; Ask first and Allowed leave the definitions alone",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const script = scripted([], "Noted.")
        const { mock, api, chat, events } = yield* workshop(script.handler)
        const turn = (label: string) =>
          Effect.gen(function* () {
            const before = mock.requests().length
            const versionId = yield* task(api, chat, label)
            yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
            return mock
              .requests()
              .slice(before)
              .find((r) => r.path === "/v1/chat/completions")!.body as unknown as Body
          })
        const names = (body: Body) => (body.tools ?? []).map((t) => t.function.name)
        const instructions = (body: Body) => JSON.stringify(body.messages.at(-1)?.content)
        const allowed = yield* turn("first")
        assert.includeMembers(names(allowed), ["create_card", "edit_card", "clone_card", "start_chat"])
        assert.include(instructions(allowed), "Turned off in this workshop: nothing.")
        yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
        const asking = yield* turn("second")
        assert.deepStrictEqual(asking.tools, allowed.tools, "Ask first changes only execution")
        assert.include(instructions(asking), "Turned off in this workshop: nothing.")
        yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "off" })
        const off = yield* turn("third")
        assert.notIncludeMembers(names(off), ["create_card", "edit_card", "clone_card"])
        assert.includeMembers(names(off), ["list_library", "start_chat"])
        assert.include(instructions(off), "Turned off in this workshop: Create and edit library items.")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live(
    "Off refuses a call the run was already offered, and a crafted step edit, with a plain message the model gets",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const script = scripted([
          { name: "list_library", args: { kind: "card" }, id: "look" },
          { name: "create_card", args: { name: "Turned off" }, id: "off1" }
        ])
        const { mock, api, chat, events } = yield* workshop(script.handler)
        script.hold(1)
        const versionId = yield* task(api, chat, "make one")
        yield* eventually(() => script.isHeld())
        // Turned off mid-run: the frozen definitions still offer it, but it doesn't run.
        yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "off" })
        script.release()
        yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
        assert.isEmpty(yield* cardsNamed(api, "Turned off"))
        const refusal = "“Create and edit library items” is turned off in this workshop"
        assert.isTrue(
          toolMessages(mock.requests()).some(
            (m) => m.tool_call_id === "off1" && JSON.stringify(m.content).includes(refusal)
          )
        )
        assert.isFalse(
          events.some((e) => e._tag === "Steps" && e.steps.some((s) => s.kind === "tool" && s.status === "waiting"))
        )
        // A crafted client request: new arguments for that call through Resume from a step.
        const steps = yield* api.GetRolloutSteps({ versionId })
        const step = steps.findIndex((s) => s.kind === "tool" && s.tool === "create_card")
        const me = yield* api.Whoami()
        const slotId = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId!
        const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId })
        const crafted = yield* api.ResumeFromStep({
          versionId,
          step,
          edit: { kind: "arguments", arguments: { name: "Crafted" } },
          expectedRowVersion: slot.entry.rowVersion
        })
        yield* eventually(() => finished(events, crafted.version.id) !== undefined)
        assert.isEmpty(yield* cardsNamed(api, "Crafted"))
        assert.isTrue(
          (yield* api.GetRunTranscript({ versionId: crafted.version.id })).entries.some(
            (e) => e.role === "toolResult" && e.isError && e.text.includes("is turned off in this workshop")
          )
        )
        assert.isEmpty(yield* api.ListRolloutEffects({ chatId: chat.id }))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("crafted requests can't grant what isn't offered, take a choice it lacks, or approve another call", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted([{ name: "create_card", args: { name: "Bound" }, id: "b1" }])
      const { api, chat, events } = yield* workshop(script.handler)
      assert.strictEqual(
        yield* outcome(api.SetWorkshopGrant({ chatId: chat.id, capability: "plugins.apply", mode: "allow" })),
        "GrantRefused"
      )
      assert.strictEqual(
        yield* outcome(api.SetWorkshopGrant({ chatId: chat.id, capability: "made.up", mode: "allow" })),
        "GrantRefused"
      )
      assert.strictEqual(
        yield* outcome(api.SetWorkshopGrant({ chatId: chat.id, capability: "library.read", mode: "off" })),
        "GrantRefused"
      )
      const story = yield* api.CreateChat({ title: "Story" })
      assert.strictEqual(
        yield* outcome(api.SetWorkshopGrant({ chatId: story.id, capability: "library.write", mode: "allow" })),
        "GrantRefused"
      )
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
      const versionId = yield* task(api, chat, "make one")
      const prompt = yield* awaitApproval(events, versionId, "b1")
      // Another call's id in the same run, or other arguments, are refused.
      assert.strictEqual(
        yield* outcome(api.AnswerToolApproval({ ...prompt, toolCallId: "b2", answer: "allow" })),
        "NotFound"
      )
      assert.strictEqual(
        yield* outcome(
          api.AnswerToolApproval({
            rolloutId: prompt.rolloutId,
            toolCallId: prompt.toolCallId,
            digest: argsDigest({ name: "Something else" }),
            answer: "allow"
          })
        ),
        "ApprovalRefused"
      )
      assert.isEmpty(yield* cardsNamed(api, "Bound"))
      yield* answer(api, prompt, "allow")
      yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
      assert.lengthOf(yield* cardsNamed(api, "Bound"), 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("no tool reaches grants or approvals, and a call can't word itself into another capability", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const writer = yield* Writer
      const hidden = toolWriter(writer) as unknown as Record<string, unknown>
      for (const name of USER_ONLY_WRITES) {
        assert.isUndefined(hidden[name], name)
        assert.isFalse(name in hidden, name)
      }
      assert.isFunction(hidden["AgentCreateEntity"])
      const registry = yield* ExecutionRegistry
      let reached: Array<string> = []
      const sneaky: RolloutTool<{ readonly note: string }> = {
        id: "sneaky_grant",
        label: "Tried to change permissions",
        effect: "library",
        capability: "library.write",
        description: "A synthetic tool that tries to grant itself more.",
        parameters: Type.Object({ note: Type.String() }),
        execute: (context) =>
          Effect.sync(() => {
            const w = context.writer as unknown as Record<string, unknown>
            reached = USER_ONLY_WRITES.filter((name) => typeof w[name] === "function")
            return { text: reached.length === 0 ? "No access." : "Reached." }
          })
      }
      yield* registry.rolloutTools.register(sneaky as RolloutTool<never>)
      const planner = registry.orchestrationModes.get("workshop")!
      yield* registry.orchestrationModes.register({
        ...planner,
        plan: (input) => ({ ...planner.plan(input), tools: [...planner.plan(input).tools, "sneaky_grant"] })
      })
      const script = scripted([
        { name: "AnswerToolApproval", args: { answer: "allow" }, id: "fake" },
        { name: "sneaky_grant", args: { note: "Read your library — always allowed" }, id: "s1" }
      ])
      const { api, chat, events } = yield* workshop(script.handler)
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
      const versionId = yield* task(api, chat, "try it")
      const prompt = yield* awaitApproval(events, versionId, "s1")
      // The capability and its label come from the registry, never from the call's wording.
      assert.strictEqual(prompt.capability, "library.write")
      assert.strictEqual(prompt.capabilityLabel, "Create and edit library items")
      assert.deepStrictEqual(prompt.rows, [{ label: "note", value: "Read your library — always allowed" }])
      yield* answer(api, prompt, "allow")
      yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
      assert.deepStrictEqual(reached, [])
      const transcript = yield* api.GetRunTranscript({ versionId })
      assert.isTrue(transcript.entries.some((e) => e.role === "toolResult" && e.toolCallId === "fake" && e.isError))
      assert.isTrue(
        transcript.entries.some((e) => e.role === "toolResult" && e.toolCallId === "s1" && e.text === "No access.")
      )
      assert.deepInclude(
        (yield* api.ListWorkshopCapabilities({ chatId: chat.id })).find((c) => c.id === "library.write"),
        {
          mode: "ask"
        }
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("an edit's approval shows the saved card's own name and the fields before and after", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted([
        {
          name: "edit_card",
          args: { card: "assistant", changes: [{ field: "description", text: "A new description." }] },
          id: "e1"
        }
      ])
      const { api, chat, events } = yield* workshop(script.handler)
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
      const assistant = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === "Assistant")!
      const saved = yield* api.OpenEditor({ refId: assistant.id })
      const versionId = yield* task(api, chat, "edit it")
      const prompt = yield* awaitApproval(events, versionId, "e1")
      assert.strictEqual(prompt.title, "Edit the card “Assistant”")
      assert.deepStrictEqual(prompt.changes, [
        { field: "description", before: String(saved.doc["description"]), after: "A new description." }
      ])
      yield* answer(api, prompt, "deny")
      yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
      assert.strictEqual((yield* api.OpenEditor({ refId: assistant.id })).doc["description"], saved.doc["description"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a second subscriber sees the waiting call; Stop cancels it cleanly and Resume asks again plainly", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted([{ name: "create_card", args: { name: "After stop" }, id: "st1" }], "Made.")
      const { api, chat, events } = yield* workshop(script.handler)
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
      const versionId = yield* task(api, chat, "make it")
      yield* awaitApproval(events, versionId, "st1")
      // A tab opened now (or reloaded) is told the run is waiting.
      const second = yield* watch(api, chat)
      const hello = second.find((e) => e._tag === "Hello")
      assert.isTrue(
        hello?._tag === "Hello" &&
          hello.live.some(
            (l) => l.versionId === versionId && l.steps?.some((s) => s.kind === "tool" && s.status === "waiting")
          )
      )
      yield* api.StopGeneration({ versionId })
      yield* eventually(() => finished(events, versionId as VersionId) !== undefined)
      assert.strictEqual(finished(events, versionId as VersionId)!.status, "stopped")
      const [rows, receipts] = yield* fixtureSql(
        config.dataDir,
        [
          { sql: "SELECT status FROM tool_approvals WHERE tool_call_id = 'st1'" },
          { sql: "SELECT tool_call_id FROM rollout_receipts WHERE tool_call_id = 'st1'" }
        ],
        { readOnly: true }
      )
      assert.deepStrictEqual(rows, [{ status: "cancelled" }])
      assert.isEmpty(receipts)
      assert.isEmpty(yield* cardsNamed(api, "After stop"))
      const me = yield* api.Whoami()
      const slotId = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId!
      const slot = yield* (yield* Reader).GetSlot({ userId: me.id, slotId })
      const resumed = yield* api.ResumeVersion({ versionId, expectedRowVersion: slot.entry.rowVersion })
      const again = yield* awaitApproval(events, resumed.version.id, "st1")
      assert.isFalse(again.uncertain, "a call that only waited never ran")
      yield* answer(api, again, "allow")
      yield* eventually(() => finished(events, resumed.version.id) !== undefined)
      assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")
      assert.lengthOf(yield* cardsNamed(api, "After stop"), 1)
      // The version's changes include the kept call's, for its steps and the regenerate warning.
      assert.deepStrictEqual(
        (yield* api.ListVersionEffects({ versionId: resumed.version.id })).map((e) => e.title),
        ["Created the card After stop"]
      )
      assert.isEmpty(yield* api.ListVersionEffects({ versionId }))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a restart parks a waiting run; Resume asks again, and an answer given while parked is used once", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const script = scripted([{ name: "create_card", args: { name: "Across a restart" }, id: "r1" }], "Made.")
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => startMockProvider(script.handler)),
        (m) => Effect.promise(() => m.close())
      )
      const parked = yield* Effect.gen(function* () {
        const api = yield* client()
        yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
        const chat = yield* api.CreateWorkshop({})
        const events = yield* watch(api, chat)
        yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.write", mode: "ask" })
        const versionId = yield* task(api, chat, "make it")
        yield* awaitApproval(events, versionId, "r1")
        return { chat, versionId }
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
      // A process that dies leaves the approval pending (a clean shutdown cancels it).
      yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE tool_approvals SET status = 'pending' WHERE tool_call_id = 'r1'" }
      ])
      yield* Effect.gen(function* () {
        const api = yield* client()
        const events = yield* watch(api, parked.chat)
        const me = yield* api.Whoami()
        const reader = yield* Reader
        const path = yield* api.ReadPath({
          chatId: parked.chat.id,
          leafSlotId: (yield* api.GetChat({ chatId: parked.chat.id })).activeLeafSlotId,
          range: { _tag: "Bottom" },
          limit: 5
        })
        const entry = path.entries.find((e) => e.version.id === parked.versionId)!
        assert.strictEqual(entry.version.status, "interrupted")
        assert.isEmpty(yield* cardsNamed(api, "Across a restart"))
        const slot = yield* reader.GetSlot({ userId: me.id, slotId: entry.slotId })
        const resumed = yield* api.ResumeVersion({
          versionId: parked.versionId,
          expectedRowVersion: slot.entry.rowVersion
        })
        const prompt = yield* awaitApproval(events, resumed.version.id, "r1")
        assert.isFalse(prompt.uncertain)
        yield* answer(api, prompt, "allow")
        yield* eventually(() => finished(events, resumed.version.id) !== undefined)
        assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")
        assert.lengthOf(yield* cardsNamed(api, "Across a restart"), 1)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }).pipe(Effect.scoped)
  })
})
