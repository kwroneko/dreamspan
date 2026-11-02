// Personas on the home page (owner, 2026-11-02): the persona folder's cards are under their
// own Personas tab and left out of the other tabs, unless Include personas is ticked, which
// mixes them in marked "You". The choice is remembered and in the URL. Every card is made up.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

test.beforeAll(async () => {
  await admin((api) =>
    Effect.gen(function* () {
      yield* api.CreateCard({ label: "Corin", name: "Corin" })
      yield* api.CreateCard({ label: "Delia", name: "Delia" })
      const pia = yield* api.CreateCard({ label: "Pia", name: "Pia" })
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
    .getByRole("button", { name: /^Open / })
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")).sort())
const include = (page: Page) => main(page).getByRole("checkbox", { name: "Include personas" })

for (const width of [1440, 390]) {
  test(`${width}: Personas tab, and Include personas off, on (marked) and remembered`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(server().url)
    await expect(show(page, "All")).toHaveAttribute("aria-pressed", "true")

    // Off by default: the persona isn't among the characters.
    await expect(include(page)).not.toBeChecked()
    await expect.poll(() => tiles(page)).toEqual(["Open Corin", "Open Delia"])

    // The Personas tab: the persona folder alone, unmarked, without the checkbox.
    await show(page, "Personas").click()
    await expect.poll(() => tiles(page)).toEqual(["Open Pia"])
    await expect(include(page)).toHaveCount(0)
    await expect(main(page).locator("[data-persona-badge]")).toHaveCount(0)

    // On: mixed in, marked "You", with the badge's explanation.
    await show(page, "All").click()
    await include(page).check()
    await expect.poll(() => tiles(page)).toEqual(["Open Corin", "Open Delia", "Open Pia (persona)"])
    const badge = main(page).locator("[data-persona-badge]")
    await expect(badge).toHaveCount(1)
    await expect(badge).toHaveText("You")
    if (width === 1440) {
      await badge.hover()
      await expect(page.getByText("A persona: a card you play as", { exact: true })).toBeVisible()
    }
    // The counts count it too.
    await expect(show(page, "All")).toContainText("3")

    // In the URL, and remembered: a reload keeps it, and so does a fresh visit with no params.
    expect(new URL(page.url()).searchParams.get("personas")).toBe("true")
    await page.reload()
    await expect(include(page)).toBeChecked()
    await expect.poll(() => tiles(page)).toContain("Open Pia (persona)")
    await page.goto(`${server().url}/library`)
    await page.goto(server().url)
    await expect(include(page)).toBeChecked()

    // Off again hides it, and that's remembered as well.
    await include(page).uncheck()
    await expect.poll(() => tiles(page)).toEqual(["Open Corin", "Open Delia"])
    await page.goto(server().url)
    await expect(include(page)).not.toBeChecked()
  })
}
