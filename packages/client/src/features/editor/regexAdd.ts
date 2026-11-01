import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import type { FieldPath } from "@rp/shared/editing.ts"

/**
 * Where "Add a script" writes a new script: as an element of the document's `regex` list, by its
 * id, or as the list itself when the document has none. A card without scripts has no `regex`
 * at all, and a draft naming an element of a list that isn't there has no place to go: the
 * add did nothing (owner, 2026-11-01: "the add button for regex currently does nothing").
 */
export const addScriptChange = (
  scripts: ReadonlyArray<RegexScript> | undefined,
  script: RegexScript
): { readonly path: FieldPath; readonly value: unknown } =>
  scripts === undefined ? { path: ["regex"], value: [script] } : { path: ["regex", `id=${script.id}`], value: script }
