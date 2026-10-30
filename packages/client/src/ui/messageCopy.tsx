import type { ReactNode } from "react"
import { makeRegistry } from "../registry.ts"
import { selectedSource, type SourceMap } from "./sourcePositions.ts"

const bodies = new WeakMap<Element, string>()

/** Only actual message/reasoning prose opts in; editors and previews keep native copy. */
export function MessageBody({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div
      data-message-source=""
      ref={(element) => {
        if (!element) return
        bodies.set(element, text)
        return () => {
          bodies.delete(element)
        }
      }}
    >
      {children}
    </div>
  )
}

interface CopiedSelection {
  text: string
  html: string
}
export const messageCopyHandlers = makeRegistry<{
  id: string
  order: number
  copy: (range: Range) => CopiedSelection | null
}>()

const bodyAt = (node: Node) =>
  (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest("[data-message-source]")

function textOffset(element: Element, node: Node, offset: number, code = false): number {
  const prefix = element.ownerDocument.createRange()
  prefix.selectNodeContents(element)
  prefix.setEnd(node, offset)
  let breaks = 0
  if (code) {
    const lines = [...element.querySelectorAll(":scope > span.block")]
    breaks =
      node === element
        ? Math.min(offset, Math.max(0, lines.length - 1))
        : Math.max(
            0,
            lines.findIndex((line) => line.contains(node))
          )
  }
  // Empty line spans contain a display-only newline to give them height.
  return (code ? prefix.toString().replaceAll("\n", "") : prefix.toString()).length + breaks
}

function clippedRange(range: Range, element: Element, selectNode = false): Range | null {
  if (!range.intersectsNode(element)) return null
  const clipped = range.cloneRange()
  const content = element.ownerDocument.createRange()
  if (selectNode) content.selectNode(element)
  else content.selectNodeContents(element)
  if (range.compareBoundaryPoints(Range.START_TO_START, content) < 0)
    clipped.setStart(content.startContainer, content.startOffset)
  if (range.compareBoundaryPoints(Range.END_TO_END, content) > 0)
    clipped.setEnd(content.endContainer, content.endOffset)
  return clipped.collapsed ? null : clipped
}

function renderedHtml(range: Range, body: Element): string {
  let fragment: Node = range.cloneContents()
  let ancestor = range.commonAncestorContainer
  if (ancestor.nodeType !== 1) ancestor = ancestor.parentNode!
  while (ancestor !== body && body.contains(ancestor)) {
    const wrapper = ancestor.cloneNode(false)
    wrapper.appendChild(fragment)
    fragment = wrapper
    ancestor = ancestor.parentNode!
  }
  const holder = body.ownerDocument.createElement("div")
  holder.appendChild(fragment)
  // Internal provenance isn't part of the rich-text clipboard representation.
  for (const element of holder.querySelectorAll("[data-source-map], [data-message-source]")) {
    element.removeAttribute("data-source-map")
    element.removeAttribute("data-message-source")
  }
  // Clipboard recipients don't have our stylesheet. Keep literal quote glyphs
  // without the browser's extra q quotes, and make code line breaks structural.
  for (const quote of holder.querySelectorAll("q")) quote.style.quotes = "none"
  for (const code of holder.querySelectorAll("pre code")) {
    for (const [index, line] of code.querySelectorAll(":scope > span.block").entries()) {
      if (index) code.insertBefore(body.ownerDocument.createTextNode("\n"), line)
      if (line.textContent === "\n") line.textContent = ""
      line.classList.remove("block")
    }
  }
  return holder.outerHTML
}

/** Selection.toString retains browser layout breaks that Range.toString omits.
 * Restore the original selection, including its direction, before returning. */
function nativeText(range: Range): string {
  const selection = range.startContainer.ownerDocument!.getSelection()!
  const ranges = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection
  try {
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString()
  } finally {
    selection.removeAllRanges()
    if (ranges.length === 1 && anchorNode && focusNode)
      selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
    else for (const saved of ranges) selection.addRange(saved)
  }
}

function copyStoredSelection(range: Range): CopiedSelection | null {
  if (range.collapsed) return null
  const document = range.startContainer.ownerDocument!
  const slices: string[] = []
  const html: string[] = []
  let firstBody: Element | undefined
  let lastBody: Element | undefined
  for (const body of document.querySelectorAll("[data-message-source]")) {
    const text = bodies.get(body)
    if (text === undefined) continue
    const selection = clippedRange(range, body)
    if (!selection) continue
    const mapped = body.querySelectorAll("[data-source-map]")
    if (!mapped.length) continue
    firstBody ??= body
    lastBody = body
    html.push(renderedHtml(selection, body))
    let from: number | undefined
    let to: number | undefined
    for (const element of mapped) {
      const map = JSON.parse(element.getAttribute("data-source-map")!) as SourceMap
      const content = map.code ? element.querySelector("pre code") : element
      if (!content) continue
      const selected = clippedRange(selection, content, map.br)
      if (!selected) continue
      const offsets = selectedSource(
        map,
        map.br ? 0 : textOffset(content, selected.startContainer, selected.startOffset, map.code),
        map.br ? 1 : textOffset(content, selected.endContainer, selected.endOffset, map.code)
      )
      if (!offsets) continue
      from ??= offsets[0]
      to = offsets[1]
    }
    if (from !== undefined && to !== undefined) {
      slices.push(text.slice(from, to))
    }
  }
  if (!firstBody || !lastBody) return null
  let text = slices.join("\n\n")
  if (!bodyAt(range.startContainer)) {
    const prefix = range.cloneRange()
    prefix.setEnd(firstBody, 0)
    text = nativeText(prefix) + text
    html.unshift(renderedHtml(prefix, document.documentElement))
  }
  if (!bodyAt(range.endContainer)) {
    const suffix = range.cloneRange()
    suffix.setStart(lastBody, lastBody.childNodes.length)
    const throughBody = range.cloneRange()
    throughBody.setEnd(lastBody, lastBody.childNodes.length)
    // Reading the suffix alone suppresses a paragraph break at its start.
    // Take its text from the original selection to retain the native boundary.
    text += nativeText(range).slice(nativeText(throughBody).length)
    html.push(renderedHtml(suffix, document.documentElement))
  }
  return { text, html: html.join("") }
}

/** Copy and native selection drags share the effective registered handler. */
export function registerMessageCopy() {
  const dispose = messageCopyHandlers.register({ id: "message.source-copy", order: 0, copy: copyStoredSelection })
  const transfer = (event: ClipboardEvent | DragEvent, data: DataTransfer | null) => {
    const active = document.activeElement
    if (active?.closest('input, textarea, [contenteditable="true"]')) return
    const selection = document.getSelection()
    if (!data || !selection?.rangeCount || selection.isCollapsed || event.defaultPrevented) return
    const range = selection.getRangeAt(0)
    // A stale selection must not replace an unrelated link/image drag's payload.
    if (event.type === "dragstart" && (!(event.target instanceof Node) || !range.intersectsNode(event.target))) return
    const handlers = [...messageCopyHandlers.list()].sort((a, b) => b.order - a.order)
    for (const handler of handlers) {
      const copied = handler.copy(range)
      if (!copied) continue
      data.setData("text/plain", copied.text)
      data.setData("text/html", copied.html)
      // Cancelling dragstart would cancel the transfer itself.
      if (event.type === "copy") event.preventDefault()
      return
    }
  }
  const onCopy = (event: ClipboardEvent) => transfer(event, event.clipboardData)
  const onDragStart = (event: DragEvent) => transfer(event, event.dataTransfer)
  if (typeof document !== "undefined") {
    document.addEventListener("copy", onCopy)
    document.addEventListener("dragstart", onDragStart)
  }
  return () => {
    dispose()
    if (typeof document !== "undefined") {
      document.removeEventListener("copy", onCopy)
      document.removeEventListener("dragstart", onDragStart)
    }
  }
}
