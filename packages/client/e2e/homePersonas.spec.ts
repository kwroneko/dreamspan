// Personas on the home page (owner, 2026-11-02): the persona folder's cards are under their
// own Personas tab and left out of the other tabs, unless Include personas is on, which
// mixes them in marked "Persona". The choice is in the tab's URL. Every card is made up.
import { expect, test, type Page } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { openPanel, closePanel } from "./support/panel.ts"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

let pia: { entityId: EntityId; id: string }
let corin: EntityId
let delia: EntityId

test.beforeAll(async () => {
  await admin((api) =>
    Effect.gen(function* () {
      corin = (yield* api.CreateCard({ label: "Corin", name: "Corin" })).entityId
      delia = (yield* api.CreateCard({ label: "Delia", name: "Delia" })).entityId
      pia = yield* api.CreateCard({ label: "Pia", name: "Pia" })
      yield* api.SetPersona({ entityId: pia.entityId, persona: true })
    })
  )
})

const main = (page: Page) => page.getByRole("main")
const show = (page: Page, name: string) =>
  main(page).getByRole("group", { name: "Show", exact: true }).getByRole("button", { name, exact: true })
const tiles = (page: Page) =>
  main(page)
    .getByLabel("Characters", { exact: true })
    .getByRole("link", { name: /^Open / })
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")).sort())
const include = (page: Page) => main(page).getByRole("button", { name: "Include personas", exact: true })

for (const width of [1440, 390]) {
  test(`${width}: Personas tab, and Include personas off, on (marked) and in the URL`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(server().url)
    await expect(show(page, "All")).toHaveAttribute("aria-pressed", "true")

    // Off by default: the persona isn't among the characters.
    await expect(include(page)).toHaveAttribute("aria-pressed", "false")
    await expect(include(page).locator("svg path")).toHaveCount(4)
    await expect(include(page).locator("svg path").nth(2)).toHaveAttribute("d", "m17 8 5 5")
    await include(page).hover()
    await expect(page.getByText("Click to show personas", { exact: true }).filter({ visible: true })).toBeVisible()
    await expect.poll(() => tiles(page)).toEqual(["Open Corin", "Open Delia"])

    // Personas shows the folder alone, with its toggle kept in place and disabled (03580791d).
    await show(page, "Personas").click()
    await expect.poll(() => tiles(page)).toEqual(["Open Pia"])
    await expect(include(page)).toBeDisabled()
    await expect(include(page)).toHaveAttribute("aria-pressed", "false")
    await expect(main(page).locator("[data-persona-badge]")).toHaveCount(0)

    // On: mixed in, marked "Persona", with the badge's explanation.
    await show(page, "All").click()
    await include(page).click()
    await expect(include(page)).toHaveAttribute("aria-pressed", "true")
    await expect(include(page).locator("svg path")).toHaveCount(2)
    await main(page).getByRole("heading", { name: "Characters", exact: true }).hover()
    await include(page).hover()
    await expect(page.getByText("Click to hide personas", { exact: true }).filter({ visible: true })).toBeVisible()
    await expect.poll(() => tiles(page)).toEqual(["Open Corin", "Open Delia", "Open Pia (persona)"])
    const badge = main(page).locator("[data-persona-badge]")
    await expect(badge).toHaveCount(1)
    await expect(badge).toHaveText("Persona")
    if (width === 1440) {
      await badge.hover()
      await expect(
        page.getByText("In the persona folder: a card you can play in chats.", { exact: true })
      ).toBeVisible()
    }
    // The counts count it too.
    await expect(show(page, "All")).toContainText("3")

    // In the tab's URL (owner, 2026-11-18): a reload and a copied link keep it; nothing is
    // remembered on the account, so a bare visit shows the default.
    expect(new URL(page.url()).searchParams.get("personas")).toBe("true")
    const copied = page.url()
    await page.reload()
    await expect(include(page)).toHaveAttribute("aria-pressed", "true")
    await expect.poll(() => tiles(page)).toContain("Open Pia (persona)")
    await page.goto(`${server().url}/library`)
    await page.goto(server().url)
    await expect(include(page)).toHaveAttribute("aria-pressed", "false")
    await expect.poll(() => tiles(page)).toEqual(["Open Corin", "Open Delia"])

    // Off again hides it, and leaves the URL bare.
    await page.goto(copied)
    await expect(include(page)).toHaveAttribute("aria-pressed", "true")
    await include(page).click()
    await expect.poll(() => tiles(page)).toEqual(["Open Corin", "Open Delia"])
    expect(new URL(page.url()).searchParams.has("personas")).toBe(false)
  })
}

