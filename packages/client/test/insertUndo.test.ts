import { expect, it, vi } from "vitest"
import type { ForkId, SlotId } from "@rp/shared/chat.ts"
import type { ChatSession as Session } from "../src/features/chat/session.ts"
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock("../src/ui/Toast.tsx", () => ({ showToast: toast }))
vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
const { ChatSession } = await import("../src/features/chat/session.ts")
const { insertedToast } = await import("../src/features/chat/insertMessage/toast.ts")

it("Undo deletes in the insertion's fork even after the viewer switches forks", async () => {
  const view = { forkId: "inserting-fork" as ForkId, entries: [] }
  const requests: Array<{ tag: string; payload: unknown }> = []
  // Exercise the actual session method through the toast; only the RPC transport is replaced.
  const session = {
    view,
    snapshot: () => view,
    call: async (invoke: (client: unknown) => unknown) => {
      invoke((tag: string, payload: unknown) => requests.push({ tag, payload }))
      return { ok: true, value: null }
    }
  }
  Object.setPrototypeOf(session, ChatSession.prototype)
  insertedToast(session as unknown as Session, "inserted-slot" as SlotId, "Message inserted")
  view.forkId = "inherited-fork" as ForkId
  toast.mock.calls[0]![0].actions[0].onClick()
  await Promise.resolve()
  expect(requests).toEqual([{ tag: "DeleteMessage", payload: { slotId: "inserted-slot", forkId: "inserting-fork" } }])
})
