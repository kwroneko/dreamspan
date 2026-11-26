import { expect, type Page, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { closePanel } from "./support/panel.ts"
import { chooseCustomServer, REPLY, startProvider } from "./support/provider.ts"
import { ADMIN, startServer, withAdmin } from "./support/server.ts"
import { writeStFolder } from "./support/stFiles.ts"

const story = "I found a compass under the bridge."
const jargon =
  /\b(?:StorageError|RpcClientError|ServerError|Unhandled(?:PromiseRejection)?|TypeError):?|\bat (?:async )?\S+ \([^\n]+:\d+:\d+\)/

async function checkClean(page: Page) {
  await expect(page.getByText(jargon).filter({ visible: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width
  )
}

async function checkEmptyPages(page: Page, url: string) {
  await page.goto(`${url}/library`)
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible()
  const sections = page.getByRole("tablist", { name: "Library sections" })
  for (const section of ["Cards", "Lorebooks", "Presets", "Notes"]) {
    await sections.getByRole("tab", { name: new RegExp(`^${section} · 0$`) }).click()
    const panel = page.getByRole("tabpanel")
    await expect(panel.getByText(`No ${section.toLowerCase()} yet`, { exact: true })).toBeVisible()
    if (section === "Notes") {
      await expect(panel.getByText(/Use New note to make one/)).toBeVisible()
      await expect(page.getByRole("button", { name: "New note", exact: true })).toBeVisible()
    } else {
      await expect(panel.getByRole("link", { name: "Import files to add some.", exact: true })).toBeVisible()
    }
    await checkClean(page)
  }

  await page.goto(`${url}/bin`)
  await expect(page.getByText("Nothing deleted", { exact: true })).toBeVisible()
  await checkClean(page)
  await page.goto(`${url}/files`)
  await expect(page.getByText("No files yet.", { exact: false })).toBeVisible()
  await expect(page.getByText("Upload files", { exact: true })).toBeVisible()
  const usage = page.getByRole("button", { name: /of .+ used/ })
  await usage.click()
  const storage = page.getByRole("dialog", { name: "Storage" })
  await expect(storage.getByText("Your files", { exact: true })).toBeVisible()
  await expect(storage.getByText(/\d+(?:\.\d+)? (?:B|KB|MB|GB)/).first()).toBeVisible()
  await checkClean(page)

  await page.goto(`${url}/settings`)
  const settings = page.getByRole("navigation", { name: "Settings" })
  await expect(settings.getByRole("link", { name: "Connections", exact: true })).toBeVisible()
  await checkClean(page)
  await settings.getByRole("link", { name: "Connections", exact: true }).click()
  await expect(page.getByText("No connections yet", { exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "New connection" })).toBeVisible()
  await checkClean(page)
  await page.goto(`${url}/settings/mcp`)
  await expect(page.getByText("No MCP servers yet", { exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Add a server" })).toBeVisible()
  await checkClean(page)
  await page.goto(`${url}/settings/costs`)
  await expect(page.getByText(/No custom formulas/)).toBeVisible()
  const past = page.getByRole("region", { name: "Past requests" })
  await past.getByRole("button", { name: "Check past requests" }).click()
  await expect(past.getByText("No past requests would change.", { exact: true })).toBeVisible()
  await checkClean(page)
}

test.describe.configure({ mode: "parallel" })

for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
]) {
  for (const theme of ["dark", "light"] as const) {
    test(`onboards a fresh account at ${width}×${height} in ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      const server = await startServer(withAdmin)
      const provider = await startProvider({ holdAfterText: true })
      const shot = async (name: string) => {
        await checkClean(page)
        await info.attach(name, { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" })
      }
      const steps = page.getByRole("region", { name: "Get started" })
      try {
        await page.goto(server.url)
        await expect(page.getByRole("heading", { name: "Log in to Dreamspan" })).toBeVisible()
        await page.getByLabel("Handle", { exact: true }).fill(ADMIN.handle)
        await page.getByLabel("Password", { exact: true }).fill(ADMIN.password)
        await page.getByRole("button", { name: "Log in", exact: true }).click()
        await expect(steps).toContainText("0 of 3 done")
        expect(await page.locator("html").evaluate((root) => getComputedStyle(root).colorScheme)).toBe(theme)
        await expectLayout(page, info, "first-run-checklist", { scope: '[aria-labelledby="first-run-title"]' })
        await shot("first-run-checklist")

        await checkEmptyPages(page, server.url)
        await page.goto(server.url)
        await steps.getByRole("link", { name: "Connect a model" }).click()
        await chooseCustomServer(page)
        await page.getByLabel("Name", { exact: true }).fill("Mock connection")
        await page.getByLabel("Base URL", { exact: true }).fill(provider.baseUrl)
        await page.getByRole("button", { name: "Test", exact: true }).click()
        await expect(page.getByText("2 models listed")).toBeVisible()
        await page.getByRole("combobox", { name: "Default model for new chats", exact: true }).click()
        await page.getByRole("option", { name: "fake-small" }).click()
        await page.getByRole("button", { name: "Create connection" }).click()
        await expect(page.getByRole("heading", { name: "Mock connection", exact: true })).toBeVisible()
        await shot("connection-created")

        await page.goto(server.url)
        await expect(steps).toContainText("1 of 3 done")
        await steps.getByRole("link", { name: "Import", exact: true }).click()
        const cardName = width === 1440 ? "Bob" : "Cartographer"
        if (width === 1440) {
          const folder = writeStFolder(info.outputPath("fixture"), [])
          await page.getByRole("link", { name: "Choose the folder", exact: true }).click()
          await page.getByLabel("Choose the folder").setInputFiles(folder)
          await page.getByRole("button", { name: "Import", exact: true }).click()
          await expect(page.getByRole("list", { name: "Imported" })).toContainText("Cards: 1")
        } else {
          const imported = page.waitForResponse(
            (response) =>
              response.request().method() === "POST" && new URL(response.url()).pathname === "/library/import"
          )
          await page.getByLabel(/^Choose files/).setInputFiles({
            name: "cartographer.json",
            mimeType: "application/json",
            buffer: Buffer.from(JSON.stringify({ name: cardName, first_mes: "The map is ready." }))
          })
          expect((await imported).ok()).toBe(true)
          await expect(page.getByRole("list", { name: "Imported files" })).toContainText(
            `Added “${cardName}” to the library as a card.`
          )
        }
        await shot("card-imported")

        await page.goto(server.url)
        await expect(steps).toContainText("2 of 3 done")
        await page
          .getByRole("main")
          .getByRole("link", { name: `Open ${cardName}`, exact: true })
          .click()
        if (width === 390) {
          // On a phone, the card opens over the chat instead of beside it.
          await expect(page.getByRole("tablist", { name: "Chat panel" })).toBeVisible()
          await closePanel(page)
        }
        const composer = page.getByRole("textbox", { name: "Message", exact: true })
        await expect(composer).toBeEditable()
        await composer.fill(story)
        await page.getByRole("button", { name: /^(Send|.+ replies)$/ }).click()
        await expect(page.getByRole("article", { name: "Your message" })).toContainText(story)
        const reply = page.getByRole("article", { name: "Reply" }).last()
        await expect(reply).toContainText(REPLY)
        await expect(page.getByText("generating", { exact: true })).toBeVisible()
        provider.release()
        await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
        await expect(reply).toContainText(REPLY)
        expect(provider.completions.some((request) => JSON.stringify(request.messages).includes(story))).toBe(true)
        await expectLayout(page, info, "first-chat", { scope: '[data-testid="composer"]' })
        await shot("first-chat")
        await page.goto(server.url)
        await expect(page.getByRole("main").getByRole("link", { name: `Open ${cardName}`, exact: true })).toBeVisible()
        await expect(steps).toHaveCount(0)
        await checkClean(page)
      } finally {
        await Promise.all([server.stop(), provider.stop()])
      }
      expect(errors).toEqual([])
    })
  }
}
