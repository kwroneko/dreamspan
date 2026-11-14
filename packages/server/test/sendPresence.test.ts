// `send_message`'s `present` (DESIGN §3.5 [D], §7.2; spec/AGENTIC.md §4.5): a chat can have each
// agent reply say who is in the scene for the message it sends. Against a scripted mock that
// answers with the tool call: the setting off leaves the request as it was; on, the message's
// own presence record and the chat's away state follow what the reply named, so each
// character's later request has only what it was there for, in a plain group chat and after
// threads were joined; a wrong name is refused and corrected; the write happens once.
import { assert, describe, it } from "@effect/vitest"
import type { EntityId, ForkId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { awayAt } from "@rp/shared/knowledge.ts"
import { foldState, type StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { DatabaseSync } from "node:sqlite"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"
import { runStory } from "./support/threadStory.ts"

type Sent = { readonly message: string; readonly present?: ReadonlyArray<string> }
type Mode = "off" | "optional" | "required"

const sendCall = (args: Sent, id: string) => [
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            { index: 0, id, type: "function", function: { name: "send_message", arguments: JSON.stringify(args) } }
          ]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  },
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [],
    usage: { prompt_tokens: 90, completion_tokens: 5 }
  }
]

/** Answers each request that offers tools with the next queued send; anything else in plain text. */
const scriptedSends = (queue: Array<Sent>) => {
  let calls = 0
  return (request: Recorded, res: import("node:http").ServerResponse) => {
    const next = request.body?.tools ? queue.shift() : undefined
    if (next) {
      const chunks = sendCall(next, `call_${++calls}`)
      const limit = Number(request.body?.["max_tokens"] ?? request.body?.["max_completion_tokens"] ?? 5)
      const usage = chunks.at(-1)!.usage!
      usage.completion_tokens = Math.min(5, limit)
      sse(res, chunks)
    } else sse(res, completionChunks(["A plain reply."], { prompt_tokens: 80, completion_tokens: 3 }))
  }
}

type Body = {
  readonly tools?: ReadonlyArray<{
    readonly function: {
      readonly name: string
      readonly parameters: { readonly properties: Record<string, unknown>; readonly required?: ReadonlyArray<string> }
    }
  }>
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
}
const textOf = (body: Body) =>
  body.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : ((m.content ?? []) as ReadonlyArray<{ text?: string }>).map((p) => p.text ?? "").join("")
    )
    .join("\n")
const sendTool = (body: Body) => body.tools!.find((t) => t.function.name === "send_message")!.function

/**
 * Mira, Wren and Ash with the user's Tobin, in separate contexts, tools on with none allowed:
 * "The road flooded.", then Mira's reply, sent as `first` says.
 */
