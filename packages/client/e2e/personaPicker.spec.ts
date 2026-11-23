// Synthetic cards only: the one persona picker (SpeakerSwitcher.tsx, registered as
// `chat.card-switcher`) from both places a new single chat's persona is picked, the composer's
// chip and the Cast tab's Switch, with the same assertions: its persona tabs, search, rows and
// their … menu (which closes as the list scrolls), the persona lock row, and picking.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
/** The picker's popup, not a phone's panel sheet (also a dialog) under it. */
const PICKER = '[role="dialog"]:has(input[aria-label="Find a card to play as"])'

interface Entry {
  readonly name: string
  /** Opens the picker on the new chat's page; returns it. */
  readonly open: (page: Page) => Promise<Locator>
  /** Its tabs: the persona tabs, after the composer's own Speak as. */
  readonly tabs: ReadonlyArray<string>
  /** The trigger once `persona` is played. */
  readonly played: (page: Page, persona: string) => Locator
  readonly close: (page: Page) => Promise<void>
}

const entries: ReadonlyArray<Entry> = [
  {
    name: "composer",
    open: async (page) => {
      await page.getByRole("button", { name: /^Speaking as .*\. Change the speaker$/ }).click()
      const picker = page.getByRole("dialog", { name: "Speak as", exact: true })
      await expect(picker.getByRole("tab", { name: "Speak as", exact: true })).toHaveAttribute("aria-selected", "true")
      await picker.getByRole("tab", { name: "Personas", exact: true }).click()
      return picker
    },
    tabs: ["Speak as", "Personas", "All cards"],
    played: (page, persona) =>
      page.getByRole("button", { name: `Speaking as ${persona}. Change the speaker`, exact: true }),
    close: async () => {}
  },
  {
    name: "cast",
    open: async (page) => {
      await openPanel(page, "Cast")
      await page.getByRole("button", { name: /^Playing as .*\. Change your persona$/ }).click()
      return page.getByRole("dialog", { name: "Your persona", exact: true })
    },
    tabs: ["Personas", "All cards"],
    played: (page, persona) =>
      page.getByRole("button", { name: `Playing as ${persona}. Change your persona`, exact: true }),
    close: async (page) => {
      if ((await page.viewportSize())!.width < 700) await closePanel(page)
    }
  }
]

