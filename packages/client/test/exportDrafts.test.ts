import { Effect, Exit } from "effect"
import { describe, expect, it, vi } from "vitest"
import { HELD_FIELD, textField, valueField } from "@rp/shared/editing.ts"
import type { EditorSnapshot } from "@rp/shared/editorApi.ts"
import type { Caller } from "../src/features/editor/caller.ts"
import { exportDrafts } from "../src/features/cardExport/exportDrafts.ts"
import { HELD_LABEL } from "../src/features/cardExport/unsaved.ts"

vi.hoisted(() => vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" }))

const snapshot = (id: string, kind: string, doc: Record<string, unknown>, fields: Record<string, string> = {}) =>
  ({
    ref: { id, kind, headRevisionId: `${id}-head`, label: id },
    doc,
    drafts: Object.entries(fields).map(([field, content]) => ({
      id: `${id}-${field}`,
      key: { field },
      status: "active",
      content,
      rowVersion: 1,
      session: 1,
      baseRevision: `${id}-head`,
      recovered: 0,
      displaced: null
    }))
  }) as unknown as EditorSnapshot

const fixture = (snapshots: ReadonlyArray<EditorSnapshot>, fail?: string) => {
  const calls: string[] = []
  const rpc = (tag: string, payload: { refId?: string }) => {
    calls.push(tag)
    if (tag === fail || `${tag}:${payload.refId}` === fail) return Effect.fail("unavailable")
    if (tag === "OpenEditor") return Effect.succeed(snapshots.find((s) => s.ref.id === payload.refId)!)
    if (tag === "ListCardNotes")
      return Effect.succeed(snapshots.filter((s) => s.doc.owner).map((s) => ({ ref: s.ref, doc: s.doc })))
    if (tag === "ListSharedNotes") return Effect.succeed([{ ref: snapshots.find((s) => s.ref.id === "shared")!.ref }])
    throw new Error(`Unexpected RPC: ${tag}`)
  }
  const call: Caller = async (run) => {
    const result = await Effect.runPromiseExit(run(rpc as never))
    return Exit.isSuccess(result)
      ? { ok: true, value: result.value }
      : { ok: false, error: { tag: "ServerError", message: "Unavailable", problems: [], reason: null }, cause: null }
  }
  return { calls, check: () => exportDrafts(snapshots[0]!.ref.id, "user", call) }
}

describe("drafts checked before an export", () => {
  for (const held of [
    { deleted: ["a"] },
    { order: ["b", "a"] },
    { attached: [{ id: "book", enabled: true }] },
    { detached: ["book"] }
  ])
    it(`includes held-only preset changes: ${JSON.stringify(held)}`, async () => {
      const { check } = fixture([snapshot("preset", "preset", {}, { [HELD_FIELD]: JSON.stringify(held) })])
      const checked = await check()
      expect(checked.ok && checked.value.map((v) => v.names)).toEqual([[HELD_LABEL]])
    })

  it("checks a linked slot and shared text, committing a shared ref only once", async () => {
    const { check } = fixture([
      snapshot("card", "card", {}),
      snapshot(
        "slot",
        "note",
        { owner: { card: "card" }, title: "Slot", exportable: true, link: "shared-entity" },
        { [textField(["title"])]: "New title" }
      ),
      snapshot("slot2", "note", { owner: { card: "card" }, title: "Slot 2", exportable: true, link: "shared-entity" }),
      snapshot("shared", "note", { content: "Saved" }, { [textField(["content"])]: "Shared typing" })
    ])
    const checked = await check()
    expect(checked.ok && checked.value.map((v) => v.store.refId)).toEqual(["slot", "shared"])
    expect(checked.ok && checked.value[0]!.names).toEqual(["Note “New title”: Title"])
  })

  it("checks a note's unsaved switch to exportable", async () => {
    const { check } = fixture([
      snapshot("card", "card", {}),
      snapshot(
        "slot",
        "note",
        { owner: { card: "card" }, title: "Private", exportable: false },
        { [valueField(["exportable"])]: "true" }
      )
    ])
    const checked = await check()
    expect(checked.ok && checked.value.map((v) => v.store.refId)).toEqual(["slot"])
  })
})
