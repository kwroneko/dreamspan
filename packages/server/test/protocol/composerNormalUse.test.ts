import type { ChatSession } from "../../../client/src/features/chat/session.ts"
import type { PageEnv } from "../../../client/src/features/editor/backup.ts"
import { assert, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect, Layer } from "effect"
import { DraftClock } from "../../src/db/Database.ts"
import { Generator } from "../../src/chat/Generator.ts"
import { client, serverLayer, testConfig } from "../support/config.ts"
import { FakeIndexedDb } from "./fakeIndexedDb.ts"
const idb = new FakeIndexedDb()
globalThis.indexedDB = idb as unknown as IDBFactory
const { copiesOfUser, keepCopy, makeCopy } = await import("../../../client/src/features/editor/backup.ts")
const { ComposerDraft } = await import("../../../client/src/features/chat/composerDraft.ts")

type Api = Effect.Success<ReturnType<typeof client>>

/** A page: its own timers, run by hand, and the composer of one chat. */
const page = (
  api: Api,
  chatId: string,
  owner: string,
  time: BigInt64Array,
  /** Runs after each OpenComposer is answered, before the page goes on: a race laid out by hand. */
  afterOpen: () => Promise<unknown> = async () => {}
) => {
  /** What this page's keepalive requests wait for before they reach the server (`hold`). */
  let network: Promise<unknown> = Promise.resolve()
  const timers = new Map<number, () => void>()
  let next = 0
  const keepalives: Array<Promise<unknown>> = []
  const session = {
    id: chatId,
    call: async (
      fn: (client: (tag: string, p: never) => Effect.Effect<unknown, unknown>) => Effect.Effect<unknown, unknown>
    ) => {
      try {
        let opened = false
        const value = await Effect.runPromise(
          fn((tag, p) => {
            opened ||= tag === "OpenComposer"
            return (api as never as Record<string, (p: never) => Effect.Effect<unknown, unknown>>)[tag]!(p)
          })
        )
        if (opened) await afterOpen()
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: { tag: "Failed", message: String(error), problems: [], reason: null } }
      }
    }
  }
  const env: PageEnv = {
    setTimer: (run) => {
      timers.set(++next, run)
      return next
    },
    clearTimer: (timer) => void timers.delete(timer as number),
    now: () => Number(Atomics.load(time, 0)),
    keepalive: (_path, body) => {
      const { composers } = JSON.parse(body) as { composers: Array<never> }
      const sent = network
        .then(() => Promise.all(composers.map((save) => Effect.runPromise(api.SaveComposer(save)))))
        .then(
          (results) => ({ ok: true, recovered: results.filter((r) => r.recovered).length }),
          () => false as const
        )
      keepalives.push(sent)
      return sent
    }
  }
  const store = new ComposerDraft(session as unknown as ChatSession, owner, env)
  /** Runs the timers due, as the page would while the user pauses. */
  const pause = async (ms = 1000) => {
    Atomics.add(time, 0, BigInt(ms))
    for (let round = 0; round < 5; round++) {
      const due = [...timers.values()]
      timers.clear()
      for (const run of due) run()
      await store.flush()
    }
  }
  /** Keepalive requests from now on reach the server only once `release` is called. */
  const hold = () => {
    let release = () => {}
    network = new Promise<void>((resolve) => (release = resolve))
    return release
  }
  return { store, pause, keepalives, hold }
}

const open = async (store: InstanceType<typeof ComposerDraft>) => {
  store.setFork(null, false)
  await vi.waitFor(() => assert.isTrue(store.snapshot().ready))
}

/** Types `text` a few characters at a time, with saves now and then, as a person types. */
const typeOut = async (p: ReturnType<typeof page>, from: string, text: string) => {
  for (let at = from.length + 3; at < text.length; at += 3) {
    p.store.type(text.slice(0, at))
    if (at % 12 === 0) await p.pause(700)
    else Atomics.add(time0(), 0, 150n)
  }
  p.store.type(text)
}
let clockView: BigInt64Array | null = null
const time0 = () => clockView!

const send = (api: Api, p: ReturnType<typeof page>, parentSlotId: string | null) => {
  let slot: string | null = null
  return p.store
    .submit(async (from) => {
      const result = await Effect.runPromise(
        api.SendMessage({
          chatId: p.store["chatId"] as never,
          parentSlotId: parentSlotId as never,
          branch: false,
          content: from.text,
          composer: { draftId: from.draftId, session: from.session }
        })
      )
      if (result._tag === "Posted") slot = result.entry.slotId
      return { sent: true, draft: result.draft, recovered: result.recovered }
    })
    .then(() => slot)
}

