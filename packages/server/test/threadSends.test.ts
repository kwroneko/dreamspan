// Sending one message to several threads (spec/THREADS.md §6, TH4) through the real server and a
// mock provider: Mira at the Lantern, Wren at the docks, the user playing Tobin. A copy in each
// thread, with its own speaker and its own reply generating at the same time, each from its own
// thread's path only; a copy queued behind a reply still being written there posts with its group;
// No one in one thread; Stop and a failure in one thread leave the other's reply be; a swipe of one
// thread's reply stays there; the copies link to each other; refusals. Synthetic data only.
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { foldState } from "@rp/shared/state.ts"
import type { SendTarget } from "@rp/shared/threadsApi.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, json, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

/** The text a request sends, all its messages joined. */
const sentText = (request: Recorded) =>
  ((request.body?.messages ?? []) as ReadonlyArray<{ content: unknown }>)
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as ReadonlyArray<{ text?: string }>).map((p) => p.text ?? "").join("")
    )
    .join("\n")

/** A provider whose answers wait until the test lets them go, each request in turn. */
const gatedProvider = Effect.gen(function* () {
  const waiting: Array<() => void> = []
  let open = true
  const mock = yield* Effect.acquireRelease(
    Effect.promise(() =>
      startMockProvider(async (request, res) => {
        if (!open) await new Promise<void>((resolve) => waiting.push(resolve))
        if (sentText(request).includes("[fail here]"))
          return json(res, 500, { error: { message: "The mock provider failed on purpose." } })
        sse(res, completionChunks(["The tide is out."], { prompt_tokens: 10, completion_tokens: 4 }))
      })
    ),
    (m) => Effect.promise(() => m.close())
  )
  return {
    mock,
    hold: () => void (open = false),
    release: () => {
      open = true
      for (const go of waiting.splice(0)) go()
    },
    waiting: () => waiting.length
  }
})

const story = Effect.gen(function* () {
  const provider = yield* gatedProvider
  const api = yield* client()
  const reader = yield* Reader
  const writer = yield* Writer
  const userId = (yield* api.Whoami()).id as UserId
  const made = yield* generateReply(api, {
    connection: { kind: "openai-chat", baseUrl: `${provider.mock.url}/v1` },
    model: {},
    characters: ["Wren"]
  })
  const chatId = made.chat.id
  const mira = made.mira.entityId as EntityId
  const wren = made.characters[0]!.entityId as EntityId
  const F = made.chat.currentForkId! as ForkId
  const S = made.version.slotId as SlotId
  const tobin = foldState(yield* reader.StateEventsAt({ userId, chatId, slotId: S, forkId: F }))
    .playedByMe[0] as EntityId
  const rowVersion = (slotId: SlotId, forkId: ForkId) =>
    Effect.map(reader.GetSlot({ userId, slotId, forkId }), (slot) => slot.entry.rowVersion)
  // A branch made before the threads: never one of them.
  const before = (yield* writer.CreateFork({ userId, chatId, fromForkId: F, atSlotId: S })).fork
  const started = yield* api.StartThreads({
    chatId,
    forkId: F,
    slotId: S,
    expectedRowVersion: yield* rowVersion(S, F),
    threads: [
      { name: "At the Lantern", cast: [mira], writesAs: tobin },
      { name: "At the docks", cast: [wren], writesAs: null }
    ]
  })
  const D = started.forkIds[1]!
  const say = (fork: ForkId, parent: SlotId, content: string) =>
    writer.AppendMessage({
      userId,
      chatId,
      forkId: fork,
      parentSlotId: parent,
      branch: false,
      commitDraft: null,
      version: new NewVersion({
        speakerEntityId: tobin,
        writer: "human",
        content,
        status: "complete",
        macroMode: "verbatim",
        origin: "user_written"
      })
    })
  const lantern = yield* say(F, S, "The fire at the Lantern crackles.")
  const docks = yield* say(D, S, "Gulls scream over the docks.")
  const tip = (fork: ForkId) =>
    Effect.map(
      reader.ReadPath({ userId, chatId, forkId: fork, leafSlotId: null, range: { _tag: "Bottom" }, limit: 5 }),
      (window) => window.entries.at(-1)!
    )
  const target = (forkId: ForkId, parentSlotId: SlotId, fields: Partial<SendTarget> = {}): SendTarget => ({
    forkId,
    parentSlotId,
    speakerEntityId: tobin,
    reply: true,
    replySpeakerEntityId: null,
    ...fields
  })
  /** The copies a message names, as fork `forkId` shows it. */
  const copiesOf = (slotId: SlotId, forkId: ForkId) =>
    Effect.map(reader.GetSlot({ userId, slotId, forkId }), (slot) => slot.entry.copies)
  return {
    ...provider,
    api,
    reader,
    writer,
    userId,
    chatId,
    mira,
    wren,
    tobin,
    F,
    D,
    S,
    before,
    lantern,
    docks,
    tip,
    target,
    copiesOf,
    events: made.events
  }
})

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))

