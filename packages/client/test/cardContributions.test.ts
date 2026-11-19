import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { register } from "../src/features/cardForks/index.tsx"
import { cardContributions, CardSurface } from "../src/features/cardForks/surfaces.tsx"

it("registers independent commands and surfaces, with reversible plugin overrides", () => {
  const dispose = register()
  try {
    expect(cardContributions.list().map((c) => c.id)).toEqual([
      "card-forks.fork",
      "card-forks.family",
      "card-forks.compare",
      "card-forks.parent",
      "card-forks.unlink",
      "card-forks.family-surface",
      "card-forks.provenance-surface",
      "card-forks.badge-surface"
    ])
    const original = cardContributions.get("card-forks.fork")!
    const override = cardContributions.register({
      ...original,
      component: ({ entityId }) => createElement("p", null, `Plugin fork ${entityId}`)
    })
    const disabled = cardContributions
      .list()
      .filter((c) => c.placement === "actions" && c.id !== original.id)
      .map((c) => cardContributions.disable(c.id))
    const props = { entityId: "synthetic" as EntityId, placement: "actions" as const }
    expect(renderToStaticMarkup(createElement(CardSurface, props))).toBe("<p>Plugin fork synthetic</p>")
    const hide = cardContributions.disable(original.id)
    expect(renderToStaticMarkup(createElement(CardSurface, props))).toBe("")
    hide()
    override()
    expect(cardContributions.get(original.id)).toBe(original)
    for (const undo of disabled) undo()
  } finally {
    for (const undo of dispose.reverse()) undo()
  }
  expect(cardContributions.list()).toHaveLength(0)
})
