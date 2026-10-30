// Generating at the insertion point (spec/MESSAGE-INSERT.md §4.2, §5, unit 6), through the
// `message.insert` command and a mock provider. Messages are in causal order (owner,
// 2026-10-30): a generated inserted message is assembled like a mid-history regenerate, from
// the fork's display path up to the anchor, and the model never sees what follows it.
import { assert, describe, it } from "@effect/vitest"
import type { EntityId, ForkId, PathEntry, VersionId } from "@rp/shared/chat.ts"
import { CurrentUser } from "@rp/shared/api.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { InsertBody } from "@rp/shared/messagesApi.ts"
import { Effect, Stream } from "effect"
import { Writer } from "../src/db/Database.ts"
import { Generator } from "../src/chat/Generator.ts"
import { Commands } from "../src/commands.ts"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import { completeFixture } from "./support/lcmFixtures.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const GREETING = "Late again, Tobin."
const SENT = "The road flooded."

/**
 * A mock provider answering each completion with "Reply n." (n counts completions). While
 * `hold` is set, answers wait until `release()`.
 */
const provider = () =>
  Effect.gen(function* () {
    let count = 0
    const held: Array<() => void> = []
    const state = { hold: false }
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startMockProvider(async (request, res) => {
          if (!request.path.endsWith("/chat/completions")) return sse(res, [])
          const n = ++count
          if (state.hold) await new Promise<void>((resolve) => held.push(resolve))
          sse(res, completionChunks([`Reply ${n}.`], { prompt_tokens: 10, completion_tokens: 2 }))
        })
      ),
      (m) =>
        Effect.promise(() => {
          for (const resolve of held.splice(0)) resolve()
          return m.close()
        })
    )
    const completions = () => mock.requests().filter((r) => r.path.endsWith("/chat/completions"))
    return {
      mock,
      state,
      completions,
      release: () => {
        state.hold = false
        for (const resolve of held.splice(0)) resolve()
      }
    }
  })

/** What a completion request sent the model, as one string. */
const sent = (request: Recorded) => JSON.stringify(request.body?.["messages"] ?? [])

const read = (api: Api, chatId: string, forkId?: ForkId) =>
  Effect.map(
    api.ReadPath({
      chatId: chatId as never,
      ...(forkId ? { forkId } : {}),
      leafSlotId: null,
      range: { _tag: "Bottom" },
      limit: 50
    }),
    (window) => window.entries
  )

const texts = (entries: ReadonlyArray<PathEntry>) => entries.map((e) => e.version.content)

