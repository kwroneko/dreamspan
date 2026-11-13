// Resume beside a failed plain reply (spec/AGENTIC.md §12.6): the error box has a Resume
// button, explained on hover, which writes the reply again as a new version, since the failed
// one has no text to continue. Layout audit on the message at 1440 and 390, light and dark.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { PLAIN_REPLY, startAgentProvider } from "./support/agentProvider.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: Awaited<ReturnType<typeof startAgentProvider>>
test.beforeAll(async () => {
  provider = await startAgentProvider()
})
test.afterAll(async () => {
  await provider.stop()
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a failed plain reply resumes from the button beside its error at ${width} ${theme}`, async ({
      page
    }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Synthetic",
              baseUrl: provider.baseUrl,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            }
          })
          const model = yield* api.AddUserModel({ connectionId: connection.id, key: "agent-small", overrides: {} })
          yield* api.SetGenerationDefaults({
            defaults: { model: { connection: connection.id, model: model.id }, preset: null }
          })
          const chat = yield* api.CreateChat({ title: `Plain resume ${width} ${theme}` })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "Is it still raining?"
          })
          if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
          return chat
        })
      )
      await page.goto(`${server().url}/chats/${chat.id}`)
      await expect(page.getByTestId("messages").getByText("Is it still raining?")).toBeVisible()
      provider.failPlain()
      await page
        .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
        .last()
        .click()
      const failed = page.getByRole("article").last()
      const box = failed.getByRole("note").filter({ hasText: /^Failed \(/ })
      await expect(box).toBeVisible()
      const resume = box.getByRole("button", { name: "Resume", exact: true })
      await expect(resume).toBeVisible()
      await resume.hover()
      await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
        "Carries this reply on from where it stopped"
      )
      const shots = process.env.SCREENSHOT_DIR
      if (shots) {
        mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: resolve(shots, `plain-failed-${width}-${theme}.png`), animations: "disabled" })
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expectLayout(page, info, `plain-failed-${width}-${theme}`, { scope: "article:last-of-type" })
      await resume.click()
      await expect(failed).toContainText(PLAIN_REPLY)
      await expect(failed.getByText(/^Failed \(/)).toHaveCount(0)
    })
