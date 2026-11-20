// A real-use regression: wrapping a registered link in a Tooltip made the request
// action an empty menu row and an empty pinned button. Use a synthetic provider.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { messageMenu, showActions } from "./support/message.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { REPLY, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

for (const width of [1440, 390])
  test(`the request action has a label and opens stopped and completed replies at ${width}px`, async ({
    page
  }, info) => {
    const provider = await startProvider({ holdAfterText: true })
    try {
      const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Synthetic request action",
              baseUrl: provider.baseUrl,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            }
          })
          const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
          yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: model.id } } })
          yield* api.SetDisplayPrefs({ prefs: { messageToolbar: { "message.context": false } } })
          return yield* api.CreateChat({ title: `Request action ${width}` })
        })
      )
      await page.setViewportSize({ width, height: 900 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chat.id}`)
      await page.getByRole("button", { name: "Generate", exact: true }).click()
      const reply = page.getByRole("article").last()
      await expect(reply.locator(".markdown").last()).toHaveText(REPLY)
      await reply.getByRole("button", { name: "Stop", exact: true }).click()
      await expect(reply.getByText("stopped", { exact: true })).toBeVisible()

      const label = "Open request inspector"
      if (process.env.LAYOUT_AUDIT) {
        await showActions(reply)
        await reply.getByRole("button", { name: "More actions", exact: true }).click()
        await expectLayout(page, info, `request-menu-${width}`, { scope: '[role="menu"]' })
        await page.keyboard.press("Escape")
      }
      await messageMenu(reply, label)
      await expect(page).toHaveURL(/\/context\//)
      await expect(page.getByRole("region", { name: "Messages", exact: true })).toBeVisible()
      await page.goto(`${server().url}/chats/${chat.id}`)

      // Pinning uses the same registered link and must retain its accessible label,
      // navigation target and explanation as the reply finishes naturally too.
      provider.release()
      await showActions(reply)
      await reply.getByRole("button", { name: "Generate another version", exact: true }).click()
      await expect(reply.getByRole("button", { name: /Version 2 of 2/ })).toBeVisible()
      await expect(reply.getByText("generating", { exact: true })).toHaveCount(0)
      await showActions(reply)
      await reply.getByRole("button", { name: "More actions", exact: true }).click()
      await page.getByRole("menuitemcheckbox", { name: `Show ${label} on the message`, exact: true }).click()
      await page.keyboard.press("Escape")
      await showActions(reply)
      const link = reply.getByRole("link", { name: label, exact: true })
      await expect(link).toBeVisible()
      if (process.env.LAYOUT_AUDIT)
        await expectLayout(page, info, `request-toolbar-${width}`, {
          scope: '[role="toolbar"][aria-label="Message actions"]'
        })
      await link.hover()
      await expect(
        page.getByText("Shows everything the model was sent for this version, and where each part came from.", {
          exact: true
        })
      ).toBeVisible()
      await link.click()
      await expect(page).toHaveURL(/\/context\//)
      await expect(page.getByRole("region", { name: "Messages", exact: true })).toBeVisible()
    } finally {
      await provider.stop()
    }
  })