for (const width of [1440, 390]) {
  test(`${width}: Persona outside a chat, You only for the selected chat persona`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    for (const path of ["/library", `/cards/${pia.entityId}`, `/library/${pia.id}`]) {
      await page.goto(`${server().url}${path}`)
      const badge = main(page).locator("[data-persona-badge]")
      await expect(badge).toHaveText("Persona")
      await badge.focus()
      await page.keyboard.press("Tab")
      await page.keyboard.press("Shift+Tab")
      await expect(
        page.getByText("In the persona folder: a card you can play in chats.", { exact: true })
      ).toBeVisible()
    }
    const chat = await admin((api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: "Badge context" })
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: corin } })
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Persona", entityId: pia.entityId } })
        return chat
      })
    )
    await page.goto(`${server().url}/chats/${chat.id}?panel=card:${pia.entityId}`)
    const tab = page.getByRole("tabpanel", { name: "Pia", exact: true })
    const played = tab.locator("[data-persona-badge]")
    await expect(played).toHaveText("You")
    await played.focus()
    await page.keyboard.press("Tab")
    await page.keyboard.press("Shift+Tab")
    await expect(page.getByText("You play this card in this chat.", { exact: true })).toBeVisible()
    await page.goto(`${server().url}/chats/${chat.id}?editor=${pia.id}`)
    await expect(
      page.getByRole("region", { name: "Card editor", exact: true }).locator("[data-persona-badge]")
    ).toHaveText("You")
    await page.goto(`${server().url}/chats/${chat.id}`)
    await openPanel(page, "Cast")
    await expect(
      page.getByRole("group", { name: "Your persona", exact: true }).locator("[data-persona-badge]")
    ).toHaveText("You")
    await closePanel(page)
    await page.getByRole("button", { name: /^Speaking as Pia/ }).click()
    const switcher = page.getByRole("dialog", { name: "Speak as", exact: true })
    const speak = switcher.getByRole("group", { name: "Speak as", exact: true })
    await expect(speak.getByRole("option", { name: "Pia", exact: true }).locator("[data-persona-badge]")).toHaveText(
      "You"
    )
    await speak.getByRole("option", { name: "Corin", exact: true }).click()
    await page.getByRole("button", { name: /^Speaking as Corin/ }).click()
    await expect(speak.getByRole("option", { name: "Pia", exact: true }).locator("[data-persona-badge]")).toHaveText(
      "You"
    )
    await expect(speak.getByRole("option", { name: "Corin", exact: true }).locator("[data-persona-badge]")).toHaveCount(
      0
    )
    await page.keyboard.press("Escape")

    // Folder membership and the card selected in a chat are independent.
    await admin((api) =>
      api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Persona", entityId: delia } })
    )
    await page.goto(`${server().url}/chats/${chat.id}?panel=card:${delia}`)
    await expect(page.getByRole("tabpanel", { name: "Delia", exact: true }).locator("[data-persona-badge]")).toHaveText(
      "You"
    )
    await page.goto(`${server().url}/library/${pia.id}`)
    await expect(main(page).locator("[data-persona-badge]")).toHaveText("Persona")
  })
}
