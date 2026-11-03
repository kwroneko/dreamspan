import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { openSummarySettings } from "./support/panel.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
let cookie: string
let preset: RefId
const rpc = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  preset = await rpc((api) => Effect.map(api.CreatePreset({ label: "Story summaries" }), (ref) => ref.id))
})

for (const width of [390, 1024, 1440])
  for (const theme of ["light", "dark"] as const)
    test(`specific summary preset and field history at ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const chatId = await rpc((api) =>
        Effect.gen(function* () {
          yield* api.SetRefArchived({ refId: preset, archived: false })
          yield* api.ChangeGenerationDefaults({ change: { lcm: { withPreset: "current", preset: null } } })
          const card = yield* api.CreateCard({ label: "Summary fixture", name: "Summary fixture" })
          const started = yield* api.StartChat({
            cards: [card.entityId],
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "A synthetic story begins.", speakerEntityId: null }
          })
          return started.chat.id
        })
      )
      await page.goto(`${server().url}/chats/${chatId}`)
      let section = await openSummarySettings(page)
      await expect(section.getByRole("button", { name: "Preset for summaries", exact: true })).toHaveCount(0)
      await section.getByRole("button", { name: "A specific preset", exact: true }).click()
      const picker = section.getByRole("button", { name: "Preset for summaries", exact: true })
      await expect(picker).toBeVisible()
      const open = section.getByRole("button", { name: "Open this preset in the large editor", exact: true })
      await expect(open).toBeVisible()
      await expect(open).toBeDisabled()
      await picker.click()
      await page.getByRole("radio", { name: "Story summaries", exact: true }).click()
      await expect(picker).toContainText("Story summaries")
      await expect(open).toBeEnabled()
      const history = section.getByRole("button", { name: "Undo / history", exact: true })
      await expect(history).toHaveCount(1)
      await expect(
        section.locator("[data-field-chrome]").getByRole("button", { name: "Undo / history", exact: true })
      ).toHaveCount(1)
      await expectLayout(page, info, `summary-chat-${width}-${theme}`, {
        scope: 'section[aria-label="Summary settings"]'
      })
      await info.attach("Summary settings", { body: await section.screenshot(), contentType: "image/png" })
      await open.click()
      await expect(page.getByRole("dialog", { name: "Preset editor", exact: true })).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`editor=${preset}`))
      await page.reload()
      await expect(page.getByRole("dialog", { name: "Preset editor", exact: true })).toBeVisible()
      // The account default has the same picker and large editor, with history inside its field.
      await page.goto(`${server().url}/settings/chats`)
      const defaults = page.getByRole("region", { name: "Summary defaults for new chats" })
      await defaults.getByRole("button", { name: "A specific preset", exact: true }).click()
      await defaults.getByRole("button", { name: "Preset for summaries", exact: true }).click()
      await page.getByRole("radio", { name: "Story summaries", exact: true }).click()
      await expect(defaults.getByRole("button", { name: "Preset for summaries", exact: true })).toContainText(
        "Story summaries"
      )
      await expect(
        page
          .getByRole("region", { name: "Models for summaries" })
          .locator("[data-field-chrome]")
          .getByRole("button", { name: "Undo / history", exact: true })
      ).toHaveCount(1)
      await expectLayout(page, info, `summary-account-${width}-${theme}`, {
        scope: 'section[aria-label="Models for summaries"], section[aria-label="Summary defaults for new chats"]'
      })
      await info.attach("Summary defaults", { body: await page.screenshot(), contentType: "image/png" })
      await defaults.getByRole("button", { name: "Open this preset in the large editor", exact: true }).click()
      await expect(page.getByRole("dialog", { name: "Preset editor", exact: true })).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`editor=${preset}`))
      // An archived choice stays selected and warns, while summary assembly falls back.
      await rpc((api) => api.SetRefArchived({ refId: preset, archived: true }))
      await page.goto(`${server().url}/chats/${chatId}`)
      section = await openSummarySettings(page)
      await expect(
        section.getByText("The chosen preset is no longer available; summaries use your current preset.", {
          exact: true
        })
      ).toBeVisible()
      await expect(
        section.getByRole("button", { name: "Open this preset in the large editor", exact: true })
      ).toBeDisabled()
      const settings = await rpc((api) => api.GetLcmSettings({ chatId: chatId as ChatId, leafSlotId: null }))
      expect(settings.resolved.withPreset).toBe("specific")
      expect(settings.resolved.preset).toBe(preset)
    })
