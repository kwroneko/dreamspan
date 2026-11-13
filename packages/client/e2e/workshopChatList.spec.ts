// Workshop chats in the chat lists (owner, 2026-11-13: "they absolutely need their own filter and
// entry style. They must be immediately recognizable as different."): the Chats filter's
// Workshops choice, the other choices leaving workshops out, the row's accent edge, tint and badge
// in the sidebar, the Chats page and its search, and no "New chat with this cast" in a workshop's
// menu. Synthetic chats only; no provider is called.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const shots = process.env.DECISIONS_SHOTS ?? "<work>/artifacts/decisions1113"
const server = serverPerFile(withAdmin)
let ids = { solo: "", pair: "", workshop: "" }

test.beforeAll(async () => {
  ids = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const wren = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      const start = (name: string, cards: ReadonlyArray<typeof mira.entityId>) =>
        Effect.gen(function* () {
          const started = yield* api.StartChat({
            cards,
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "A synthetic start.", speakerEntityId: null }
          })
          yield* api.RenameChat({ chatId: started.chat.id, name })
          return started.chat.id as string
        })
      const solo = yield* start("Harbor solo", [mira.entityId])
      const pair = yield* start("Harbor pair", [mira.entityId, wren.entityId])
      const workshop = yield* api.CreateWorkshop({})
      yield* api.RenameChat({ chatId: workshop.id, name: "Tidy the library" })
      return { solo, pair, workshop: workshop.id as string }
    })
  )
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`workshops in the chat lists at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      mkdirSync(shots, { recursive: true })
      const panel =
        width === 390
          ? page.locator(".fixed.inset-0")
          : page.getByRole("complementary", { name: "Sidebar", exact: true })
      const open = async () => {
        if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
      }
      const chats = panel.getByRole("region", { name: "Chats", exact: true })
      const rows = chats.locator("[data-chat-id]")
      const row = (id: string) => chats.locator(`[data-fork-row]:has([data-chat-id="${id}"])`)
      const choose = async (label: string) => {
        await panel.getByRole("combobox", { name: "Show chats" }).click()
        await page.getByRole("option", { name: label }).click()
      }

      await page.goto(`${server().url}/?sideChatsShow=all`)
      await open()
      await expect(panel.getByRole("combobox", { name: "Show chats" })).toHaveText("All · 3")
      await expect(rows).toHaveCount(3)

      // In All: the workshop row is tinted with an accent edge and says "Workshop", the story rows don't.
      const workshopRow = row(ids.workshop)
      await expect(workshopRow).toHaveAttribute("data-kind-row", "")
      await expect(workshopRow.locator('[data-kind-badge="workshop"]')).toHaveText("Workshop")
      await expect(workshopRow.locator("[data-chat-id]")).toHaveAccessibleName(/Tidy the library, Workshop$/)
      for (const story of [ids.solo, ids.pair]) {
        await expect(row(story)).not.toHaveAttribute("data-kind-row", "")
        await expect(row(story).locator("[data-kind-badge]")).toHaveCount(0)
      }
      const edge = await workshopRow.evaluate((el) => {
        const style = getComputedStyle(el)
        return { shadow: style.boxShadow, image: style.backgroundImage }
      })
      expect(edge.shadow).not.toBe("none")
      expect(edge.image).toContain("linear-gradient")
      await expectLayout(page, info, `workshop-list-sidebar-${width}-${theme}`, {
        scope: width === 390 ? ".fixed.inset-0" : '[aria-label="Sidebar"]'
      })
      await chats.screenshot({ path: resolve(shots, `rows-${width}-${theme}.png`), animations: "disabled" })

      // The filter: Workshops is its own choice, with an explanation, and the others leave workshops out.
      await panel.getByRole("combobox", { name: "Show chats" }).click()
      await expect(page.getByRole("option")).toHaveText([
        /^All · 3/,
        /^Pinned · 0/,
        /^Group chats · 1/,
        /^One-on-one · 1/,
        /^With branches · 0/,
        /^Workshops · 1/
      ])
      await expect(page.getByRole("option", { name: /^Workshops/ })).toHaveAccessibleDescription(/Shows only workshops/)
      await page.keyboard.press("Escape")
      await choose("Workshops · 1")
      await expect(page).toHaveURL(/sideChatsShow=workshops/)
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toHaveAttribute("data-chat-id", ids.workshop)
      for (const [label, only] of [
        ["One-on-one · 1", ids.solo],
        ["Group chats · 1", ids.pair]
      ] as const) {
        await choose(label)
        await expect(rows).toHaveCount(1)
        await expect(rows.first()).toHaveAttribute("data-chat-id", only)
      }
      // The URL is the state: a reload on Workshops shows only the workshop.
      await page.goto(`${server().url}/?sideChatsShow=workshops`)
      await open()
      await expect(panel.getByRole("combobox", { name: "Show chats" })).toHaveText("Workshops · 1")
      await expect(rows).toHaveCount(1)
      await expectLayout(page, info, `workshop-filter-sidebar-${width}-${theme}`, {
        scope: width === 390 ? ".fixed.inset-0" : '[aria-label="Sidebar"]'
      })

      const userId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.map(api.Whoami(), (u) => u.id)
      )
      await page.evaluate(
        (id) =>
          localStorage.setItem(
            `rp.chats.sidebar.${id}`,
            JSON.stringify({ sideChatsShow: "workshops", sideChatsSort: "name", sideChatsReverse: true })
          ),
        userId
      )
      await page.goto(`${server().url}/`)
      await open()
      await expect(panel.getByRole("combobox", { name: "Show chats" })).toHaveText("All · 3")
      await expect(rows).toHaveCount(3)
      expect(new URL(page.url()).searchParams.has("sideChatsSort")).toBe(false)
      expect(new URL(page.url()).searchParams.has("sideChatsReverse")).toBe(false)

      // The Chats page and its search use the same row, with the same marks.
      await page.goto(`${server().url}/chats`)
      const list = page.getByRole("list", { name: "Chats" })
      const item = list.locator("li", { has: page.getByRole("link", { name: /Tidy the library/ }) })
      await expect(item).toHaveAttribute("data-kind-row", "")
      await expect(item.locator('[data-kind-badge="workshop"]')).toHaveText("Workshop")
      await expect(list.locator("li", { has: page.getByRole("link", { name: /Harbor solo/ }) })).not.toHaveAttribute(
        "data-kind-row",
        ""
      )
      await page.getByRole("textbox", { name: "Find a chat" }).fill("Tidy")
      await expect(list.locator("li")).toHaveCount(1)
      await expect(list.locator("li").first()).toHaveAttribute("data-kind-row", "")
      await expectLayout(page, info, `workshop-list-page-${width}-${theme}`)
      await page.screenshot({ path: resolve(shots, `chats-page-${width}-${theme}.png`) })
      await page.getByRole("textbox", { name: "Find a chat" }).fill("")
    })

const menuItems = async (page: Page) => {
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  const names = await page.getByRole("menuitem").allTextContents()
  await page.keyboard.press("Escape")
  return names
}

test("a workshop's menu has no New chat with this cast; a story's still does", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${ids.solo}`)
  await expect(page.getByRole("button", { name: "Chat actions", exact: true })).toBeVisible()
  expect((await menuItems(page)).some((name) => name.startsWith("New chat with this cast"))).toBe(true)
  await page.goto(`${server().url}/chats/${ids.workshop}`)
  await expect(page.locator('[data-kind-badge="workshop"]').first()).toBeVisible()
  const items = await menuItems(page)
  expect(items.length).toBeGreaterThan(0)
  expect(items.some((name) => name.startsWith("New chat with this cast"))).toBe(false)
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`shared workshop branch rows stay recognizable at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const workshop = yield* api.GetChat({ chatId: ids.workshop as never })
          yield* api.CreateFork({
            chatId: workshop.id,
            fromForkId: workshop.currentForkId,
            atSlotId: workshop.activeLeafSlotId
          })
        })
      )
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${ids.workshop}`)
      if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
      const branches = page.getByRole("region", { name: "Branches of the open chat", exact: true })
      await expect(branches).toBeVisible()
      const heading = branches.getByRole("button", { name: /^Branches of/ })
      if ((await heading.getAttribute("aria-expanded")) === "false") await heading.click()
      await expect(heading).toHaveAttribute("aria-expanded", "true")
      const rows = branches.locator("[data-fork-row]")
      await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2)
      for (const row of await rows.all()) {
        await expect(row).toHaveAttribute("data-kind-row", "")
        await expect(row.locator('[data-kind-badge="workshop"]')).toHaveText("Workshop")
        await expect(row.locator("[data-chat-id]")).toHaveAccessibleName(/Workshop/)
      }
      await expectLayout(page, info, `workshop-branch-footer-${width}-${theme}`, {
        scope: '[aria-label="Branches of the open chat"]'
      })
      await page.goto(`${server().url}/?forks=${ids.workshop}`)
      if (width === 390) await page.getByRole("button", { name: "Chats and menu", exact: true }).click()
      const listed = page.locator(`[data-fork-row]:has([data-chat-id="${ids.workshop}"])`)
      await expect.poll(() => listed.count()).toBeGreaterThanOrEqual(2)
      for (const row of await listed.all()) await expect(row).toHaveAttribute("data-kind-row", "")
      await expectLayout(page, info, `workshop-branch-list-${width}-${theme}`, {
        scope: width === 390 ? ".fixed.inset-0" : '[aria-label="Sidebar"]'
      })
    })
