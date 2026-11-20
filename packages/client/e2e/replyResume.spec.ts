// The button beside a failed or stopped plain reply (spec/AGENTIC.md §12.6), named for what it
// does and explained on hover: Retry asks for the reply again when it has no text, Continue
// carries on text it stopped in. Layout audit on the message at 1440 and 390, light and dark.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { PARTIAL_REPLY, PLAIN_REPLY, startAgentProvider } from "./support/agentProvider.ts"
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

const CASES = [
  { status: "failed", partial: false, label: "Retry", hint: "Asks the model for this reply again" },
  { status: "stopped", partial: false, label: "Retry", hint: "Asks the model for this reply again" },
  { status: "stopped", partial: true, label: "Continue", hint: "Continues the text it stopped in" }
] as const

for (const { status, partial, label, hint } of CASES)
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`a ${status} plain reply${partial ? " with text" : ""} offers ${label} at ${width} ${theme}`, async ({
        page
      }, info) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
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
        if (status === "failed") provider.failPlain()
        else provider.holdPlain(partial)
        await page
          .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
          .last()
          .click()
        const failed = page.getByRole("article").last()
        if (status === "stopped") {
          await expect.poll(() => provider.heldCount()).toBeGreaterThan(0)
          if (partial) await expect(failed).toContainText(PARTIAL_REPLY)
          await failed.getByRole("button", { name: "Stop", exact: true }).click()
          await expect(failed.getByText("stopped", { exact: true })).toBeVisible()
          provider.release()
        }
        const box = failed
          .getByRole("note")
          .filter({ hasText: status === "failed" ? /^Failed \(/ : "This reply was stopped." })
        await expect(box).toBeVisible()
        const resume = box.getByRole("button", { name: label, exact: true })
        await expect(resume).toBeVisible()
        await expect(box.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0)
        await resume.hover()
        await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(hint)
        const shots = process.env.SCREENSHOT_DIR
        if (shots) {
          mkdirSync(shots, { recursive: true })
          await page.screenshot({
            path: resolve(shots, `plain-${status}-${label}-${width}-${theme}.png`),
            animations: "disabled"
          })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await expectLayout(page, info, `plain-${status}-${label}-${width}-${theme}`, { scope: "article:last-of-type" })
        await resume.click()
        await expect(failed).toContainText(PLAIN_REPLY)
        await expect(failed.getByText(/^Failed \(/)).toHaveCount(0)
      })
