import { Effect } from "effect"
import type { ChatId, ForkId, SlotId } from "@rp/shared/chat.ts"
import type { Client } from "./rpc.ts"

/** Synthetic review chats, made entirely through the same operations as the app. */
export const seedSplitChats = (api: Client) =>
  Effect.gen(function* () {
    const chat = yield* api.CreateChat({ title: "Split demo · Journeys" })
    const send = (forkId: ForkId, parentSlotId: SlotId | null, content: string) =>
      Effect.gen(function* () {
        const sent = yield* api.SendMessage({ chatId: chat.id, forkId, parentSlotId, branch: false, content })
        if (sent._tag !== "Posted") throw new Error("Synthetic chat unexpectedly queued")
        return sent.entry.slotId
      })
    const first = yield* send(chat.currentForkId!, null, "The travelers meet by the old map.")
    const splitAt = yield* send(chat.currentForkId!, first, "Three paths leave the crossroads.")
    yield* send(chat.currentForkId!, splitAt, "The original journey follows the river.")
    const make = (fromForkId: ForkId, atSlotId: SlotId, name: string) =>
      api.CreateFork({ chatId: chat.id, fromForkId, atSlotId, name })
    const harbor = yield* make(chat.currentForkId!, splitAt, "Split demo · Harbor")
    const quay = yield* send(harbor.fork.id, splitAt, "The harbor lights guide the travelers to the quay.")
    yield* send(harbor.fork.id, quay, "The harbor journey follows the water.")
    const market = yield* make(harbor.fork.id, quay, "Market route")
    yield* send(market.fork.id, quay, "The market route continues past the stalls.")
    const lighthouse = yield* make(harbor.fork.id, quay, "Split demo · Lighthouse")
    yield* send(lighthouse.fork.id, quay, "The lighthouse keeper opens the gate.")
    const forest = yield* make(chat.currentForkId!, splitAt, "Split demo · Forest")
    yield* send(forest.fork.id, splitAt, "The forest path disappears beneath the trees.")
    const hills = yield* make(chat.currentForkId!, splitAt, "Split demo · Hills")
    yield* send(hills.fork.id, splitAt, "The hill path climbs into the clouds.")
    const detour = yield* make(chat.currentForkId!, splitAt, "River detour")
    yield* send(detour.fork.id, splitAt, "The river detour passes an abandoned bridge.")
    for (const forkId of [harbor.fork.id, lighthouse.fork.id, forest.fork.id, hills.fork.id])
      yield* api.SetSplitChat({ forkId, split: true })
    return {
      chatId: chat.id,
      original: chat.currentForkId!,
      harbor: harbor.fork.id,
      market: market.fork.id,
      lighthouse: lighthouse.fork.id,
      forest: forest.fork.id,
      hills: hills.fork.id,
      splitAt,
      quay,
      groupId: harbor.fork.id as unknown as ChatId
    }
  })
