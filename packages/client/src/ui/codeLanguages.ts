// Syntax modes for the code editor, loaded only when a file of that kind opens (spec/
// FILES-AND-ENVIRONMENT.md §8.2): each `@codemirror/lang-*` package is its own chunk. Colours come
// from the theme's tokens, so highlighting follows light and dark.
import type { Extension } from "@codemirror/state"

type Loader = () => Promise<Extension>

const LOADERS: Record<string, Loader> = {
  javascript: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  typescript: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  python: () => import("@codemirror/lang-python").then((m) => m.python()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  css: () => import("@codemirror/lang-css").then((m) => m.css())
}

const BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  jsonl: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  css: "css",
  scss: "css"
}

/** The editor language for a file name, or null for plain text. */
export const languageOf = (name: string) => {
  const dot = name.lastIndexOf(".")
  return dot < 0 ? null : (BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null)
}

/** The theme's highlighting: semantic tokens only. */
const highlighting = () =>
  import("@codemirror/language").then(({ HighlightStyle, syntaxHighlighting }) =>
    import("@lezer/highlight").then(({ tags }) =>
      syntaxHighlighting(
        HighlightStyle.define([
          { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "var(--color-accent)" },
          { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--color-success)" },
          { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--color-warning)" },
          { tag: [tags.comment, tags.meta], color: "var(--color-muted)", fontStyle: "italic" },
          { tag: [tags.tagName, tags.heading], color: "var(--color-accent)", fontWeight: "600" },
          { tag: [tags.attributeName, tags.propertyName], color: "var(--color-message-quote)" },
          { tag: tags.invalid, color: "var(--color-danger)" },
          { tag: tags.emphasis, fontStyle: "italic" },
          { tag: tags.strong, fontWeight: "600" },
          { tag: tags.link, textDecoration: "underline" }
        ])
      )
    )
  )

/** The mode and its highlighting, or nothing for an unknown language or one that fails to load. */
export const loadLanguage = (language: string): Promise<Extension> => {
  const loader = LOADERS[language]
  if (!loader) return Promise.resolve([])
  return Promise.all([loader(), highlighting()]).catch(() => [])
}
