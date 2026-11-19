import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { CardSavedFlow } from "../src/features/editor/CardSavedFlow.tsx"
import { cardSavedContributions } from "../src/features/editor/cardSaved.ts"
import { Resume } from "../src/features/cardRename/Resume.tsx"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})
const change = { entityId: "synthetic" as EntityId, oldName: "Aria", newName: "Ari" }
vi.mock("../src/session.ts", () => ({ useSession: () => ({ user: { id: "synthetic-user" } }) }))
vi.mock("../src/features/cardRename/pending.ts", () => ({
  usePending: () => ({ entityId: "synthetic", oldName: "Aria", newName: "Ari" })
}))

it("renders the current registration for an existing offer, including replacement and disablement", () => {
  const original = {
    id: "card-rename.history",
    order: 100,
    applies: () => true,
    component: () => createElement("p", null, "Original offer")
  }
  const dispose = cardSavedContributions.register(original)
  const render = () => renderToStaticMarkup(createElement(CardSavedFlow, { change, onDone: () => {} }))
  try {
    expect(render()).toBe("<p>Original offer</p>")
    const restore = cardSavedContributions.register({
      ...original,
      component: () => createElement("p", null, "Plugin offer")
    })
    try {
      expect(render()).toBe("<p>Plugin offer</p>")
      const enable = cardSavedContributions.disable(original.id)
      try {
        expect(render()).toBe("")
      } finally {
        enable()
      }
      expect(render()).toBe("<p>Plugin offer</p>")
    } finally {
      restore()
    }
    expect(render()).toBe("<p>Original offer</p>")
  } finally {
    dispose()
  }
})

it("does not offer recovery while the registered workflow is disabled or does not apply", () => {
  const original = { id: "card-rename.history", order: 100, applies: () => true, component: () => null }
  const dispose = cardSavedContributions.register(original)
  const render = () => renderToStaticMarkup(createElement(Resume, { entityId: change.entityId }))
  try {
    expect(render()).toContain("Resume history replacement")
    const enable = cardSavedContributions.disable(original.id)
    try {
      expect(render()).toBe("")
    } finally {
      enable()
    }
    const restore = cardSavedContributions.register({ ...original, applies: () => false })
    try {
      expect(render()).toBe("")
    } finally {
      restore()
    }
    expect(render()).toContain("Resume history replacement")
  } finally {
    dispose()
  }
})
