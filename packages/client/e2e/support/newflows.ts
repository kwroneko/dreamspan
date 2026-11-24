// Synthetic creation flows. The same measurements run in the focused layout audit.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./layoutAudit.ts"
import { openPanel } from "./panel.ts"
import { showAppNavigation, hideAppNavigation } from "./appMenu.ts"
import { loginCookie, withCookie } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { saveRevision } from "./saveRevision.ts"

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
          test(`persona: New card's form, the card editor and the chat's persona ${suffix}`, async ({ page }, info) => {
            // A persona is a card (owner, 2026-11-07): New card's form, then the card editor.
            const newCardForm = async (dialog: Locator) => {
              for (const label of ["Display name", "In-chat nickname", "Version"])
                await expect(dialog.getByLabel(label, { exact: true })).toBeVisible()
              await expect(dialog.getByLabel("Description", { exact: true })).toHaveCount(0)
              await expect(dialog.getByLabel("Picture", { exact: true })).toHaveCount(0)
              await expect(dialog.locator('input[type="file"]')).toHaveCount(0)
            }
            const cardEditor = async (scope: Locator | Page) => {
              await expect(scope.getByRole("button", { name: "Picture", exact: true }).first()).toBeVisible({
                timeout: 30_000
              })
              await expect(scope.locator('.cm-content[aria-label="Description"]')).toBeVisible()
            }
            await page.goto(`${server().url}/library?show=personas`)
            await page.getByRole("button", { name: "New persona", exact: true }).click()
            const dialog = page.getByRole("dialog", { name: "New persona", exact: true })
            await newCardForm(dialog)
            await dialog.getByLabel("Display name", { exact: true }).fill(`Persona ${suffix}`)
            await dialog.getByLabel("In-chat nickname", { exact: true }).fill(`Keeper ${suffix}`)
            await dialog.getByLabel("Version", { exact: true }).fill("v1")
            await expectLayout(page, info, `new-persona-${suffix}`, { scope: '[role="dialog"]' })
            await dialog.screenshot({ path: info.outputPath("new-persona.png") })
            await dialog.getByRole("button", { name: "Create", exact: true }).click()
            await expect(dialog).toHaveCount(0)
            const made = (await admin((api) => api.ListCards())).find((card) => card.label === `Persona ${suffix}`)!
            expect(made.persona).toBe(true)
            expect(made.modelName).toBe(`Keeper ${suffix}`)
            expect(made.subtitle).toBe("v1")
            const ref = (await admin((api) => api.ListLibrary({ kind: "card" }))).find(
              (ref) => ref.entityId === made.entityId
            )!
            await expect(page).toHaveURL(new RegExp(`/library/${ref.id}`))
            await cardEditor(page)
            await expect(page.getByRole("button", { name: "Switch persona", exact: true })).toBeVisible()
            await page.getByRole("button", { name: "Switch persona", exact: true }).click()
            await page.getByRole("button", { name: "New persona…", exact: true }).click()
            await newCardForm(dialog)
            await dialog.getByLabel("Display name", { exact: true }).fill(`Second persona ${suffix}`)
            await dialog.getByRole("button", { name: "Create", exact: true }).click()
            await expect(page.getByRole("button", { name: "Switch persona", exact: true })).toContainText(
              `Second persona ${suffix}`
            )
            await page.goto(`${server().url}/?show=personas`)
            // The Personas tab is a list, not a creation page: no New persona row under its search
            // (owner, 2026-11-23), on Home or in the left panel.
            await expect(
              page
                .getByRole("main")
                .getByRole("link", { name: /^Open Persona / })
                .first()
            ).toBeVisible()
            await expect(page.getByRole("button", { name: "New persona", exact: true })).toHaveCount(0)
            await expectLayout(page, info, `personas-home-${suffix}`, { scope: "main" })
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
            await newCardForm(dialog)
            await dialog.getByLabel("Display name", { exact: true }).fill(`Chat persona ${suffix}`)
            await expectLayout(page, info, `new-persona-chat-${suffix}`, {
              scope: '[role="dialog"][data-layout-overlay="Modal dialog covers the page"]'
            })
            await dialog.screenshot({ path: info.outputPath("new-persona-chat.png") })
            await dialog.getByRole("button", { name: "Create", exact: true }).click()
            await expect(dialog).toHaveCount(0)
            // It opens in the card editor in the side panel, and the chat plays it.
            const tab = page.getByRole("tabpanel", { name: `Chat persona ${suffix}`, exact: true })
            await cardEditor(tab)
            await page.screenshot({ path: info.outputPath("persona-in-panel.png") })
            const played = (await admin((api) => api.ListCards())).find(
              (card) => card.label === `Chat persona ${suffix}`
            )!
            expect(played.persona).toBe(true)
            await openPanel(page, "Cast")
            await expect(cast.getByRole("button", { name: /Change your persona/ })).toHaveAccessibleName(
              new RegExp(`Playing as Chat persona ${suffix}`)
            )
            await cast.getByRole("button", { name: /Change your persona/ }).click()
            await expect(
              page.getByRole("tabpanel", { name: "Personas", exact: true }).getByText(`Chat persona ${suffix}`, {
                exact: true
              })
            ).toBeVisible()
          })
          test(`lorebook: chat and preset attachment ${suffix}`, async ({ page }, info) => {
            // A click starts Save; it doesn't wait for its draft flush or revision write.
            // Hold the revision so the post-save assertion cannot depend on server speed.
            let holdCommit = true
            const heldCommits: Array<() => void> = []
            await page.routeWebSocket(/\/rpc$/, (socket) => {
              const upstream = socket.connectToServer()
              socket.onMessage((data) => {
                if (holdCommit && typeof data === "string" && data.includes('"CommitEditorDrafts"'))
                  heldCommits.push(() => upstream.send(data))
                else upstream.send(data)
              })
              upstream.onMessage((data) => socket.send(data))
            })
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
            const saving = saveRevision(page)
            await expect.poll(() => heldCommits.length).toBe(1)
            const beforeCommit = await admin((api) => api.OpenEditor({ refId: preset.id }))
            expect(beforeCommit.doc["lorebooks"]).toBeUndefined()
            holdCommit = false
            for (const send of heldCommits) send()
            await saving
            const saved = await admin((api) => api.OpenEditor({ refId: preset.id }))
            expect(saved.doc["lorebooks"]).toEqual(expect.arrayContaining([expect.objectContaining({ enabled: true })]))
            await page.reload()
            await expect(page.getByRole("switch", { name: `Preset book ${suffix}`, exact: true })).toBeChecked()
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
          test(`sorts: each place's in this tab's URL, carried, and no other page follows ${suffix}`, async ({
            page
          }) => {
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
            const param = (key: string) => new URL(page.url()).searchParams.get(key)
            await page.goto(`${server().url}/?fresh=${width}-${theme}`)
            const home = page.locator("[data-card-grid-controls]")
            await home.getByRole("button", { name: "Added", exact: true }).click()
            await expect.poll(() => param("sort")).toBe("added")
            await showAppNavigation(page)
            await page
              .getByRole("group", { name: "Left panel", exact: true })
              .getByRole("button", { name: "Characters", exact: true })
              .click()
            await page.getByRole("button", { name: "Sort by: Recent", exact: true }).click()
            await page.getByRole("menuitemcheckbox", { name: "Name", exact: true }).click()
            await expect.poll(() => param("sideSort")).toBe("name")
            await hideAppNavigation(page)
            // Into a chat in this tab: the left panel's sort comes along.
            await page.evaluate((href) => {
              const a = Object.assign(document.createElement("a"), { href })
              document.body.append(a)
              a.click()
              a.remove()
            }, `/chats/${chat.id}`)
            await expect.poll(() => new URL(page.url()).pathname).toBe(`/chats/${chat.id}`)
            await expect.poll(() => param("sideSort")).toBe("name")
            const cast = await openPanel(page, "Cast")
            await cast.getByRole("button", { name: "Add characters", exact: true }).click()
            const adding = cast.getByRole("region", { name: "Add characters", exact: true })
            await adding.getByRole("button", { name: "Sort by: Recent", exact: true }).click()
            await page.getByRole("menuitemcheckbox", { name: "Name", exact: true }).click()
            await expect.poll(() => param("csort")).toBe("name")
            await page.reload()
            await expect(
              (await openPanel(page, "Cast"))
                .getByRole("region", { name: "Add characters", exact: true })
                .getByRole("button", { name: "Sort by: Name", exact: true })
            ).toBeVisible()
            // Another page of this browser: every sort at its default.
            const other = await page.context().newPage()
            await other.goto(`${server().url}/chats/${chat.id}`)
            const otherCast = await openPanel(other, "Cast")
            await otherCast.getByRole("button", { name: "Add characters", exact: true }).click()
            await expect(
              otherCast
                .getByRole("region", { name: "Add characters", exact: true })
                .getByRole("button", { name: "Sort by: Recent", exact: true })
            ).toBeVisible()
            expect(new URL(other.url()).searchParams.get("sideSort")).toBeNull()
            await other.close()
          })
        })
      }
  })
}
