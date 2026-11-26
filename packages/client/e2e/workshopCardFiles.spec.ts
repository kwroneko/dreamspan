// A character card attached as a file in a workshop (spec/WORKSHOP-CARDS.md §4.5, unit C11) in
// the browser: a synthetic PNG card and a JSON card picked with the paperclip show as card tiles
// (picture, name, "Card file") in the composer and the sent message; the request the reply was
// made from names them as cards; a scripted reply reads and edits both with the card file tools;
// the change rows under the turn count the fields changed and open the card file's change view;
// the edited PNG imports with the change. Synthetic cards and a scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { crc32 } from "node:zlib"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { FILES_ROUTES } from "@dreamspan/shared/files.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { messageMenu } from "./support/message.ts"
import { filesOf, PIXEL } from "./support/files.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

const shots = process.env.SCREENSHOT_DIR
const ANSWER = "I tightened Wren and Gull in their files."
const WREN = "/files/Attachments/wren.png"
const GULL = "/files/Attachments/gull.json"

const card = (name: string, description: string) => ({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name,
    description,
    personality: "Careful.",
    scenario: "A calm night.",
    first_mes: "The lamp is lit.",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "Synthetic",
    character_version: "",
    extensions: { synthetic: { kept: true } }
  }
})

/** The one-pixel PNG with a `ccv3` text chunk holding the card, before its end. */
const cardPng = (value: unknown) => {
  const data = Buffer.from(`ccv3\0${Buffer.from(JSON.stringify(value)).toString("base64")}`, "latin1")
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write("tEXt", 4, "latin1")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([PIXEL.subarray(0, PIXEL.length - 12), head, data, crc, PIXEL.subarray(PIXEL.length - 12)])
}

