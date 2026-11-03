// The import screen and the library list (ARCHITECTURE.md §11): files picked in the
// browser, uploaded to the real server, their reports read as text, and exports downloaded.
// Every file here is made up.
import { readFile, truncate, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

const pngChunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.byteLength)
  out.writeUInt32BE(data.byteLength, 0)
  out.write(type, 4, "latin1")
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength)
  return out
}

/** A 1×1 PNG carrying `card` in a `chara` chunk, as ST writes one. */
const cardPng = (card: unknown) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 128]))),
    pngChunk("tEXt", Buffer.from(`chara\0${Buffer.from(JSON.stringify(card)).toString("base64")}`, "latin1")),
    pngChunk("IEND", Buffer.alloc(0))
  ])

// File text that would be markup if anything rendered it as Markdown or HTML.
const NAME = "<b>Wren</b> **bold**"

const card = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: NAME,
    description: "A lighthouse keeper.",
    first_mes: "The lamp needs oil.",
    extensions: { depth_prompt: { prompt: "Wren smells of lamp oil.", depth: 2, role: "system" } }
  }
}

const preset = (main: string) =>
  Buffer.from(
    JSON.stringify({
      temperature: 1,
      prompts: [{ identifier: "main", name: "Main Prompt", role: "system", content: main, system_prompt: true }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }]
    })
  )

/** At phone and desktop width: nothing scrolls sideways, and with SCREENSHOT_DIR set, saved there. */
const shoot = async (page: Page, name: string) => {
  for (const [width, device] of [
    [390, "phone"],
    [1280, "desktop"]
  ] as const) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    const dir = process.env.SCREENSHOT_DIR
    if (dir) await page.screenshot({ path: join(dir, `${name}-${device}.png`), fullPage: true })
  }
}

/** Check the blob handed to the browser, and the saved file when native downloads work. */
const exportedFile = async (page: Page, browser: Browser, button: Locator, filename: string) => {
  const blobs = await page.evaluateHandle(() => {
    const captured = new Map<string, Blob>()
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (object) => {
      const url = create(object)
      if (object instanceof Blob) captured.set(url, object)
      return url
    }
    return { captured, restore: () => (URL.createObjectURL = create) }
  })
  try {
    const started = page.waitForEvent("download")
    await button.click()
    const download = await started
    expect(download.suggestedFilename()).toBe(filename)
    const bytes = await blobs.evaluate(async ({ captured }, url) => {
      const blob = captured.get(url)
      if (!blob) throw new Error(`The download did not use an exported blob: ${url}`)
      return blob.text()
    }, download.url())
    const failure = await download.failure()
    if (failure === "canceled" && browser.browserType().name() === "chromium") {
      // Chromium has also canceled plain synthetic downloads outside this app in
      // affected environments. Quarantine file saving only if that limitation is
      // reproduced now, without our code, CSP, service workers or URL revocation.
      const probe = await browser.newPage({ acceptDownloads: true })
      try {
        await probe.setContent("<p>Synthetic download probe</p>")
        const event = probe.waitForEvent("download")
        await probe.evaluate(() => {
          const link = document.createElement("a")
          link.href = URL.createObjectURL(new Blob(["synthetic download"]))
          link.download = "probe.txt"
          link.click()
        })
        expect(await (await event).failure(), "Only an independently reproduced cancellation is quarantined").toBe(
          "canceled"
        )
        test.info().annotations.push({
          type: "native-download-quarantined",
          description: "Chromium canceled both the export and an independent synthetic download; blob bytes checked."
        })
      } finally {
        await probe.close()
      }
    } else {
      expect(failure, "The browser must complete the export download").toBeNull()
      expect(await readFile(await download.path(), "utf8")).toBe(bytes)
    }
    return JSON.parse(bytes)
  } finally {
    await blobs.evaluate(({ restore }) => restore())
    await blobs.dispose()
  }
}

