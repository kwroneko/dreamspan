import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { noteBlock, openNoteSettings } from "./support/notes.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { closePanel, openPanel, panelTab } from "./support/panel.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { cacheChip } from "./support/strip.ts"
import { saveRevision } from "./support/saveRevision.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let provider: FakeProvider
test.beforeAll(async () => {
  provider = await startProvider()
})
test.afterAll(async () => {
  await provider.stop()
})
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-own-turn-notes")
mkdirSync(shots, { recursive: true })
const setup = async (page: Page, tag: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const name of [`Mira ${tag}`, `Tobin ${tag}`]) {
    const r = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
      headers: { origin: server().url, "content-type": "application/octet-stream" },
      data: Buffer.from(
        JSON.stringify({
          spec: "chara_card_v2",
          spec_version: "2.0",
          data: {
            name,
            description: "Wears blue.\nFears the sea.",
            personality: "Patient.\nKeeps a secret.",
            first_mes: "The road is clear."
          }
        })
      )
    })
    expect(r.status()).toBe(200)
  }
  return admin((api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      const refs = yield* api.ListLibrary({ kind: "card" })
      const mira = cards.find((c) => c.name === `Mira ${tag}`)!,
        tobin = cards.find((c) => c.name === `Tobin ${tag}`)!
      const preset = yield* api.CreatePreset({ label: `Own turns ${tag}` })
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: `Synthetic ${tag}`,
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: null
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "synthetic",
        overrides: { context: 32000 }
      })
      yield* api.ChangeGenerationDefaults({
        change: { preset: preset.id, model: { connection: connection.id, model: model.id } }
      })
      const chat = yield* api.CreateChat({ title: `Own turns ${tag}` })
      for (const card of [mira, tobin])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      return { mira: { ...mira, refId: refs.find((r) => r.entityId === mira.entityId)!.id }, tobin, chat }
    })
  )
}
const selectLastLine = async (page: Page, scope: ReturnType<Page["locator"]>, name: string) => {
  const box = scope.getByRole("textbox", { name, exact: true })
  await box.click()
  await page.keyboard.press("Control+End")
  await page.keyboard.press("Home")
  await page.keyboard.press("Shift+End")
}

