// Give each library list one atom so all
// registered surfaces share its read and the same write invalidation.
import type { EntityKind } from "@dreamspan/shared/library.ts"
import { Atom } from "effect/reactivity"
import { AppClient } from "../../rpc.ts"

const lists = Atom.family((key: string) => {
  const [kind, archived] = JSON.parse(key) as [EntityKind, boolean]
  if (kind === "note" && !archived)
    return AppClient.query("ListSharedNoteRefs", undefined, { reactivityKeys: ["library"] })
  return AppClient.query(
    "ListLibrary",
    { kind, ...(archived ? { archived: true } : {}) },
    { reactivityKeys: ["library"], timeToLive: kind === "lorebook" ? "5 minutes" : "400 millis" }
  )
})

export const libraryListAtom = (kind: EntityKind, archived = false) => lists(JSON.stringify([kind, archived]))
