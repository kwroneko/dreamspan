// Subagents after review (review-subagents2to5): consent holds wherever a subagent is sent to
// again (a continuation, a resumed one, a background one carried on under Ask first); the summary
// pick names a model only where the chat summarizes; a restart question shows under Ask first; the
// per-reply count spans the reply's Stops and Resumes; a reused call id never borrows another
// call's subagent; one subagent is carried on once; a message reported "Delivered" is never lost
// silently; approvals don't use up wall time; progress never follows a report; and a resumed
// subagent's turns count from the resume. Synthetic data and scripted loopback providers only.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { ApprovalPrompt } from "@dreamspan/shared/agent.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { Mailbox } from "../src/agent/mailbox.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import {
  type Api,
  childRollouts,
  children,
  cutAfterCall,
  gate,
  liveRow,
  mockProvider,
  parents,
  type Reply,
  resume,
  resumeFromStep,
  scripted,
  secondConnection,
  stepsEvents,
  task,
  text,
  toolResults,
  toolsDone,
  workshop
} from "./support/subagentFlow.ts"

const LIST: Reply = { call: { name: "list_library", args: { kind: "card" }, id: "child-list" } }
/** A subagent that looks once, then reports. */
const once =
  (report: string) =>
  (messages: ReadonlyArray<{ role: string }>): Reply =>
    toolsDone(messages) === 0 ? LIST : report
const spawn = (id: string, extra: Record<string, unknown> = {}): Reply => ({
  call: { name: "agent", args: { type: "research", task: "List the cards.", name: "cards", ...extra }, id }
})
const message = (id: string, words: string): Reply => ({
  call: { name: "message_agent", args: { agent: "research-1", message: words }, id }
})
const reported = (messages: ReadonlyArray<{ role: string; content?: unknown }>) =>
  messages.some((m) => m.role === "user" && text(m).includes("Subagent research-1 (cards)"))

/** Resolves once `check` holds: a reply's turn waits for the subagent to be where the test wants it. */
const until = (check: () => boolean) =>
  new Promise<void>((resolve) => {
    const poll = () => (check() ? resolve() : setTimeout(poll, 10))
    poll()
  })

/** The reply's last message, written after its subagent's report, is done. */
const summedUp = (events: ReadonlyArray<ChatEvent>) =>
  events.some((e) => e._tag === "Version" && e.version.status === "complete" && e.version.content === "Summed up.")

/** Waits for the call's step to ask the user (on any message), then returns what it asks. */
const prompted = (events: ReadonlyArray<ChatEvent>, callId: string, which: (p: ApprovalPrompt) => boolean) =>
  Effect.gen(function* () {
    const find = () =>
      stepsEvents(events)
        .flatMap((e) => e.steps)
        .flatMap((s) =>
          s.kind === "tool" && s.id === callId && s.status === "waiting" && s.approval ? [s.approval] : []
        )
        .filter(which)
        .at(-1)
    yield* eventually(() => find() !== undefined, 10_000)
    return find()!
  })
const answer = (api: Api, prompt: ApprovalPrompt, choice: "allow" | "deny") =>
  api.AnswerToolApproval({
    rolloutId: prompt.rolloutId,
    toolCallId: prompt.toolCallId,
    digest: prompt.digest,
    answer: choice
  })

/** A workshop on the main provider, and a second connection picked for subagents as `cheap`. */
const withCheap = (main: ReturnType<typeof scripted>, cheap: ReturnType<typeof scripted>) =>
  Effect.gen(function* () {
    const setup = yield* workshop(main.handler)
    const second = yield* mockProvider(cheap.handler)
    const other = yield* secondConnection(setup.api, second.url)
    yield* setup.api.ChangeSubagentSettings({
      picks: ["same", other.pick],
      rows: { [other.pick]: { alias: "cheap", note: "" } }
    })
    return { ...setup, second, other }
  })