/** A chat greeted by Mira, the user's message as Tobin and Mira's reply, all through the mock. */
const setup = (api: Api, url: string) =>
  Effect.gen(function* () {
    const ready = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${url}/v1` },
      model: {},
      greeting: `*Mira looks up.* ${GREETING}`,
      content: SENT
    })
    const entries = yield* read(api, ready.chat.id)
    const [greeting, message, reply] = entries
    const mira = greeting!.version.speakerEntityId as EntityId
    // The card the user plays.
    const cast = yield* api.GetCast({ chatId: ready.chat.id, slotId: null })
    const tobin = cast.playedByMe[0]!
    return {
      ...ready,
      forkId: ready.chat.currentForkId as ForkId,
      greeting: greeting!,
      message: message!,
      reply: reply!,
      mira,
      tobin
    }
  })

const insert = (api: Api, chatId: string, forkId: ForkId, anchor: PathEntry | null, body: InsertBody) =>
  api.InsertMessage({
    chatId: chatId as never,
    forkId,
    anchor: anchor?.slotId ?? null,
    expectedRowVersion: anchor?.rowVersion ?? 0,
    body
  })

const done = (events: ReadonlyArray<ChatEvent>, versionId: VersionId) =>
  eventually(() => {
    const version = finished(events, versionId)
    return version !== undefined && version.status !== "generating"
  }).pipe(Effect.map(() => finished(events, versionId)!))

describe("generating an inserted message", () => {
  it.live("is assembled from the display path up to the anchor, as the chosen speaker", () =>
    Effect.gen(function* () {
      const { completions, mock } = yield* provider()
      const api = yield* client()
      const s = yield* setup(api, mock.url)
      const tobin = s.tobin

      // Below the greeting, as Tobin (the user's card): the model sees the greeting only.
      const before = completions().length
      const x1 = yield* insert(api, s.chat.id, s.forkId, s.greeting, { _tag: "Generate", speaker: tobin })
      assert.strictEqual(x1.entry.version.status, "generating")
      assert.strictEqual(x1.entry.position, 1)
      const v1 = yield* done(s.events, x1.entry.version.id)
      assert.strictEqual(v1.status, "complete")
      assert.strictEqual(v1.content, "Reply 2.")
      assert.strictEqual(v1.speakerEntityId, tobin)
      const first = completions()[before]!
      assert.include(sent(first), GREETING)
      assert.notInclude(sent(first), SENT)
      assert.notInclude(sent(first), "Reply 1.")
      // The user's card's turn: an impersonation, as the composer's Generate as Tobin is.
      assert.strictEqual((yield* api.GetRunContext({ versionId: v1.id })).type, "impersonate")

      // Below the user's message, as Mira with a direction: it sees the greeting, the message
      // inserted before it and the user's message, and none of the reply that follows.
      const x2 = yield* insert(api, s.chat.id, s.forkId, s.message, {
        _tag: "Generate",
        speaker: s.mira,
        direction: "Mention the lantern."
      })
      assert.strictEqual(x2.entry.position, 3)
      const v2 = yield* done(s.events, x2.entry.version.id)
      assert.strictEqual(v2.speakerEntityId, s.mira)
      assert.strictEqual(v2.direction, "Mention the lantern.")
      const second = sent(completions()[before + 1]!)
      assert.include(second, GREETING)
      assert.include(second, "Reply 2.")
      assert.include(second, SENT)
      assert.include(second, "Mention the lantern.")
      assert.notInclude(second, "Reply 1.")
      assert.isBelow(second.indexOf(GREETING), second.indexOf("Reply 2."))
      assert.isBelow(second.indexOf("Reply 2."), second.indexOf(SENT))
      assert.notStrictEqual((yield* api.GetRunContext({ versionId: v2.id })).type, "impersonate")

      // The fork shows them in place, numbered by position, and the next reply reads them all.
      const entries = yield* read(api, s.chat.id)
      assert.deepStrictEqual(texts(entries), [`*Mira looks up.* ${GREETING}`, "Reply 2.", SENT, "Reply 3.", "Reply 1."])
      assert.deepStrictEqual(
        entries.map((e) => e.position),
        [0, 1, 2, 3, 4]
      )
      const next = yield* posted(api.Generate({ chatId: s.chat.id, parentSlotId: s.reply.slotId, branch: false }))
      yield* done(s.events, next.entry.version.id)
      const third = sent(completions().at(-1)!)
      for (const [a, b] of [
        [GREETING, "Reply 2."],
        ["Reply 2.", SENT],
        [SENT, "Reply 3."],
        ["Reply 3.", "Reply 1."]
      ] as const)
        assert.isBelow(third.indexOf(a), third.indexOf(b), `${a} before ${b}`)

      // Subscribers got each inserted slot with its position.
      const slots = s.events.flatMap((e) => (e._tag === "Slot" && e.entry.position !== undefined ? [e.entry] : []))
      assert.deepStrictEqual(
        slots.map((e) => [e.slotId, e.position]),
        [
          [x1.entry.slotId, 1],
          [x2.entry.slotId, 3]
        ]
      )

      // A retry of the first one still reads only what precedes it.
      const retry = yield* api.Regenerate({
        slotId: x1.entry.slotId,
        forkId: s.forkId,
        expectedRowVersion: entries[1]!.rowVersion
      })
      yield* done(s.events, retry.version.id)
      const retried = sent(completions().at(-1)!)
      assert.include(retried, GREETING)
      assert.notInclude(retried, SENT)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("never sees following messages through a summary crossing the insertion point", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const p = yield* provider()
      const api = yield* client()
      const writer = yield* Writer
      const s = yield* setup(api, p.mock.url)
      const userId = (yield* api.Whoami()).id
      yield* api.SetLcmEnabled({ chatId: s.chat.id, forkId: s.forkId, enabled: true })
      yield* completeFixture(
        config.dataDir,
        writer,
        userId,
        s.chat.id,
        [s.greeting, s.message, s.reply].map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 })),
        [],
        "FUTURE_SUMMARY_TEXT"
      )
      const before = p.completions().length
      const x = yield* insert(api, s.chat.id, s.forkId, s.greeting, { _tag: "Generate", speaker: s.tobin })
      yield* done(s.events, x.entry.version.id)
      const request = sent(p.completions()[before]!)
      assert.include(request, GREETING)
      assert.notInclude(request, SENT)
      assert.notInclude(request, "Reply 1.")
      assert.notInclude(request, "FUTURE_SUMMARY_TEXT")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("leaves out of a reply already generating, and is in a queued message's reply", () =>
    Effect.gen(function* () {
      const p = yield* provider()
      const api = yield* client()
      const s = yield* setup(api, p.mock.url)
      p.state.hold = true
      const before = p.completions().length
      const tip = yield* posted(api.Generate({ chatId: s.chat.id, parentSlotId: s.reply.slotId, branch: false }))
      yield* eventually(() => p.completions().length > before)

      const x = yield* insert(api, s.chat.id, s.forkId, s.greeting, {
        _tag: "Write",
        speaker: s.mira,
        content: "An inserted line."
      })
      assert.strictEqual(x.entry.position, 1)
      const queued = yield* api.SendMessage({
        chatId: s.chat.id,
        parentSlotId: tip.entry.slotId,
        branch: false,
        content: "Queued after the reply."
      })
      assert.strictEqual(queued._tag, "Queued")

      p.release()
      yield* done(s.events, tip.entry.version.id)
      assert.notInclude(sent(p.completions()[before]!), "An inserted line.")
      // The queued message posts at the tip, and its reply reads the inserted message.
      yield* eventually(() => p.completions().length > before + 1)
      const queuedReply = sent(p.completions()[before + 1]!)
      assert.include(queuedReply, "An inserted line.")
      assert.include(queuedReply, "Queued after the reply.")
      yield* eventually(() => s.events.some((e) => e._tag === "Version" && e.version.content === "Reply 3."))
      const entries = yield* read(api, s.chat.id)
      assert.deepStrictEqual(texts(entries).slice(0, 2), [`*Mira looks up.* ${GREETING}`, "An inserted line."])
      assert.deepStrictEqual(texts(entries).slice(-3), ["Reply 2.", "Queued after the reply.", "Reply 3."])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("leaves a generation in another fork untouched", () =>
    Effect.gen(function* () {
      const p = yield* provider()
      const api = yield* client()
      const writer = yield* Writer
      const s = yield* setup(api, p.mock.url)
      const userId = (yield* api.Whoami()).id as UserId
      const other = (yield* writer.CreateFork({
        userId,
        chatId: s.chat.id,
        fromForkId: s.forkId,
        atSlotId: s.reply.slotId
      })).fork.id as ForkId
      const shownThere = texts(yield* read(api, s.chat.id, other))

      p.state.hold = true
      const before = p.completions().length
      const there = yield* posted(
        api.Generate({ chatId: s.chat.id, forkId: other, parentSlotId: s.reply.slotId, branch: false })
      )
      yield* eventually(() => p.completions().length > before)
      yield* insert(api, s.chat.id, s.forkId, s.greeting, { _tag: "Write", speaker: s.mira, content: "Only in main." })
      p.release()
      yield* done(s.events, there.entry.version.id)
      assert.notInclude(sent(p.completions()[before]!), "Only in main.")

      // The other fork goes on without it: its path and its next request.
      assert.deepStrictEqual(texts(yield* read(api, s.chat.id, other)), [...shownThere, "Reply 2."])
      const again = yield* posted(
        api.Generate({ chatId: s.chat.id, forkId: other, parentSlotId: there.entry.slotId, branch: false })
      )
      yield* done(s.events, again.entry.version.id)
      assert.notInclude(sent(p.completions().at(-1)!), "Only in main.")
      assert.include(texts(yield* read(api, s.chat.id, s.forkId)), "Only in main.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("is stopped by Undo, which sends it to the bin, and restored in its gap", () =>
    Effect.gen(function* () {
      const p = yield* provider()
      const api = yield* client()
      const s = yield* setup(api, p.mock.url)
      p.state.hold = true
      const before = p.completions().length
      const x = yield* insert(api, s.chat.id, s.forkId, s.greeting, { _tag: "Generate", speaker: s.mira })
      yield* eventually(() => p.completions().length > before)

      // Undo: the message to the bin, its generation stopped with it.
      const item = yield* api.DeleteMessage({ slotId: x.entry.slotId, forkId: s.forkId })
      const stopped = yield* done(s.events, x.entry.version.id)
      assert.oneOf(stopped.status, ["stopped", "interrupted"])
      assert.notInclude(texts(yield* read(api, s.chat.id)), stopped.content)
      assert.strictEqual((yield* read(api, s.chat.id)).length, 3)
      p.release()

      yield* api.RestoreBinItem({ itemId: item.id })
      const entries = yield* read(api, s.chat.id)
      assert.strictEqual(entries[1]!.slotId, x.entry.slotId)
      assert.deepStrictEqual(
        entries.map((e) => e.position),
        [0, 1, 2, 3]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("two tabs inserting at one anchor both succeed, the newer directly below it", () =>
    Effect.gen(function* () {
      const p = yield* provider()
      const first = yield* client()
      const s = yield* setup(first, p.mock.url)
      const second = yield* client()
      const seen: Array<ChatEvent> = []
      yield* second.SubscribeChat({ chatId: s.chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => seen.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => seen.length > 0)
      // Both tabs saw the greeting at the same row version.
      const a = yield* insert(first, s.chat.id, s.forkId, s.greeting, { _tag: "Write", speaker: s.mira, content: "A" })
      const b = yield* insert(second, s.chat.id, s.forkId, s.greeting, { _tag: "Write", speaker: s.mira, content: "B" })
      assert.deepStrictEqual([a.entry.position, b.entry.position], [1, 1])
      const entries = yield* read(first, s.chat.id)
      assert.deepStrictEqual(texts(entries).slice(0, 4), [`*Mira looks up.* ${GREETING}`, "B", "A", SENT])
      // Each tab hears of both, each placed where it went.
      for (const events of [s.events, seen])
        yield* eventually(
          () =>
            events.filter(
              (e) =>
                e._tag === "Slot" && e.entry.position === 1 && [a.entry.slotId, b.entry.slotId].includes(e.entry.slotId)
            ).length === 2
        )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("refusals keep their tags through the command", () =>
    Effect.gen(function* () {
      const p = yield* provider()
      const api = yield* client()
      const s = yield* setup(api, p.mock.url)
      p.state.hold = true
      const swipe = yield* api.Regenerate({ slotId: s.reply.slotId, expectedRowVersion: s.reply.rowVersion })
      // A version still being written can't be duplicated.
      assert.strictEqual(
        yield* outcome(insert(api, s.chat.id, s.forkId, s.reply, { _tag: "Duplicate", versionId: swipe.version.id })),
        "InsertRefused"
      )
      p.release()
      yield* done(s.events, swipe.version.id)
      // An anchor deleted in the fork is a stale write.
      yield* api.DeleteMessage({ slotId: s.message.slotId, forkId: s.forkId })
      assert.strictEqual(
        yield* outcome(insert(api, s.chat.id, s.forkId, s.message, { _tag: "Write", speaker: null, content: "x" })),
        "StaleWrite"
      )
      // It's a registered command, which the RPC dispatches to; input it doesn't take is
      // refused at its boundary.
      const command = (yield* Commands).get("message.insert")!
      const me = yield* api.Whoami()
      assert.strictEqual(
        yield* outcome(
          command
            .execute({
              chatId: s.chat.id,
              forkId: s.forkId,
              anchor: null,
              expectedRowVersion: 0,
              body: { _tag: "Write" }
            })
            .pipe(Effect.provideService(CurrentUser, me))
        ),
        "HistoryRejected"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )

  it.live("Generate is refused when the server has nothing to generate with", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "No model" })
      const m = yield* posted(api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "m0" }))
      const forkId = m.chat.currentForkId as ForkId
      assert.strictEqual(
        yield* outcome(insert(api, chat.id, forkId, m.entry, { _tag: "Generate", speaker: null })),
        "GenerationUnavailable"
      )
      assert.deepStrictEqual(texts(yield* read(api, chat.id)), ["m0"])
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
