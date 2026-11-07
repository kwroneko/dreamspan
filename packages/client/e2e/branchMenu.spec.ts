// The header's opened branch menu (branchmenu, 2026-11-05; DESIGN §3.2): a chat with dozens of
// nested branches, some named (one very long), some pinned, long previews. The layout audit runs
// on the open menu at 1440, at 1024 in a half-width frame and at 390, light and dark, at the
// top of the list and scrolled to its end. BRANCH_MENU_SHOTS saves screenshots there.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { ForkId, SlotId } from "@rp/shared/chat.ts"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.use({ locale: "en-GB", timezoneId: "UTC" })

const NAMES = [
  "Harbor ending",
  "The long way round through the marsh villages before the autumn floods arrive",
  "Lighthouse",
  "Wren stays behind",
  "Quiet night",
  "Market at dusk"
]
const LINES = [
  "The lamps along the quay come on one by one.",
  "Wren pulls the map from her coat, creased and damp, and spreads it across the barrel lid so the lantern light falls on the coastline she has been tracing for three nights without sleep.",
  "Nobody answers.",
  "The ferryman shakes his head and points north, towards the marsh villages and the long causeway that floods at every spring tide, and says the road is closed until the bell rings twice.",
  "Rain again."
]

let fixtures: { branchy: string; plain: string; branches: number }

test.beforeAll(async () => {
  fixtures = await admin((api) =>
    Effect.gen(function* () {
      const send = (chatId: string, forkId: ForkId, parent: SlotId | null, content: string) =>
        Effect.map(
          api.SendMessage({ chatId: chatId as never, forkId, parentSlotId: parent, branch: false, content }),
          (sent) => (sent as { entry?: { slotId: SlotId } }).entry!.slotId
        )
      const made = yield* api.CreateChat({ title: "Wren at the harbor" })
      const root = made.currentForkId!
      const paths = new Map<ForkId, SlotId[]>()
      const rootPath: SlotId[] = []
      for (let i = 0; i < 12; i++)
        rootPath.push(yield* send(made.id, root, rootPath.at(-1) ?? null, `${i}: ${LINES[i % LINES.length]}`))
      paths.set(root, rootPath)
      // Branches of branches: each from an earlier one, at one of its messages.
      const forks: ForkId[] = [root]
      let seed = 7
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed / 0x100000000
      }
      for (let i = 0; i < 34; i++) {
        const parent = forks[Math.floor(random() * forks.length)]!
        const parentPath = paths.get(parent)!
        const cut = Math.max(1, Math.floor(parentPath.length * (0.5 + random() * 0.5)) - 1)
        const at = parentPath[cut - 1]!
        const { fork } = yield* api.CreateFork({ chatId: made.id, fromForkId: parent, atSlotId: at })
        const path = parentPath.slice(0, cut)
        path.push(yield* send(made.id, fork.id, at, `Branch ${i}: ${LINES[i % LINES.length]}`))
        paths.set(fork.id, path)
        forks.push(fork.id)
      }
      for (const [i, name] of NAMES.entries()) yield* api.NameFork({ forkId: forks[2 + i * 5]!, name })
      for (const i of [4, 9, 20]) yield* api.PinFork({ forkId: forks[i]!, pinned: true })
      // The chat opens on the last branch made; show another, so "Back to…" links appear.
      const plain = yield* api.CreateChat({ title: "Lighthouse night" })
      yield* send(plain.id, plain.currentForkId!, null, "The lamp turns, and the stairs go up forever.")
      return { branchy: `${made.id}?fork=${forks[9]}`, plain: plain.id, branches: forks.length }
    })
  )
})

const shots = process.env.BRANCH_MENU_SHOTS
const shot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" })
}

const sidebarChat = (page: Page, title: string) =>
  page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: new RegExp(`^Open chat ${title}`) })

const menu = (page: Page) => page.getByRole("dialog", { name: "Branches of this chat" })

