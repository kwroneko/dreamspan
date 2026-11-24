// The message editor's styling off the page's thread (messageStyleView.ts): each request is a
// whole text, and the answer its ranges. Blocks are kept by their text between requests, so a
// keystroke reparses only the block it changed.
import { messageStyleRanges, styleCache } from "./messageStyles.ts"
import type { StyleRequest, StyleResponse } from "./messageStyleView.ts"

const caches = new Map<number, ReturnType<typeof styleCache>>()
self.onmessage = (event: MessageEvent<StyleRequest>) => {
  const request = event.data
  if (request.close) return void caches.delete(request.editor)
  let cache = caches.get(request.editor)
  if (!cache) caches.set(request.editor, (cache = styleCache()))
  const ranges = messageStyleRanges(request.text, { html: request.html, examples: request.examples === true }, cache)
  const response: StyleResponse = { editor: request.editor, id: request.id, ranges }
  self.postMessage(response, { transfer: [ranges.buffer] })
}
