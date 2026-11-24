import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { closePanel, openPanel } from "./support/panel.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
test.setTimeout(180_000)
let cookie = ""
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`creating a pending chat's persona selects it and opens its editor at ${width} ${theme}`, async ({
      page
    }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const card = await admin((api) =>
        Effect.gen(function* () {
          // Each case starts with no personas, including no default.
          yield* api.ChangeGenerationDefaults({ change: { persona: null } })
          for (const card of yield* api.ListCards())
            if (card.persona) yield* api.SetPersona({ entityId: card.entityId, persona: false })
          return yield* api.CreateCard({ label: `Host ${width} ${theme}`, name: `Host ${width} ${theme}` })
        })
      )
      await page.goto(`${server().url}/cards/${card.entityId}/chat`)
      const speaker = page.getByRole("button", { name: /^Speaking as / })
      await expect(speaker).toHaveAccessibleName(/^Speaking as You\b/)
      await speaker.click()
      await expect(page.getByRole("group", { name: "Your persona", exact: true })).toContainText(
        "No cards in the persona folder."
      )
      await page.screenshot({ path: info.outputPath("pending-no-personas.png") })
      await page.getByRole("button", { name: "New persona…", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "New persona", exact: true })
      const name = `New keeper ${width} ${theme}`
      await dialog.getByLabel("Display name", { exact: true }).fill(name)
      await dialog.getByLabel("In-chat nickname", { exact: true }).fill("Keeper")
      await dialog.getByLabel("Version", { exact: true }).fill("v1")
      await page.screenshot({ path: info.outputPath("pending-new-persona.png") })
      await dialog.getByRole("button", { name: "Create", exact: true }).click()
      await expect(dialog).toHaveCount(0)
      const editor = page.getByRole("tabpanel", { name, exact: true })
      await expect(editor.locator('.cm-content[aria-label="Description"]')).toBeVisible()
      await expect(editor.getByRole("button", { name: "Picture", exact: true }).first()).toBeVisible()
      await page.screenshot({ path: info.outputPath("pending-persona-editor.png") })
      // The Cast selector has its own cast context; creation there must reveal the editor too.
      const cast = await openPanel(page, "Cast")
      await cast.getByRole("button", { name: /Change your persona/ }).click()
      await page.getByRole("button", { name: "New persona…", exact: true }).click()
      const secondName = `Second keeper ${width} ${theme}`
      await dialog.getByLabel("Display name", { exact: true }).fill(secondName)
      await dialog.getByRole("button", { name: "Create", exact: true }).click()
      await expect(
        page.getByRole("tabpanel", { name: secondName, exact: true }).locator('.cm-content[aria-label="Description"]')
      ).toBeVisible()
      await page.screenshot({ path: info.outputPath("pending-cast-persona-editor.png") })
      if (width === 390) await closePanel(page)
      await expect(speaker).toHaveAccessibleName(new RegExp(`^Speaking as ${secondName}\\b`))
      await speaker.click()
      await expect(
        page.getByRole("group", { name: "Your persona", exact: true }).getByRole("option", { name: secondName })
      ).toHaveAttribute("aria-current", "true")
      await page.keyboard.press("Escape")
      await page.getByLabel("Message", { exact: true }).fill("The new keeper arrives.")
      await page.getByRole("button", { name: /^Send(?: as .+)?$/ }).click()
      await expect(page).toHaveURL(/\/chats\//)
      const created = (await admin((api) => api.ListCards())).find((card) => card.name === secondName)!
      const chatId = new URL(page.url()).pathname.split("/")[2] as import("@dreamspan/shared/chat.ts").ChatId
      expect((await admin((api) => api.GetCast({ chatId, slotId: null }))).playedByMe).toEqual([created.entityId])
      expect((await admin((api) => api.GetGenerationDefaults())).persona).toBeNull()
      await openPanel(page, "Cast")
      await expect(page.getByRole("button", { name: /Change your persona/ })).toHaveAccessibleName(
        new RegExp(`^Playing as ${secondName}\\b`)
      )
    })