const open = async (page: Page, width: number, theme: "light" | "dark", half: boolean): Promise<Locator> => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: theme })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${fixtures.branchy}`)
  await expect(page.getByText(/^Branch 3[0-3]:|^11:/).first()).toBeAttached()
  let scope: Page | Locator = page
  if (half) {
    await page.getByRole("button", { name: "Split right" }).click()
    await sidebarChat(page, "Lighthouse night").click()
    await expect(page.locator("[data-frame]")).toHaveCount(2)
    scope = page.locator("[data-frame]").first()
  }
  await scope.getByRole("button", { name: /^Branch:.*switch branch$/ }).click()
  const dialog = menu(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("list", { name: "Branches" }).getByRole("listitem")).toHaveCount(fixtures.branches)
  return dialog
}

for (const [width, half] of [
  [1440, false],
  [1024, true],
  [390, false]
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`the open branch menu at ${width}${half ? " in a half-width frame" : ""} ${theme}`, async ({ page }) => {
      test.setTimeout(120_000)
      const name = `menu-${width}${half ? "-half" : ""}-${theme}`
      const dialog = await open(page, width, theme, half)
      if (half)
        expect(
          await dialog.evaluate((popup) => {
            const box = popup.getBoundingClientRect()
            return [...document.querySelectorAll("article[data-slot] [data-portrait]")].some((portrait) => {
              const r = portrait.getBoundingClientRect()
              return (
                r.width &&
                r.height &&
                r.left < box.right &&
                box.left < r.right &&
                r.top < box.bottom &&
                box.top < r.bottom
              )
            })
          }),
          "the half-width menu covers message portraits"
        ).toBe(true)
      await shot(page, name)
      await expectLayout(page, test.info(), name, { scope: '[role="dialog"]' })
      // Scrolled to the end: the last rows and the footer.
      await dialog.getByRole("list", { name: "Branches" }).evaluate((list) => {
        const scroller = list.closest("[data-branch-scroll]") ?? list
        scroller.scrollTop = scroller.scrollHeight
      })
      await shot(page, `${name}-end`)
      await expectLayout(page, test.info(), `${name}-end`, { scope: '[role="dialog"]' })
    })

test("the menu pins, renames and opens branches, and keeps unavailable footer actions in place", async ({ page }) => {
  test.setTimeout(120_000)
  const dialog = await open(page, 1440, "light", false)
  const list = dialog.getByRole("list", { name: "Branches" })
  // Grouped as the left panel groups them, the shown branch marked.
  await expect(dialog.getByRole("heading", { name: "Pinned branches" })).toBeVisible()
  await expect(list.locator("[aria-current]")).toBeInViewport()
  // The menu takes the height below the header: at 900 px, five rows and two headings or more show in full.
  const shownRows = await dialog.locator("[data-branch-scroll]").evaluate((scroller) => {
    const box = scroller.getBoundingClientRect()
    return [...scroller.querySelectorAll("[data-branch-row]")].filter((row) => {
      const r = row.getBoundingClientRect()
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1
    }).length
  })
  expect(shownRows).toBeGreaterThanOrEqual(5)
  const popup = (await dialog.boundingBox())!
  expect(popup.y + popup.height).toBeLessThanOrEqual(900 - 8)
  // Rows are links: a middle or modified click opens the branch in a new tab.
  const href = await list.locator("[data-branch-row]:not(:has([aria-current])) a").first().getAttribute("href")
  expect(href).toMatch(/\/chats\/[^?]+(\?fork=.+)?$/)
  const unpinned = list.locator("[data-branch-row]").filter({ hasNot: page.locator("[aria-pressed=true]") })
  const row = list.locator(`[data-fork="${await unpinned.last().getAttribute("data-fork")}"]`)
  const label = (await row.locator("[data-branch-title-line]").innerText()).replace(/opens here$/, "").trim()
  await row.getByRole("button", { name: `Pin ${label}`, exact: true }).click()
  await expect(row.getByRole("button", { name: `Unpin ${label}`, exact: true })).toBeVisible()
  await row.getByRole("button", { name: `Unpin ${label}`, exact: true }).click()
  await expect(row.getByRole("button", { name: `Pin ${label}`, exact: true })).toBeVisible()
  // Renaming keeps the row's height.
  const height = (await row.boundingBox())!.height
  await row.getByRole("button", { name: `Rename ${label}`, exact: true }).click()
  await expect(row.getByRole("textbox", { name: `Name of branch ${label}` })).toBeVisible()
  expect((await row.boundingBox())!.height).toBeCloseTo(height, 0)
  await row.getByRole("textbox", { name: `Name of branch ${label}` }).fill("Tide pools")
  await row.getByRole("button", { name: "Save the name", exact: true }).click()
  await expect(list.getByRole("heading", { name: "Named branches" })).toBeVisible()
  await expect(list.getByRole("link", { name: /^Tide pools/ })).toBeVisible()
  // The footer's actions stay where they are; one that doesn't apply is greyed.
  for (const name of ["Back to the branch the chat opens on", "Go to where this branch starts"])
    await expect(dialog.getByRole("button", { name, exact: true })).toBeEnabled()
  await expect(dialog.getByRole("link", { name: "Show in the left panel" })).toBeVisible()
  await list.getByRole("link", { name: /^Tide pools/ }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("button", { name: /^Branch: Tide pools/ })).toBeVisible()
})
