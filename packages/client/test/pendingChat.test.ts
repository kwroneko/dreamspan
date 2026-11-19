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

  expect(await pending.listCards()).toEqual({ ok: true, value: [host, keeper] })
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

it("keeps a joined character available to play as after refreshing the persona picker", async () => {
  const host = card("host")
  const guest = card("guest")
  const keeper = card("keeper", true)
  const greeter = (card: CastCard) =>
    new CardForChat({
      card,
      greetings: ["Hello."],
      groupGreetings: ["Hello, everyone."],
      description: "",
      personality: "",
      scenario: ""
    })
  const client = ((method: string) => {
    if (method === "ListCards") return Effect.succeed([host, guest, keeper])
    expect(method).toBe("GetCardForChat")
    return Effect.succeed(greeter(guest))
  }) as unknown as AppClient["Service"]
  const call: Caller = async (execute) => ({ ok: true, value: await Effect.runPromise(execute(client)) })
  const pending = new PendingChat([guest, keeper], [greeter(host)], null, call)
  await pending.join(guest.entityId)
  pending.setReplier(guest.entityId)
  pending.pick(0, 1)

  expect(await pending.listCards()).toEqual({ ok: true, value: [host, guest, keeper] })
  // Adding and playing have different choices: the add list still excludes members.
  expect(pending.cards).toEqual([keeper])
  expect(pending.snapshot()).toMatchObject({ persona: null, replier: guest.entityId, picks: [1, 0] })
  pending.setPersona(guest.entityId)
  expect(pending.view().cast?.playedByMe).toEqual([guest.entityId])
  expect(pending.view().cast?.participants).toEqual([host.entityId, guest.entityId])
  expect(pending.view().cast?.macroNames).toEqual({ user: "guest", char: "host" })
  expect(await pending.listCards()).toEqual({ ok: true, value: [host, guest, keeper] })
  expect(pending.playing()).toEqual(guest)
  pending.setPersona(null)
  pending.remove(guest.entityId)
  await pending.listCards()
  expect(pending.cards).toEqual([guest, keeper])
})

it("starts a single chat with the persona locked to its character, a group's with the default", () => {
  const host = card("host")
  const guest = card("guest")
  const pilot = card("pilot", true)
  const mapmaker = card("mapmaker", true)
  const greeter = (c: CastCard) =>
    new CardForChat({ card: c, greetings: ["Hi."], groupGreetings: [], description: "", personality: "", scenario: "" })
  const call: Caller = async () => ({ ok: true, value: undefined as never })
  const start = (greeters: ReadonlyArray<CastCard>, lock: EntityId | null, group = false) =>
    new PendingChat(
      [pilot, mapmaker],
      greeters.map(greeter),
      group ? { name: "Voyage", chatId: "chat" as never } : null,
      call,
      mapmaker.entityId,
      false,
      lock
    )
  const single = start([host], pilot.entityId)
  expect(single.snapshot().persona).toBe(pilot.entityId)
  expect(single.lockCard).toEqual(host)
  expect(start([host], null).snapshot().persona).toBe(mapmaker.entityId)
  // A lock naming a card that is no longer a persona falls back to the default.
  expect(start([host], guest.entityId).snapshot().persona).toBe(mapmaker.entityId)
  const group = start([host, guest], pilot.entityId, true)
  expect(group.snapshot().persona).toBe(mapmaker.entityId)
  expect(group.lockCard).toBeNull()
})
