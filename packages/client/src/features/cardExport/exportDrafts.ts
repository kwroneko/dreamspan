// Read every revision and draft that an export can take. A failed read must stop the export:
// otherwise a working HTTP download could silently bypass a failed draft check over RPC.
import { HELD_FIELD } from "@dreamspan/shared/editing.ts"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import type { Caller, CallResult } from "../editor/caller.ts"
import { openEditorStore } from "../editor/openEditors.ts"
import { EditorStore } from "../editor/store.ts"
import { unsavedFieldNames } from "./unsaved.ts"

export interface UnsavedExport {
  readonly store: EditorStore
  readonly names: ReadonlyArray<string>
}

const storeFor = async (refId: RefId, userId: string, call: Caller): Promise<CallResult<EditorStore>> => {
  const open = openEditorStore(refId)
  const store = open instanceof EditorStore ? open : new EditorStore(refId, userId, call)
  if (store.snapshot === null) {
    const loaded = await store.load()
    if (!loaded.ok) return loaded
  }
  await store.flush()
  return { ok: true, value: store }
}

const unsavedOf = (store: EditorStore, prefix = ""): UnsavedExport => ({
  store,
  names: unsavedFieldNames(store.snapshot!.ref.kind, store.working().doc, store.head, [
    ...store.dirtyFields(),
    ...(store.held() === null ? [] : [HELD_FIELD])
  ]).map((name) => `${prefix}${name}`)
})

export async function exportDrafts(
  refId: RefId,
  userId: string,
  call: Caller
): Promise<CallResult<ReadonlyArray<UnsavedExport>>> {
  const opened = await storeFor(refId, userId, call)
  if (!opened.ok) return opened
  const all = [unsavedOf(opened.value)]
  if (opened.value.snapshot!.ref.kind === "card") {
    const listed = await call((client) => client("ListCardNotes", { cardRefId: refId }))
    if (!listed.ok) return listed
    // A shared note can supply several slots. Reuse its store and commit it only once.
    const stores = new Map<RefId, EditorStore>([[refId, opened.value]])
    const getStore = async (id: RefId): Promise<CallResult<EditorStore>> => {
      const known = stores.get(id)
      if (known) return { ok: true, value: known }
      const result = await storeFor(id, userId, call)
      if (result.ok) stores.set(id, result.value)
      return result
    }
    const checked = new Set<RefId>()
    const add = (store: EditorStore, prefix: string) => {
      if (checked.has(store.refId)) return
      checked.add(store.refId)
      all.push(unsavedOf(store, prefix))
    }
    for (const note of listed.value) {
      const slot = await getStore(note.ref.id)
      if (!slot.ok) return slot
      const working = slot.value.working().doc
      // Include a note being made exportable as well as one the last revision exports.
      if (note.doc.exportable !== true && working.exportable !== true) continue
      const title = typeof working.title === "string" && working.title !== "" ? working.title : note.ref.label
      const prefix = `Note “${title}”: `
      // The slot owns its title, placement and export flag even when its text is shared.
      add(slot.value, prefix)
      const links = new Set([note.doc.link, working.link].filter((link): link is string => typeof link === "string"))
      for (const entityId of links) {
        const shared = await call((client) => client("ListSharedNotes", { entityId: entityId as EntityId }))
        if (!shared.ok) return shared
        const ref = shared.value[0]?.ref
        if (!ref) continue // A deleted shared note has no text in the export either.
        const store = await getStore(ref.id)
        if (!store.ok) return store
        add(store.value, prefix)
      }
    }
  }
  return { ok: true, value: all.filter((entry) => entry.names.length > 0) }
}