test.describe("workshop card files", () => {
  const server = serverPerFile(withAdmin)
  let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
  const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
    asUser(server(), ADMIN.handle, ADMIN.password, use)
  test.beforeAll(async () => {
    provider = await startWorkshopProvider({
      perTask: true,
      answer: ANSWER,
      calls: [
        { name: "read_card_file", arguments: { path: WREN } },
        {
          name: "edit_card_file",
          arguments: { path: WREN, changes: [{ field: "description", find: "lighthouse", replace: "harbour" }] }
        },
        { name: "read_card_file", arguments: { path: GULL, view: "summary" } },
        {
          name: "edit_card_file",
          arguments: { path: GULL, changes: [{ field: "scenario", text: "The ferry runs late tonight." }] }
        }
      ]
    })
    await admin((api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",

          settings: {
            providerSettings: { toolLoading: "every" },

            name: "Synthetic workshop",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: model.id }, preset: null }
        })
      })
    )
  })
  test.afterAll(async () => {
    await provider.stop()
  })

  for (const [width, theme] of [
    [1340, "dark"],
    [1340, "light"],
    [390, "dark"]
  ] as const)
    test(`card files show as cards, are read and edited by the assistant, and re-import at ${width} ${theme}`, async ({
      page
    }, info) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const files = filesOf(page.request, server().url)
      await files.clear()
      const workshop = await admin((api) => api.CreateWorkshop({ title: `Card files ${width} ${theme}` }))
      const shot = async (label: string) => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (!shots) return
        mkdirSync(shots, { recursive: true })
        await page.waitForTimeout(200)
        await page.screenshot({ path: resolve(shots, `card-files-${label}-${width}-${theme}.png`) })
      }

      await page.goto(`${server().url}/chats/${workshop.id}`)
      await expect(page.getByRole("button", { name: "Attach", exact: true })).toBeEnabled()
      await page.getByLabel("Choose files").setInputFiles([
        {
          name: "wren.png",
          mimeType: "image/png",
          buffer: cardPng(card("Wren Hollow", "A synthetic lighthouse keeper."))
        },
        {
          name: "gull.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(card("Gull Keeper", "A synthetic ferryman.")))
        }
      ])

      // Each shows as a card: its picture (the PNG's own), its name, "Card file".
      const attached = page.getByRole("list", { name: "Attachments" })
      const wren = attached.locator('[data-card-file="wren.png"]')
      const gull = attached.locator('[data-card-file="gull.json"]')
      await expect(wren).toContainText("Wren Hollow", { timeout: 20_000 })
      await expect(wren).toContainText("Card file")
      await expect(wren.locator("img")).toHaveCount(1)
      await expect(gull).toContainText("Gull Keeper", { timeout: 20_000 })
      await expect(gull).toContainText("Card file")
      const tip = page.locator('[data-layout-overlay="Tooltip floats above the page"][data-open]')
      await gull.hover()
      await expect(tip).toHaveText("Opens the copy of this card file as it was attached.")
      await page.mouse.move(0, 0)
      await shot("composer")
      await expectLayout(page, info, `card-files-composer-${width}-${theme}`, {
        scope: '[aria-label="Image attachments"]'
      })

      await page.getByLabel("Message", { exact: true }).fill("Tighten these two.")
      await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
      const reply = page.getByRole("article").filter({ hasText: ANSWER })
      await expect(reply).toHaveCount(1, { timeout: 60_000 })

      // The sent message shows the same cards, the PNG not again as a picture.
      const sent = page.getByRole("article").filter({ hasText: "Tighten these two." }).last()
      const listed = sent.getByRole("list", { name: "Message files" })
      await expect(listed.locator("[data-card-file]")).toHaveCount(2)
      await expect(listed.locator('[data-card-file="wren.png"]')).toContainText("Wren Hollow")
      await expect(sent.getByRole("button", { name: /^View image/ })).toHaveCount(0)

      // The model read them as cards, and the tools read and edited both files.
      const first = provider.bodies.find((b) => JSON.stringify(b.messages).includes("Tighten these two."))!
      expect(JSON.stringify(first.messages)).toContain('card_name=\\"Wren Hollow\\" format=\\"png\\"')
      expect(JSON.stringify(first.messages)).toContain('card_name=\\"Gull Keeper\\" format=\\"json\\"')
      const results = provider.toolResults()
      expect(results[0]).toContain("A synthetic lighthouse keeper.")
      expect(results[1]).toContain("Edited /files/Attachments/wren.png")
      expect(results[2]).toContain("Gull Keeper")
      expect(results[3]).toContain("scenario")

      // One row per card file under the turn, counting what changed; each link explains itself.
      const rows = page.locator("[data-change-rows]")
      await expect(rows).toHaveCount(1)
      const wrenRow = rows.locator(`[data-change-row="${WREN}"]`)
      await expect(rows.locator("[data-change-row]")).toHaveCount(2)
      await expect(wrenRow.locator("[data-change-name]")).toHaveText("Wren Hollow")
      await expect(wrenRow.locator("[data-change-count]")).toHaveText("Card file edited · 1 field")
      await expect(rows.locator(`[data-change-row="${GULL}"] [data-change-count]`)).toHaveText(
        "Card file edited · 1 field"
      )
      const checkHint = async (target: string, text: string) =>
        expect(async () => {
          await page.mouse.move(0, 0)
          await wrenRow.locator(target).hover()
          await expect(tip).toHaveText(text, { timeout: 1200 })
        }).toPass({ timeout: 10_000 })
      await checkHint("[data-change-count]", "Shows what the assistant changed: Description.")
      await checkHint("[data-change-name]", "Opens the card file wren.png in Files, as it is now.")
      await page.mouse.move(0, 0)
      await shot("rows")
      await expectLayout(page, info, `card-files-rows-${width}-${theme}`, { scope: "[data-change-rows]" })

      // The request the reply was made from names the card in its attachment element.
      await messageMenu(reply, "Open request inspector")
      await expect(page.getByRole("heading", { name: "The request a reply was generated from" })).toBeVisible()
      const element = page.getByText(/card_name="Wren Hollow"/).first()
      await expect(element).toBeVisible({ timeout: 15_000 })
      await element.scrollIntoViewIfNeeded()
      await shot("inspector")
      await page.goBack()

      // The change view: only the fields that differ, before and after this reply.
      await page.locator(`[data-change-row="${WREN}"] [data-change-count]`).first().click()
      await expect(page).toHaveURL(/\/files\/card-change\?/)
      const view = page.locator("section", { has: page.getByRole("heading", { name: "Wren Hollow · changes" }) }).last()
      const changed = view.getByLabel("What changed", { exact: true }).locator("details")
      await expect(changed).toHaveCount(1)
      await expect(changed.locator("summary")).toHaveText([/^Description/])
      await changed.first().locator("summary").click()
      await expect(view.getByText("A synthetic harbour keeper.")).toBeVisible()
      await expect(view.getByText(/changed by the assistant in a workshop reply/)).toBeVisible()
      await expect(view.locator("[data-change-action]")).toHaveText("Revert")
      await shot("view")
      await expectLayout(page, info, `card-files-view-${width}-${theme}`, { scope: "main" })

      // The edited file is still a PNG card: imported, it has the change.
      const raw = await page.request.get(`${server().url}${FILES_ROUTES.raw}?${new URLSearchParams({ path: WREN })}`, {
        headers: { origin: server().url }
      })
      const imported = await page.request.post(`${server().url}/library/import?name=wren.png`, {
        data: await raw.body(),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(imported.status()).toBe(200)
      const ref = (await imported.json()).library.ref as { id: RefId }
      const doc = await admin((api) => api.OpenEditor({ refId: ref.id }))
      expect(doc.doc.description).toBe("A synthetic harbour keeper.")
      expect(doc.doc.name).toBe("Wren Hollow")

      // Revert (spec/WORKSHOP-CARDS.md §8.1): the field goes back in the file, which stays a PNG
      // card, and the row says Reverted.
      await view.locator("[data-change-action]").click()
      await expect(view.locator("[data-change-state]")).toHaveText("Reverted", { timeout: 15_000 })
      const back = await page.request.get(`${server().url}${FILES_ROUTES.raw}?${new URLSearchParams({ path: WREN })}`, {
        headers: { origin: server().url }
      })
      const again = await page.request.post(`${server().url}/library/import?name=wren.png`, {
        data: await back.body(),
        headers: { origin: server().url, "content-type": "application/octet-stream" }
      })
      expect(again.status()).toBe(200)
      const againRef = (await again.json()).library.ref.id as RefId
      const reverted = await admin((api) => api.OpenEditor({ refId: againRef }))
      expect(reverted.doc.description).toBe("A synthetic lighthouse keeper.")
      await shot("reverted")
      await page.goBack()
      await expect(page.locator(`[data-change-row="${WREN}"] [data-change-state]`).first()).toHaveText("Reverted")
    })
})
