// The owner's shape (hundreds of branches, a few workshops beside the story): branching the story
// with workshops beside it costs about what it costs without (spec/WORKSHOP-BRANCHES.md §3.3: one
// fork row and one pairing event per workshop), and a story branch's workshops list at once.
import { assert, it } from "@effect/vitest"
import { type ChatId, type ForkId, NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"

const said = (content: string) =>
  new NewVersion({
    speakerEntityId: null,
    writer: "human",
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: "user_written"
  })

const MESSAGES = 600
const FORKS = 300
const WORKSHOPS = 4

it.live(
  `forks a ${MESSAGES}-message story with ${FORKS} branches and ${WORKSHOPS} workshops cheaply`,
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const reader = yield* Reader
      const userId = (yield* api.Whoami()).id
      const story = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Long road",
        participants: [],
        greeting: null
      })
      const main = story.currentForkId as ForkId
      const slots: Array<SlotId> = []
      const append = (chatId: ChatId, forkId: ForkId, parent: SlotId | null, content: string) =>
        writer.AppendMessage({
          userId,
          chatId,
          forkId,
          parentSlotId: parent,
          branch: false,
          commitDraft: null,
          version: said(content)
        })
      for (let i = 0; i < MESSAGES; i++)
        slots.push((yield* append(story.id, main, slots.at(-1) ?? null, `Mile ${i} of the road.`)).slotId)
      const fork = (i: number) =>
        writer.CreateFork({ userId, chatId: story.id, fromForkId: main, atSlotId: slots[(i * 7) % MESSAGES]! })
      const time = (n: number, from: number) =>
        Effect.gen(function* () {
          const started = performance.now()
          for (let i = 0; i < n; i++) yield* fork(from + i)
          return (performance.now() - started) / n
        })
      const without = yield* time(FORKS / 2, 0)
      // A few workshops, each with a talk that ran along the story.
      for (let k = 0; k < WORKSHOPS; k++) {
        const workshop = yield* api.CreateWorkshop({ attachTo: story.id, attachFork: main })
        let leaf = workshop.activeLeafSlotId
        for (let i = 0; i < 30; i++)
          leaf = (yield* append(workshop.id, workshop.currentForkId as ForkId, leaf, `Note ${i}.`)).slotId
      }
      const withWorkshops = yield* time(FORKS / 2, FORKS / 2)
      const listStarted = performance.now()
      const beside = yield* api.ListAttachedWorkshops({ chatId: story.id, forkId: main })
      const listMs = performance.now() - listStarted
      const branchesStarted = performance.now()
      yield* api.ListWorkshopBranches({ chatId: beside[0]!.id })
      const branchesMs = performance.now() - branchesStarted
      console.info(
        `workshop fork hook: ${without.toFixed(1)} ms/fork without, ${withWorkshops.toFixed(1)} ms/fork with ${WORKSHOPS} workshops; list ${listMs.toFixed(1)} ms; branches ${branchesMs.toFixed(1)} ms`
      )
      assert.lengthOf(beside, WORKSHOPS)
      // Every story branch made since has its own branch of each workshop.
      const forks = yield* reader.ListForks({ userId, chatId: story.id })
      assert.strictEqual(forks.length, FORKS + 1)
      assert.isBelow(withWorkshops, without * 2 + 15)
      assert.isBelow(listMs, 250)
      assert.isBelow(branchesMs, 250)
    }).pipe(Effect.provide(serverLayer(config)))
  },
  600_000
)
