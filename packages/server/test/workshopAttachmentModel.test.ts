import { assert, it } from "@effect/vitest"
import type { Chat } from "@dreamspan/shared/chat.ts"
import type { ComposerLibraryHandover } from "@dreamspan/shared/composerApi.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { mulberry32 } from "@dreamspan/shared/naturalOrder.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { slowIt } from "./support/slow.ts"

interface Workshop {
  readonly chatId: Chat["id"]
  readonly draftId: string
  readonly refs: Set<RefId>
  status: "pending" | "started" | "swept"
  recentSweep: boolean
  parent: Chat["activeLeafSlotId"]
}

interface Tab {
  workshop: Workshop
  session: number
  shown: ReadonlyArray<RefId>
  retry?: Carry
}

interface Url extends ComposerLibraryHandover {
  readonly refId: RefId
  at?: Workshop
}

interface Carry {
  readonly destination: Workshop
  readonly source: Workshop
  readonly refId: RefId
  readonly url?: Url
}

const actions = [
  "attach",
  "remove",
  "sweep",
  "carry",
  "retry",
  "URL replay",
  "handover",
  "expiry",
  "reload",
  "send"
] as const

const model = (seed: number, rounds: number) => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const writer = yield* Writer
    const { id: userId } = yield* api.Whoami()
    const refs = []
    for (const label of ["Channel markers", "Tide tables", "Harbour notices"])
      refs.push((yield* api.CreateLorebook({ label })).id)
    const random = mulberry32(seed)
    const pick = <A>(choices: ReadonlyArray<A>) => choices[Math.floor(random() * choices.length)]!
    const workshops = new Map<Chat["id"], Workshop>()
    const urls: Url[] = []
    const history: string[] = []
    const context = () => `seed ${seed}: ${history.join(", ")}`
    const key = ({ chatId, draftId }: Workshop) => ({ chatId, draftId })
    const checkList = (refs: ReadonlyArray<RefId>, workshop: Workshop) =>
      assert.deepStrictEqual([...refs].sort(), [...workshop.refs].sort(), context())

    // The model moves ownership between workshops. Every copy of a URL follows the item
    // it applied, while a carry names a specific predecessor.
    const move = (source: Workshop, destination: Workshop, refId: RefId) => {
      if (source.status !== "swept" || !source.refs.delete(refId)) return
      destination.refs.add(refId)
      for (const url of urls) if (url.at === source && url.refId === refId) url.at = destination
    }
    const open = (reopen?: Workshop) =>
      Effect.gen(function* () {
        const chat = yield* api.OpenDraftChat({
          draftFor: "workshop::",
          ...(reopen === undefined ? {} : { reopen: reopen.chatId })
        })
        const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
        const workshop = workshops.get(chat.id) ?? {
          chatId: chat.id,
          draftId: draft.id,
          refs: new Set<RefId>(),
          status: "pending",
          recentSweep: false,
          parent: chat.activeLeafSlotId
        }
        if (reopen !== undefined) {
          if (reopen.status === "swept") {
            assert.notStrictEqual(workshop.chatId, reopen.chatId, context())
            for (const refId of reopen.refs) move(reopen, workshop, refId)
          } else assert.strictEqual(workshop.chatId, reopen.chatId, context())
        }
        workshops.set(chat.id, workshop)
        const shown = (yield* api.GetComposerLibrary(key(workshop))).map((item) => item.refId)
        checkList(shown, workshop)
        const tab: Tab = { workshop, session: draft.session, shown }
        return tab
      })

    const change = (tab: Tab, add: ReadonlyArray<RefId>, remove: ReadonlyArray<RefId>) =>
      Effect.gen(function* () {
        if (tab.workshop.status === "swept") return
        for (const refId of remove) tab.workshop.refs.delete(refId)
        for (const refId of add) tab.workshop.refs.add(refId)
        tab.shown = (yield* api.SetComposerLibrary({ ...key(tab.workshop), add, remove })).map((item) => item.refId)
        checkList(tab.shown, tab.workshop)
      })
    const follow = (tab: Tab, url: Url) =>
      Effect.gen(function* () {
        const { workshop } = tab
        if (workshop.status === "swept") return
        const { originChatId, operationId, refId } = url
        if (workshop.status === "pending") {
          const origin = workshops.get(originChatId)!
          if (url.at !== undefined) move(url.at, workshop, refId)
          else if (origin === workshop || origin.recentSweep || (origin.status === "swept" && origin.refs.has(refId))) {
            move(origin, workshop, refId)
            workshop.refs.add(refId)
            url.at = workshop
          }
        }
        tab.shown = (yield* api.SetComposerLibrary({
          ...key(workshop),
          add: [refId],
          remove: [],
          handover: { originChatId, operationId }
        })).map((item) => item.refId)
        checkList(tab.shown, workshop)
      })
    const carry = (tab: Tab, { destination, source, refId, url }: Carry) =>
      Effect.gen(function* () {
        const result = yield* api
          .SetComposerLibrary({
            ...key(destination),
            add: [refId],
            remove: [],
            carriedFrom: source.chatId,
            ...(url === undefined ? {} : { handover: { originChatId: url.originChatId, operationId: url.operationId } })
          })
          .pipe(Effect.result)
        if (destination.status === "swept") {
          if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "NotFound", context())
          else assert.fail(context())
          return
        }
        move(source, destination, refId)
        if (result._tag === "Failure") return assert.fail(`${context()}: ${result.failure._tag}`)
        const shown = result.success.map((item) => item.refId)
        checkList(shown, destination)
        if (tab.workshop === destination) tab.shown = shown
      })
    const checkOwnership = () =>
      Effect.gen(function* () {
        const [actual] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: `SELECT d.target_id AS chatId, l.ref_id AS refId, 'composer' AS location
                  FROM composer_library l JOIN drafts d ON d.id = l.draft_id WHERE d.user_id = ?
                UNION ALL
                SELECT chat_id, ref_id, 'swept' FROM swept_composer_library WHERE user_id = ?`,
              params: [userId, userId]
            }
          ],
          { readOnly: true }
        )
        const expected = [...workshops.values()].flatMap(({ chatId, status, refs }) =>
          [...refs].map((refId) => `${chatId}/${refId}/${status === "swept" ? "swept" : "composer"}`)
        )
        // B includes swept workshops that neither tab has reopened yet.
        assert.deepStrictEqual(
          actual!.map((row) => `${row.chatId}/${row.refId}/${row.location}`).sort(),
          expected.sort(),
          context()
        )
      })

    let first: Tab = yield* open()
    let second: Tab = yield* open(first.workshop)
    const initial = { originChatId: first.workshop.chatId, operationId: "initial", refId: refs[0]! }
    urls.push(initial, { ...initial, operationId: "lost-before-apply", refId: refs[1]! })
    yield* follow(first, initial)
    yield* change(second, [refs[2]!], [])
    yield* checkOwnership()
    for (let round = 0; round < rounds; round++) {
      const remaining = [...actions]
      while (remaining.length > 0) {
        const [action] = remaining.splice(Math.floor(random() * remaining.length), 1)
        const left = random() < 0.5
        const [tab, other] = left ? [first, second] : [second, first]
        const here = tab.workshop
        const refId = pick(refs)
        const visit = (next: Tab) => {
          if (tab.retry !== undefined) next.retry = tab.retry
          if (left) first = next
          else second = next
        }
        history.push(`${left ? "A" : "B"} ${action}`)
        switch (action) {
          case "attach":
            yield* change(tab, [refId], [])
            break
          case "remove":
            yield* change(tab, [], [refId])
            break
          case "sweep":
            if (here.status === "pending") {
              assert.isTrue(yield* writer.SweepPendingChat({ userId, chatId: here.chatId }), context())
              here.status = "swept"
              here.recentSweep = true
            }
            break
          case "carry": {
            const sources = [...workshops.values()].filter((workshop) => workshop.status === "swept")
            if (sources.length === 0) break
            const dest = here.status === "swept" ? yield* open() : tab
            visit(dest)
            const url = random() < 0.5 ? urls.find((url) => url.refId === refId) : undefined
            dest.retry = { destination: dest.workshop, source: pick(sources), refId, ...(url ? { url } : {}) }
            yield* carry(dest, dest.retry)
            break
          }
          case "retry":
            if (tab.retry !== undefined) yield* carry(tab, tab.retry)
            break
          case "URL replay": {
            const dest = here.status === "swept" ? yield* open() : tab
            visit(dest)
            yield* follow(dest, pick(urls))
            break
          }
          case "handover":
            if (here.status === "pending") {
              const url = { originChatId: here.chatId, operationId: `handover-${round}`, refId }
              urls.push(url)
              yield* follow(tab, url)
            }
            break
          case "expiry": {
            yield* fixtureSql(config.dataDir, [{ sql: "UPDATE swept_pending_chats SET swept_at = 1" }])
            for (const workshop of workshops.values()) workshop.recentSweep = false
            const prune = yield* api.OpenDraftChat({ draftFor: "workshop::" })
            yield* writer.SweepPendingChat({ userId, chatId: prune.id })
            break
          }
          case "reload":
            visit(yield* open(random() < 0.7 ? here : other.workshop))
            break
          case "send": {
            const chosen = tab.shown.length > 0 && random() < 0.6 ? pick(tab.shown) : refId
            const credential = pick([tab, tab, tab, other, undefined])
            const allowed = here.status !== "swept" && here.refs.has(chosen) && credential?.workshop === here
            const result = yield* api
              .SendMessage({
                chatId: here.chatId,
                parentSlotId: here.parent,
                branch: false,
                reply: false,
                content: "Review these notes.",
                library: [{ kind: "lorebook", refId: chosen }],
                ...(credential === undefined
                  ? {}
                  : { composer: { draftId: credential.workshop.draftId, session: credential.session } })
              })
              .pipe(Effect.result)
            // A applies to stale, cross-tab and missing credentials as well as successful sends.
            if (!allowed) {
              if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "NotFound", context())
              else assert.fail(context())
              break
            }
            if (result._tag !== "Success" || result.success._tag !== "Posted") return assert.fail(context())
            assert.deepStrictEqual(
              result.success.entry.version.library?.map((item) => item.refId),
              [chosen],
              context()
            )
            here.refs.delete(chosen)
            here.status = "started"
            here.parent = result.success.entry.slotId
            if (result.success.draft !== null) tab.session = result.success.draft.session
            break
          }
        }
        yield* checkOwnership()
      }
    }
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
}

for (const seed of [9, 41])
  it.live(`preserves workshop attachment ownership in two tabs (seed ${seed})`, () => model(seed, 6), 60_000)

for (let seed = 100; seed < 112; seed++)
  slowIt.live(`preserves workshop attachment ownership in a longer run (seed ${seed})`, () => model(seed, 16), 120_000)