test("import files, read their reports as text, export them, and update one from a new version", async ({
  page,
  browser
}) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import`)
  await page.getByLabel("Choose files, or drop them here").setInputFiles([
    { name: "wren.png", mimeType: "image/png", buffer: cardPng(card) },
    { name: "narrator.json", mimeType: "application/json", buffer: preset("Write vivid prose.") },
    { name: "notes.json", mimeType: "application/json", buffer: Buffer.from('{"hello": "world"}') }
  ])
  const files = page.getByRole("list", { name: "Imported files" })
  await expect(page.getByText("Done.")).toBeVisible()
  const wren = files.locator("li", { hasText: "wren.png" })
  await expect(wren).toContainText(`Added “${NAME}” to the library as a card.`)
  await expect(wren).toContainText("The Character's Note became a note on the card.")
  await expect(wren).toContainText("imported")
  // The file's text is text: nothing in the page was made from it.
  await expect(files.locator("b")).toHaveCount(0)
  const notes = files.locator("li", { hasText: "notes.json" })
  await expect(notes).toContainText("Nothing was imported.")
  await expect(notes).toContainText("not imported")
  await expect(notes.getByRole("list", { name: "Import report" })).toContainText("error")
  await shoot(page, "import-report")

  await page.getByRole("link", { name: "Back to the library" }).click()
  await expect(page.getByRole("list", { name: "Cards" })).toContainText(NAME)
  await shoot(page, "library-filled")
  await page.getByRole("tab", { name: /^Presets/ }).click()
  await expect(page.getByRole("list", { name: "Presets" })).toContainText("narrator")

  await page.getByRole("button", { name: "More actions for narrator" }).click()
  await page.getByRole("menuitem", { name: "Export…", exact: true }).hover()
  await expect(page.getByRole("menuitem", { name: "Preset JSON", exact: true })).toBeVisible()
  const exported = await exportedFile(
    page,
    browser,
    page.getByRole("menuitem", { name: "Preset JSON", exact: true }),
    "narrator.json"
  )
  expect(exported.prompts.find((p: { identifier: string }) => p.identifier === "main").content).toBe(
    "Write vivid prose."
  )

  await page.getByRole("tab", { name: /^Cards/ }).click()
  await page.getByRole("button", { name: `More actions for ${NAME}` }).click()
  await page.getByRole("menuitem", { name: "Export…", exact: true }).hover()
  await expect(page.getByRole("menuitem", { name: "V2 JSON", exact: true })).toBeVisible()
  const cardFile = await exportedFile(
    page,
    browser,
    page.getByRole("menuitem", { name: "V2 JSON", exact: true }),
    "_b_Wren__b_ __bold__.json"
  )
  expect(cardFile.data.name).toBe(NAME)
  expect(cardFile.data.extensions.depth_prompt).toEqual({
    prompt: "Wren smells of lamp oil.",
    depth: 2,
    role: "system"
  })

  await page.getByRole("tab", { name: /^Presets/ }).click()
  await page.getByRole("button", { name: "More actions for narrator" }).click()
  await page.getByRole("menuitem", { name: "Update from file…", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Update “narrator”" })).toBeVisible()
  await page.getByLabel("Choose the new version, or drop it here").setInputFiles({
    name: "narrator v2.json",
    mimeType: "application/json",
    buffer: preset("Write vivid, sensory prose.")
  })
  await expect(files.locator("li", { hasText: "narrator v2.json" })).toContainText("Updated “narrator”: updated.")
})

test("a file larger than the cap is refused before it's sent", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import`)
  let uploads = 0
  page.on("request", (request) => {
    if (request.url().includes("/library/import")) uploads++
  })
  // A sparse file: big on paper, nothing written.
  const huge = test.info().outputPath("huge.json")
  await writeFile(huge, "")
  await truncate(huge, 64 * 1024 * 1024 + 1)
  await page.getByLabel("Choose files, or drop them here").setInputFiles(huge)
  await expect(page.getByRole("list", { name: "Imported files" })).toContainText("This file is larger than 64 MB.")
  expect(uploads).toBe(0)
})

test("files can't be added while a batch is importing", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import`)
  // Each upload is held a moment, so the batch is still going when another drop could come.
  await page.route("**/library/import?**", async (route) => {
    await new Promise((done) => setTimeout(done, 1500))
    await route.continue()
  })
  const picker = page.getByLabel("Choose files, or drop them here")
  await picker.setInputFiles({ name: "slow.json", mimeType: "application/json", buffer: preset("Slow.") })
  await expect(picker).toBeDisabled()
  await expect(page.getByText("Wait until these files are done to add more.")).toBeVisible()
  await expect(page.getByText("Done.")).toBeVisible()
  await expect(picker).toBeEnabled()
})

test("an upload refused for an ended session says so", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import`)
  await page.route("**/library/import?**", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"login required"}' })
  )
  await page
    .getByLabel("Choose files, or drop them here")
    .setInputFiles({ name: "late.json", mimeType: "application/json", buffer: preset("Late.") })
  await expect(page.getByRole("list", { name: "Imported files" })).toContainText("Your session has ended.")
})

test("the import page's back link returns where the user came from", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings`)
  await page.getByRole("link", { name: "Import", exact: true }).first().click()
  await expect(page).toHaveURL(/\/import$/)
  await page.getByRole("button", { name: "Back", exact: true }).click()
  await expect(page).toHaveURL(/\/settings/)
})