const scene = (
  dataDir: string,
  mode: Mode | null,
  first: ReadonlyArray<Sent>,
  options: {
    readonly characters?: ReadonlyArray<string>
    readonly narrator?: string
    readonly contract?: "final_text"
    readonly context?: "shared"
  } = {}
) =>
  Effect.gen(function* () {
    const queue = [...first]
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider(scriptedSends(queue))),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    const reader = yield* Reader
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id as UserId
    const names = options.characters ?? ["Wren", "Ash"]
    const state: Array<StateEventData> = [
      { key: "context.per_speaker", value: options.context ?? "separate" },
      { key: "agent.enabled", value: { on: true } },
      { key: "agent.tools", value: { tools: [] } }
    ]
    if (options.contract) state.push({ key: "output.contract", value: options.contract })
    if (mode) state.push({ key: "agent.send_presence", value: { mode } })
    const made = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      characters: names,
      state,
      before: (chat, ids) =>
        options.narrator
          ? writer.AddStateEvent({
              userId,
              chatId: chat.id,
              slotId: null,
              versionId: null,
              scope: null,
              data: { key: "cast.role", value: { entity: ids[names.indexOf(options.narrator)]!, role: "narrator" } }
            })
          : Effect.void
    })
    const chatId = made.chat.id
    const forkId = made.chat.currentForkId! as ForkId
    const ids: Record<string, EntityId> = { Mira: made.mira.entityId as EntityId }
    names.forEach((name, i) => (ids[name] = made.characters[i]!.entityId as EntityId))
    let tip = made.version.slotId as SlotId
    const bodies = () =>
      mock
        .requests()
        .filter((r) => r.path === "/v1/chat/completions")
        .map((r) => r.body as unknown as Body)
    const say = (content: string) =>
      Effect.gen(function* () {
        const sent = yield* posted(api.SendMessage({ chatId, parentSlotId: tip, branch: false, content }))
        tip = sent.entry.slotId
      })
    /** A reply by `speaker`, the model sending `sends` in turn until one is taken. */
    const turn = (speaker: string, ...sends: ReadonlyArray<Sent>) =>
      Effect.gen(function* () {
        queue.push(...sends)
        const { entry } = yield* posted(
          api.Generate({ chatId, parentSlotId: tip, branch: false, speakerEntityId: ids[speaker]! })
        )
        yield* eventually(() => finished(made.events, entry.version.id) !== undefined)
        tip = entry.slotId
        return finished(made.events, entry.version.id)!
      })
    /** A swipe of the reply at `slotId`, sent as `send` says. */
    const swipe = (slotId: SlotId, expectedRowVersion: number, send: Sent) =>
      Effect.gen(function* () {
        queue.push(send)
        const entry = yield* api.Regenerate({ slotId, forkId, expectedRowVersion })
        yield* eventually(() => finished(made.events, entry.version.id) !== undefined)
        return finished(made.events, entry.version.id)!
      })
    const away = (slotId: SlotId) =>
      Effect.map(reader.StateEventsAt({ userId, chatId, slotId, forkId }), (events) =>
        [...awayAt(foldState(events))].sort()
      )
    const stored = (versionId: VersionId) => {
      const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
      try {
        const row = db.prepare("SELECT rollout_id, presence_json FROM version_records WHERE id = ?").get(versionId) as {
          rollout_id: string
          presence_json: string | null
        }
        const receipts = db
          .prepare("SELECT tool_call_id FROM rollout_receipts WHERE rollout_id = ? ORDER BY tool_call_id")
          .all(row.rollout_id) as Array<{ tool_call_id: string }>
        return {
          rolloutId: row.rollout_id,
          presence:
            row.presence_json === null ? null : (JSON.parse(row.presence_json) as Record<string, Array<string>>),
          receipts: receipts.map((r) => r.tool_call_id)
        }
      } finally {
        db.close()
      }
    }
    const marks = () => api.GetAwayMarks({ chatId, forkId, slotId: tip })
    return {
      api,
      reader,
      writer,
      userId,
      chatId,
      forkId,
      made,
      ids,
      bodies,
      say,
      turn,
      swipe,
      away,
      stored,
      marks,
      enqueue: (...sends: ReadonlyArray<Sent>) => queue.push(...sends),
      tip: () => tip
    }
  })

const run = <A, E, R>(use: (dataDir: string) => Effect.Effect<A, E, R>) => {
  const config = testConfig()
  return use(config.dataDir).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
}
const sorted = (...ids: ReadonlyArray<string>) => [...ids].sort()

