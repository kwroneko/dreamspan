// The button beside a failed or stopped plain reply (spec/AGENTIC.md §12.6), named for what it
// does and explained on hover: Retry asks for the reply again when it has no text, Continue
// carries on text it stopped in. The button sits on the right of the box's text, or under it
// where the text needs the width. Layout audit on the message at 1440 and 390, light and dark.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Locator, test } from "@playwright/test"
import { Effect } from "effect"
import { PARTIAL_REPLY, PLAIN_REPLY, type PlainFailure, startAgentProvider } from "./support/agentProvider.ts"
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

const RETRY = { label: "Retry", hint: "Asks the model for this reply again" } as const
const CONTINUE = { label: "Continue", hint: "Continues the text it stopped in" } as const
const CASES: ReadonlyArray<{
  status: "failed" | "stopped" | "interrupted"
  partial: boolean
  fail?: PlainFailure
  label: string
  hint: string
}> = [
  { status: "failed", partial: false, ...RETRY },
  { status: "failed", partial: false, fail: "content_filter", ...RETRY },
  { status: "failed", partial: false, fail: "denied", ...RETRY },
  { status: "stopped", partial: false, ...RETRY },
  { status: "stopped", partial: true, ...CONTINUE },
  { status: "interrupted", partial: true, ...CONTINUE }
]

const BOX_TEXT = {
  failed: /^Failed \(/,
  stopped: "This reply was stopped.",
  interrupted: "The app stopped while this reply was being written."
} as const

/** The button is on the text's row, centred on it, or under it; either way on the box's right. */
const expectButtonPlacement = async (box: Locator, button: Locator) => {
  const text = (await box.locator("p").first().boundingBox())!
  const area = (await box.boundingBox())!
  const place = (await button.boundingBox())!
  expect(place.height).toBeGreaterThanOrEqual(32)
  expect(Math.abs(area.x + area.width - (place.x + place.width) - 12)).toBeLessThanOrEqual(2)
  const besideText = place.x >= text.x + text.width
  if (besideText) {
    const centre = (rect: { y: number; height: number }) => rect.y + rect.height / 2
    expect(Math.abs(centre(text) - centre(place))).toBeLessThanOrEqual(2)
  } else expect(place.y).toBeGreaterThanOrEqual(text.y + text.height)
  return besideText
}

for (const { status, partial, fail, label, hint } of CASES)
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`a ${status}${fail ? ` (${fail})` : ""} plain reply${partial ? " with text" : ""} offers ${label} at ${width} ${theme}`, async ({
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
        if (status === "failed") provider.failPlain(fail)
        else provider.holdPlain(partial)
        await page
          .getByRole("button", { name: /^(Reply$|Generate(?! another))/ })
          .last()
          .click()
        const failed = page.getByRole("article").last()
        if (status !== "failed") {
          await expect.poll(() => provider.heldCount()).toBeGreaterThan(0)
          if (partial) await expect(failed).toContainText(PARTIAL_REPLY)
        }
        if (status === "stopped") {
          await failed.getByRole("button", { name: "Stop", exact: true }).click()
          await expect(failed.getByText("stopped", { exact: true })).toBeVisible()
          provider.release()
        }
        if (status === "interrupted") {
          await server().restart()
          provider.release()
          await page.reload()
        }
        const box = page.getByRole("article").last().getByRole("note").filter({ hasText: BOX_TEXT[status] })
        await expect(box).toBeVisible()
        if (fail === "content_filter") await expect(box).toContainText("content_filter")
        if (fail === "denied") await expect(box).toContainText("synthetic-large-preview-2026-10-01")
        const resume = box.getByRole("button", { name: label, exact: true })
        await expect(resume).toBeVisible()
        await expect(box.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0)
        const beside = await expectButtonPlacement(box, resume)
        // A one-line notice keeps its button beside it on a wide screen.
        if (width === 1440 && fail !== "denied") expect(beside).toBe(true)
        // A message that just loaded may re-render under the pointer and close its tooltip: hover again.
        await expect(async () => {
          await page.mouse.move(0, 0)
          await resume.hover()
          await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(hint, {
            timeout: 3000
          })
        }).toPass()
        const shots = process.env.SCREENSHOT_DIR
        if (shots) {
          mkdirSync(shots, { recursive: true })
          await page.screenshot({
            path: resolve(shots, `plain-${status}${fail ? `-${fail}` : ""}-${label}-${width}-${theme}.png`),
            animations: "disabled"
          })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await expectLayout(page, info, `plain-${status}${fail ? `-${fail}` : ""}-${label}-${width}-${theme}`, {
          scope: "article:last-of-type"
        })
        await resume.click()
        await expect(page.getByRole("article").last()).toContainText(PLAIN_REPLY)
        await expect(failed.getByText(/^Failed \(/)).toHaveCount(0)
      })
