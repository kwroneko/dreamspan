// Choices are shared across tabs and scoped to a draft, including writes crossing a branch switch.
import type { EntityId, SlotId } from "@dreamspan/shared/chat.ts"
import { ComposerChoice } from "@dreamspan/shared/composerApi.ts"
import { afterEach, expect, it, vi } from "vitest"
import { composerChoice } from "../src/features/chat/speaker.ts"
import type { ChatSession } from "../src/features/chat/session.ts"

const id = (name: string) => name as EntityId
const choice = (
  draftId: string,
  speaker: string | null = null,
  guidance = false,
  guidanceSlotId: SlotId | null = null
) =>
  new ComposerChoice({
    draftId,
    guidance,
    speakerEntityId: speaker === null ? null : id(speaker),
    replyFromEntityId: null,
    noReplies: false,
    guidanceSlotId
  })

const fixture = (holdRead = false) => {
  const rows = new Map([
    ["one", choice("one", "Ana")],
    ["two", choice("two", "Bo")]
  ])
  const pending: Array<(refuse?: boolean) => void> = []
  const reads: Array<() => void> = []
  const writes: Array<Record<string, unknown>> = []
  let receive: (next: ComposerChoice | null) => void = () => {}
  const session = {
    id: "chat",
    onComposerChoice: (listener: typeof receive) => {
      receive = listener
    },
    call: (
      run: (
        client: (
          tag: string,
          payload: { draftId: string; speakerEntityId?: EntityId; guidance?: boolean; guidanceSlotId?: SlotId | null }
        ) => unknown
      ) => unknown
    ) =>
      run((tag, payload) => {
        if (tag === "GetComposerChoice") {
          const result = { ok: true, value: rows.get(payload.draftId)! }
          if (holdRead) return new Promise((resolve) => reads.push(() => resolve(result)))
          return Promise.resolve(result)
        }
        writes.push(payload)
        return new Promise((resolve) =>
          pending.push((refuse) => {
            if (refuse) return resolve({ ok: false, error: { tag: "Failed" } })
            const before = rows.get(payload.draftId)!
            const next = choice(
              payload.draftId,
              payload.speakerEntityId ?? before.speakerEntityId,
              payload.guidance ?? before.guidance,
              payload.guidanceSlotId === undefined ? (before.guidanceSlotId ?? null) : payload.guidanceSlotId
            )
            rows.set(payload.draftId, next)
            receive(next)
            resolve({ ok: true, value: next })
          })
        )
      })
  } as unknown as ChatSession
  const store = composerChoice(session)
  return { store, rows, pending, reads, writes, receive: (next: ComposerChoice | null) => receive(next) }
}

it("finishes loading a new branch when an old branch's choice was still saving", async () => {
  const { store, pending } = fixture()
  store.bind("one")
  await vi.waitFor(() => expect(store.snapshot().loaded).toBe(true))
  const saved = store.change({ speaker: id("Mira") })
  expect(store.snapshot().saving).toBe(true)
  store.bind("two")
  await vi.waitFor(() => expect(pending).toHaveLength(1))
  pending.shift()!()
  await saved
  expect(store.snapshot()).toMatchObject({ draftId: "two", loaded: true, saving: false, speaker: "Bo" })
})

it("saves rapid picks in order and reads a newer change made in another tab", async () => {
  const { store, pending, rows, receive } = fixture()
  store.bind("one")
  await vi.waitFor(() => expect(store.snapshot().loaded).toBe(true))
  const first = store.change({ speaker: id("Bo") })
  const second = store.change({ speaker: id("Mira") })
  await vi.waitFor(() => expect(pending).toHaveLength(1))
  pending.shift()!()
  await first
  await vi.waitFor(() => expect(pending).toHaveLength(1))
  pending.shift()!()
  rows.set("one", choice("one", "Wren"))
  receive(rows.get("one")!)
  await second
  expect(store.snapshot()).toMatchObject({ loaded: true, saving: false, speaker: "Wren" })
})

it("applies guidance immediately, saves rapid switches in order, and keeps another fork independent", async () => {
  const { store, pending, rows } = fixture()
  store.bind("one")
  await vi.waitFor(() => expect(store.snapshot().loaded).toBe(true))
  const first = store.change({ guidance: true })
  expect(store.snapshot()).toMatchObject({ guidance: true, saving: false })
  const second = store.change({ guidance: false })
  expect(store.snapshot().guidance).toBe(false)
  await vi.waitFor(() => expect(pending).toHaveLength(1))
  pending.shift()!()
  await first
  expect(store.snapshot().guidance).toBe(false)
  await vi.waitFor(() => expect(pending).toHaveLength(1))
  pending.shift()!()
  await second
  expect(store.snapshot().guidance).toBe(false)
  const third = store.change({ guidance: true })
  store.bind("two")
  expect(store.snapshot().loaded).toBe(false)
  await vi.waitFor(() => expect(pending).toHaveLength(1))
  pending.shift()!()
  await third
  expect(rows.get("one")!.guidance).toBe(true)
  expect(store.snapshot()).toMatchObject({ draftId: "two", loaded: true, guidance: false })
})

