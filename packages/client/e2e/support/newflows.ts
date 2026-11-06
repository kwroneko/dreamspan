// Synthetic creation flows. The same measurements run in the focused layout audit.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./layoutAudit.ts"
import { openPanel } from "./panel.ts"
import { showAppNavigation, hideAppNavigation } from "./appMenu.ts"
import { portraitPng } from "./portrait.ts"
import { loginCookie, withCookie } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"

export function newflowTests() {
  test.describe("newflows", () => {
    test.setTimeout(180_000)
    const server = serverPerFile(withAdmin)
    let cookie = ""
    test.beforeAll(async () => {
      cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
    })
    const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        const suffix = `${width} ${theme}`
        test.describe(suffix, () => {
          test.beforeEach(async ({ page }) => {
            await page.setViewportSize({ width, height: 900 })
            await page.emulateMedia({ colorScheme: theme })
            await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          })
          for (const kind of ["lorebook", "note"] as const) {
            test(`${kind}: Library and switcher ${suffix}`, async ({ page }, info) => {
              await page.goto(`${server().url}/library?kind=${kind}`)
              await page.getByRole("button", { name: `New ${kind}`, exact: true }).click()
              const dialog = page.getByRole("dialog", { name: `New ${kind}`, exact: true })
              await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled()
              await dialog.getByLabel("Name", { exact: true }).fill("   ")
              await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled()
              await dialog.getByLabel("Name", { exact: true }).fill(`Library ${kind} ${suffix}`)
              await expectLayout(page, info, `new-${kind}-${suffix}`, { scope: '[role="dialog"]' })
              await dialog.screenshot({ path: info.outputPath(`new-${kind}.png`) })
              await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
              expect(
                (await admin((api) => api.ListLibrary({ kind }))).some(
                  (ref) => ref.label === `Library ${kind} ${suffix}`
                )
              ).toBe(false)
              await page.getByRole("button", { name: `New ${kind}`, exact: true }).click()
              await dialog.getByLabel("Name", { exact: true }).fill(`Library ${kind} ${suffix}`)
              await dialog.getByRole("button", { name: "Create", exact: true }).click()
              await expect(dialog).toHaveCount(0)
              const first = (await admin((api) => api.ListLibrary({ kind }))).find(
                (ref) => ref.label === `Library ${kind} ${suffix}`
              )!
              await expect(page).toHaveURL(new RegExp(`/library/${first.id}`))
              await page.reload()
              await expect(page.getByRole("button", { name: `Switch ${kind}`, exact: true })).toContainText(first.label)
              await page.getByRole("button", { name: `Switch ${kind}`, exact: true }).click()
              await page.getByRole("button", { name: `New ${kind}…`, exact: true }).click()
              await expect(dialog).toBeVisible()
              await dialog.getByLabel("Name", { exact: true }).fill(`Switcher ${kind} ${suffix}`)
              await dialog.getByRole("button", { name: "Create", exact: true }).click()
              await expect(page.getByRole("button", { name: `Switch ${kind}`, exact: true })).toContainText(
                `Switcher ${kind} ${suffix}`
              )
              const made = (await admin((api) => api.ListLibrary({ kind }))).find(
                (ref) => ref.label === `Switcher ${kind} ${suffix}`
              )!
              const opened = await admin((api) => api.OpenEditor({ refId: made.id }))
              if (kind === "lorebook") expect(opened.doc["entries"]).toEqual([])
              else expect(opened.doc["owner"]).toEqual({ shared: "global" })
            })
          }
          test(`persona: lists, picture and switcher ${suffix}`, async ({ page }, info) => {
            await page.goto(`${server().url}/library?show=personas`)
            await page.getByRole("button", { name: "New persona", exact: true }).click()
            const dialog = page.getByRole("dialog", { name: "New persona", exact: true })
            await dialog.getByLabel("Name", { exact: true }).fill(`Persona ${suffix}`)
            await dialog.getByLabel("Description", { exact: true }).fill("A synthetic lighthouse keeper.")
            await dialog
              .getByLabel("Picture", { exact: true })
              .setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: portraitPng() })
            await expectLayout(page, info, `new-persona-${suffix}`, { scope: '[role="dialog"]' })
            await dialog.screenshot({ path: info.outputPath("new-persona.png") })
            await dialog.getByRole("button", { name: "Create", exact: true }).click()
            await expect(dialog).toHaveCount(0)
            const cards = await admin((api) => api.ListCards())
            const made = cards.find((card) => card.label === `Persona ${suffix}`)!
            expect(made.persona).toBe(true)
            expect(made.avatarMediaId).not.toBeNull()
            const ref = (await admin((api) => api.ListLibrary({ kind: "card" }))).find(
              (ref) => ref.entityId === made.entityId
            )!
            expect((await admin((api) => api.OpenEditor({ refId: ref.id }))).doc["description"]).toBe(
              "A synthetic lighthouse keeper."
            )
            await expect(page.getByRole("button", { name: "Switch persona", exact: true })).toBeVisible()
            await page.getByRole("button", { name: "Switch persona", exact: true }).click()
            await page.getByRole("button", { name: "New persona…", exact: true }).click()
            await dialog.getByLabel("Name", { exact: true }).fill(`Second persona ${suffix}`)
            await dialog.getByRole("button", { name: "Create", exact: true }).click()
            await expect(page.getByRole("button", { name: "Switch persona", exact: true })).toContainText(
              `Second persona ${suffix}`
            )
            await page.goto(`${server().url}/?show=personas`)
            await expect(
              page.getByRole("button", { name: "New persona", exact: true }).filter({ visible: true }).first()
            ).toBeVisible()
            await expectLayout(page, info, `personas-home-${suffix}`, { scope: "main" })
            await page
              .getByRole("button", { name: "New persona", exact: true })
              .filter({ visible: true })
              .first()
              .click()
            await expect(dialog).toBeVisible()
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
            const { chat } = await admin((api) =>
              Effect.gen(function* () {
                const card = yield* api.CreateCard({ label: `Persona chat ${suffix}`, name: `Persona chat ${suffix}` })
                return yield* api.StartChat({
                  cards: [card.entityId],
                  persona: null,
                  greeting: null,
                  first: { _tag: "Send", content: "Synthetic hello.", speakerEntityId: null }
                })
              })
            )
            await page.goto(`${server().url}/chats/${chat.id}`)
            const cast = await openPanel(page, "Cast")
            await cast.getByRole("button", { name: /Change your persona/ }).click()
            await page.getByRole("button", { name: "New persona…", exact: true }).click()
            await expect(dialog).toBeVisible()
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
          })
          test(`lorebook: chat and preset attachment ${suffix}`, async ({ page }, info) => {
            const { chat, preset } = await admin((api) =>
              Effect.gen(function* () {
                const card = yield* api.CreateCard({ label: `Attach card ${suffix}`, name: `Attach card ${suffix}` })
                const preset = yield* api.CreatePreset({ label: `Attach preset ${suffix}` })
                const { chat } = yield* api.StartChat({
                  cards: [card.entityId],
                  persona: null,
                  greeting: 0,
                  first: { _tag: "Send", content: "Synthetic hello.", speakerEntityId: null }
                })
                return { chat, preset }
              })
            )
            await page.goto(`${server().url}/chats/${chat.id}`)
            const tab = await openPanel(page, "Lorebooks")
            await tab.getByRole("button", { name: "Add a lorebook", exact: true }).click()
            await tab.getByRole("button", { name: "New lorebook…", exact: true }).click()
            const dialog = page.getByRole("dialog", { name: "New lorebook", exact: true })
            await dialog.getByLabel("Name", { exact: true }).fill(`Chat book ${suffix}`)
            await expectLayout(page, info, `attach-chat-${suffix}`, {
              scope: '[role="dialog"][data-layout-overlay="Modal dialog covers the page"]'
            })
            await dialog.getByRole("button", { name: "Create", exact: true }).click()
            await expect(dialog).toHaveCount(0)
            await expect(tab.getByRole("button", { name: "Add entry", exact: true })).toBeVisible()
            const book = (await admin((api) => api.ListLibrary({ kind: "lorebook" }))).find(
              (ref) => ref.label === `Chat book ${suffix}`
            )!
            await page.reload()
            await openPanel(page, "Lorebooks")
            await expect(tab.getByRole("switch", { name: `Chat book ${suffix}`, exact: true })).toBeChecked()
            await page.goto(`${server().url}/library/${preset.id}`)
            await page.getByRole("button", { name: "Attach a lorebook", exact: true }).click()
            await page.getByRole("button", { name: "New lorebook…", exact: true }).click()
            await dialog.getByLabel("Name", { exact: true }).fill(`Preset book ${suffix}`)
            await expectLayout(page, info, `attach-preset-${suffix}`, { scope: '[role="dialog"]' })
            await dialog.getByRole("button", { name: "Create", exact: true }).click()
            await expect(dialog).toHaveCount(0)
            await expect(page.getByRole("button", { name: "Switch lorebook", exact: true })).toContainText(
              `Preset book ${suffix}`
            )
            await page.goto(`${server().url}/library/${preset.id}`)
            await expect(page.getByRole("switch", { name: `Preset book ${suffix}`, exact: true })).toBeChecked()
            // Existing preset attachment behavior: the new attachment waits for Save.
            await page.getByRole("button", { name: "Save", exact: true }).first().click()
            const saved = await admin((api) => api.OpenEditor({ refId: preset.id }))
            expect(saved.doc["lorebooks"]).toEqual(expect.arrayContaining([expect.objectContaining({ enabled: true })]))
            expect(book.kind).toBe("lorebook")
            await admin((api) => api.ChangeGenerationDefaults({ change: { preset: preset.id } }))
            await page.goto(`${server().url}/chats/${chat.id}`)
            const panel = await openPanel(page, "Prompt preset")
            await panel.getByRole("button", { name: "Attach a lorebook", exact: true }).click()
            await panel.getByRole("button", { name: "New lorebook…", exact: true }).click()
            await dialog.getByLabel("Name", { exact: true }).fill(`Panel preset book ${suffix}`)
            await expectLayout(page, info, `attach-panel-preset-${suffix}`, {
              scope: '[role="dialog"][data-layout-overlay="Modal dialog covers the page"]'
            })
            await dialog.getByRole("button", { name: "Create", exact: true }).click()
            await expect(dialog).toHaveCount(0)
            await expect(page.getByRole("button", { name: "Switch lorebook", exact: true })).toContainText(
              `Panel preset book ${suffix}`
            )
            await page.goto(`${server().url}/library/${preset.id}`)
            await expect(page.getByRole("switch", { name: `Panel preset book ${suffix}`, exact: true })).toBeChecked()
          })
          test(`sorts: account memory after browser storage is cleared ${suffix}`, async ({ page }) => {
            const { chat } = await admin((api) =>
              Effect.gen(function* () {
                const card = yield* api.CreateCard({ label: `Sort card ${suffix}`, name: `Sort card ${suffix}` })
                return yield* api.StartChat({
                  cards: [card.entityId],
                  persona: null,
                  greeting: null,
                  first: { _tag: "Send", content: "Synthetic hello.", speakerEntityId: null }
                })
              })
            )
            await admin((api) =>
              api.SetDisplayPrefs({
                prefs: {
                  homeCards: { sort: "name", reversed: true, withPersonas: false },
                  sidebarCards: { sort: "added", reversed: false, withPersonas: false },
                  castCards: { sort: "created", reversed: true, withPersonas: false }
                }
              })
            )
            await page.goto(server().url)
            await page.evaluate(() => localStorage.clear())
            await page.goto(`${server().url}/?fresh=${width}-${theme}`)
            const home = page.locator("[data-card-grid-controls]")
            await expect(home.getByRole("button", { name: "Name", exact: true })).toHaveAttribute(
              "aria-pressed",
              "true"
            )
            await expect(home.getByRole("button", { name: "Order: Z to A", exact: true })).toBeVisible()
            await home.getByRole("button", { name: "Added", exact: true }).click()
            await expect.poll(async () => (await admin((api) => api.GetDisplayPrefs({}))).homeCards.sort).toBe("added")
            await page.goto(`${server().url}/?fresh=again-${width}-${theme}`)
            await expect(home.getByRole("button", { name: "Added", exact: true })).toHaveAttribute(
              "aria-pressed",
              "true"
            )
            await showAppNavigation(page)
            await page
              .getByRole("group", { name: "Left panel", exact: true })
              .getByRole("button", { name: "Characters", exact: true })
              .click()
            await expect(page.getByRole("button", { name: "Sort by: Added", exact: true })).toBeVisible()
            await page.getByRole("button", { name: "Sort by: Added", exact: true }).click()
            await page.getByRole("menuitemcheckbox", { name: "Name", exact: true }).click()
            await expect
              .poll(async () => (await admin((api) => api.GetDisplayPrefs({}))).sidebarCards.sort)
              .toBe("name")
            await hideAppNavigation(page)
            await page.goto(`${server().url}/chats/${chat.id}`)
            const cast = await openPanel(page, "Cast")
            await cast.getByRole("button", { name: "Add characters", exact: true }).click()
            const adding = cast.getByRole("region", { name: "Add characters", exact: true })
            await expect(adding.getByRole("button", { name: "Sort by: Created", exact: true })).toBeVisible()
            await expect(adding.getByRole("button", { name: "Order: Oldest first", exact: true })).toBeVisible()
            await adding.getByRole("button", { name: "Sort by: Created", exact: true }).click()
            await page.getByRole("menuitemcheckbox", { name: "Name", exact: true }).click()
            await expect.poll(async () => (await admin((api) => api.GetDisplayPrefs({}))).castCards.sort).toBe("name")
            const prefs = await admin((api) => api.GetDisplayPrefs({}))
            expect(prefs.sidebarCards.sort).toBe("name")
            expect(prefs.castCards.sort).toBe("name")
          })
        })
      }
  })
}
