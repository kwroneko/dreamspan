import { LOREBOOK_SCHEMA_VERSION, type LorebookDoc } from "@dreamspan/shared/docs/lorebook.ts"

export const emptyBook = (): LorebookDoc => ({
  schema_version: LOREBOOK_SCHEMA_VERSION,
  name: "",
  description: "",
  scan_depth: null,
  token_budget: null,
  recursive_scanning: null,
  extensions: {},
  entries: []
})

export { newLorebookEntry as emptyEntry } from "@dreamspan/shared/docs/lorebook.ts"
