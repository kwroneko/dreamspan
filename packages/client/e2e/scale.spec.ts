// The app used as a heavy SillyTavern user would (ARCHITECTURE.md §12 "Stored fork
// summaries", §13 "Import jobs"): a folder of hundreds of cards with portrait-sized avatars
// and thousands of chats, some of thousands of messages, imported through the import page;
// the user leaves while it runs, reloads, opens the home grid, characters and their card
// pages, then checks what the import left. Opt-in, as it takes tens of minutes:
// E2E_SCALE=1 (sizes: E2E_SCALE_CARDS, E2E_SCALE_CHATS, E2E_SCALE_LONG, E2E_SCALE_GROUPS).
// Every file is made up (support/stScaleFolder.ts).
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { writeScaleFolder } from "./support/stScaleFolder.ts"

const enabled = process.env.E2E_SCALE === "1"
const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback)

test.skip(!enabled, "E2E_SCALE=1 runs the import at a heavy user's scale")
test.describe.configure({ mode: "serial" })

const server = serverPerFile({ ...withAdmin, DB_READERS: "2" })
let root = ""
let folder: ReturnType<typeof writeScaleFolder>

test.beforeAll(() => {
  test.setTimeout(20 * 60_000)
  root = mkdtempSync(join(tmpdir(), "rp-st-scale-"))
  folder = writeScaleFolder(root, {
    cards: size("E2E_SCALE_CARDS", 420),
    chats: size("E2E_SCALE_CHATS", 2100),
    longChats: size("E2E_SCALE_LONG", 3),
    groups: size("E2E_SCALE_GROUPS", 12)
  })
})
test.afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A character tile on the home grid, by its card's name. */
const tile = (page: Page, name: string) => page.getByRole("link", { name: new RegExp(`^Open ${name}`) })

/** Recent sorting virtualizes older cards out of the grid until the user filters to them. */
const findCard = (page: Page, name: string) =>
  page.getByRole("searchbox", { name: "Search characters and groups", exact: true }).fill(name, { timeout: 15_000 })

/** Opens a card's page and expects its chats, never an endless "Loading the card…". */
const openCardPage = async (page: Page, name: string) => {
  await page.goto(`${server().url}/`)
  await findCard(page, name)
  await expect(tile(page, name)).toBeVisible({ timeout: 15_000 })
  await tile(page, name).click()
  const id = new URL(page.url()).searchParams.get("character")
  expect(id).not.toBeNull()
  const started = Date.now()
  await page.goto(`${server().url}/cards/${id}`)
  await expect(page.getByRole("heading", { name: /^Chats/ }).first()).toBeVisible({ timeout: 15_000 })
  return Date.now() - started
}

test("an import at scale runs on the server while the user leaves, reloads and uses the app", async ({
  page
}, info) => {
  test.setTimeout(120 * 60_000)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import/st`)
  await page.getByLabel("Folder path").fill(root)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByText("You can close this tab while the import runs.")).toBeVisible()

  // A full page load: the import goes on, and the shell says so wherever the user is.
  await page.goto(`${server().url}/`)
  await expect(page.getByText(/Importing ST data/)).toBeVisible()
  await page.reload()
  await expect(page.getByText(/Importing ST data/)).toBeVisible()
  await page.screenshot({ path: info.outputPath("home-during-1440.png") })

  // While it runs: the grid, a card's chat and its card page answer, round after round.
  const favourite = folder.names.find((name) => folder.used.has(name))!
  for (let round = 0; ; round++) {
    await page.goto(`${server().url}/import/st`)
    const running = page.getByText("Running", { exact: true }).first()
    const finished = page.getByText("Finished", { exact: true }).first()
    await expect(running.or(finished).first()).toBeVisible({ timeout: 15_000 })
    if (await finished.isVisible()) break
    await page.goto(`${server().url}/`)
    await findCard(page, "Card 000")
    await expect(tile(page, "Card 000").first()).toBeVisible({ timeout: 15_000 })
    if (await tile(page, favourite).count()) {
      const took = await openCardPage(page, favourite)
      console.log(`round ${round}: card page in ${took} ms`)
    }
    await page.waitForTimeout(20_000)
  }

  // After: the job is listed with its report, after a reload too.
  await page.goto(`${server().url}/import/st`)
  await expect(page.getByText("Finished", { exact: true }).first()).toBeVisible()
  await page.reload()
  await expect(page.getByText("Finished", { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: info.outputPath("import-finished-1440.png"), fullPage: true })

  // Cards with imported chats are used, with their count; the grid's thumbnails are small.
  await page.goto(`${server().url}/`)
  const media: Array<number> = []
  page.on("response", (response) => {
    if (response.url().includes("/library/media")) media.push(Number(response.headers()["content-length"] ?? 0))
  })
  await findCard(page, favourite)
  await expect(tile(page, favourite)).toContainText(/\d+ chats/, { timeout: 15_000 })
  await page.waitForTimeout(3000)
  expect(media.length).toBeGreaterThan(0)
  expect(Math.max(...media)).toBeLessThan(200_000)
  for (const [width, scheme] of [
    [1440, "light"],
    [1440, "dark"],
    [390, "light"],
    [390, "dark"]
  ] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(`${server().url}/`)
    await findCard(page, favourite)
    await expect(tile(page, favourite)).toContainText(/\d+ chats/, { timeout: 15_000 })
    await page.screenshot({ path: info.outputPath(`home-after-${width}-${scheme}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  expect(await openCardPage(page, favourite)).toBeLessThan(15_000)
})
