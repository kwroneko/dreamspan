// The side panel's persona tab follows the persona (owner, 2026-11-23): with the tab of the card
// the user plays open, picking another persona opens the new persona's tab, in place (replace),
// not This chat's or a dead tab, in a chat not saved yet and in a saved one, from the composer's
// Speak as and from the Cast tab's Switch. Back never lands on the old persona's tab. Every card
// is made up.
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { closePanel, openPanel, panelTab } from "./support/panel.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
test.setTimeout(120_000)
let cookie = ""
const ids: Record<string, EntityId> = {}
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  await withCookie(server(), cookie, (api) =>
    Effect.gen(function* () {
      for (const name of ["Halden", "Ilse", "Juno"]) {
        ids[name] = (yield* api.CreateCard({ label: name, name })).entityId as EntityId
        if (name !== "Halden") yield* api.SetPersona({ entityId: ids[name], persona: true })
      }
      // A pending chat plays the default persona.
      yield* api.ChangeGenerationDefaults({ change: { persona: ids.Ilse! } })
    })
  )
})

/** A saved chat with Halden, played as Ilse, a line written there. */
const savedChat = () =>
  withCookie(server(), cookie, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Lighthouse" })
      for (const change of [
        { _tag: "Join", entityId: ids.Halden! },
        { _tag: "Persona", entityId: ids.Ilse! }
      ] as const)
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change })
      yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Dusk.", reply: false })
      return chat.id
    })
  )

const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const personaTab = (page: Page, name: string) =>
  page.getByRole("tablist", { name: "Characters", exact: true }).getByRole("tab", { name, exact: true })

/** The new persona's tab is the one open, with its card, and the URL names it. */
const expectPersonaOpen = async (page: Page, name: string) => {
  await expect(personaTab(page, name)).toHaveAttribute("aria-selected", "true")
  const body = page.getByRole("tabpanel", { name, exact: true })
  await expect(body.locator("[data-card-header]")).toBeVisible()
  await expect(body).not.toContainText("Available once the chat is saved")
  await expect.poll(() => panelParam(page)).toBe(`card:${ids[name]}`)
}

const composerPick = async (page: Page, name: string) => {
  await page.getByRole("button", { name: /^(Playing|Speaking) as / }).click()
  await page
    .getByRole("group", { name: "Your persona", exact: true })
    .getByRole("option", { name, exact: true })
    .click()
}

for (const width of [1440, 390])
  for (const saved of [false, true]) {
    const where = saved ? "saved chat" : "pending chat"
    const open = async (page: Page) => {
      await page.setViewportSize({ width, height: 900 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const path = saved ? `/chats/${await savedChat()}` : `/cards/${ids.Halden}/chat`
      await page.goto(`${server().url}${path}`)
      await expect(page.getByRole("button", { name: /^(Playing|Speaking) as Ilse\b/ }).first()).toBeVisible({ timeout: 30_000 })
      // This chat first, then the persona's tab: a step in the history.
      await openPanel(page, "This chat")
      await panelTab(page, "Ilse")
      await expect(personaTab(page, "Ilse")).toHaveAttribute("aria-selected", "true")
      await expect.poll(() => panelParam(page)).toBe(`card:${ids.Ilse}`)
    }

    test(`${width}, ${where}: Speak as moves the open persona tab to the new persona`, async ({ page }) => {
      await open(page)
      if (width === 1440) {
        // The panel beside the chat: the tab follows at once, in place.
        await composerPick(page, "Juno")
        await expectPersonaOpen(page, "Juno")
        await expect(personaTab(page, "Ilse")).toHaveCount(0)
        await page.goBack()
        await expect(page.getByRole("tabpanel", { name: "This chat", exact: true })).toBeVisible()
        await expect.poll(() => panelParam(page)).toBe("chat")
      } else {
        // A phone's sheet covers the composer: closed, the persona switched, it reopens at the new persona's tab.
        await closePanel(page)
        await composerPick(page, "Juno")
        await expect(page.getByRole("button", { name: /^(Playing|Speaking) as Juno\b/ }).first()).toBeVisible()
        await page.getByRole("button", { name: "Chat panel", exact: true }).click()
        await expectPersonaOpen(page, "Juno")
        // Back closes the sheet it opened, and never opens the old persona's tab.
        await page.goBack()
        await expect(page.getByRole("tablist", { name: "Chat panel" })).toHaveCount(0)
        expect(panelParam(page)).not.toBe(`card:${ids.Ilse}`)
      }
    })

    test(`${width}, ${where}: the Cast tab's Switch, then Back, opens the new persona's tab`, async ({ page }) => {
      await open(page)
      const cast = await openPanel(page, "Cast")
      await cast.getByRole("button", { name: /Change your persona/ }).click()
      await page.getByRole("option", { name: "Juno", exact: true }).click()
      await expect(cast.getByRole("button", { name: /^Playing as Juno/ })).toBeVisible()
      await expect.poll(() => panelParam(page)).toBe("cast")
      // Back to where the old persona's tab was open: the new persona's, the URL replaced.
      await page.goBack()
      await expectPersonaOpen(page, "Juno")
      await expect(page.getByRole("tabpanel", { name: "This chat", exact: true })).toBeHidden()
      // And Back again, the tab before it.
      await page.goBack()
      await expect(page.getByRole("tabpanel", { name: "This chat", exact: true })).toBeVisible()
      await expect.poll(() => panelParam(page)).toBe("chat")
    })
  }
