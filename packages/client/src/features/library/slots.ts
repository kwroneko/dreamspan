import { defineSlot } from "../../slots.tsx"
import type { EntityKind, RefId } from "@rp/shared/library.ts"

export const libraryActions = defineSlot<{ kind: EntityKind; personas: boolean }>("library.actions")

/** Below the library's actions, above its sections: what an action opens in the page (an inline panel). */
export const libraryPanels = defineSlot<{ kind: EntityKind }>("library.panels")

/**
 * What the ST import page's sections are given: the import opened (`?job=`), and a way to open
 * another; `again` (`?again=`), an import whose folder the user asked to check again.
 */
export interface StImportSectionProps {
  readonly opened: string | null
  readonly open: (importId: string | null) => void
  readonly again: string | null
}

/** The ST import page (/import/st): the import shown, the start form, the list of imports. */
export const stImportSections = defineSlot<StImportSectionProps>("library.st-import.sections")

/** Cards on the Import page; each transfer feature can be replaced independently. */
export const importCards = defineSlot<{ into: RefId | null }>("library.import.cards")
