// The old pages' typed backups in localStorage move into the browser copies (IndexedDB) for
// Browser recovery. A backup leaves localStorage only once its exact copy is kept there.
import { beforeEach, expect, it, vi } from "vitest"
import type { Copy } from "../src/features/editor/backup.ts"

const kept = vi.hoisted(() => new Map<string, Copy>())
/** What a put does: kept, lost (IndexedDB unavailable or the transaction aborted), or a hook. */
const put = vi.hoisted(() => ({ mode: "keep" as "keep" | "lose", during: () => {} }))
vi.mock("../src/features/editor/backup.ts", async (original) => ({
  ...(await original<typeof import("../src/features/editor/backup.ts")>()),
  copiesOf: async (userId: string, refId: string) =>
    [...kept.values()].filter((copy) => copy.userId === userId && copy.refId === refId),
  keepCopy: async (copy: Copy) => {
    put.during()
    if (put.mode === "keep") kept.set(copy.key, copy)
  }
}))
import { adoptTypedBackups } from "../src/features/editor/typedBackup.ts"

const stored = new Map<string, string>()
beforeEach(() => {
  kept.clear()
  stored.clear()
  put.mode = "keep"
  put.during = () => {}
  // As a browser's: its methods, and its entries as its own keys.
  const api = {
    get length() {
      return stored.size
    },
    key: (index: number) => [...stored.keys()][index] ?? null,
    getItem: (name: string) => stored.get(name) ?? null,
    setItem: (name: string, value: string) => void stored.set(name, value),
    removeItem: (name: string) => void stored.delete(name)
  }
  vi.stubGlobal(
    "localStorage",
    new Proxy(api, {
      ownKeys: () => [...stored.keys()],
      getOwnPropertyDescriptor: (_target, name) =>
        typeof name === "string" && stored.has(name)
          ? { value: stored.get(name), enumerable: true, configurable: true }
          : undefined
    })
  )
})

const legacy = (target: string, at: number, content: string) =>
  stored.set(`dreamspan.pendingTyped:user:${target}`, JSON.stringify({ at, content }))

it("keeps a backup in localStorage when its copy couldn't be kept (rev-dd3 #1)", async () => {
  legacy("pending-workshop:new", 1000, "The only copy of these keystrokes.")
  put.mode = "lose"
  await adoptTypedBackups("user")
  expect(stored.get("dreamspan.pendingTyped:user:pending-workshop:new")).toContain("The only copy")
})

it("moves a backup once its copy is kept", async () => {
  legacy("pending-workshop:new", 1000, "Moved over.")
  await adoptTypedBackups("user")
  expect([...kept.values()].map((copy) => copy.content)).toEqual(["Moved over."])
  expect(stored.size).toBe(0)
})

it("leaves newer text another tab wrote meanwhile (rev-dd3 #2)", async () => {
  legacy("pending-workshop:new", 1000, "Older text.")
  put.during = () => legacy("pending-workshop:new", 2000, "Older text. Newer keystrokes.")
  await adoptTypedBackups("user")
  expect(stored.get("dreamspan.pendingTyped:user:pending-workshop:new")).toContain("Newer keystrokes")
})

it("two backups of the same moment for different drafts are both kept (rev-dd3 #3)", async () => {
  legacy("pending-workshop:new", 1000, "A workshop's first message.")
  legacy("pending-chat:card-1", 1000, "A card's first message.")
  await adoptTypedBackups("user")
  expect([...kept.values()].map((copy) => copy.content).sort()).toEqual([
    "A card's first message.",
    "A workshop's first message."
  ])
  expect(stored.size).toBe(0)
})
