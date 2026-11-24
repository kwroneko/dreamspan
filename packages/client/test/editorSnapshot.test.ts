import { Effect } from "effect"
import { expect, it } from "vitest"
import { valueField, applyDrafts } from "@dreamspan/shared/editing.ts"
import type { Caller } from "../src/features/editor/caller.ts"
import { EditorStore } from "../src/features/editor/store.ts"
import { replacedBy } from "../src/features/chat/lorebookRows.ts"

it("uses live preset lorebooks for card replacements while attachment changes are held", async () => {
  const snapshot = {
    ref: { id: "lorebook-preset", kind: "preset", headRevisionId: "revision", label: "Synthetic" },
    doc: { lorebooks: [{ id: "current", enabled: true }] },
    drafts: []
  }
  const store = new EditorStore(
    "lorebook-preset" as never,
    "synthetic",
    (async () => ({ ok: true, value: snapshot })) as unknown as Caller,
    { setTimer: () => 0, clearTimer: () => {}, now: () => 1, keepalive: async () => false }
  )
  await store.load()
  const live = store.value(["lorebooks"], false)
  store.attachLorebook({ id: "next", enabled: true })
  store.detachLorebook("current")
  expect(store.value(["lorebooks"])).toEqual([{ id: "next", enabled: true }])
  expect(store.value(["lorebooks"], false)).toBe(live)
  const replacement = () =>
    replacedBy(
      { entity: "card", world: "World" },
      undefined,
      [],
      store.value(["lorebooks"], false) as typeof snapshot.doc.lorebooks,
      () => "World"
    )
  expect(replacement()).toBe("current")
  store.switchLorebook("current", false)
  expect(replacement()).toBeNull()
})

it("a value draft changes only its affected editor snapshots and preserves document bytes", async () => {
  const doc = {
    prompts: Array.from({ length: 100 }, (_, i) => ({
      identifier: `p-${i}`,
      name: `Prompt ${i}`,
      content: `Synthetic ${i}`
    })),
    order: Array.from({ length: 100 }, (_, i) => ({ identifier: `p-${i}`, enabled: true })),
    extension: JSON.parse('{"__proto__":{"retained":true},"parts":[null,{"text":"unchanged"}]}') as unknown
  }
  const snapshot = {
    ref: { id: "snapshot-ref", kind: "preset", headRevisionId: "snapshot-revision", label: "Synthetic" },
    doc,
    drafts: []
  }
  const rpc = () => Effect.succeed(structuredClone(snapshot))
  const store = new EditorStore(
    "snapshot-ref" as never,
    "synthetic",
    (async (use: (client: typeof rpc) => Effect.Effect<unknown>) => ({
      ok: true,
      value: await Effect.runPromise(use(rpc))
    })) as unknown as Caller,
    { setTimer: () => 0, clearTimer: () => {}, now: () => 1, keepalive: async () => false }
  )
  await store.load()
  const prompts = store.value(["prompts"]) as typeof doc.prompts
  const order = store.value(["order"]) as typeof doc.order
  const next = order.map((entry, i) => ({ ...entry, enabled: i === 0 ? false : entry.enabled }))
  store.setValue(["order"], next)
  const shown = store.value([])
  const changed = store.value(["order"]) as typeof doc.order
  expect(store.value(["prompts"])).toBe(prompts)
  expect(changed[0]).not.toBe(order[0])
  expect(changed.slice(1).filter((entry, i) => entry !== order[i + 1])).toHaveLength(0)
  expect(JSON.stringify(shown)).toBe(
    JSON.stringify(applyDrafts("preset", doc, [{ field: valueField(["order"]), content: JSON.stringify(next) }]).doc)
  )
  store.setValue(["extension"], { changed: true, parts: [null, { text: "unchanged" }] })
  expect(store.value(["extension", "changed"])).toBe(true)
  expect(store.value(["prompts"])).toBe(prompts)
  expect(store.value(["order"])).toBe(changed)
  expect(Object.getPrototypeOf(store.value([]))).toBe(Object.prototype)
  expect(Object.prototype).not.toHaveProperty("retained")
})
