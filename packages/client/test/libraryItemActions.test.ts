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
import { TooltipProvider } from "../src/ui/Tooltip.tsx"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

const ref = (fields: Partial<LibraryRef>) =>
  new LibraryRef({
    id: "ref" as RefId,
    entityId: "entity" as EntityId,
    kind: "card",
    refKind: "upstream",
    label: "Synthetic",
    subtitle: "",
    headRevisionId: "rev" as RevisionId,
    followsRefId: null,
    chatId: null,
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

it("offers each kind its own actions, a newly made fork no update from a file", () => {
  const dispose = registerItemActions()
  try {
    const card = { entry: ref({ hasImport: true }), persona: false, exportFormats: formats }
    expect(ids(card)).toEqual(["library.chat", "library.edit", "library.persona", "library.update", "library.export"])
    expect(ids({ ...card, entry: ref({ hasImport: false }) })).not.toContain("library.update")
    expect(ids({ ...card, entry: ref({ kind: "lorebook" }) })).toEqual(["library.update"])
    expect(ids({ ...card, entry: ref({ kind: "preset", refKind: "variant" }) })).toEqual([
      "library.edit",
      "library.export"
    ])
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
  expect(render()).toBe('<div class="flex shrink-0 items-center gap-1"></div>')
})
