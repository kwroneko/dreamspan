// HTML in messages as registered parts of the message renderer (spec/HTML-MESSAGES.md §3.1), each
// replaceable or disableable by id, as plugins can do with any part:
// - `html.inline`: the sanitizer schema for inline markup; disabled, HTML shows as text;
// - `html.classifier`: which code blocks are documents (Tavern Helper's "frontend" test);
// - `html.frame`: what renders a document block; disabled, it shows as its code block.
import type { ComponentType } from "react"
import type { Options as Schema } from "rehype-sanitize"
import { makeRegistry } from "../../registry.ts"

export const htmlSchemas = makeRegistry<{
  readonly id: string
  readonly order: number
  /** The schema, given the trusted attribute that marks Markdown's own elements (schema.ts). */
  readonly schema: (marker: string) => Schema
}>()

export const htmlClassifiers = makeRegistry<{
  readonly id: string
  readonly order: number
  /** Whether a fenced code block is a whole HTML document to show in a frame. */
  readonly isDocument: (code: string, language: string) => boolean
}>()

/** What a document block's renderer is given (rehypeHtml.ts makes the block). */
interface DocumentBlockProps {
  /** The block's text after the display transforms: the document. */
  readonly source: string
  /** Its place among the message's document blocks, from 0. */
  readonly index: number
  /** Copy metadata (sourcePositions.ts): the block's stored range, on its one placeholder character. */
  readonly sourceMap?: string
}
const documentRenderers = makeRegistry<{
  readonly id: string
  readonly order: number
  readonly component: ComponentType<DocumentBlockProps>
}>()

/**
 * Tavern Helper's test (`is_frontend.ts`): a code block whose text has `html>`, `<head>` or
 * `<body` is a full document, whatever its fence's language.
 */
export const isDocumentBlock = (code: string) => ["html>", "<head>", "<body"].some((tag) => code.includes(tag))

/** Everything the parts registries hold, bumped on any change, so renderers re-key their pipelines. */
let revision = 0
const bump = () => {
  revision++
}
htmlSchemas.subscribe(bump)
htmlClassifiers.subscribe(bump)
documentRenderers.subscribe(bump)
export const htmlPartsRevision = () => revision
export const subscribeHtmlParts = (listener: () => void) => {
  const stops = [htmlSchemas, htmlClassifiers, documentRenderers].map((registry) => registry.subscribe(listener))
  return () => stops.forEach((stop) => stop())
}

const effective = <A extends { readonly order: number }>(entries: ReadonlyArray<A>) =>
  [...entries].sort((a, b) => b.order - a.order)[0]
export const effectiveSchema = () => effective(htmlSchemas.snapshot().entries)
export const effectiveClassifier = () => effective(htmlClassifiers.snapshot().entries)
export const effectiveDocumentRenderer = () => effective(documentRenderers.snapshot().entries)