const scenarios = [
  "typing with corrections",
  "rewriting a sentence",
  "cutting the text and pasting it back",
  "page hidden and shown again",
  "reload",
  "a late copy of text already sent"
] as const
for (const scenario of scenarios)
  it.live(`${scenario}, sending and reopening the chat moves no text to the bin and shows no notice`, () => {
    const clock = new SharedArrayBuffer(8)
    const time = new BigInt64Array(clock)
    clockView = time
    Atomics.store(time, 0, BigInt(Date.now()))
    return Effect.gen(function* () {
      idb.clear()
      const api = yield* client()
      const owner = (yield* api.Whoami()).id
      const chat = yield* api.CreateChat({ title: "Synthetic normal use" })
      yield* Effect.promise(async () => {
        let first = page(api, chat.id, owner, time)
        await open(first.store)
        const opening = "The keeper climbs the stairs of the lighthouse slowly."
        await typeOut(first, "", opening)
        await first.pause(6000)
        let text = opening
        if (scenario === "typing with corrections") {
          text = opening.slice(0, -8)
          first.store.type(text)
          await first.pause(700)
          text = `${text}quickly, lamp in hand.`
          first.store.type(text)
        } else if (scenario === "rewriting a sentence") {
          text = "The keeper "
          first.store.type(text)
          await first.pause(700)
          text = "The keeper waits by the door, listening to the storm."
          await typeOut(first, "The keeper ", text)
        } else if (scenario === "cutting the text and pasting it back") {
          first.store.type("")
          await first.pause(700)
          text = `${opening} The lamp flickers.`
          first.store.type(text)
        } else if (scenario === "a late copy of text already sent") {
          // Kept while the page closed, never sent from it: the same words went from elsewhere.
          await keepCopy(
            makeCopy(
              owner,
              `composer:${chat.id}`,
              first.store.snapshot().draftId!,
              {
                kind: "composer",
                payload: {
                  chatId: chat.id,
                  draftId: first.store.snapshot().draftId!,
                  rowVersion: 1,
                  session: 0,
                  next: false,
                  content: opening.slice(0, 20)
                }
              },
              Number(Atomics.load(time, 0)) - 60_000
            )
          )
        } else if (scenario === "page hidden and shown again") {
          // pagehide without unloading (back-forward cache): the page comes back as it was.
          text = `${opening} Wind`
          first.store.type(text)
          first.store.beacon()
          await Promise.all(first.keepalives)
          text = `${opening} Wind howls outside.`
          await typeOut(first, `${opening} Wind`, text)
        } else {
          text = `${opening} Wind`
          first.store.type(text)
          // The page closes before the save; its keepalive arrives after the new page read the
          // composer, and before it looks for this browser's copies (the closing page, still
          // running, drops its copy once the keepalive is answered).
          const closing = first
          const release = closing.hold()
          closing.store.beacon()
          first = page(api, chat.id, owner, time, async () => {
            release()
            await Promise.all(closing.keepalives)
            await vi.waitFor(async () => assert.lengthOf(await copiesOfUser(owner), 0))
          })
          await open(first.store)
          assert.strictEqual(first.store.snapshot().text, text, "the reopened box has the last keystrokes")
          text = `${first.store.snapshot().text} howls outside.`
          first.store.type(text)
        }
        await first.pause(700)
        const slot = await send(api, first, null)
        assert.isNotNull(slot)
        // Typing the next message, then the page closes and the chat is opened again.
        first.store.type("Next")
        first.store.beacon()
        await first.pause(700)
        const again = page(api, chat.id, owner, time)
        await open(again.store)
        await again.pause(700)
        assert.strictEqual(again.store.snapshot().text, "Next")
        const recovered = await Effect.runPromise(api.ListRecoveredTexts({ limit: 100, before: null }))
        assert.deepStrictEqual(
          recovered.map((entry) => entry.content),
          // A sentence typed over is kept, without a word (DESIGN §6.2); nothing else was lost.
          scenario === "rewriting a sentence" ? [opening] : [],
          "only text that's nowhere else is in the recovered texts"
        )
        assert.deepStrictEqual(
          (await copiesOfUser(owner)).map((copy) => copy.content),
          [],
          "no browser copy is left"
        )
      })
    }).pipe(
      Effect.scoped,
      Effect.provide(serverLayer(testConfig(), Generator.none).pipe(Layer.provide(Layer.succeed(DraftClock)(clock))))
    )
  })
