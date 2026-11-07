import { CastCard, type EntityId } from "@rp/shared/chat.ts"
import { CardForChat } from "@rp/shared/chatSetupApi.ts"
import { Effect } from "effect"
import { expect, it } from "vitest"
import type { AppClient } from "../src/rpc.ts"
import type { Caller } from "../src/features/editor/caller.ts"
import { PendingChat } from "../src/features/chat/pendingChat.ts"

const card = (id: string, persona = false) =>
  new CastCard({
    entityId: id as EntityId,
    name: id,
    label: id,
    persona,
    inBin: false,
    talkativeness: 0.5,
    lorebook: false,
    avatarMediaId: null
  })

it("refreshes a pending chat's cards before selecting a newly created persona", async () => {
  const host = card("host")
  const keeper = card("keeper", true)
  const client = ((method: string) => {
    expect(method).toBe("ListCards")
    return Effect.succeed([host, keeper])
  }) as unknown as AppClient["Service"]
  const call: Caller = async (execute) => ({ ok: true, value: await Effect.runPromise(execute(client)) })
  const pending = new PendingChat(
    [],
    [
      new CardForChat({
        card: host,
        greetings: ["Welcome, {{user}}."],
        groupGreetings: [],
        description: "",
        personality: "",
        scenario: ""
      })
    ],
    null,
    call
  )
  const before = pending.view()
  const snapshots: Array<ReturnType<typeof pending.snapshot>> = []
  pending.subscribe(() => snapshots.push(pending.snapshot()))

  expect(await pending.listCards()).toEqual({ ok: true, value: [keeper] })
  expect(pending.cards).toEqual([keeper])
  expect(pending.view()).not.toBe(before)
  expect(snapshots).toHaveLength(1)
  // Reading new choices must not implicitly choose a persona.
  expect(pending.playing()).toBeNull()
  pending.setPersona(keeper.entityId)
  expect(pending.playing()).toEqual(keeper)
  expect(pending.view().cast?.playedByMe).toEqual([keeper.entityId])
  expect(pending.view().cast?.macroNames.user).toBe("keeper")
  expect(pending.view(snapshots[0]!).cast?.playedByMe).toEqual([])
  expect(pending.view(pending.snapshot()).cast?.playedByMe).toEqual([keeper.entityId])
})
