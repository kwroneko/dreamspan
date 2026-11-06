import type { EntityId } from "@rp/shared/chat.ts"
import { LibraryRef, type RefId, type RevisionId } from "@rp/shared/library.ts"
import type { ExportFormatInfo } from "@rp/shared/libraryImport.ts"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { cardContributions } from "../src/features/cardForks/surfaces.tsx"
import {
  availableItemActions,
  libraryItemActions,
  LibraryItemActions,
  type LibraryItemContext
} from "../src/features/library/itemActions.tsx"
import { registerItemActions } from "../src/features/library/registerItemActions.tsx"
import { register as registerCardImport } from "../src/features/cardImport/index.tsx"
import { chatCardActions } from "../src/features/chat/presentation.tsx"
import { TooltipProvider } from "../src/ui/Tooltip.tsx"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

const ref = (fields: Partial<LibraryRef>) =>
  new LibraryRef({
    id: "ref" as RefId,
    entityId: "entity" as EntityId,
    kind: "card",
    label: "Synthetic",
    subtitle: "",
    headRevisionId: "rev" as RevisionId,
    parentEntityId: null,
    updateAvailable: false,
    rowVersion: 1,
    updatedAt: 0,
    ...fields
  })
const format = (id: string, kind: ExportFormatInfo["kind"]): ExportFormatInfo => ({
  id,
  kind,
  label: id,
  mime: "application/octet-stream",
  extension: id,
  media: "none"
})
const formats = [format("png", "card"), format("preset-json", "preset")]
const ids = (context: LibraryItemContext) => availableItemActions(context).map((action) => action.id)

it("offers each kind its own actions, a lorebook an Edit, a card no merging update from a file", () => {
  const dispose = registerItemActions()
  try {
    const card = { entry: ref({ hasImport: true }), persona: false, exportFormats: formats }
    // A card takes a new version wholesale through "Import a new version…" (features/cardImport).
    expect(ids(card)).toEqual(["library.chat", "library.edit", "library.persona", "library.export"])
    expect(ids({ ...card, entry: ref({ hasImport: false }) })).not.toContain("library.update")
    // Every kind opens in its editor's page, a lorebook too.
    expect(ids({ ...card, entry: ref({ kind: "lorebook" }) })).toEqual(["library.edit", "library.update"])
    // A preset has its archive button beside Edit, as in the preset pickers.
    // A variant merges its original's new versions instead of importing a file.
    expect(ids({ ...card, entry: ref({ kind: "preset", parentEntityId: "parent" as EntityId }) })).toEqual([
      "library.edit",
      "library.archive",
      "library.export"
    ])
    expect(ids({ ...card, entry: ref({ kind: "preset" }) })).toEqual([
      "library.edit",
      "library.archive",
      "library.update",
      "library.export"
    ])
  } finally {
    for (const undo of dispose) undo()
  }
  expect(libraryItemActions.list()).toHaveLength(0)
})

it("registers Import a new version… for cards, in the library, the card's actions and a chat's card", () => {
  const dispose = registerCardImport()
  try {
    const card = { entry: ref({}), persona: false, exportFormats: formats }
    expect(ids(card)).toEqual(["card-import.new-version"])
    expect(ids({ ...card, entry: ref({ kind: "preset" }) })).toEqual([])
    expect(cardContributions.list().map((entry) => [entry.id, entry.placement])).toEqual([
      ["card-import.new-version", "actions"]
    ])
    expect(chatCardActions.list().map((entry) => entry.id)).toEqual(["card-import.new-version"])
  } finally {
    for (const undo of dispose) undo()
  }
  expect(libraryItemActions.list()).toHaveLength(0)
})

it("renders direct actions and a menu only when something registered fills it", () => {
  const context = { entry: ref({}), persona: false, exportFormats: formats }
  const render = () =>
    renderToStaticMarkup(createElement(TooltipProvider, null, createElement(LibraryItemActions, { context })))
  const direct = libraryItemActions.register({
    id: "synthetic.direct",
    order: 0,
    direct: ({ entry }) => createElement("button", null, `Open ${entry.label}`)
  })
  expect(render()).toContain("Open Synthetic")
  expect(render()).not.toContain("More actions for Synthetic")
  // A card contribution with a menu entry opens the menu even with no library menu entries.
  const card = cardContributions.register({
    id: "synthetic.card-menu",
    placement: "actions",
    order: 0,
    menu: () => createElement("span", null, "Synthetic card item")
  })
  expect(render()).toContain("More actions for Synthetic")
  const lorebook = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(LibraryItemActions, { context: { ...context, entry: ref({ kind: "lorebook" }) } })
    )
  )
  expect(lorebook).not.toContain("More actions")
  const hidden = libraryItemActions.disable("synthetic.direct")
  expect(render()).not.toContain("Open Synthetic")
  hidden()
  expect(render()).toContain("Open Synthetic")
  card()
  direct()
  expect(render()).toMatch(/^<div[^>]*><\/div>$/)
})

it("hands an action its registered description, so a plugin's entry explains itself", () => {
  const context = { entry: ref({}), persona: false, exportFormats: formats }
  const direct = libraryItemActions.register({
    id: "synthetic.described",
    order: 0,
    description: "Does a synthetic thing.",
    direct: ({ description }) => createElement("button", { title: description }, "Synthetic")
  })
  try {
    const html = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(LibraryItemActions, { context }))
    )
    expect(html).toContain('title="Does a synthetic thing."')
  } finally {
    direct()
  }
})
