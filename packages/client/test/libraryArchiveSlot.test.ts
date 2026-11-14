import type { RefId } from "@rp/shared/library.ts"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
vi.hoisted(() => vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" }))
import { register } from "../src/features/library/index.ts"
import { importCards } from "../src/features/library/slots.ts"
import { SlotOutlet } from "../src/slots.tsx"

it("lets a plugin disable or replace the library export card independently", () => {
  register()
  const render = () =>
    renderToStaticMarkup(
      createElement(SlotOutlet<{ into: RefId | null }>, { slot: importCards, props: { into: null } })
    )
  expect(render()).toContain("Export the whole library")
  const restore = importCards.disable("library.export-archive")
  expect(render()).not.toContain("Export the whole library")
  restore()
  const original = importCards.get("library.export-archive")!
  const undo = importCards.register({ ...original, component: () => createElement("p", null, "Plugin transfer") })
  expect(render()).toContain("Plugin transfer")
  expect(render()).not.toContain("Export the whole library")
  undo()
  expect(render()).toContain("Export the whole library")
})