describe("subagents after review", () => {
  // Finding 1.
  it.live("a message to a subagent whose model was unpicked since is refused, and nothing is sent to it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const unpicked = gate()
      const main = scripted({
        parent: async (messages) => {
          const done = toolsDone(messages)
          if (done === 0) return spawn("spawn", { model: "cheap" })
          if (done === 1) {
            await unpicked.promise
            return message("msg", "Which is newest?")
          }
          return "Done."
        },
        child: once("Same report.")
      })
      const cheap = scripted({ parent: () => "", child: once("Cheap report.") })
      const { api, chat, events, mock, second } = yield* withCheap(main, cheap)
      const versionId = yield* task(api, chat, "follow up")
      yield* eventually(() => parents(mock.requests()).length === 2)
      assert.lengthOf(children(second.requests()), 2)
      // The user unticks the model while the reply runs.
      yield* api.ChangeSubagentSettings({ picks: ["same"] })
      unpicked.open()
      yield* eventually(() => finished(events, versionId)?.status === "complete")
      assert.lengthOf(children(second.requests()), 2, "nothing more went to the unpicked model")
      assert.lengthOf(children(mock.requests()), 0, "nor anywhere else")
      const results = toolResults(parents(mock.requests()).at(-1)!.messages)
      assert.include(results[1], "model is no longer allowed for subagents in this chat")
      assert.lengthOf(yield* childRollouts(config.dataDir), 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 1.
  it.live("Resume doesn't carry on a subagent whose model was unpicked since: nothing is sent to it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) => (toolsDone(messages) === 0 ? spawn("spawn", { model: "cheap" }) : "Done."),
        child: once("Same report.")
      })
      const cheap = scripted({ parent: () => "", child: once("Cheap report.") })
      cheap.holdChild(1)
      const { api, chat, events, mock, second } = yield* withCheap(main, cheap)
      const versionId = yield* task(api, chat, "stop it")
      yield* eventually(() => cheap.isHeld())
      yield* api.StopGeneration({ versionId })
      yield* eventually(() => finished(events, versionId) !== undefined)
      yield* api.ChangeSubagentSettings({ picks: ["same"] })
      const sent = children(second.requests()).length
      cheap.holdChild(null)
      const resumed = yield* resume(api, chat, versionId)
      yield* eventually(() => finished(events, resumed)?.status === "complete")
      assert.lengthOf(children(second.requests()), sent)
      assert.lengthOf(children(mock.requests()), 0)
      assert.include(
        toolResults(parents(mock.requests()).at(-1)!.messages)[0],
        "model is no longer allowed for subagents in this chat"
      )
      assert.deepStrictEqual(
        (yield* childRollouts(config.dataDir)).map((r) => r["status"]),
        ["stopped"]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 9.
  it.live("a background subagent carried on by Resume asks first where its capability says so", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) =>
          reported(messages)
            ? "Summed up."
            : toolsDone(messages) === 0
              ? spawn("spawn", { background: true })
              : "Waiting.",
        child: once("Two cards.")
      })
      main.holdChild(1)
      const { api, chat, events, mock } = yield* workshop(main.handler)
      yield* task(api, chat, "in the background")
      yield* eventually(() => stepsEvents(events).some((e) => e.waitingFor === 1) && main.isHeld())
      const waiting = stepsEvents(events).find((e) => e.waitingFor === 1)!.versionId
      yield* api.StopGeneration({ versionId: waiting })
      yield* eventually(() => finished(events, waiting) !== undefined)
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "subagents", mode: "ask" })
      const sent = children(mock.requests()).length
      main.holdChild(null)
      const resumed = yield* resume(api, chat, waiting)
      const asked = yield* prompted(events, "spawn", () => true)
      assert.strictEqual(asked.capability, "subagents")
      assert.lengthOf(children(mock.requests()), sent, "nothing is sent before the user answers")
      yield* answer(api, asked, "allow")
      yield* eventually(() => finished(events, resumed)?.status === "complete")
      assert.strictEqual(finished(events, resumed)!.content, "Summed up.")
      assert.lengthOf(children(mock.requests()), sent + 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 2.
  it.live("under Ask first, Resume asks to run the call and then whether to start the task again", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) => (toolsDone(messages) === 0 ? spawn("spawn") : "Done."),
        child: once("Fresh report.")
      })
      const { api, chat, events, mock } = yield* workshop(main.handler)
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "subagents", mode: "ask" })
      main.holdChild(1)
      const versionId = yield* task(api, chat, "ask first")
      const first = yield* prompted(events, "spawn", (p) => !p.restart)
      yield* answer(api, first, "allow")
      yield* eventually(() => main.isHeld())
      yield* api.StopGeneration({ versionId })
      yield* eventually(() => finished(events, versionId) !== undefined)
      // Its saved run is gone (as a damaged one would be): it can't be carried on.
      yield* fixtureSql(config.dataDir, [
        {
          sql: "UPDATE rollout_payloads SET transcript_json = NULL WHERE rollout_id = (SELECT id FROM rollouts WHERE spawned_by_rollout_id = (SELECT rollout_id FROM versions WHERE id = ?))",
          params: [versionId]
        }
      ])
      main.holdChild(null)
      const resumed = yield* resume(api, chat, versionId)
      // The dangling call asks first, as any resumed call does under Ask first.
      const rerun = yield* prompted(events, "spawn", (p) => !p.restart && p.rolloutId !== first.rolloutId)
      yield* answer(api, rerun, "allow")
      // Then the restart question shows, with its own answer.
      const restart = yield* prompted(events, "spawn", (p) => p.restart !== undefined)
      assert.strictEqual(restart.restart!.handle, "research-1")
      assert.notStrictEqual(restart.toolCallId, rerun.toolCallId)
      const before = children(mock.requests()).length
      yield* answer(api, restart, "allow")
      yield* eventually(() => finished(events, resumed)?.status === "complete")
      const result = toolResults(parents(mock.requests()).at(-1)!.messages).at(-1)!
      assert.include(result, "Fresh report.")
      assert.lengthOf(children(mock.requests()), before + 2, "started over from its task")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 3.
  it.live("the summary pick names this chat's summary model only where the chat summarizes", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) => (toolsDone(messages) === 0 ? spawn("spawn") : "Done."),
        child: once("Same report.")
      })
      const cheap = scripted({ parent: () => "", child: once("Cheap report.") })
      const { api, chat, events, mock, second, other } = yield* withCheap(main, cheap)
      // Picked in another chat; here the summary model is on the second connection, summaries off.
      yield* api.ChangeSubagentSettings({ picks: ["same", "summary"] })
      const at = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: at,
        change: { _tag: "SummaryModel", model: { connection: other.connection.id, model: other.model.id } }
      })
      yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
      const off = yield* task(api, chat, "summaries off")
      yield* eventually(() => finished(events, off)?.status === "complete")
      const description = (body: { tools?: ReadonlyArray<{ function: { name: string; description?: string } }> }) =>
        body.tools?.find((t) => t.function.name === "agent")?.function.description ?? ""
      assert.notInclude(description(parents(mock.requests())[0]!), "- fast:")
      assert.lengthOf(children(second.requests()), 0, "never sent to a connection this chat didn't choose")
      assert.lengthOf(children(mock.requests()), 2)
      // With summaries on, the chat already sends to it: `fast` is offered and used.
      yield* api.SetLcmEnabled({ chatId: chat.id, enabled: true })
      const before = parents(mock.requests()).length
      const on = yield* task(api, chat, "summaries on")
      yield* eventually(() => finished(events, on)?.status === "complete")
      assert.include(description(parents(mock.requests())[before]!), "- fast: cheap-model.")
      assert.lengthOf(children(second.requests()), 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 4.
  it.live("the per-reply count spans the reply's Stop and Resume", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let stopped = false
      const main = scripted({
        parent: (messages) => {
          const done = toolsDone(messages)
          if (done === 0) return spawn("spawn")
          // Held until the reply is stopped; the resumed reply starts another.
          if (done === 1) return stopped ? spawn("again") : new Promise<Reply>(() => {})
          return "Done."
        },
        child: once("Two cards.")
      })
      const { api, chat, events, mock } = yield* workshop(main.handler)
      yield* api.ChangeSubagentSettings({ limits: { perRun: 1 } })
      const versionId = yield* task(api, chat, "count")
      yield* eventually(() => parents(mock.requests()).length === 2)
      stopped = true
      yield* api.StopGeneration({ versionId })
      yield* eventually(() => finished(events, versionId) !== undefined)
      const resumed = yield* resume(api, chat, versionId)
      yield* eventually(() => finished(events, resumed)?.status === "complete")
      const results = toolResults(parents(mock.requests()).at(-1)!.messages)
      assert.include(results[1], "started as many subagents as it may")
      assert.lengthOf(children(mock.requests()), 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 5.
  it.live("a call id reused within a reply never answers with, or runs as, another call's subagent", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) => {
          const done = toolsDone(messages)
          if (done === 0) return spawn("dup")
          if (done === 1)
            return { call: { name: "agent", args: { type: "research", task: "Count the notes." }, id: "dup" } }
          return "Done."
        },
        child: once("Two cards.")
      })
      const { api, chat, events, mock } = yield* workshop(main.handler)
      const versionId = yield* task(api, chat, "reuse")
      yield* eventually(() => finished(events, versionId)?.status === "complete")
      const results = toolResults(parents(mock.requests()).at(-1)!.messages)
      assert.include(results[0], "Two cards.")
      assert.notInclude(results[1], "Two cards.")
      assert.include(results[1], "already used by another call")
      assert.lengthOf(children(mock.requests()), 2)
      assert.lengthOf(yield* childRollouts(config.dataDir), 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 5.
  it.live("after carrying on from a step before the spawn, a call reusing its id doesn't find the subagent", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let again = false
      const LOOK: Reply = { call: { name: "list_library", args: { kind: "card" }, id: "look" } }
      const REUSE: Reply = { call: { name: "list_library", args: { kind: "card" }, id: "c1" } }
      const main = scripted({
        parent: (messages) => {
          const done = toolsDone(messages)
          if (again) return [LOOK, REUSE, message("ask", "More?")][done] ?? "Second."
          return [LOOK, spawn("c1")][done] ?? "First."
        },
        child: once("Two cards.")
      })
      const { api, chat, events, mock } = yield* workshop(main.handler)
      const versionId = yield* task(api, chat, "carry on from a step")
      yield* eventually(() => finished(events, versionId)?.status === "complete")
      again = true
      const carried = yield* resumeFromStep(api, chat, versionId, 0)
      yield* eventually(() => finished(events, carried)?.status === "complete")
      const results = toolResults(parents(mock.requests()).at(-1)!.messages)
      assert.include(results.at(-1)!, "No subagent research-1 in this conversation.")
      assert.lengthOf(children(mock.requests()), 2)
      const steps = yield* api.GetRolloutSteps({ versionId: carried })
      const reused = steps.find((s) => s.kind === "tool" && s.id === "c1")
      assert.isDefined(reused)
      assert.isUndefined(reused?.kind === "tool" ? reused.subagent : undefined, "the lookup shows no subagent")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 6.
  it.live("a dangling message to a background subagent reaches the run that carries it on: one carry", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) => {
          if (reported(messages)) return "Summed up."
          const done = toolsDone(messages)
          if (done === 1) return until(() => main.isHeld()).then(() => message("msg", "Also count the notes."))
          return done === 0 ? spawn("spawn", { background: true }) : "Waiting."
        },
        child: (messages) =>
          toolsDone(messages) === 0
            ? LIST
            : messages.some((m) => text(m).includes("Also count the notes."))
              ? "Cards and notes."
              : "Two cards."
      })
      main.holdChild(1)
      const { api, chat, events, mock } = yield* workshop(main.handler)
      yield* task(api, chat, "message it")
      yield* eventually(() => stepsEvents(events).some((e) => e.waitingFor === 1) && main.isHeld())
      const waiting = stepsEvents(events).find((e) => e.waitingFor === 1)!.versionId
      yield* api.StopGeneration({ versionId: waiting })
      yield* eventually(() => finished(events, waiting) !== undefined)
      // As a crash before the message's result was saved leaves it: the call dangling.
      yield* cutAfterCall(config.dataDir, waiting, "msg")
      main.holdChild(null)
      yield* resume(api, chat, waiting)
      yield* eventually(() => summedUp(events))
      assert.deepStrictEqual(
        (yield* childRollouts(config.dataDir)).map((r) => [r["spawned_by_call_id"], r["status"]]),
        [
          ["spawn", "stopped"],
          ["spawn", "completed"]
        ]
      )
      const last = parents(mock.requests()).at(-1)!.messages
      assert.include(JSON.stringify(last), "Cards and notes.")
      // The message it had already read isn't delivered again by the call carried on.
      const read = children(mock.requests())
        .at(-1)!
        .messages.filter((m) => text(m).includes("Also count the notes."))
      assert.lengthOf(read, 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a dangling message whose lookup still saw the stopped subagent goes to the run that carries it on", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) => {
          if (reported(messages)) return "Summed up."
          const done = toolsDone(messages)
          if (done === 1) return until(() => main.isHeld()).then(() => message("msg", "Also count the notes."))
          return done === 0 ? spawn("spawn", { background: true }) : "Waiting."
        },
        child: (messages) =>
          toolsDone(messages) === 0
            ? LIST
            : messages.some((m) => text(m).includes("Also count the notes."))
              ? "Cards and notes."
              : "Two cards."
      })
      main.holdChild(1)
      const { api, chat, events, mock } = yield* workshop(main.handler)
      yield* task(api, chat, "message it, looked up late")
      yield* eventually(() => stepsEvents(events).some((e) => e.waitingFor === 1) && main.isHeld())
      const waiting = stepsEvents(events).find((e) => e.waitingFor === 1)!.versionId
      yield* api.StopGeneration({ versionId: waiting })
      yield* eventually(() => finished(events, waiting) !== undefined)
      yield* cutAfterCall(config.dataDir, waiting, "msg")
      main.holdChild(null)
      // The message's lookup reads before the run carrying the subagent on is saved, and its answer
      // (the stopped run) comes back only once that run is in place, as on a busy machine.
      const reader = (yield* Reader) as { FindSubagentByHandle: Reader["Service"]["FindSubagentByHandle"] }
      const lookup = reader.FindSubagentByHandle
      let late = true
      reader.FindSubagentByHandle = ((payload: Parameters<typeof lookup>[0]) =>
        lookup(payload).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              if (!late) return
              late = false
              while ((yield* childRollouts(config.dataDir)).length < 2) yield* Effect.sleep("10 millis")
              yield* Effect.sleep("200 millis")
            })
          )
        )) as typeof lookup
      yield* Effect.addFinalizer(() => Effect.sync(() => (reader.FindSubagentByHandle = lookup)))
      yield* resume(api, chat, waiting)
      yield* eventually(() => summedUp(events))
      assert.isFalse(late, "the lookup was held")
      assert.deepStrictEqual(
        (yield* childRollouts(config.dataDir)).map((r) => [r["spawned_by_call_id"], r["status"]]),
        [
          ["spawn", "stopped"],
          ["spawn", "completed"]
        ]
      )
      assert.include(JSON.stringify(parents(mock.requests()).at(-1)!.messages), "Cards and notes.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a dangling message whose lookup finds the carrying run before it's in place waits for it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) => {
          if (reported(messages)) return "Summed up."
          const done = toolsDone(messages)
          if (done === 1) return until(() => main.isHeld()).then(() => message("msg", "Also count the notes."))
          return done === 0 ? spawn("spawn", { background: true }) : "Waiting."
        },
        child: (messages) =>
          toolsDone(messages) === 0
            ? LIST
            : messages.some((m) => text(m).includes("Also count the notes."))
              ? "Cards and notes."
              : "Two cards."
      })
      main.holdChild(1)
      const { api, chat, events, mock } = yield* workshop(main.handler)
      yield* task(api, chat, "message it, saved but not running")
      yield* eventually(() => stepsEvents(events).some((e) => e.waitingFor === 1) && main.isHeld())
      const waiting = stepsEvents(events).find((e) => e.waitingFor === 1)!.versionId
      yield* api.StopGeneration({ versionId: waiting })
      yield* eventually(() => finished(events, waiting) !== undefined)
      yield* cutAfterCall(config.dataDir, waiting, "msg")
      main.holdChild(null)
      // The run carrying the subagent on is saved, and the message's lookup finds it there, before
      // that run is in place to take messages: the answer to its save comes back only after.
      const reader = (yield* Reader) as { FindSubagentByHandle: Reader["Service"]["FindSubagentByHandle"] }
      const writer = (yield* Writer) as { ResumeSubagent: Writer["Service"]["ResumeSubagent"] }
      const lookup = reader.FindSubagentByHandle
      const save = writer.ResumeSubagent
      let saved = false
      let looked = false
      const until$ = (check: () => boolean) =>
        Effect.gen(function* () {
          while (!check()) yield* Effect.sleep("10 millis")
        })
      reader.FindSubagentByHandle = ((payload: Parameters<typeof lookup>[0]) =>
        looked
          ? lookup(payload)
          : until$(() => saved).pipe(
              Effect.andThen(lookup(payload)),
              Effect.tap(() => Effect.sync(() => (looked = true)))
            )) as typeof lookup
      writer.ResumeSubagent = ((payload: Parameters<typeof save>[0]) =>
        save(payload).pipe(
          Effect.tap(() => Effect.sync(() => (saved = true))),
          Effect.tap(() => until$(() => looked))
        )) as typeof save
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          reader.FindSubagentByHandle = lookup
          writer.ResumeSubagent = save
        })
      )
      yield* resume(api, chat, waiting)
      yield* eventually(() => summedUp(events))
      assert.isTrue(looked, "the lookup came after the save")
      assert.deepStrictEqual(
        (yield* childRollouts(config.dataDir)).map((r) => [r["spawned_by_call_id"], r["status"]]),
        [
          ["spawn", "stopped"],
          ["spawn", "completed"]
        ]
      )
      const parent = parents(mock.requests()).at(-1)!.messages
      assert.include(JSON.stringify(parent), "Cards and notes.")
      assert.notInclude(JSON.stringify(parent), "couldn't")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a subagent carried on by Resume sends nothing before the reply's dangling message to it has run", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) => {
          if (reported(messages)) return "Summed up."
          const done = toolsDone(messages)
          if (done === 1) return until(() => main.isHeld()).then(() => message("msg", "Also count the notes."))
          return done === 0 ? spawn("spawn", { background: true }) : "Waiting."
        },
        child: (messages) =>
          toolsDone(messages) === 0
            ? LIST
            : messages.some((m) => text(m).includes("Also count the notes."))
              ? "Cards and notes."
              : "Two cards."
      })
      main.holdChild(1)
      const { api, chat, events, mock } = yield* workshop(main.handler)
      yield* task(api, chat, "message it slowly")
      yield* eventually(() => stepsEvents(events).some((e) => e.waitingFor === 1) && main.isHeld())
      const waiting = stepsEvents(events).find((e) => e.waitingFor === 1)!.versionId
      yield* api.StopGeneration({ versionId: waiting })
      yield* eventually(() => finished(events, waiting) !== undefined)
      yield* cutAfterCall(config.dataDir, waiting, "msg")
      // Under Ask first both the carry and the dangling message ask: the message's answer comes last,
      // however late, as a slow lookup or a busy machine can make it come.
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "subagents", mode: "ask" })
      main.holdChild(null)
      const sent = children(mock.requests()).length
      yield* resume(api, chat, waiting)
      yield* answer(api, yield* prompted(events, "spawn", () => true), "allow")
      const asked = yield* prompted(events, "msg", () => true)
      while ((yield* childRollouts(config.dataDir)).length < 2) yield* Effect.sleep("10 millis")
      // The carried-on run is in place: it waits for the message instead of reporting without it.
      yield* Effect.sleep("300 millis")
      assert.lengthOf(children(mock.requests()), sent, "nothing is sent before the message's call has run")
      yield* answer(api, asked, "allow")
      yield* eventually(() => summedUp(events))
      assert.deepStrictEqual(
        (yield* childRollouts(config.dataDir)).map((r) => [r["spawned_by_call_id"], r["status"]]),
        [
          ["spawn", "stopped"],
          ["spawn", "completed"]
        ]
      )
      const first = children(mock.requests()).at(sent)!
      assert.lengthOf(
        first.messages.filter((m) => text(m).includes("Also count the notes.")),
        1,
        "its first request reads the message"
      )
      assert.include(JSON.stringify(parents(mock.requests()).at(-1)!.messages), "Cards and notes.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 7.
  it.live("a message delivered just before the reply stopped reaches the subagent Resume carries on", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) => {
          if (reported(messages)) return "Summed up."
          const done = toolsDone(messages)
          if (done === 1) return until(() => main.isHeld()).then(() => message("msg", "Also count the notes."))
          return done === 0 ? spawn("spawn", { background: true }) : "Waiting."
        },
        child: (messages) =>
          toolsDone(messages) === 0
            ? LIST
            : messages.some((m) => text(m).includes("Also count the notes."))
              ? "Cards and notes."
              : "Two cards."
      })
      main.holdChild(1)
      const { api, chat, events, mock } = yield* workshop(main.handler)
      yield* task(api, chat, "message then stop")
      yield* eventually(() => stepsEvents(events).some((e) => e.waitingFor === 1) && main.isHeld())
      assert.include(
        toolResults(parents(mock.requests()).find((b) => toolResults(b.messages).length === 2)!.messages)[1],
        "Delivered to research-1."
      )
      const waiting = stepsEvents(events).find((e) => e.waitingFor === 1)!.versionId
      yield* api.StopGeneration({ versionId: waiting })
      yield* eventually(() => finished(events, waiting) !== undefined)
      main.holdChild(null)
      const resumed = yield* resume(api, chat, waiting)
      yield* eventually(() => finished(events, resumed)?.status === "complete")
      assert.include(JSON.stringify(parents(mock.requests()).at(-1)!.messages), "Cards and notes.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 7.
  it.live("a message after a subagent's last turn doesn't buy it another request; the parent is told", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) => {
          if (reported(messages)) return "Summed up."
          const done = toolsDone(messages)
          if (done === 1) return until(() => main.isHeld()).then(() => message("msg", "Also count the notes."))
          return done === 0 ? spawn("spawn", { background: true }) : "Waiting."
        },
        child: once("Two cards.")
      })
      main.holdChild(1)
      const { api, chat, events, mock } = yield* workshop(main.handler)
      yield* api.ChangeSubagentSettings({ limits: { requests: 2 } })
      yield* task(api, chat, "past the cap")
      yield* eventually(() => stepsEvents(events).some((e) => e.waitingFor === 1) && main.isHeld())
      const waiting = stepsEvents(events).find((e) => e.waitingFor === 1)!.versionId
      main.holdChild(null)
      yield* eventually(() => finished(events, waiting)?.status === "complete")
      assert.lengthOf(children(mock.requests()), 2, "no request past its cap")
      const report = parents(mock.requests())
        .at(-1)!
        .messages.find((m) => m.role === "user" && text(m).includes("Subagent research-1 (cards)"))!
      assert.include(text(report), "It ended before reading your message")
      assert.include(text(report), "Also count the notes.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 7.
  it.live("a message waiting when a subagent stops at its limit isn't lost: the parent is told", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) => {
          if (reported(messages)) return "Summed up."
          const done = toolsDone(messages)
          if (done === 1) return until(() => main.isHeld()).then(() => message("msg", "Also count the notes."))
          return done === 0 ? spawn("spawn", { background: true }) : "Waiting."
        },
        child: (messages) =>
          toolsDone(messages) < 3
            ? { call: { name: "list_library", args: { kind: "card" }, id: `child-${toolsDone(messages)}` } }
            : "Two cards.",
        usage: { prompt_tokens: 6000, completion_tokens: 0, total_tokens: 6000 }
      })
      main.holdChild(1)
      const { api, chat, events, mock } = yield* workshop(main.handler)
      yield* api.ChangeSubagentSettings({ limits: { tokens: 10_000 } })
      yield* task(api, chat, "at the limit")
      yield* eventually(() => stepsEvents(events).some((e) => e.waitingFor === 1) && main.isHeld())
      const waiting = stepsEvents(events).find((e) => e.waitingFor === 1)!.versionId
      main.holdChild(null)
      yield* eventually(() => finished(events, waiting)?.status === "complete")
      const report = parents(mock.requests())
        .at(-1)!
        .messages.find((m) => m.role === "user" && text(m).includes("Subagent research-1 (cards)"))!
      assert.include(text(report), "Stopped at its limit")
      assert.include(text(report), "It ended before reading your message")
      assert.lengthOf(children(mock.requests()), 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 8.
  it.live(
    "a subagent waiting for the user's answer isn't stopped at its wall-time limit meanwhile",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        let storyId = ""
        const main = scripted({
          parent: (messages) => (toolsDone(messages) === 0 ? spawn("spawn") : "Done."),
          // Reading a chat asks first by default.
          child: (messages) =>
            toolsDone(messages) === 0
              ? { call: { name: "read_chat", args: { chat: storyId }, id: "child-read" } }
              : "Two cards."
        })
        const { api, chat, events, mock, story } = yield* workshop(main.handler)
        storyId = story.id
        // 6 seconds of its own work; its read asks first.
        yield* api.ChangeSubagentSettings({ limits: { minutes: 0.1 } })
        const versionId = yield* task(api, chat, "ask in the child")
        const child = () => liveRow(events, "spawn")?.steps?.find((s) => s.kind === "tool" && s.status === "waiting")
        yield* eventually(() => child() !== undefined)
        // The user takes longer than its limit to answer.
        yield* Effect.sleep(8_000)
        const waitingStep = child()
        assert.isDefined(waitingStep, "still asking")
        const prompt = waitingStep!.kind === "tool" ? waitingStep!.approval! : undefined
        yield* answer(api, prompt!, "allow")
        yield* eventually(() => finished(events, versionId)?.status === "complete")
        const result = toolResults(parents(mock.requests()).at(-1)!.messages)[0]!
        assert.include(result, "Two cards.")
        assert.include(result, "&quot;status&quot;:&quot;done&quot;")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    60_000
  )

  // Finding 11.
  it.live("a resumed subagent's turn cap counts from the resume, as its other limits do", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) => (toolsDone(messages) === 0 ? spawn("spawn") : "Done."),
        // Never done on its own: only its cap ends it.
        child: (messages) => ({
          call: { name: "list_library", args: { kind: "card" }, id: `child-${toolsDone(messages)}` }
        })
      })
      const { api, chat, events, mock } = yield* workshop(main.handler)
      yield* api.ChangeSubagentSettings({ limits: { requests: 4 } })
      main.holdChild(2)
      const versionId = yield* task(api, chat, "resume a capped one")
      yield* eventually(() => main.isHeld())
      yield* api.StopGeneration({ versionId })
      yield* eventually(() => finished(events, versionId) !== undefined)
      const before = children(mock.requests()).length
      main.holdChild(null)
      const resumed = yield* resume(api, chat, versionId)
      yield* eventually(() => finished(events, resumed)?.status === "complete")
      const after = children(mock.requests()).slice(before)
      assert.lengthOf(after, 4, "four requests from the resume on")
      assert.include(JSON.stringify(after.at(-1)!.messages), "Write your report now.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  // Finding 11.
  it.live("a background subagent's chat state goes to the message that holds its call", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const main = scripted({
        parent: (messages) =>
          reported(messages)
            ? "Summed up."
            : toolsDone(messages) === 0
              ? spawn("spawn", { background: true })
              : "Waiting.",
        child: once("Two cards.")
      })
      main.holdChild(1)
      const { api, chat, events } = yield* workshop(main.handler)
      const versionId = yield* task(api, chat, "state")
      yield* eventually(() => stepsEvents(events).some((e) => e.waitingFor === 1) && main.isHeld())
      const me = yield* api.Whoami()
      const [rows] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT id FROM rollouts WHERE spawned_by_rollout_id IS NOT NULL" }],
        { readOnly: true }
      )
      // The reply posted "Waiting." (it holds the call) and goes on in a new message meanwhile.
      yield* (yield* Writer).ApplyRolloutEffect({
        userId: me.id,
        rolloutId: String(rows![0]!["id"]),
        toolCallId: "child-state",
        events: [{ key: "agent.enabled", value: { on: true } }],
        result: "Done."
      })
      const [placed] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT version_id FROM state_events WHERE origin_ref LIKE '%child-state%'" }],
        { readOnly: true }
      )
      assert.deepStrictEqual(placed, [{ version_id: versionId }])
      main.holdChild(null)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("the run's mailbox", () => {
  // Finding 11.
  it("waiting resolves at once when the last background subagent ended before it was asked", async () => {
    const mailbox = new Mailbox()
    mailbox.start("call")
    mailbox.end("call")
    const result = await Promise.race([
      mailbox.next().then(() => "woke"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 200))
    ])
    assert.strictEqual(result, "woke")
  })

  // Finding 10.
  it("a subagent's report drops its undelivered progress line", () => {
    const mailbox = new Mailbox()
    mailbox.note("research-1", { role: "rpApp", content: "Progress", timestamp: 0 } as never)
    mailbox.post({
      role: "rpApp",
      content: "Report",
      report: { callId: "c", handle: "research-1" },
      timestamp: 0
    } as never)
    assert.deepStrictEqual(
      mailbox.drain().map((m) => (m as { content: string }).content),
      ["Report"]
    )
  })
})
