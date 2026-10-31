import type { Version } from "@rp/shared/chat.ts"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type ReasoningActionProps, reasoningActions } from "../src/features/chat/presentation.tsx"
import {
  collapseAllReasoning,
  collapseCount,
  registerReasoningActions,
  subscribeCollapses
} from "../src/features/chat/reasoningActions.tsx"
import type { ChatSession } from "../src/features/chat/session.ts"
import { SlotOutlet } from "../src/slots.tsx"

const props: ReasoningActionProps = {
  version: {} as Version,
  text: "Synthetic *raw* thought.",
  streaming: false,
  kind: "reasoning",
  session: {} as ChatSession
}
const render = () =>
  renderToStaticMarkup(createElement(SlotOutlet<ReasoningActionProps>, { slot: reasoningActions, props }))

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
      "reasoning.collapse-all",
      "reasoning.show-as-text"
    ])
    const html = render()
    expect(html.indexOf("Copy reasoning")).toBeLessThan(html.indexOf("Collapse all"))
    // A plugin's registration under the same id takes the place of the default.
    const replaced = reasoningActions.register({ id: "reasoning.copy", order: 10, component: () => "Plugin copy" })
    expect(render()).toContain("Plugin copy")
    expect(render()).not.toContain("Copy reasoning")
    replaced()
    expect(render()).toContain("Copy reasoning")
    dispose[1]!()
    expect(render()).not.toContain("Collapse all")
  })

  it("offers Show as reply text only on a finished reply-section panel", () => {
    const sections = { sections: [{ lead: "", open: "<think>", text: "Plan.", close: "</think>" }], gap: "" }
    const of = (extra: Partial<ReasoningActionProps>) =>
      renderToStaticMarkup(
        createElement(SlotOutlet<ReasoningActionProps>, {
          slot: reasoningActions,
          props: { ...props, version: { replySections: sections } as unknown as Version, ...extra }
        })
      )
    expect(of({ kind: "sections" })).toContain("Show as reply text")
    expect(of({ kind: "sections" })).toContain("Copy notes")
    expect(of({ kind: "reasoning" })).not.toContain("Show as reply text")
    expect(of({ kind: "sections", streaming: true })).not.toContain("Show as reply text")
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
