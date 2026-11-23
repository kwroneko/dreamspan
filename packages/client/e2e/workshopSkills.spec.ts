// Workshop skills and the start card in the browser (spec/TOOL-LOADING.md §6, spec/WORKSHOP.md
// §2.2): a card's Skills section in the Extra tab lists its skills, says why one would be
// skipped, adds, edits and removes them; the workshop start card picks the assistant's card and
// the user's persona, kept in the URL, for that workshop alone. Every card here is made up.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = process.env.SCREENSHOT_DIR
test.setTimeout(150_000)

const importCard = async (page: Page, name: string) => {
  const data = {
    name,
    description: `${name} tidies the harbour office's ledgers.`,
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "Synthetic",
    character_version: "1.0",
    extensions: {
      dreamspan: {
        skills: [
          {
            name: "proofread",
            description: "Checks a card's spelling and punctuation.",
            instructions: "Read each field slowly. List the mistakes before fixing any.",
            tools: ["read_card", "edit_card"]
          },
          { use: "cards" },
          { name: "Bad Name", description: "", instructions: "" }
        ]
      }
    }
  }
  const body = Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data }))
  const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  return (await response.json()).library.ref as { id: RefId; entityId: EntityId }
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`card skills and workshop start choices at ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shot = async (name: string) => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (!shots) return
        mkdirSync(shots, { recursive: true })
        await page.waitForTimeout(200)
        await page.screenshot({ path: resolve(shots, `wsskills-${name}-${width}-${theme}.png`) })
      }
      const cardName = `Ledger keeper ${width} ${theme}`
      const ref = await importCard(page, cardName)
      const personaName = `Harbour clerk ${width} ${theme}`
      const persona = await admin((api) => api.CreateCard({ label: personaName, name: personaName, persona: true }))

      // The Skills section: each entry, the installed one marked, the broken one saying why.
      await page.goto(`${server().url}/library/${ref.id}`)
      await page.getByRole("tab", { name: "Extra", exact: true }).click()
      const list = page.getByRole("list", { name: "Skills", exact: true })
      await expect(list.getByRole("listitem")).toHaveCount(3)
      await expect(list.getByRole("listitem").nth(0)).toContainText("Checks a card's spelling and punctuation.")
      await expect(list.getByRole("listitem").nth(1)).toContainText("installed")
      await expect(list.getByRole("listitem").nth(2)).toContainText("Skipped until it says what it's for.")
      await list.getByRole("listitem").nth(2).scrollIntoViewIfNeeded()
      await shot("section")
      await expectLayout(page, info, `wsskills-section-${width}-${theme}`)

      // Add one: the dialog checks it as it's typed.
      await page.getByRole("button", { name: "Add a skill", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Add a skill" })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel("Name", { exact: true }).fill("tide-notes")
      await expect(dialog.getByRole("list", { name: "Problems" })).toContainText("Skipped until it says what it's for.")
      await dialog.getByLabel("What it's for", { exact: true }).fill("Writes tide notes into a lorebook.")
      await dialog.getByLabel("Instructions", { exact: true }).fill("Keep each note under two lines.")
      await dialog.getByLabel("Tools", { exact: true }).fill("read_lorebook, edit_lorebook")
      await expect(dialog.getByRole("list", { name: "Problems" })).toHaveCount(0)
      await shot("dialog")
      await expectLayout(page, info, `wsskills-dialog-${width}-${theme}`)
      await dialog.getByRole("button", { name: "Add", exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(list.getByRole("listitem")).toHaveCount(4)
      // Edit it, then remove the broken one.
      await page.getByRole("button", { name: "Edit tide-notes", exact: true }).click()
      const edit = page.getByRole("dialog", { name: "Edit tide-notes" })
      await expect(edit.getByLabel("Tools", { exact: true })).toHaveValue("read_lorebook, edit_lorebook")
      await edit.getByLabel("What it's for", { exact: true }).fill("Writes short tide notes.")
      await edit.getByRole("button", { name: "Save", exact: true }).click()
      await expect(list.getByRole("listitem").nth(3)).toContainText("Writes short tide notes.")
      await page.getByRole("button", { name: "Remove Bad Name", exact: true }).click()
      await expect(list.getByRole("listitem")).toHaveCount(3)
      // Saved, the card's revision holds them in its own extension.
      await saveRevision(page)
      await expect
        .poll(async () => {
          const opened = await admin((api) => api.OpenEditor({ refId: ref.id }))
          const skills = (
            opened.doc as { extensions?: { dreamspan?: { skills?: Array<{ name?: string; use?: string }> } } }
          ).extensions?.dreamspan?.skills
          return skills?.map((s) => s.name ?? `use:${s.use}`)
        })
        .toEqual(["proofread", "use:cards", "tide-notes"])

      // The start card: the default assistant and persona, changed for this workshop only.
      await page.goto(`${server().url}/chats`)
      const assistant = page.getByRole("button", { name: /^Assistant: / })
      await expect(assistant).toBeVisible()
      await assistant.click()
      await page.getByRole("radio", { name: new RegExp(cardName) }).click()
      await expect(page).toHaveURL(new RegExp(`workshopCard=${ref.entityId}`))
      const you = page.getByRole("button", { name: /^You: / })
      await you.click()
      // The one persona picker, as in a chat's Cast tab; a workshop's persona comes from the folder.
      const picker = page.getByRole("dialog", { name: "Your persona" })
      await expect(picker.getByRole("tab")).toHaveText(["Personas"])
      await shot("persona-picker")
      await expectLayout(page, info, `wsskills-persona-picker-${width}-${theme}`)
      await picker.getByRole("option", { name: personaName, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`workshopPersona=${persona.entityId}`))
      // The URL keeps the choice across a reload.
      await page.reload()
      await expect(page.getByRole("button", { name: `Assistant: ${cardName}`, exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: `You: ${personaName}`, exact: true })).toBeVisible()
      await shot("start-card")
      await expectLayout(page, info, `wsskills-start-card-${width}-${theme}`)
      const before = await admin((api) => api.GetWorkshopDefaults({}))
      await page.getByRole("button", { name: "New workshop", exact: true }).click()
      // It opens the workshop not made yet, with these choices; its first message makes it.
      await expect(page).toHaveURL(/\/new\/workshop/)
      await page.getByLabel("Message", { exact: true }).fill("Hello.")
      await page.getByRole("button", { name: /^Send/ }).click()
      await expect(page).toHaveURL(/\/chats\/[^/?]+/)
      const chatId = new URL(page.url()).pathname.split("/").at(-1)!
      const cast = await admin((api) => api.GetCast({ chatId: chatId as never, slotId: null }))
      expect(cast.participants).toContain(ref.entityId)
      expect(cast.playedByMe).toEqual([persona.entityId])
      const after = await admin((api) => api.GetWorkshopDefaults({}))
      expect(after.card).toBe(before.card ?? after.card)
      expect(after.card).not.toBe(ref.entityId)
      expect(after.persona).not.toBe(persona.entityId)
    })
