// Importing an ST data folder in the browser (ARCHITECTURE.md §13): a synthetic folder in
// ST's multi-user layout is picked, one user chosen, its files sent, and the report acted
// on: a chat linked to a card by choice, a hidden run un-hidden. Every file here is made up.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
import { expect, type Page, test } from "@playwright/test"
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

const png = (...extra: Array<Buffer>) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 128]))),
    ...extra,
    pngChunk("IEND", Buffer.alloc(0))
  ])

const card = (name: string, firstMes: string, extensions: Record<string, unknown> = {}) =>
  png(
    pngChunk(
      "tEXt",
      Buffer.from(
        `chara\0${Buffer.from(
          JSON.stringify({
            spec: "chara_card_v2",
            spec_version: "2.0",
            data: { name, first_mes: firstMes, extensions }
          })
        ).toString("base64")}`,
        "latin1"
      )
    )
  )

const jsonl = (...lines: ReadonlyArray<unknown>) => lines.map((line) => JSON.stringify(line)).join("\n")
const at = (minute: number) => new Date(Date.UTC(2025, 0, 1, 10, minute)).toISOString()
const message = (name: string, mes: string, minute: number, more: Record<string, unknown> = {}) => ({
  name,
  is_user: name === "Sam",
  is_system: false,
  send_date: at(minute),
  mes,
  extra: {},
  ...more
})

let root = ""
test.beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rp-st-folder-"))
  const files: Record<string, string | Buffer> = {
    "settings.json": JSON.stringify({
      power_user: { personas: { "sam.png": "Sam" }, persona_descriptions: { "sam.png": { description: "Curious." } } }
    }),
    "User Avatars/sam.png": png(),
    "characters/Bob.png": card("Bob", "Bob waves."),
    "characters/Twin_a.png": card("Twin", "Which one am I?"),
    "characters/Twin_b.png": card("Twin", "Which one am I?", { variant: "b" }),
    "chats/Bob/Bob - long.jsonl": jsonl(
      { chat_metadata: {}, user_name: "unused", character_name: "unused" },
      ...Array.from({ length: 12 }, (_, i) =>
        message(i % 2 ? "Sam" : "Bob", `Old message ${i}.`, i, {
          is_system: true,
          ...(i === 11 ? { extra: { memory: "Bob and Sam met." } } : {})
        })
      ),
      message("Sam", "Where were we?", 20),
      message("Bob", "Here.", 21)
    ),
    "chats/Bob/Bob - hello.jsonl": jsonl({ chat_metadata: {} }, message("Bob", "Bob waves.", 0)),
    "chats/Twin/Twin - who.jsonl": jsonl(
      { chat_metadata: {} },
      message("Twin", "Which one am I?", 0),
      message("Sam", "Hm.", 1)
    ),
    "instruct/Alpaca.json": "{}",
    "secrets.json": JSON.stringify({ api_key_openai: "sk-not-a-real-key" })
  }
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, "ST/data/default-user", path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  // Another ST user, to choose between.
  mkdirSync(join(root, "ST/data/bea/characters"), { recursive: true })
  writeFileSync(join(root, "ST/data/bea/characters/Bea.png"), card("Bea", "Hi."))
})
test.afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** At phone and desktop width: nothing scrolls sideways, and with SCREENSHOT_DIR set, saved there. */
const shoot = async (page: Page, name: string) => {
  for (const [width, device] of [
    [390, "phone"],
    [1280, "desktop"]
  ] as const) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    const dir = process.env.SCREENSHOT_DIR
    if (dir) await page.screenshot({ path: join(dir, `st-import-${name}-${device}.png`), fullPage: true })
  }
}

test("import an ST folder, link a chat by choosing its card, and un-hide a summarized run", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import`)
  await page.getByRole("link", { name: "Import a SillyTavern folder" }).click()
  await page.getByLabel("Choose the folder").setInputFiles(join(root, "ST"))

  // Two ST users: choose one.
  await page.getByRole("combobox", { name: "ST user" }).click()
  await page.getByRole("option", { name: /^default-user/ }).click()
  await expect(page.getByText("8 files to import")).toBeVisible()
  await shoot(page, "picked")
  await page.getByRole("button", { name: "Import", exact: true }).click()

  const imported = page.getByRole("list", { name: "Imported" })
  await expect(imported).toContainText("Cards: 3 added")
  await expect(imported).toContainText("Personas: 1 added")
  await expect(imported).toContainText("Chats: 1 added")
  // The report holds only what to act on (DESIGN §1.4): no skipped files, greetings or files not read.
  await expect(imported).not.toContainText("skipped")
  await expect(page.getByText("with only a greeting")).toHaveCount(0)
  await expect(page.getByText("instruct template")).toHaveCount(0)

  const hidden = page.getByRole("list", { name: "Hidden runs" })
  await expect(hidden).toContainText("12 messages hidden. Its summary covers them")
  const links = page.getByRole("list", { name: "Chats to link" })
  await expect(links).toContainText("Several cards are named “Twin”.")
  await shoot(page, "report")

  await links.getByRole("button", { name: "Import with this card" }).click()
  await expect(links).toHaveCount(0)
  await expect(imported).toContainText("Chats: 2 added")

  await hidden.getByRole("link", { name: "Bob - long" }).isVisible()
  await hidden.getByRole("button", { name: "Un-hide" }).click()
  await expect(hidden).toHaveCount(0)

  await page.goto(`${server().url}/chats`)
  await expect(page.getByRole("link", { name: "Bob - long" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Twin - who" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Bob - hello" })).toHaveCount(0)
})

test("a chain of branches sorted the wrong way is sent once each, parents first", async ({ page }) => {
  // 000 branches from 001, which branches from 002, and so on to 020: each sorts before its parent.
  const chain = join(root, "chain")
  mkdirSync(join(chain, "group chats"), { recursive: true })
  for (let i = 0; i <= 20; i++) {
    const header = { chat_metadata: i === 20 ? {} : { main_chat: String(i + 1).padStart(3, "0") } }
    writeFileSync(
      join(chain, "group chats", `${String(i).padStart(3, "0")}.jsonl`),
      jsonl(header, message("Card", "greeting", 0), message("Sam", "user", 1), message("Card", `branch ${i}`, 2 + i))
    )
  }
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  let uploads = 0
  page.on("request", (request) => {
    if (request.url().includes("/st-import/file?")) uploads++
  })
  await page.goto(`${server().url}/import/st`)
  await page.getByLabel("Choose the folder").setInputFiles(chain)
  await expect(page.getByText("21 files to import")).toBeVisible()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toContainText("Group chats: 1 added, 20 updated")
  expect(uploads).toBe(21)
})
