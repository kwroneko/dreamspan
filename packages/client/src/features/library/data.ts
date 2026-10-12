// What the library screens read. An import makes the `library` key stale.
import type { EntityKind } from "@rp/shared/library.ts"
import type { ExportFormat } from "@rp/shared/libraryImport.ts"
import { allOf } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"

const listAtom = (kind: EntityKind) => AppClient.query("ListLibrary", { kind }, { reactivityKeys: ["library"] })

/** The kinds the library screen lists, in order. */
export const LISTED = [
  { kind: "card", title: "Cards" },
  { kind: "lorebook", title: "Lorebooks" },
  { kind: "preset", title: "Presets" }
] as const satisfies ReadonlyArray<{ kind: EntityKind; title: string }>

export const libraryAtom = allOf({ card: listAtom("card"), lorebook: listAtom("lorebook"), preset: listAtom("preset") })

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  "card-png": "PNG",
  "card-v2-json": "V2 JSON",
  "card-v3-json": "V3 JSON",
  "card-charx": "CHARX",
  "st-world-info": "World Info JSON",
  "st-preset": "Preset JSON"
}
