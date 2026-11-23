// The tab menus' Move items (owner, 2026-11-23: "Move to a new frame below" did nothing for a
// frame's only tab): a frame's only tab leaves first, as closing it would, and the node that
// took its place is split; an item that wouldn't change the layout is disabled. Each item is
// clicked from a tab's right-click menu and from its frame's ⋯, in a frame of two tabs and in a
// split, and the resulting layout read from the URL.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { gotoWithLayout, storedLayout } from "./support/workbench.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const TITLES = { A: "Harbour walk", B: "Lighthouse night", C: "Orchard rain" } as const
type Name = keyof typeof TITLES
let chats: Record<Name, string>

test.beforeAll(async () => {
  chats = await admin((api) =>
    Effect.gen(function* () {
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const made: Partial<Record<Name, string>> = {}
      for (const name of ["A", "B", "C"] as const) {
        const chat = yield* api.CreateChat({ title: TITLES[name] })
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: mira.entityId } })
        made[name] = chat.id
      }
      return made as Record<Name, string>
    })
  )
})

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

/** A frame is its tabs' names; a split is `[r | c, ...children]` (shares left out). */
type Shape = ReadonlyArray<unknown>

const href = (name: Name) => `/chats/${chats[name]}`

/** The compact layout for `gotoWithLayout`: the focused tab is `focus`, shown in its frame. */
const encode = (shape: Shape, focus: Name): unknown => {
  const head = shape[0]
  if (head === "r" || head === "c") {
    const children = shape.slice(1) as Array<Shape>
    return [head, children.map(() => 1 / children.length), ...children.map((c) => encode(c, focus))]
  }
  const names = shape as ReadonlyArray<Name>
  return [Math.max(0, names.indexOf(focus)), ...names.map((n) => (n === focus ? "=" : href(n)))]
}

/** The page's layout as a shape, read from its URL; a single tab alone is `[name]`. */
const current = (page: Page): Shape => {
  const name = (h: string) =>
    (Object.keys(chats) as Array<Name>).find((n) => h.replace(/^[~^]/, "").startsWith(href(n))) ?? h
  const stored = storedLayout(page)
  if (stored === null) return [name(new URL(page.url()).pathname)]
  const read = (node: Array<unknown>): Shape =>
    node[0] === "r" || node[0] === "c"
      ? [node[0], ...(node.slice(2) as Array<Array<unknown>>).map(read)]
      : (node.slice(1) as Array<string>).map(name)
  return read(JSON.parse(stored) as Array<unknown>)
}

const open = async (page: Page, shape: Shape, focus: Name) => {
  await gotoWithLayout(page, server().url, href(focus), encode(shape, focus))
  await expect(page.locator("[data-tab] [role=tab]", { hasText: TITLES[focus] })).toBeVisible()
  await expect.poll(() => current(page)).toEqual(shape)
}

const tabOf = (page: Page, name: Name) => page.locator("[data-tab] [role=tab]", { hasText: TITLES[name] })

/** The menu acting on `name`: its tab's right-click menu, or its frame's ⋯ (it's the shown tab). */
const menuFor = async (page: Page, name: Name, via: "context" | "frame"): Promise<Locator> => {
  if (via === "context") {
    await tabOf(page, name).click({ button: "right" })
    return page.getByRole("menu", { name: /^Actions for / })
  }
  await page
    .locator("[data-frame]")
    .filter({ has: tabOf(page, name) })
    .getByRole("button", { name: "Tab and frame actions" })
    .click()
  return page.getByRole("menu", { name: "Tab and frame actions" })
}

const item = (menu: Locator, label: string) => menu.getByRole("menuitem", { name: new RegExp(`^${label}`) })

interface Case {
  readonly state: string
  readonly shape: Shape
  readonly tab: Name
  readonly item: string
  /** The layout after, or why the item is disabled. */
  readonly after: Shape | string
}

