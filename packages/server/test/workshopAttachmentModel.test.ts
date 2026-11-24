import { assert, it } from "@effect/vitest"
import type { BinItem } from "@dreamspan/shared/bin.ts"
import type { Chat, EntityId } from "@dreamspan/shared/chat.ts"
import type { ComposerLibraryHandover } from "@dreamspan/shared/composerApi.ts"
import type { DraftFor } from "@dreamspan/shared/draftChatApi.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { mulberry32 } from "@dreamspan/shared/naturalOrder.ts"
import { Effect, Stream } from "effect"
import { rememberDraftFor, reopenSweptDraft } from "../../client/src/features/chat/chatStarted.ts"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { slowIt } from "./support/slow.ts"

interface Workshop {
  readonly chatId: Chat["id"]
  readonly draftId: string
  readonly draftFor: DraftFor
  readonly refs: Set<RefId>
  status: "pending" | "started" | "swept"
  recentSweep: boolean
  parent: Chat["activeLeafSlotId"]
  replacement?: Workshop
}

interface Tab {
  workshop: Workshop
  session: number
  shown: ReadonlyArray<RefId>
  retry?: Carry
  reopen?: Workshop
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
  "side reconnect",
  "delete story branch",
  "restore story branch",
  "purge assistant card",
  "bin",
  "restore",
  "drop reopen reply",
  "retry reopen",
  "legacy replay",
  "send"
] as const

