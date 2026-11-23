// Two cards with the same name in one chat, told apart by their versions (CardVersion.tsx; audit
// item 016, CARD-FORKS surface 5): the Cast tab's rows and the composer's Speak as list show
// each card's version under its name, and a card without one shows none, at 1440 and 390 in
// light and dark, with the layout audit of both.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let chatId = ""

test.beforeAll(async () => {
  chatId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({
        prefs: { chatDensity: process.env.STACK_DENSITY === "compact" ? "compact" : "comfortable" }
      })
      const summer = yield* api.CreateCard({ label: "Mira", name: "Mira", version: "Summer coast" })
      const winter = yield* api.CreateCard({ label: "Mira", name: "Mira", version: "Winter keep" })
      const tobin = yield* api.CreateCard({ label: "Tobin", name: "Tobin" })
      const ana = yield* api.CreateCard({ label: "Ana", name: "Ana", version: "Traveller" })
      yield* api.SetPersona({ entityId: ana.entityId, persona: true })
      const chat = yield* api.CreateChat({ title: "Two Miras" })
      for (const id of [summer.entityId, winter.entityId, tobin.entityId, ana.entityId])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: id } })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "PlayedByMe", entityIds: [ana.entityId] }
      })
      return chat.id
    })
  )
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`same-named cards show their versions at ${width} in ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)

      const cast = await openPanel(page, "Cast")
      const tabs = page.getByRole("tablist", { name: "Characters", exact: true })
      await expect(tabs.getByRole("tab", { name: "Mira · Summer coast", exact: true })).toHaveCount(1)
      await expect(tabs.getByRole("tab", { name: "Mira · Winter keep", exact: true })).toHaveCount(1)
      for (const version of ["Summer coast", "Winter keep"]) {
        const tab = tabs.getByRole("tab", { name: `Mira · ${version}`, exact: true })
        await tab.scrollIntoViewIfNeeded()
        await expect(tab.getByText(`Mira · ${version}`, { exact: true })).not.toHaveClass(/sr-only/)
      }
      const characters = cast.getByRole("list", { name: "Characters in this chat", exact: true })
      const miras = characters.getByRole("listitem", { name: "Mira", exact: true })
      await expect(miras).toHaveCount(2)
      await expect(miras.locator("[data-card-version]")).toHaveText(["Summer coast", "Winter keep"])
      await expect(
        characters.getByRole("listitem", { name: "Tobin", exact: true }).locator("[data-card-version]")
      ).toHaveCount(0)
      await expect(cast.getByRole("group", { name: "Your persona" }).locator("[data-card-version]")).toHaveText(
        "Traveller"
      )
      await expectLayout(page, info, `cast-versions-${width}-${theme}`, { scope: '[role="tabpanel"]' })
      await expectLayout(page, info, `cast-tabs-${width}-${theme}`, { scope: "[data-chat-panel-tabs]" })
      await page.screenshot({ path: info.outputPath(`cast-${width}-${theme}.png`) })
      if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).first().click()

      await page.getByRole("button", { name: /^Next:.*Choose who replies next/ }).click()
      await expect(page.getByRole("radio", { name: "Mira · Summer coast", exact: true })).toBeVisible()
      await expect(page.getByRole("radio", { name: "Mira · Winter keep", exact: true })).toBeVisible()
      await expectLayout(page, info, `next-versions-${width}-${theme}`, { scope: '[role="dialog"]' })
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: /^Speaking as / }).click()
      const speakAs = page.getByRole("tabpanel", { name: "Speak as", exact: true })
      const options = speakAs.getByRole("option", { name: "Mira", exact: true })
      await expect(options).toHaveCount(2)
      await expect(options.locator("[data-card-version]")).toHaveText(["Summer coast", "Winter keep"])
      await expectLayout(page, info, `speak-as-versions-${width}-${theme}`, { scope: '[role="dialog"]' })
      await page.screenshot({ path: info.outputPath(`speak-as-${width}-${theme}.png`) })
    })