test.setTimeout(120_000)
for (const width of [1440, 390])
  for (const scheme of ["light", "dark"] as const)
    test(`move, pair, marker and export (${width} ${scheme})`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: scheme })
      await page.addInitScript((theme) => localStorage.setItem("rp.theme", theme), scheme)
      const { mira, tobin, chat } = await setup(page, `${width}${scheme}`)
      const shot = (name: string) => page.screenshot({ path: join(shots, `${name}-${width}-${scheme}.png`) })
      await page.goto(`${server().url}/library/${mira.refId}`)
      let definition = await cardFieldsTab(page, "Definition")
      let field = definition.locator('[data-own-turn-field="description"]')
      await selectLastLine(page, field, "Description")
      await field.getByRole("button", { name: "Move to an own-turn note", exact: true }).click()
      await expect(field.getByText("only on", { exact: false })).toContainText(mira.name)
      await expect(field.getByRole("textbox", { name: "Description", exact: true })).not.toContainText("Fears the sea.")
      await field.getByRole("tab", { name: "Original", exact: true }).click()
      await expect(field.getByRole("textbox", { name: "Description", exact: true })).toContainText("Fears the sea.")
      await field.getByRole("tab", { name: "As replaced", exact: true }).click()
      await expectLayout(page, info, `large card ${width} ${scheme}`, { scope: '[data-own-turn-field="description"]' })
      await shot("card")
      const notes = await cardFieldsTab(page, "Notes")
      await expect(notes.locator("[data-moved-note-pair]")).toHaveCount(1)
      await expect(notes.getByText("Moved from Description", { exact: true }).first()).toBeVisible()
      await expectLayout(page, info, `card notes ${width} ${scheme}`, { scope: "[data-moved-note-pair]" })
      const own = noteBlock(notes, "Moved from Description")
      await openNoteSettings(own, "Moved from Description")
      await expect(own.getByRole("combobox", { name: "When it applies" })).toHaveText("On its card's turn")
      await expect(own.getByRole("combobox", { name: "Position" })).toHaveText("At the preset's Own-turn notes")
      await expect(own.getByRole("textbox", { name: "Text of Moved from Description" })).toContainText(
        "Where the story since then shows {{char}} differently, the story wins."
      )
      await expectLayout(page, info, `own note settings ${width} ${scheme}`, { scope: "[data-moved-note-pair]" })
      await own.getByRole("button", { name: "Settings of Moved from Description", exact: true }).click()
      await page.getByRole("button", { name: "Export…", exact: true }).click()
      await page.getByRole("menuitem", { name: "V2 JSON", exact: true }).click()
      const warning = page.getByRole("dialog", { name: "Export the original card" })
      await expect(warning).toContainText("SillyTavern will get the original text")
      await expectLayout(page, info, `export notice ${width} ${scheme}`, { scope: '[role="dialog"]' })
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        warning.getByRole("button", { name: "Export", exact: true }).click()
      ])
      expect(download.suggestedFilename()).toContain(".json")
      await page.goto(`${server().url}/chats/${chat.id}`)
      await openPanel(page, "Cast")
      await panelTab(page, mira.name)
      const card = page.getByRole("tabpanel", { name: mira.name, exact: true })
      definition = await cardFieldsTab(card, "Definition")
      field = definition.locator('[data-own-turn-field="personality"]')
      await selectLastLine(page, field, "Personality")
      await field.getByRole("button", { name: "Move to an own-turn note", exact: true }).click()
      await expect(field.locator("[data-own-turn-tokens]")).toBeVisible()
      await expectLayout(page, info, `panel card ${width} ${scheme}`, { scope: '[data-own-turn-field="personality"]' })
      await shot("panel")
      const chatNotes = await openPanel(page, "Notes")
      const pair = chatNotes.locator("[data-moved-note-pair]").filter({ hasText: "Moved from Description" })
      await expect(pair.getByRole("switch")).toHaveCount(1)
      await pair.getByRole("switch").click()
      await expect(pair.getByRole("switch")).not.toBeChecked()
      const listed = await admin((api) => api.ListChatNotes({ chatId: chat.id, slotId: null }))
      const description = listed.filter(
        (n) => n.doc.move_group === listed.find((n) => n.doc.title === "Moved from Description")?.doc.move_group
      )
      expect(description).toHaveLength(2)
      expect(description.every((n) => !n.active)).toBe(true)
      await expectLayout(page, info, `chat notes ${width} ${scheme}`, { scope: "[data-moved-note-pair]" })
      await shot("notes")
      await pair.getByRole("switch").click()
      const presetPanel = await openPanel(page, "Prompt preset")
      const marker = presetPanel.locator('[data-prompt="ownTurnNotes"]')
      await expect(marker).toBeVisible()
      await expectLayout(page, info, `preset marker ${width} ${scheme}`, { scope: '[data-prompt="ownTurnNotes"]' })
      const handle = marker.getByRole("button", { name: "Move Own-turn notes", exact: true })
      await handle.focus()
      await handle.press("ArrowUp")
      await handle.press("ArrowUp")
      await expect(
        presetPanel.getByText("Above the history, own-turn notes rewrite the cached part whenever the speaker changes.")
      ).toBeVisible()
      await handle.press("ArrowDown")
      await handle.press("ArrowDown")
      await marker.getByRole("button", { name: "Actions for Own-turn notes", exact: true }).click()
      await page.getByRole("menuitem", { name: "Delete the prompt", exact: true }).click()
      await expect(marker).toHaveCount(0)
      await presetPanel
        .locator('[data-prompt="newestMessage"]')
        .getByRole("button", { name: "Actions for Newest message", exact: true })
        .click()
      await page.getByRole("menuitem", { name: "Insert Own-turn notes below", exact: true }).click()
      await expect(marker).toBeVisible()
      await shot("marker")
      for (const speaker of [mira, tobin]) {
        const generated = await admin((api) =>
          Effect.gen(function* () {
            const chatNow = yield* api.GetChat({ chatId: chat.id })
            const result = yield* api.Generate({
              chatId: chat.id,
              parentSlotId: chatNow.activeLeafSlotId,
              branch: false,
              speakerEntityId: speaker.entityId
            })
            if (result._tag !== "Posted") throw new Error("queued")
            return result.entry.version.id
          })
        )
        await expect
          .poll(() => admin((api) => api.GetRunContext({ versionId: generated }).pipe(Effect.map((run) => run.status))))
          .toBe("completed")
        await page.goto(`${server().url}/chats/${chat.id}/context/${generated}`)
        if (speaker === mira) {
          await expect(page.getByRole("region", { name: "Messages", exact: true })).toContainText("Fears the sea.")
          await expect(page.getByRole("region", { name: "Messages", exact: true })).toContainText("Own-turn note")
        } else {
          const notSent = page.getByRole("region", { name: "Not sent", exact: true })
          await expect(notSent).toContainText("Own-turn note")
          await expect(notSent).toContainText(`only on ${mira.name}'s turns`)
        }
        await expectLayout(page, info, `inspector ${speaker === mira ? "own" : "other"} ${width} ${scheme}`, {
          scope: "main"
        })
        await shot(speaker === mira ? "inspector-own" : "inspector-other")
      }
      await page.goto(`${server().url}/chats/${chat.id}`)
      const settings = await openPanel(page, "Prompt preset")
      const ownMarker = settings.locator('[data-prompt="ownTurnNotes"]')
      const moveMarker = ownMarker.getByRole("button", { name: "Move Own-turn notes", exact: true })
      await moveMarker.focus()
      await moveMarker.press("ArrowUp")
      await moveMarker.press("ArrowUp")
      await saveRevision(settings)
      await expect
        .poll(() =>
          admin((api) =>
            api
              .GetNextContext({ chatId: chat.id, leafSlotId: null })
              .pipe(Effect.map((next) => next.warmth?.speakerChange ?? ""))
          )
        )
        .toContain(`Mira ${width}${scheme}'s turn starts differently from Tobin ${width}${scheme}'s`)
      await closePanel(page)
      await cacheChip(page).click()
      const cache = page.getByRole("dialog").filter({ hasText: "cached copy has expired" })
      await expect(cache).toContainText(/~[\d,]+ tokens are written again/)
      await expectLayout(page, info, `speaker cache warning ${width} ${scheme}`, { scope: '[role="dialog"]' })
      await shot("cache-warning")
    })