describe("send_message says who is present", () => {
  it.live("off, or never set: the tool takes only the message and the request is the same", () =>
    Effect.gen(function* () {
      const first = (mode: Mode | null) =>
        run((dataDir) =>
          Effect.gen(function* () {
            const t = yield* scene(dataDir, mode, [{ message: "Mira shrugs." }])
            assert.strictEqual(t.made.version.content, "Mira shrugs.")
            assert.isNull(t.stored(t.made.version.id).presence)
            return t.bodies()[0]!
          })
        )
      const never = yield* first(null)
      const off = yield* first("off")
      assert.deepStrictEqual(Object.keys(sendTool(never).parameters.properties), ["message"])
      assert.strictEqual(JSON.stringify(off), JSON.stringify(never))
    })
  )

  it.live("a named user persona and narrator leave their presence unchanged without a retry", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* scene(
          dataDir,
          "required",
          [{ message: "Mira and Tobin wait with Nara.", present: ["Mira", "Tobin", "Nara"] }],
          { characters: ["Wren", "Nara"], narrator: "Nara" }
        )
        assert.strictEqual(t.made.version.content, "Mira and Tobin wait with Nara.")
        assert.strictEqual(t.bodies().length, 1)
        assert.deepStrictEqual(t.stored(t.made.version.id).presence, {
          away: [t.ids["Wren"]!],
          narrators: [t.ids["Nara"]!]
        })
        assert.deepStrictEqual(yield* t.away(t.made.version.slotId), [t.ids["Wren"]!])
      })
    )
  )

  it.live("ambiguous names are refused before changing who can read the message", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* scene(
          dataDir,
          "required",
          [
            { message: "Ambiguous secret.", present: ["Mira", "Wren"] },
            { message: "Mira alone.", present: ["Mira"] }
          ],
          { characters: ["Wren", "Wren"] }
        )
        assert.strictEqual(t.made.version.content, "Mira alone.")
        assert.strictEqual(t.bodies().length, 2)
        assert.include(String(t.bodies()[1]!.messages.at(-1)!.content), "More than one character")
      })
    )
  )

  it.live("an auto token bound caps the captured request after model and preset settings", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* scene(dataDir, "off", [{ message: "An ordinary reply." }])
        const before = t.bodies().length
        const { entry } = yield* posted(
          t.api.Generate({
            chatId: t.chatId,
            forkId: t.forkId,
            parentSlotId: t.tip(),
            branch: false,
            speakerEntityId: t.ids["Mira"]!,
            outputLimit: 4
          })
        )
        yield* eventually(() => finished(t.made.events, entry.version.id) !== undefined)
        const body = t.bodies()[before]! as unknown as Record<string, unknown>
        assert.strictEqual(body["max_tokens"] ?? body["max_completion_tokens"], 4)
      })
    )
  )

  it.live("tool rounds share one hard token ceiling and exhaustion sends no further request", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* scene(dataDir, "required", [{ message: "Mira waits.", present: ["Mira", "Wren", "Ash"] }])
        const limited = (limit: number) =>
          Effect.gen(function* () {
            const before = t.bodies().length
            const { entry } = yield* posted(
              t.api.Generate({
                chatId: t.chatId,
                forkId: t.forkId,
                parentSlotId: (yield* t.api.GetChat({ chatId: t.chatId })).activeLeafSlotId,
                branch: false,
                speakerEntityId: t.ids["Mira"]!,
                outputLimit: limit,
                immediate: true
              })
            )
            yield* eventually(() => finished(t.made.events, entry.version.id) !== undefined)
            return {
              bodies: t.bodies().slice(before) as unknown as Array<Record<string, unknown>>,
              version: finished(t.made.events, entry.version.id)!
            }
          })
        t.enqueue({ message: "Wrong.", present: ["Nobody"] }, { message: "Correct.", present: ["Mira"] })
        const enough = yield* limited(8)
        assert.deepStrictEqual(
          enough.bodies.map((body) => body["max_tokens"] ?? body["max_completion_tokens"]),
          [8, 3]
        )
        assert.strictEqual(enough.version.content, "Correct.")
        t.enqueue({ message: "Wrong again.", present: ["Nobody"] }, { message: "Never billed.", present: ["Mira"] })
        const exhausted = yield* limited(4)
        assert.strictEqual(exhausted.bodies.length, 1)
        assert.strictEqual(exhausted.version.status, "failed")
      })
    )
  )

  it.live("must say still offers the required send tool when the old contract is final text", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* scene(dataDir, "required", [{ message: "Required via tool.", present: ["Mira"] }], {
          contract: "final_text"
        })
        assert.strictEqual(t.made.version.content, "Required via tool.")
        assert.deepStrictEqual(sendTool(t.bodies()[0]!).parameters.required, ["message", "present"])
        assert.strictEqual(t.bodies().length, 1)
      })
    )
  )

  it.live("shared contexts refuse presence declarations before a character request can leak history", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* scene(dataDir, "required", [{ message: "Never sent.", present: ["Mira"] }], {
          context: "shared"
        })
        assert.strictEqual(t.made.version.status, "failed")
        assert.strictEqual(t.bodies().length, 0)
        assert.include(t.made.version.error!.message, "Separate contexts")
      })
    )
  )

  it.live("required: who a reply names is there for it; the others miss it until named again", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* scene(dataDir, "required", [{ message: "Wren storms out.", present: ["Mira", "Ash"] }])
        const { Mira, Wren, Ash } = t.ids as { Mira: EntityId; Wren: EntityId; Ash: EntityId }
        const tool = sendTool(t.bodies()[0]!)
        assert.deepStrictEqual(Object.keys(tool.parameters.properties), ["message", "present"])
        assert.deepStrictEqual(tool.parameters.required, ["message", "present"])
        // The names aren't in the definition: it's the same for every cast.
        assert.notInclude(JSON.stringify(tool), "Wren")

        const left = t.made.version
        assert.strictEqual(left.status, "complete")
        assert.strictEqual(left.content, "Wren storms out.")
        // The message's own record, and the chat from it on. Tobin, the user's, wasn't named
        // and isn't away.
        assert.deepStrictEqual(t.stored(left.id).presence, { away: [Wren] })
        assert.deepStrictEqual(yield* t.away(left.slotId), [Wren])
        const marked = yield* t.marks()
        assert.strictEqual(marked.length, 1)
        assert.deepInclude(marked[0]!, { entityId: Wren, away: true, by: "character", slotId: left.slotId })

        // Nothing changes while the replies keep naming the same characters.
        yield* t.say("The vault code is 739.")
        const kept = yield* t.turn("Ash", { message: "Ash memorises it.", present: ["Ash", "Mira"] })
        assert.deepStrictEqual(t.stored(kept.id).presence, { away: [Wren] })
        assert.strictEqual((yield* t.marks()).length, 1)

        // Named again, she's back with that message.
        const back = yield* t.turn("Mira", { message: "Wren walks back in.", present: ["Mira", "Ash", "Wren"] })
        assert.isNull(t.stored(back.id).presence)
        assert.deepStrictEqual(yield* t.away(back.slotId), [])
        // The Cast tab's away marks name the reply's speaker.
        assert.deepStrictEqual(
          (yield* t.marks()).map((m) => [m.entityId, m.away, m.by]),
          [
            [Wren, true, "character"],
            [Wren, false, "character"]
          ]
        )
        assert.strictEqual((yield* t.marks())[1]!.setBy, Mira)

        // Each character's next request: Wren's has only what she was there for.
        const before = t.bodies().length
        yield* t.turn("Wren", { message: "What did I miss?", present: ["Mira", "Ash", "Wren"] })
        const forWren = textOf(t.bodies()[before]!)
        assert.include(forWren, "The road flooded.")
        assert.include(forWren, "Wren walks back in.")
        for (const missed of ["Wren storms out.", "The vault code is 739.", "Ash memorises it."])
          assert.notInclude(forWren, missed)
        const next = t.bodies().length
        yield* t.turn("Ash", { message: "Plenty.", present: ["Mira", "Ash", "Wren"] })
        const forAsh = textOf(t.bodies()[next]!)
        for (const heard of ["Wren storms out.", "The vault code is 739.", "Wren walks back in.", "What did I miss?"])
          assert.include(forAsh, heard)
        void Ash
      })
    )
  )

  it.live("a name nobody has, or no names at all, is refused and sent again; the write happens once", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* scene(dataDir, "required", [
          { message: "First try.", present: ["Mira", "Nobody"] },
          { message: "Second try." },
          { message: "Ash stays.", present: ["mira", " Ash "] }
        ])
        const { Wren } = t.ids as { Wren: EntityId }
        const version = t.made.version
        assert.strictEqual(version.content, "Ash stays.")
        const bodies = t.bodies()
        assert.strictEqual(bodies.length, 3)
        const refusal = bodies[1]!.messages.at(-1)!
        assert.strictEqual(refusal.role, "tool")
        assert.include(String(refusal.content), "No character called “Nobody” is in the chat. In it: ")
        for (const name of ["Mira", "Wren", "Ash"]) assert.include(String(refusal.content), name)
        assert.strictEqual(bodies[2]!.messages.at(-1)!.role, "tool")
        assert.deepStrictEqual(yield* t.away(version.slotId), [Wren])
        // Only the send that was taken wrote anything.
        const { rolloutId, receipts } = t.stored(version.id)
        assert.deepStrictEqual(receipts, ["call_3"])
        const again = yield* t.writer.DeclareRolloutPresence({
          userId: t.userId,
          rolloutId,
          toolCallId: "call_3",
          present: []
        })
        assert.deepStrictEqual(again, { left: [], back: [], replayed: true })
        assert.deepStrictEqual(yield* t.away(version.slotId), [Wren])
        assert.strictEqual((yield* t.marks()).length, 1)
        // A finished reply takes no new one.
        const late = yield* Effect.flip(
          t.writer.DeclareRolloutPresence({ userId: t.userId, rolloutId, toolCallId: "call_9", present: [] })
        )
        assert.strictEqual(late._tag, "NotFound")
      })
    )
  )

  it.live("optional: a send without names changes nothing; a swipe and your own change take over", () =>
    run((dataDir) =>
      Effect.gen(function* () {
        const t = yield* scene(dataDir, "optional", [{ message: "Mira waits." }], {
          characters: ["Wren", "Ash", "Nara"],
          narrator: "Nara"
        })
        const { Mira, Wren, Ash, Nara } = t.ids as Record<"Mira" | "Wren" | "Ash" | "Nara", EntityId>
        const tool = sendTool(t.bodies()[0]!)
        assert.deepStrictEqual(Object.keys(tool.parameters.properties), ["message", "present"])
        assert.deepStrictEqual(tool.parameters.required, ["message"])
        assert.deepStrictEqual(t.stored(t.made.version.id).presence, { narrators: [Nara] })
        assert.deepStrictEqual(yield* t.away(t.made.version.slotId), [])

        // Ash names only itself: the others the model speaks for are away; the narrator isn't.
        yield* t.say("Everyone else, out.")
        const alone = yield* t.turn("Ash", { message: "Ash is alone.", present: ["Ash"] })
        assert.deepStrictEqual(t.stored(alone.id).presence, { away: [Mira, Wren], narrators: [Nara] })
        assert.deepStrictEqual(yield* t.away(alone.slotId), sorted(Mira, Wren))

        // A swipe that names everyone: the first version's marks go with it.
        const row = (yield* t.reader.GetSlot({ userId: t.userId, slotId: alone.slotId, forkId: t.forkId })).entry
        const swipe = yield* t.swipe(row.slotId, row.rowVersion, {
          message: "Ash is among friends.",
          present: ["Ash", "Mira", "Wren"]
        })
        assert.strictEqual(swipe.content, "Ash is among friends.")
        assert.deepStrictEqual(t.stored(swipe.id).presence, { narrators: [Nara] })
        assert.deepStrictEqual(yield* t.away(alone.slotId), [])
        // The version swiped away keeps its own record.
        assert.deepStrictEqual(t.stored(alone.id).presence, { away: [Mira, Wren], narrators: [Nara] })

        // What a reply marked, you can change like any other away mark.
        const out = yield* t.turn("Mira", { message: "Wren slips out.", present: ["Mira", "Ash"] })
        assert.deepStrictEqual(yield* t.away(out.slotId), [Wren])
        yield* t.writer.AddStateEvent({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.forkId,
          slotId: out.slotId,
          versionId: null,
          scope: null,
          data: { key: "away.set", value: { entity: Wren, away: false } }
        })
        assert.deepStrictEqual(yield* t.away(out.slotId), [])
        void Ash
      })
    )
  )

  it.live("after threads are joined: a reply's names decide who reads it, in this branch only", () =>
    (() => {
      const queue: Array<Sent> = []
      return runStory(
        "separate",
        (t) =>
          Effect.gen(function* () {
            yield* t.append(t.D, t.wren, "Wren: Gulls scream over the empty docks.")
            yield* t.append(t.F, t.mira, "Mira waits.")
            const joined = (yield* t.join(t.F, [t.D])).entries[0]!.slotId
            assert.notInclude(yield* t.awayIn(t.F, joined), t.wren)
            const docksTip = (yield* t.append(t.D, t.wren, "Wren: A ship's light, far out.")).slotId
            const docksAway = yield* t.awayIn(t.D, docksTip)
            for (const change of [
              { _tag: "AgentEnabled", on: true },
              { _tag: "AgentTools", tools: [] },
              { _tag: "SendPresence", mode: "required" }
            ] as const)
              yield* t.api.ChangeCast({ chatId: t.chatId, forkId: t.F, slotId: joined, change })

            queue.push({ message: "Mira bolts the door behind Wren.", present: ["Mira"] })
            const { entry } = yield* posted(
              t.api.Generate({
                chatId: t.chatId,
                forkId: t.F,
                parentSlotId: joined,
                branch: false,
                speakerEntityId: t.mira
              })
            )
            yield* eventually(() => finished(t.events, entry.version.id) !== undefined)
            assert.strictEqual(finished(t.events, entry.version.id)!.content, "Mira bolts the door behind Wren.")
            const away = yield* t.awayIn(t.F, entry.slotId)
            for (const gone of [t.wren, t.pell, t.quill]) assert.include(away, gone)
            assert.notInclude(away, t.mira)
            // Wren read the join, not the message she wasn't named for; Mira reads both.
            const forWren = yield* t.contextFor(t.F, t.wren)
            assert.include(forWren, "Gulls scream over the empty docks.")
            assert.notInclude(forWren, "Mira bolts the door behind Wren.")
            assert.include(yield* t.contextFor(t.F, t.mira), "Mira bolts the door behind Wren.")
            // The docks thread is its own branch: nothing there changed.
            assert.deepStrictEqual(yield* t.awayIn(t.D, docksTip), docksAway)
          }),
        { respond: scriptedSends(queue) }
      )
    })()
  )
})