test.describe("the persona picker", () => {
  test.setTimeout(180_000)
  for (const width of [1440, 390])
    for (const entry of entries)
      test(`${entry.name}: tabs, search, row menu, lock and pick ${width}`, async ({ page }, info) => {
        const tag = `${entry.name} ${width}`
        const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
        const { harbor, extra } = await withCookie(server(), cookie, (api) =>
          Effect.gen(function* () {
            const harbor = yield* api.CreateCard({ label: `Harbor ${tag}`, name: `Harbor ${tag}` })
            const extra = yield* api.CreateCard({ label: `Ferry ${tag}`, name: `Ferry ${tag}` })
            for (let at = 0; at < 12; at++) {
              const card = yield* api.CreateCard({ label: `Aide ${tag} ${at}`, name: `Aide ${tag} ${at}` })
              yield* api.SetPersona({ entityId: card.entityId, persona: true })
              if (at === 0) yield* api.ChangeGenerationDefaults({ change: { persona: card.entityId } })
            }
            return { harbor, extra }
          })
        )
        await page.setViewportSize({ width, height: 900 })
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        await page.goto(`${server().url}/cards/${harbor.entityId}/chat`)
        const aide = (at: number) => `Aide ${tag} ${at}`

        const picker = await entry.open(page)
        await expect(picker.getByRole("tab")).toHaveText([...entry.tabs])
        await expect(picker.getByRole("tab", { name: "Personas", exact: true })).toHaveAttribute(
          "aria-selected",
          "true"
        )
        const list = picker.getByRole("tabpanel", { name: "Personas", exact: true }).getByRole("listbox")
        // The persona played first, ticked as the persona; the lock row under the list names it.
        await expect(list.getByRole("option").first()).toHaveAccessibleName(aide(0))
        await expect(list.getByRole("option", { name: aide(0), exact: true })).toHaveAttribute("aria-current", "true")
        await expect(
          picker.getByRole("checkbox", { name: `Always play as ${aide(0)} with ${harbor.label}`, exact: true })
        ).not.toBeChecked()
        await expect(picker.getByRole("button", { name: "No persona", exact: true })).toBeVisible()
        await expect(picker.getByRole("button", { name: "New persona…", exact: true })).toBeVisible()
        await expectLayout(page, info, `persona-picker-${entry.name}-${width}`, { scope: PICKER })
        await picker.screenshot({ path: info.outputPath(`picker.png`), animations: "disabled" })

        // A row's … holds its persona actions; its menu closes once the list scrolls the row out of view.
        const actions = list.getByRole("button", { name: `Persona actions for ${aide(0)}`, exact: true })
        await actions.click()
        const menu = page.getByRole("menu", { name: `Persona actions for ${aide(0)}`, exact: true })
        await expect(menu.getByRole("menuitem")).toHaveCount(1)
        await expect(menu.getByRole("menuitem", { name: "Clear default persona", exact: true })).toBeVisible()
        await list.evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        await expect(menu).toHaveCount(0)
        await expect(picker).toBeVisible()
        // Opened from the keyboard on a half-hidden row, the list scrolls to show it: the menu stays.
        // Scrolled so half the first row's … is above the list's top edge.
        await list.evaluate(
          (element, name) =>
            new Promise((done) => {
              element.scrollTop = 0
              const button = element.querySelector(`[aria-label="${name}"]`)!.getBoundingClientRect()
              element.scrollTop = button.top - element.getBoundingClientRect().top + button.height / 2
              requestAnimationFrame(() => requestAnimationFrame(done))
            }),
          `Persona actions for ${aide(0)}`
        )
        expect((await actions.boundingBox())!.y).toBeLessThan((await list.boundingBox())!.y)
        await actions.press("Enter")
        await expect(menu.getByRole("menuitem", { name: "Clear default persona", exact: true })).toBeVisible()
        await page.waitForTimeout(300)
        await expect(menu).toBeVisible()
        await page.keyboard.press("Escape")
        await expect(menu).toHaveCount(0)

        // Search filters the tab shown; All cards has every card.
        const search = picker.getByRole("combobox", { name: "Find a card to play as", exact: true })
        await search.fill(`${tag} 1`)
        await expect(list.getByRole("option")).toHaveCount(3)
        for (const at of [1, 10, 11])
          await expect(list.getByRole("option", { name: aide(at), exact: true })).toBeVisible()
        await picker.getByRole("tab", { name: "All cards", exact: true }).click()
        const all = picker.getByRole("tabpanel", { name: "All cards", exact: true }).getByRole("listbox")
        await search.fill(`Ferry ${tag}`)
        await expect(all.getByRole("option")).toHaveText([new RegExp(extra.label)])
        await picker.getByRole("tab", { name: "Personas", exact: true }).click()

        // Picking plays the persona, and the lock row follows it.
        await search.fill(aide(2))
        await list.getByRole("option", { name: aide(2), exact: true }).click()
        await expect(picker).toHaveCount(0)
        await expect(entry.played(page, aide(2))).toBeVisible()
        await entry.close(page)
        const again = await entry.open(page)
        const lock = again.getByRole("checkbox", {
          name: `Always play as ${aide(2)} with ${harbor.label}`,
          exact: true
        })
        await lock.click()
        await expect(lock).toBeChecked()
        await expect
          .poll(
            async () =>
              (await withCookie(server(), cookie, (api) => api.GetPersonaLock({ entityId: harbor.entityId })))?.entityId
          )
          .toBeDefined()
        await expectLayout(page, info, `persona-picker-${entry.name}-locked-${width}`, { scope: PICKER })
        await lock.click()
        await expect(lock).not.toBeChecked()
      })
})
