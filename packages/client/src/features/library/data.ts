// What the library screens read. An import makes the `library` key stale.
import type { EntityKind } from "@rp/shared/library.ts"
import { allOf } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"

const listAtom = (kind: EntityKind) => AppClient.query("ListLibrary", { kind }, { reactivityKeys: ["library"] })

/** The kinds the library screen lists, in order. */
export const LISTED = [
  { kind: "card", title: "Cards" },
  { kind: "lorebook", title: "Lorebooks" },
  { kind: "preset", title: "Presets" }
] as const satisfies ReadonlyArray<{ kind: EntityKind; title: string }>

/** Cards as chats see them: which are in the persona folder. */
const castCardsAtom = AppClient.query("ListCards", undefined, { reactivityKeys: ["library"] })

export const libraryAtom = allOf({
  card: listAtom("card"),
  lorebook: listAtom("lorebook"),
  preset: listAtom("preset"),
  /** Archived presets, for the presets' Archived view (the other kinds have none yet). */
  archivedPresets: AppClient.query("ListLibrary", { kind: "preset", archived: true }, { reactivityKeys: ["library"] }),
  castCards: castCardsAtom,
  exportFormats: AppClient.query("ListExportFormats", undefined, { reactivityKeys: ["library"] })
})