const model = (seed: number, rounds: number) => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const writer = yield* Writer
    const { id: userId } = yield* api.Whoami()
    const books = new Map<RefId, EntityId>()
    const createBook = (label: string) =>
      Effect.gen(function* () {
        const book = yield* api.CreateLorebook({ label })
        books.set(book.id, book.entityId)
        return book.id
      })
    const refs = yield* Effect.forEach(["Channel markers", "Tide tables", "Harbour notices"], createBook)
    const binned = new Map<RefId, BinItem["id"]>()
    const story = yield* api.CreateChat({ title: "The lighthouse" })
    const opening = yield* api.SendMessage({
      chatId: story.id,
      parentSlotId: null,
      branch: false,
      reply: false,
      content: "The tide turns."
    })
    if (opening._tag !== "Posted") return assert.fail("Expected the story's opening message to post")
    const sideEntry = `side:${story.id}:${story.currentForkId ?? ""}` as const
    const legacyOrigin = uuidv7() as Chat["id"]
    const random = mulberry32(seed)
    const pick = <A>(choices: ReadonlyArray<A>) => choices[Math.floor(random() * choices.length)]!
    const workshops = new Map<Chat["id"], Workshop>()
    const urls: Url[] = []
    const sent = new Map<string, RefId>()
    const history: string[] = []
    const context = () => `seed ${seed}: ${history.join(", ")}`
    const key = ({ chatId, draftId }: Workshop) => ({ chatId, draftId })
    const checkList = (refs: ReadonlyArray<RefId>, workshop: Workshop) =>
      assert.deepStrictEqual(
        [...refs].sort(),
        [...workshop.refs].filter((refId) => !binned.has(refId)).sort(),
        `invariant B, ${context()}`
      )

    // The model moves ownership between workshops. Every copy of a URL follows the item
    // it applied, while a carry names a specific predecessor.
    const move = (source: Workshop, destination: Workshop, refId: RefId) => {
      if (source.status !== "swept" || !source.refs.delete(refId)) return false
      destination.refs.add(refId)
      for (const url of urls) if (url.at === source && url.refId === refId) url.at = destination
      return true
    }
    const open = (
      reopen?: Workshop,
      draftFor: DraftFor = reopen?.draftFor ?? "workshop::",
      requestReopen = reopen?.chatId ?? null
    ) =>
      Effect.gen(function* () {
        let source = reopen
        while (source?.status === "swept" && source.replacement !== undefined) source = source.replacement
        const opened = yield* api
          .OpenDraftChat({ draftFor, ...(requestReopen === null ? {} : { reopen: requestReopen }) })
          .pipe(Effect.result)
        if (opened._tag === "Failure")
          return assert.fail(`invariant B, ${context()}: opening ${draftFor} failed with ${opened.failure._tag}`)
        const chat = opened.success
        if (source?.status === "swept") assert.notInclude([...workshops.keys()], chat.id, context())
        else if (source !== undefined) assert.strictEqual(chat.id, source.chatId, context())
        else assert.notInclude([...workshops.keys()], chat.id, context())
        const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
        const workshop = workshops.get(chat.id) ?? {
          chatId: chat.id,
          draftId: draft.id,
          draftFor,
          refs: new Set<RefId>(),
          status: "pending",
          recentSweep: false,
          parent: chat.activeLeafSlotId
        }
        if (source?.status === "swept") {
          source.replacement = workshop
          for (const refId of source.refs) move(source, workshop, refId)
        }
        workshops.set(chat.id, workshop)
        if (workshop.status === "pending") rememberDraftFor(chat.id, draftFor)
        const shown = (yield* api.GetComposerLibrary(key(workshop))).map((item) => item.refId)
        checkList(shown, workshop)
        const tab: Tab = { workshop, session: draft.session, shown }
        return tab
      })
    const reconnect = (workshop: Workshop) =>
      Effect.gen(function* () {
        const gone = yield* api.SubscribeChat({ chatId: workshop.chatId }).pipe(Stream.runDrain, Effect.flip)
        assert.strictEqual(gone._tag, "NotFound", context())
        return yield* open(workshop, workshop.draftFor, reopenSweptDraft(workshop.draftFor, workshop.chatId))
      })

    const bin = (refId: RefId) =>
      Effect.gen(function* () {
        const item = yield* writer.DeleteEntity({ userId, entityId: books.get(refId)! })
        binned.set(refId, item.id)
      })
    const restore = (refId: RefId, itemId: BinItem["id"]) =>
      Effect.gen(function* () {
        yield* api.RestoreBinItem({ itemId })
        binned.delete(refId)
      })

    const change = (tab: Tab, add: ReadonlyArray<RefId>, remove: ReadonlyArray<RefId>) =>
      Effect.gen(function* () {
        if (tab.workshop.status === "swept") return
        const result = yield* api.SetComposerLibrary({ ...key(tab.workshop), add, remove }).pipe(Effect.result)
        if (add.some((refId) => binned.has(refId))) {
          if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "NotFound", context())
          else assert.fail(context())
          return
        }
        if (result._tag === "Failure") return assert.fail(`${context()}: ${result.failure._tag}`)
        for (const refId of remove) tab.workshop.refs.delete(refId)
        for (const refId of add) tab.workshop.refs.add(refId)
        tab.shown = result.success.map((item) => item.refId)
        checkList(tab.shown, tab.workshop)
      })
    const sweep = (workshop: Workshop) =>
      Effect.gen(function* () {
        assert.isTrue(yield* writer.SweepPendingChat({ userId, chatId: workshop.chatId }), context())
        workshop.status = "swept"
        workshop.recentSweep = true
      })
    const legacyReplay = (tab: Tab) =>
      Effect.gen(function* () {
        if (tab.workshop.status !== "pending") return
        // Keep the receipt fresh so a refusal proves ancestry is checked, even late in a seed.
        const refId = refs[0]!
        yield* fixtureSql(config.dataDir, [
          {
            sql: `INSERT OR REPLACE INTO swept_pending_chats (chat_id, user_id, label, swept_at)
              VALUES (?, ?, 'Workshop', ?), (?, ?, ?, ?)`,
            params: [
              legacyOrigin,
              userId,
              Date.now(),
              `swept-library:${legacyOrigin}`,
              userId,
              JSON.stringify([refId]),
              Date.now()
            ]
          }
        ])
        const add = { ...key(tab.workshop), add: [refId], remove: [] }
        for (const transfer of [
          { carriedFrom: legacyOrigin },
          { handover: { originChatId: legacyOrigin, operationId: "legacy-url" } }
        ]) {
          const items = yield* api.SetComposerLibrary({ ...add, ...transfer })
          checkList(
            items.map((item) => item.refId),
            tab.workshop
          )
        }
      })
    const follow = (tab: Tab, url: Url) =>
      Effect.gen(function* () {
        const { workshop } = tab
        if (workshop.status === "swept") return
        const { originChatId, operationId, refId } = url
        let refused = false
        if (workshop.status === "pending") {
          const origin = workshops.get(originChatId)!
          if (url.at !== undefined) move(url.at, workshop, refId)
          else {
            const moved = move(origin, workshop, refId)
            if (moved || origin === workshop || origin.recentSweep) {
              refused = !moved && binned.has(refId)
              if (!refused) {
                workshop.refs.add(refId)
                url.at = workshop
              }
            }
          }
        }
        const result = yield* api
          .SetComposerLibrary({ ...key(workshop), add: [refId], remove: [], handover: { originChatId, operationId } })
          .pipe(Effect.result)
        if (refused) {
          if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "NotFound", context())
          else assert.fail(context())
          return
        }
        if (result._tag === "Failure") return assert.fail(`${context()}: ${result.failure._tag}`)
        tab.shown = result.success.map((item) => item.refId)
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
    const checkInvariants = () =>
      Effect.gen(function* () {
        const [actual, posted] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: `SELECT d.target_id AS chatId, l.ref_id AS refId, 'composer' AS location
                  FROM composer_library l JOIN drafts d ON d.id = l.draft_id WHERE d.user_id = ?
                UNION ALL
                SELECT chat_id, ref_id, 'swept' FROM swept_composer_library WHERE user_id = ?`,
              params: [userId, userId]
            },
            { sql: "SELECT version_id AS versionId, ref_id AS refId FROM version_library ORDER BY version_id, ref_id" }
          ],
          { readOnly: true }
        )
        const expected = [...workshops.values()].flatMap(({ chatId, status, refs }) =>
          [...refs].map((refId) => `${chatId}/${refId}/${status === "swept" ? "swept" : "composer"}`)
        )
        // A only permits pins from sends that the model authorized.
        assert.deepStrictEqual(
          posted!.map((row) => `${row.versionId}/${row.refId}`).sort(),
          [...sent].map(([versionId, refId]) => `${versionId}/${refId}`).sort(),
          `invariant A, ${context()}`
        )
        // B includes swept workshops that neither tab has reopened yet.
        assert.deepStrictEqual(
          actual!.map((row) => `${row.chatId}/${row.refId}/${row.location}`).sort(),
          expected.sort(),
          `invariant B, ${context()}`
        )
      })

    const unbinnedRef = Effect.gen(function* () {
      const refId = pick(refs)
      const itemId = binned.get(refId)
      if (itemId !== undefined) {
        yield* restore(refId, itemId)
        yield* checkInvariants()
      }
      return refId
    })
    let deletedBranch: { itemId: BinItem["id"]; predecessor: Workshop; owner: "A" | "B" } | undefined
    const deleteStoryBranch = (owner: "A" | "B") =>
      Effect.gen(function* () {
        if (deletedBranch !== undefined) return
        const { fork } = yield* api.CreateFork({
          chatId: story.id,
          fromForkId: story.currentForkId!,
          atSlotId: opening.entry.slotId
        })
        const side = yield* open(undefined, `side:${story.id}:${fork.id}`)
        yield* change(side, [yield* unbinnedRef], [])
        yield* checkInvariants()
        const item = yield* api.DeleteFork({ forkId: fork.id })
        side.workshop.status = "swept"
        side.workshop.recentSweep = true
        deletedBranch = { itemId: item.id, predecessor: side.workshop, owner }
        yield* checkInvariants()
      })
    const restoreStoryBranch = Effect.gen(function* () {
      if (deletedBranch === undefined) return
      const { itemId, predecessor, owner } = deletedBranch
      deletedBranch = undefined
      yield* api.RestoreBinItem({ itemId })
      yield* checkInvariants()
      // The branch picker discarded side.draft. Returning to the restored branch must still
      // reopen this tab's pending workshop and recover its current ownership.
      const entry = predecessor.draftFor
      const tab = yield* open(predecessor, entry, reopenSweptDraft(entry, null))
      yield* checkInvariants()
      return { owner, tab }
    })
    const purgeAssistant = Effect.gen(function* () {
      const card = yield* api.CreateCard({
        name: "Visiting keeper",
        label: "Visiting keeper",
        description: "Synthetic card."
      })
      const draftFor = `workshop:${card.entityId}:none` as const
      const { workshop } = yield* open(undefined, draftFor)
      const tab = yield* open(workshop)
      yield* change(tab, [yield* unbinnedRef], [])
      yield* checkInvariants()
      const item = yield* writer.DeleteEntity({ userId, entityId: card.entityId })
      yield* checkInvariants()
      yield* api.PurgeBinItem({ itemId: item.id })
      workshop.status = "swept"
      workshop.recentSweep = true
      yield* checkInvariants()
      const replacement = yield* open(workshop)
      yield* checkInvariants()
      // The other tab's original URL must follow the same replacement and see the same items.
      yield* open(workshop)
      yield* checkInvariants()
      return replacement
    })

    let first: Tab = yield* open()
    let second: Tab = yield* open(first.workshop)
    const lostReopen = Effect.gen(function* () {
      history.push("A drops reopen reply, B retries the old URL")
      const predecessor = first.workshop
      yield* change(first, [refs[2]!], [])
      yield* checkInvariants()
      yield* sweep(predecessor)
      yield* checkInvariants()
      const lost = yield* open(predecessor)
      yield* checkInvariants()
      // Tab A keeps its original URL. The model observes the commit independently.
      second = yield* open(predecessor)
      yield* checkInvariants()

      history.push("B sweeps, A retries the old URL and B reopens the swept replacement")
      yield* sweep(lost.workshop)
      yield* checkInvariants()
      first = yield* open(predecessor)
      yield* checkInvariants()
      second = yield* open(lost.workshop)
      yield* checkInvariants()

      history.push("B replaces a later sweep, A follows that replacement from the original URL")
      yield* sweep(second.workshop)
      yield* checkInvariants()
      second = yield* open(second.workshop)
      yield* checkInvariants()
      first = yield* open(predecessor)
      yield* checkInvariants()
    })
    // Vary the prelude order so each regression can fail independently in the fast seeds.
    if (seed === 9) yield* lostReopen
    history.push("A replays a legacy carry and URL handover")
    yield* legacyReplay(first)
    yield* checkInvariants()
    if (seed !== 9) yield* lostReopen
    const sideReconnect = Effect.gen(function* () {
      history.push("B opens a side workshop")
      second = yield* open(undefined, sideEntry)
      yield* checkInvariants()
      history.push("B attaches to its side workshop")
      yield* change(second, [refs[1]!], [])
      yield* checkInvariants()
      history.push("A sweeps B's side workshop")
      yield* sweep(second.workshop)
      yield* checkInvariants()
      history.push("B reconnects with its side workshop still open")
      second = yield* reconnect(second.workshop)
      yield* checkInvariants()
    })
    const reopenBinned = Effect.gen(function* () {
      const predecessor = first.workshop
      history.push("B sweeps A's workshop")
      yield* sweep(predecessor)
      yield* checkInvariants()
      history.push("B bins the item kept in A's swept workshop")
      yield* bin(refs[2]!)
      yield* checkInvariants()
      history.push("A reopens while its item is in the bin")
      first = yield* open(predecessor)
      yield* checkInvariants()
      history.push("B restores the item")
      yield* restore(refs[2]!, binned.get(refs[2]!)!)
      yield* checkInvariants()
      history.push("A reloads and sees the restored item")
      first = yield* open(first.workshop)
      yield* checkInvariants()
      history.push("A retries the original URL after restoration")
      first = yield* open(predecessor)
      yield* checkInvariants()
    })
    if (seed % 2 === 0 || seed === 9) yield* sideReconnect
    yield* reopenBinned
    if (seed % 2 !== 0 && seed !== 9) yield* sideReconnect
    if (seed === 100) {
      history.push("B fills another workshop to the attachment limit")
      let full = yield* open()
      const extras = yield* Effect.forEach(
        Array.from({ length: 16 }, (_, i) => `Chart ${i + 1}`),
        createBook
      )
      const hidden = refs.slice(0, 2)
      yield* change(full, [...hidden, ...extras.slice(0, 14)], [])
      yield* checkInvariants()
      history.push("A bins two of B's attachments, B uses the two available places")
      for (const refId of hidden) {
        yield* bin(refId)
        yield* checkInvariants()
      }
      yield* change(full, extras.slice(14), [])
      yield* checkInvariants()
      history.push("A sweeps the full workshop, B reopens it")
      yield* sweep(full.workshop)
      yield* checkInvariants()
      full = yield* open(full.workshop)
      yield* checkInvariants()
      history.push("A restores the two items and B reloads")
      for (const refId of hidden) {
        yield* restore(refId, binned.get(refId)!)
        yield* checkInvariants()
      }
      full = yield* open(full.workshop)
      yield* checkInvariants()
      history.push("B removes the two restored attachments one at a time")
      for (const refId of hidden) {
        yield* change(full, [], [refId])
        yield* checkInvariants()
      }
    }
    const initial = { originChatId: first.workshop.chatId, operationId: "initial", refId: refs[0]! }
    urls.push(initial, { ...initial, operationId: "lost-before-apply", refId: refs[1]! })
    yield* follow(first, initial)
    yield* change(second, [refs[2]!], [])
    yield* checkInvariants()
    // Exercise both paths before random steps can remove their kept items. Different fast
    // seeds reach each new regression first so either one can fail on the baseline.
    const purgeAcrossTabs = Effect.gen(function* () {
      history.push("B purges A's chosen assistant card and A reopens its workshop")
      yield* purgeAssistant
    })
    if (seed === 41) yield* purgeAcrossTabs
    history.push("A deletes the shown story branch, B restores it, A returns")
    yield* deleteStoryBranch("A")
    yield* restoreStoryBranch
    if (seed !== 41) yield* purgeAcrossTabs
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
          if (tab.reopen !== undefined) next.reopen = tab.reopen
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
            if (here.status === "pending") yield* sweep(here)
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
            if (here.status === "pending" && !binned.has(refId)) {
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
          case "side reconnect":
            if (here.draftFor === sideEntry && here.status === "swept") visit(yield* reconnect(here))
            break
          case "delete story branch":
            yield* deleteStoryBranch(left ? "A" : "B")
            break
          case "restore story branch": {
            const restored = yield* restoreStoryBranch
            if (restored !== undefined) {
              if (restored.owner === "A") first = restored.tab
              else second = restored.tab
            }
            break
          }
          case "purge assistant card":
            visit(yield* purgeAssistant)
            break
          case "bin": {
            const attached = [...here.refs].filter((item) => !binned.has(item))
            if (attached.length > 0) yield* bin(pick(attached))
            break
          }
          case "restore":
            if (binned.size > 0) yield* restore(...pick([...binned]))
            break
          case "drop reopen reply": {
            const swept = [here, other.workshop].filter((workshop) => workshop.status === "swept")
            if (swept.length === 0) break
            tab.reopen = pick(swept)
            yield* open(tab.reopen)
            break
          }
          case "retry reopen":
            if (tab.reopen !== undefined) visit(yield* open(tab.reopen))
            break
          case "legacy replay":
            yield* legacyReplay(tab)
            break
          case "send": {
            const chosen = tab.shown.length > 0 && random() < 0.6 ? pick(tab.shown) : refId
            const credential = pick([tab, tab, tab, other, undefined])
            const allowed =
              here.status !== "swept" && here.refs.has(chosen) && !binned.has(chosen) && credential?.workshop === here
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
            sent.set(result.success.entry.version.id, chosen)
            here.refs.delete(chosen)
            here.status = "started"
            here.parent = result.success.entry.slotId
            if (result.success.draft !== null) tab.session = result.success.draft.session
            break
          }
        }
        yield* checkInvariants()
      }
    }
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
}

for (const seed of [9, 41])
  it.live(`preserves workshop attachment ownership in two tabs (seed ${seed})`, () => model(seed, 6), 60_000)

for (let seed = 100; seed < 112; seed++)
  slowIt.live(`preserves workshop attachment ownership in a longer run (seed ${seed})`, () => model(seed, 16), 120_000)