it("shows the mode delivered with the draft while the separate speaker read is still pending", async () => {
  const { store, rows } = fixture()
  rows.set("one", choice("one", "Ana", true))
  store.bind("one", true)
  expect(store.snapshot()).toMatchObject({ draftId: "one", guidance: true, loaded: false })
  await vi.waitFor(() => expect(store.snapshot().loaded).toBe(true))
  expect(store.snapshot().guidance).toBe(true)
})

it("keeps the reply a guidance edit was opened for before the draft was known, and saves it once it is", async () => {
  const { store, pending, writes } = fixture()
  await store.change({ guidanceSlot: "s1" as SlotId })
  expect(writes).toHaveLength(0)
  store.bind("one")
  expect(store.snapshot().guidanceSlot).toBe("s1")
  await vi.waitFor(() => expect(pending).toHaveLength(1))
  expect(writes[0]).toMatchObject({ draftId: "one", guidanceSlotId: "s1" })
  pending.shift()!()
  await vi.waitFor(() => expect(store.snapshot().loaded).toBe(true))
  expect(writes).toHaveLength(1)
})

afterEach(() => vi.unstubAllGlobals())

it("keeps a refused guidance target with its draft and replays it once after reopening", async () => {
  const saved = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key)
  })
  const original = fixture()
  original.store.bind("one")
  await vi.waitFor(() => expect(original.store.snapshot().loaded).toBe(true))
  const slot = "reply" as SlotId
  const selecting = original.store.change({ guidanceSlot: slot })
  await vi.waitFor(() => expect(original.pending).toHaveLength(1))
  original.pending.shift()!(true)
  expect(await selecting).toMatchObject({ ok: false })
  expect(original.store.snapshot().guidanceSlot).toBe(slot)
  expect(original.writes).toHaveLength(1)
  expect(saved.size).toBe(1)

  const reopened = fixture(true)
  reopened.store.bind("two")
  reopened.reads.shift()!()
  await vi.waitFor(() => expect(reopened.store.snapshot().loaded).toBe(true))
  reopened.store.bind("one")
  expect(reopened.store.snapshot().guidanceSlot).toBe(slot)
  await Promise.resolve()
  expect(reopened.writes).toHaveLength(0)
  reopened.reads.shift()!()
  await vi.waitFor(() => expect(reopened.pending).toHaveLength(1))
  reopened.pending.shift()!()
  reopened.rows.set("one", choice("one", "Mira", false, slot))
  await vi.waitFor(() => expect(reopened.reads).toHaveLength(1))
  reopened.reads.shift()!()
  await vi.waitFor(() => expect(reopened.store.snapshot()).toMatchObject({ guidanceSlot: slot, speaker: "Mira" }))
  expect(reopened.writes).toEqual([{ chatId: "chat", draftId: "one", guidanceSlotId: slot }])
  expect(saved.size).toBe(0)
})

it("keeps an early guidance edit when a live choice arrives before the initial read", async () => {
  const { store, pending, reads, rows, writes, receive } = fixture(true)
  await store.change({ guidanceSlot: "s1" as SlotId })
  store.bind("one")
  await Promise.resolve()
  expect(writes).toHaveLength(0)
  const live = choice("one", "Bo", true)
  rows.set("one", live)
  receive(live)
  reads.shift()!()
  expect(store.snapshot()).toMatchObject({ loaded: true, guidanceSlot: "s1", speaker: "Bo", guidance: true })
  await vi.waitFor(() => expect(pending).toHaveLength(1))
  pending.shift()!()
  rows.set("one", choice("one", "Mira", true, "s1" as SlotId))
  await vi.waitFor(() => expect(reads).toHaveLength(1))
  reads.shift()!()
  await vi.waitFor(() =>
    expect(store.snapshot()).toMatchObject({ loaded: true, guidanceSlot: "s1", speaker: "Mira", guidance: true })
  )
  expect(writes).toEqual([{ chatId: "chat", draftId: "one", guidanceSlotId: "s1" }])
})
