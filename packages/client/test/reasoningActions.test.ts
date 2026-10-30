import type { Version } from "@rp/shared/chat.ts"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { reasoningActions } from "../src/features/chat/presentation.tsx"
import {
  collapseAllReasoning,
  collapseCount,
  registerReasoningActions,
  subscribeCollapses
} from "../src/features/chat/reasoningActions.tsx"
import { SlotOutlet } from "../src/slots.tsx"

const props = { version: {} as Version, text: "Synthetic *raw* thought.", streaming: false }
const render = () => renderToStaticMarkup(createElement(SlotOutlet<typeof props>, { slot: reasoningActions, props }))

describe("reasoning actions", () => {
  let dispose: Array<() => void>
  beforeEach(() => {
    dispose = registerReasoningActions()
  })
  afterEach(() => {
    for (const close of dispose) close()
  })

  it("registers Copy reasoning and Collapse all, in order, each replaceable or removable", () => {
    expect([...reasoningActions.snapshot().entries].map((entry) => entry.id)).toEqual([
      "reasoning.copy",
      "reasoning.collapse-all"
    ])
    const html = render()
    expect(html.indexOf("Copy reasoning")).toBeLessThan(html.indexOf("Collapse all"))
    // A plugin's registration under the same id takes the place of the default.
    const replaced = reasoningActions.register({ id: "reasoning.copy", order: 10, component: () => "Plugin copy" })
    expect(render()).toContain("Plugin copy")
    expect(render()).not.toContain("Copy reasoning")
    replaced()
    expect(render()).toContain("Copy reasoning")
    dispose.pop()!()
    expect(render()).not.toContain("Collapse all")
  })

  it("Collapse all tells every mounted block, which reads a new count", () => {
    const seen: Array<number> = []
    const unsubscribe = subscribeCollapses(() => seen.push(collapseCount()))
    const before = collapseCount()
    collapseAllReasoning()
    collapseAllReasoning()
    unsubscribe()
    collapseAllReasoning()
    expect(seen).toEqual([before + 1, before + 2])
  })
})
