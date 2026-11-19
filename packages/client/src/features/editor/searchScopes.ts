// What a search and replace looks through (SearchDialog's "Look in"; owner, 2026-11-01): a
// lorebook's entry text, its keys, or both, a preset's prompt text, its prompt names, or both,
// and in either everything else as well. A scope picks fields by their path.
import type { FieldPath } from "@dreamspan/shared/editing.ts"

interface SearchScope {
  readonly value: string
  readonly label: string
  /** What it looks through, as its tooltip says. */
  readonly hint: string
  readonly includes: (path: FieldPath) => boolean
}

export interface SearchScopes {
  /** The choice is remembered in this browser under this name. */
  readonly id: string
  readonly options: ReadonlyArray<SearchScope>
  readonly initial: string
  /** Only fields here are searched at all: a card's own book leaves the card's other fields out. */
  readonly within?: (path: FieldPath) => boolean
}

const startsWith = (path: FieldPath, prefix: FieldPath) => prefix.every((segment, i) => path[i] === segment)

/** An entry's field of a book at `root`: `[...root, "entries", "uid=…", key, …]`. */
const entryKey = (path: FieldPath, root: FieldPath) =>
  startsWith(path, root) && path[root.length] === "entries" ? path[root.length + 2] : undefined

export const lorebookScopes = (root: FieldPath): SearchScopes => {
  const content = (path: FieldPath) => entryKey(path, root) === "content"
  const keys = (path: FieldPath) => {
    const key = entryKey(path, root)
    return key === "keys" || key === "secondary_keys"
  }
  return {
    id: "lorebook",
    initial: "all",
    within: (path) => startsWith(path, root),
    options: [
      { value: "content", label: "Content", hint: "Only the entries' text.", includes: content },
      { value: "keys", label: "Keys", hint: "Only the primary and secondary keys.", includes: keys },
      {
        value: "both",
        label: "Both",
        hint: "The entries' text and their keys.",
        includes: (path) => content(path) || keys(path)
      },
      {
        value: "all",
        label: "Everything",
        hint: "Text, keys, titles, outlet and group names, and the book's name and description.",
        includes: () => true
      }
    ]
  }
}

const promptKey = (path: FieldPath) => (path[0] === "prompts" ? path[2] : undefined)

export const presetScopes: SearchScopes = {
  id: "preset",
  initial: "all",
  options: [
    {
      value: "text",
      label: "Prompt text",
      hint: "Only the prompts' text.",
      includes: (path) => promptKey(path) === "content"
    },
    {
      value: "names",
      label: "Prompt names",
      hint: "Only the prompts' names.",
      includes: (path) => promptKey(path) === "name"
    },
    {
      value: "both",
      label: "Both",
      hint: "The prompts' text and their names.",
      includes: (path) => promptKey(path) !== undefined
    },
    {
      value: "all",
      label: "Everything",
      hint: "The prompts, the prefill, the utility prompts and the regex scripts.",
      includes: () => true
    }
  ]
}

const KEY = "dreamspan.searchScope."

export const rememberedScope = (scopes: SearchScopes) => {
  try {
    const stored = localStorage.getItem(KEY + scopes.id)
    if (stored && scopes.options.some((option) => option.value === stored)) return stored
  } catch {
    // Storage can be unavailable (a private window): the initial scope.
  }
  return scopes.initial
}

export const rememberScope = (scopes: SearchScopes, value: string) => {
  try {
    localStorage.setItem(KEY + scopes.id, value)
  } catch {
    // Not remembered: it still applies here.
  }
}

/** The fields a scope looks through. */
export const inScope = <F extends { readonly path: FieldPath }>(
  fields: ReadonlyArray<F>,
  scopes: SearchScopes | undefined,
  value: string
): ReadonlyArray<F> => {
  if (!scopes) return fields
  const scope = scopes.options.find((option) => option.value === value) ?? scopes.options[0]!
  return fields.filter((field) => (scopes.within?.(field.path) ?? true) && scope.includes(field.path))
}
