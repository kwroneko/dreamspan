import { defineSlot } from "../../slots.tsx"

export const libraryActions = defineSlot<Record<string, never>>("library.actions")

/** What the ST import page's sections are given: the import opened (`?job=`), and a way to open another. */
export interface StImportSectionProps {
  readonly opened: string | null
  readonly open: (importId: string | null) => void
}

/** The ST import page (/import/st): the import shown, the start form, the list of imports. */
export const stImportSections = defineSlot<StImportSectionProps>("library.st-import.sections")