describe("sending to several threads", () => {
  it.live("two replies generate at once, each from its own thread; the copies link to each other", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story
        const before = t.mock.requests().length
        t.hold()
        const sent = yield* t.api.SendToThreads({
          chatId: t.chatId,
          content: "Midnight. The harbor bells ring twelve times.",
          targets: [
            t.target(t.F, t.lantern.slotId, { replySpeakerEntityId: t.mira }),
            t.target(t.D, t.docks.slotId, { speakerEntityId: null, replySpeakerEntityId: t.wren })
          ]
        })
        // Both requests are out before either is answered: they run at the same time.
        yield* eventually(() => t.waiting() === 2)
        const [atLantern, atDocks] = t.mock.requests().slice(before)
        const lanternText = sentText(atLantern!)
        const docksText = sentText(atDocks!).includes("Gulls") ? sentText(atDocks!) : lanternText
        const other = docksText === lanternText ? sentText(atDocks!) : lanternText
        // Each thread's request holds its own line and the message, never the other thread's.
        assert.include(docksText, "Gulls scream")
        assert.notInclude(docksText, "The fire at the Lantern")
        assert.include(other, "The fire at the Lantern")
        assert.notInclude(other, "Gulls scream")
        for (const text of [docksText, other]) assert.include(text, "harbor bells ring twelve")
        t.release()

        assert.deepStrictEqual(
          sent.copies.map((copy) => [copy._tag, copy.forkId]),
          [
            ["Posted", t.F],
            ["Posted", t.D]
          ]
        )
        const [lanternCopy, docksCopy] = sent.copies.map((copy) => (copy._tag === "Posted" ? copy : null))
        assert.strictEqual(lanternCopy!.entry.version.speakerEntityId, t.tobin)
        assert.strictEqual(docksCopy!.entry.version.speakerEntityId, null)
        assert.strictEqual(lanternCopy!.reply!.version.speakerEntityId, t.mira)
        assert.strictEqual(docksCopy!.reply!.version.speakerEntityId, t.wren)
        for (const copy of [lanternCopy!, docksCopy!])
          yield* eventually(() => finished(t.events, copy.reply!.version.id)?.status === "complete")

        // One group: each copy names the other, with the fork that posted it.
        assert.deepStrictEqual(yield* t.copiesOf(lanternCopy!.entry.slotId, t.F), [
          { slotId: docksCopy!.entry.slotId, forkId: t.D }
        ])
        const docksWindow = yield* t.reader.ReadPath({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.D,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 5
        })
        const docksEntry = docksWindow.entries.find((entry) => entry.slotId === docksCopy!.entry.slotId)!
        assert.deepStrictEqual(docksEntry.copies, [{ slotId: lanternCopy!.entry.slotId, forkId: t.F }])
        // A reply has no copies; the user stays in the thread they sent from.
        assert.isUndefined(docksWindow.entries.at(-1)!.copies)
        assert.strictEqual((yield* t.api.GetChat({ chatId: t.chatId })).currentForkId, t.F)

        // A swipe of one thread's reply stays in that thread.
        const swiped = yield* t.api.Regenerate({
          slotId: docksCopy!.reply!.slotId,
          forkId: t.D,
          expectedRowVersion: (yield* t.tip(t.D)).rowVersion
        })
        yield* eventually(() => finished(t.events, swiped.version.id)?.status === "complete")
        assert.strictEqual((yield* t.tip(t.F)).version.id, lanternCopy!.reply!.version.id)
        assert.strictEqual((yield* t.tip(t.D)).versionCount, 2)

        // Deleting one copy: the other no longer links to it.
        yield* t.api.DeleteMessage({ slotId: docksCopy!.entry.slotId, forkId: t.D })
        assert.isUndefined(yield* t.copiesOf(lanternCopy!.entry.slotId, t.F))
      })
    )
  )

  it.live("a copy queued behind a reply still being written posts with its group; No one gets no reply", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story
        t.hold()
        // The docks' reply is still being written when the message is sent.
        const running = yield* t.api.Generate({
          chatId: t.chatId,
          forkId: t.D,
          parentSlotId: t.docks.slotId,
          branch: false,
          speakerEntityId: t.wren
        })
        assert.strictEqual(running._tag, "Posted")
        yield* eventually(() => t.waiting() === 1)
        const generations = t.mock.requests().length
        const sent = yield* t.api.SendToThreads({
          chatId: t.chatId,
          content: "Midnight. The harbor bells ring twelve times.",
          targets: [
            // Next is No one at the Lantern: the copy gets no reply there.
            t.target(t.F, t.lantern.slotId, { reply: false }),
            t.target(t.D, t.docks.slotId, { speakerEntityId: t.wren, replySpeakerEntityId: t.wren })
          ]
        })
        const [lanternCopy, docksCopy] = sent.copies
        assert.strictEqual(lanternCopy!._tag, "Posted")
        assert.isNull(lanternCopy!._tag === "Posted" ? lanternCopy!.reply : "queued")
        assert.strictEqual(docksCopy!._tag, "Queued")
        assert.strictEqual(sent.queue.length, 1)
        // Only the copy posted so far is in the group: it names none yet.
        const lanternSlot = lanternCopy!._tag === "Posted" ? lanternCopy!.entry.slotId : ("" as SlotId)
        assert.isUndefined(yield* t.copiesOf(lanternSlot, t.F))
        assert.strictEqual(t.mock.requests().length, generations)

        t.release()
        // The docks' reply ends, the queued copy posts with its group, and its reply is written.
        if (running._tag === "Posted")
          yield* eventually(() => finished(t.events, running.entry.version.id) !== undefined)
        yield* Effect.gen(function* () {
          const deadline = Date.now() + 20_000
          while ((yield* t.copiesOf(lanternSlot, t.F)) === undefined) {
            if (Date.now() > deadline) return yield* Effect.die(new Error("the queued copy never posted"))
            yield* Effect.sleep(20)
          }
        })
        const window = yield* t.reader.ReadPath({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.D,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 6
        })
        const posted = window.entries.find((entry) => entry.version.content.includes("harbor bells"))!
        assert.strictEqual(posted.version.speakerEntityId, t.wren)
        assert.deepStrictEqual(posted.copies, [{ slotId: lanternSlot, forkId: t.F }])
        assert.deepStrictEqual(yield* t.copiesOf(lanternSlot, t.F), [{ slotId: posted.slotId, forkId: t.D }])
        // Its reply was asked for when it posted.
        assert.strictEqual(window.entries.at(-1)!.parentSlotId, posted.slotId)
        // Nothing was asked of the provider at the Lantern.
        assert.strictEqual((yield* t.tip(t.F)).version.content, "Midnight. The harbor bells ring twelve times.")
      })
    )
  )

  it.live("Stop in one thread and a failure in another leave each other's reply be", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story
        t.hold()
        const sent = yield* t.api.SendToThreads({
          chatId: t.chatId,
          content: "Midnight. [fail here]",
          targets: [
            t.target(t.F, t.lantern.slotId, { replySpeakerEntityId: t.mira }),
            t.target(t.D, t.docks.slotId, { replySpeakerEntityId: t.wren })
          ]
        })
        yield* eventually(() => t.waiting() === 2)
        const [lanternCopy, docksCopy] = sent.copies.map((copy) => (copy._tag === "Posted" ? copy.reply! : null))
        // Stop at the Lantern: the docks' request goes on and fails by itself.
        yield* t.api.StopGeneration({ versionId: lanternCopy!.version.id })
        t.release()
        yield* eventually(() => finished(t.events, docksCopy!.version.id)?.status === "failed")
        yield* eventually(() => finished(t.events, lanternCopy!.version.id)?.status === "stopped")
      })
    )
  )

  it.live("refusals write nothing: a branch that isn't a thread, a thread twice, a tip that moved", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story
        const send = (targets: ReadonlyArray<SendTarget>) =>
          outcome(t.api.SendToThreads({ chatId: t.chatId, content: "Midnight.", targets: [...targets] }))
        assert.strictEqual(
          yield* send([t.target(t.F, t.lantern.slotId), t.target(t.before.id as ForkId, t.S)]),
          "ThreadsRefused"
        )
        assert.strictEqual(
          yield* send([t.target(t.D, t.docks.slotId), t.target(t.D, t.docks.slotId)]),
          "ThreadsRefused"
        )
        // The thread the user is in moved on in another tab.
        assert.strictEqual(yield* send([t.target(t.F, t.S), t.target(t.D, t.docks.slotId)]), "LeafMoved")
        assert.strictEqual((yield* t.tip(t.D)).slotId, t.docks.slotId)
        assert.strictEqual((yield* t.tip(t.F)).slotId, t.lantern.slotId)
      })
    )
  )
})
