// Choices are shared across tabs and scoped to a draft, including writes crossing a branch switch.
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { ComposerChoice } from "@dreamspan/shared/composerApi.ts"
import { expect, it, vi } from "vitest"
import { composerChoice } from "../src/features/chat/speaker.ts"
import type { ChatSession } from "../src/features/chat/session.ts"

const id = (name: string) => name as EntityId
const choice = (draftId: string, speaker: string | null = null, guidance = false) =>
  new ComposerChoice({
    draftId,
    guidance,
    speakerEntityId: speaker === null ? null : id(speaker),
    replyFromEntityId: null,
    noReplies: false
  })

const fixture = () => {
  const rows = new Map([
    ["one", choice("one", "Ana")],
    ["two", choice("two", "Bo")]
  ])
  const pending: Array<() => void> = []
  let receive: (next: ComposerChoice | null) => void = () => {}
  const session = {
    id: "chat",
    onComposerChoice: (listener: typeof receive) => {
      receive = listener
    },
    call: (
      run: (
        client: (tag: string, payload: { draftId: string; speakerEntityId?: EntityId; guidance?: boolean }) => unknown
      ) => unknown
    ) =>
      run((tag, payload) => {
        if (tag === "GetComposerChoice") return Promise.resolve({ ok: true, value: rows.get(payload.draftId)! })
        return new Promise((resolve) =>
          pending.push(() => {
            const before = rows.get(payload.draftId)!
            const next = choice(
              payload.draftId,
              payload.speakerEntityId ?? before.speakerEntityId,
              payload.guidance ?? before.guidance
            )
            rows.set(payload.draftId, next)
            receive(next)
            resolve({ ok: true, value: next })
          })
        )
      })
  } as unknown as ChatSession
  const store = composerChoice(session)
  return { store, rows, pending, receive: (next: ComposerChoice | null) => receive(next) }
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