const cases: ReadonlyArray<Case> = [
  // One frame of two tabs: the frame splits; there's no frame beside to move into.
  { state: "two tabs", shape: ["A", "B"], tab: "B", item: "Move to a new frame below", after: ["c", ["A"], ["B"]] },
  { state: "two tabs", shape: ["A", "B"], tab: "B", item: "Move to a new frame above", after: ["c", ["B"], ["A"]] },
  {
    state: "two tabs",
    shape: ["A", "B"],
    tab: "B",
    item: "Move to a new frame on the right",
    after: ["r", ["A"], ["B"]]
  },
  {
    state: "two tabs",
    shape: ["A", "B"],
    tab: "B",
    item: "Move to a new frame on the left",
    after: ["r", ["B"], ["A"]]
  },
  { state: "two tabs", shape: ["A", "B"], tab: "B", item: "Move to the frame below", after: "No frame there." },
  // Two frames side by side, the right one's only tab: it leaves, then the left frame splits.
  {
    state: "split",
    shape: ["r", ["A"], ["B"]],
    tab: "B",
    item: "Move to a new frame below",
    after: ["c", ["A"], ["B"]]
  },
  {
    state: "split",
    shape: ["r", ["A"], ["B"]],
    tab: "B",
    item: "Move to a new frame above",
    after: ["c", ["B"], ["A"]]
  },
  {
    state: "split",
    shape: ["r", ["A"], ["B"]],
    tab: "B",
    item: "Move to a new frame on the left",
    after: ["r", ["B"], ["A"]]
  },
  {
    state: "split",
    shape: ["r", ["A"], ["B"]],
    tab: "B",
    item: "Move to a new frame on the right",
    after: "It's already there."
  },
  { state: "split", shape: ["r", ["A"], ["B"]], tab: "B", item: "Move to the frame on the left", after: ["A", "B"] },
  { state: "split", shape: ["r", ["A"], ["B"]], tab: "B", item: "Move to the frame above", after: "No frame there." },
  // A frame of two tabs beside another: its own frame splits.
  {
    state: "split, two tabs",
    shape: ["r", ["A", "B"], ["C"]],
    tab: "B",
    item: "Move to a new frame below",
    after: ["r", ["c", ["A"], ["B"]], ["C"]]
  },
  {
    state: "split, two tabs",
    shape: ["r", ["A", "B"], ["C"]],
    tab: "B",
    item: "Move to the frame on the right",
    after: ["r", ["A"], ["C", "B"]]
  },
  // Nested: A | (B over C), C's only tab.
  {
    state: "nested",
    shape: ["r", ["A"], ["c", ["B"], ["C"]]],
    tab: "C",
    item: "Move to a new frame on the right",
    after: ["r", ["A"], ["B"], ["C"]]
  },
  {
    state: "nested",
    shape: ["r", ["A"], ["c", ["B"], ["C"]]],
    tab: "C",
    item: "Move to the frame above",
    after: ["r", ["A"], ["B", "C"]]
  }
]

for (const via of ["context", "frame"] as const)
  test(`each Move item from the ${via === "context" ? "tab's right-click" : "frame's ⋯"} menu`, async ({ page }) => {
    for (const c of cases) {
      await test.step(`${c.state}: ${c.item}`, async () => {
        await open(page, c.shape, c.tab)
        const menu = await menuFor(page, c.tab, via)
        const target = item(menu, c.item)
        if (typeof c.after === "string") {
          await expect(target).toBeDisabled()
          // Its explanation, shown beside it on hover, says why.
          await expect(target).toHaveAttribute("data-explain", c.after)
          await target.hover()
          await expect(page.locator("body > *").getByText(c.after, { exact: true }).last()).toBeVisible()
          await page.keyboard.press("Escape")
          await expect.poll(() => current(page)).toEqual(c.shape)
          return
        }
        await expect(target).toBeEnabled()
        await target.click()
        await expect(menu).toBeHidden()
        await expect.poll(() => current(page)).toEqual(c.after)
        await expect(tabOf(page, c.tab)).toBeVisible()
      })
    }
  })

test("Split items show the tab a second time in every state", async ({ page }) => {
  await open(page, ["r", ["A"], ["B"]], "B")
  const menu = await menuFor(page, "B", "context")
  await item(menu, "Split down").click()
  await expect.poll(() => current(page)).toEqual(["r", ["A"], ["c", ["B"], ["B"]]])
  await open(page, ["A", "B"], "B")
  await item(await menuFor(page, "B", "frame"), "Split right").click()
  await expect.poll(() => current(page)).toEqual(["r", ["A", "B"], ["B"]])
})
