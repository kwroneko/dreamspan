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

function textOffset(element: Element, node: Node, offset: number): number {
  const prefix = element.ownerDocument.createRange()
  prefix.selectNodeContents(element)
  prefix.setEnd(node, offset)
  return prefix.toString().length
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
      line.classList.remove("block")
    }
  }
  return holder.outerHTML
}

function copyStoredSelection(range: Range): CopiedSelection | null {
  const startBody = bodyAt(range.startContainer)
  const endBody = bodyAt(range.endContainer)
  if (!startBody || !endBody || !bodies.has(startBody) || !bodies.has(endBody) || range.collapsed) return null
  const slices: string[] = []
  const html: string[] = []
  let handled = false
  for (const body of startBody.ownerDocument.querySelectorAll("[data-message-source]")) {
    const text = bodies.get(body)
    if (text === undefined) continue
    const selection = clippedRange(range, body)
    if (!selection) continue
    const mapped = body.querySelectorAll("[data-source-map]")
    if (!mapped.length) continue
    handled = true
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
        map.br ? 0 : textOffset(content, selected.startContainer, selected.startOffset),
        map.br ? 1 : textOffset(content, selected.endContainer, selected.endOffset)
      )
      if (!offsets) continue
      from ??= offsets[0]
      to = offsets[1]
    }
    if (from !== undefined && to !== undefined) {
      slices.push(text.slice(from, to))
    }
  }
  return handled ? { text: slices.join("\n\n"), html: html.join("") } : null
}

/** One listener also handles a selection crossing several message bodies. */
export function registerMessageCopy() {
  const dispose = messageCopyHandlers.register({ id: "message.source-copy", order: 0, copy: copyStoredSelection })
  const onCopy = (event: ClipboardEvent) => {
    const active = document.activeElement
    if (active?.closest('input, textarea, [contenteditable="true"]')) return
    const selection = document.getSelection()
    if (!event.clipboardData || !selection?.rangeCount || selection.isCollapsed || event.defaultPrevented) return
    const range = selection.getRangeAt(0)
    const handlers = [...messageCopyHandlers.list()].sort((a, b) => b.order - a.order)
    for (const handler of handlers) {
      const copied = handler.copy(range)
      if (!copied) continue
      event.clipboardData.setData("text/plain", copied.text)
      event.clipboardData.setData("text/html", copied.html)
      event.preventDefault()
      return
    }
  }
  if (typeof document !== "undefined") document.addEventListener("copy", onCopy)
  return () => {
    dispose()
    if (typeof document !== "undefined") document.removeEventListener("copy", onCopy)
  }
}
