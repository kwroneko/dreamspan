// Notes (DESIGN §4.1) on the realistic synthetic ST folder, imported by path: the Notes tab's
// collapsed rows, opening one, adding one, picking a shared note, saving a note as one and
// unlinking it, the switches, the condition and position controls and the cache warning, the
// card editor's notes, and the request inspector showing a note on one speaker's turn and
// not on another's. At 1440 and 390, light and dark, with screenshots outside the repository
// (SCREENSHOT_DIR). Every name and text is made up.
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { CastCard, ChatId, EntityId, SlotId } from "@rp/shared/chat.ts"
import { valueField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { openPanel } from "./support/panel.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import {
  closeNoteBlock,
  noteBlock,
  noteSettings,
  noteToggle,
  openNoteBlock,
  openNoteSettings
} from "./support/notes.ts"
import { asUser } from "./support/rpc.ts"
import { saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-notes-screenshots"))
let provider: FakeProvider
let inn: { chatId: ChatId; leaf: SlotId; cast: ReadonlyArray<CastCard> }
let replies: { aria: string; tobias: string }
let ariaRef: RefId

/** A note's fields set as one saved revision, as the editor saves it. */
const setFields = (refId: RefId, fields: Record<string, unknown>) =>
  admin((api) =>
    Effect.gen(function* () {
      const opened = yield* api.OpenEditor({ refId })
      const drafts = []
      for (const [key, value] of Object.entries(fields)) {
        drafts.push(
          yield* api.SaveEditorDraft({
            refId,
            field: valueField([key]),
            draftId: null,
            content: JSON.stringify(value),
            expectedRowVersion: null,
            expectedSession: null,
            baseRevisionId: opened.ref.headRevisionId
          })
        )
      }
      yield* api.CommitEditorDrafts({
        refId,
        expectedRowVersion: opened.ref.rowVersion,
        fields: drafts.map((d) => ({ field: d.key.field, draftId: d.id, expectedRowVersion: d.rowVersion })),
        message: null
      })
    })
  )

const named = (name: string) => inn.cast.find((card) => card.name === name)!.entityId as EntityId

test.setTimeout(600_000)
test.beforeAll(async ({ browser }) => {
  test.setTimeout(500_000)
  mkdirSync(shots, { recursive: true })
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const folder = writeRealisticStFolder(join(server().dataDir, "synthetic-st"))
  await page.goto(`${server().url}/import/st`)
  await page.getByLabel("Folder path").fill(folder)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 360_000 })
  await page.close()

  provider = await startProvider()
  const connection = await admin((api) =>
    api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Local model server",
        baseUrl: provider.baseUrl,
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: "sk-notes-walkthrough-0042"
    })
  )
  await admin((api) => api.RefreshModels({ connectionId: connection.id }))
  const model = (await admin((api) => api.ListModels({ connectionId: connection.id, includeHidden: false }))).find(
    (m) => m.key === "fake-small"
  )!
  await admin((api) =>
    api.SetGenerationDefaults({ defaults: { model: { connection: connection.id, model: model.id }, preset: null } })
  )

  const library = await admin((api) => api.GetShellLibrary())
  const fork = library.forks.find((f) => f.current && f.chat.title.includes("Lantern"))!
  const chat = await admin((api) => api.GetChat({ chatId: fork.chat.id }))
  const cast = await admin((api) => api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId }))
  inn = { chatId: chat.id, leaf: chat.activeLeafSlotId!, cast: cast.cards }
  ariaRef = (await admin((api) => api.ListLibrary({ kind: "card" }))).find(
    (r) => r.label === "Aria Vance" && r.refKind === "upstream"
  )!.id

  // A note of the inn's own, on Aria's turn only, and a shared note in the library.
  const turn = await admin((api) => api.CreateChatNote({ chatId: inn.chatId, title: "Aria's outfit" }))
  await setFields(turn.id, {
    content: "Aria wears the borrowed harbor coat, two sizes too big.",
    condition: { when: "turn", card: named("Aria Vance") }
  })
  await admin((api) =>
    api.ChangeCast({
      chatId: inn.chatId,
      slotId: inn.leaf,
      change: { _tag: "Note", entityId: turn.entityId, active: true }
    })
  )
  await admin((api) =>
    api.CreateSharedNote({ title: "Harbor weather", content: "Fog rolls in off the water every evening." })
  )
  // Replies from the same message, one by Aria and one by Tobias.
  const reply = async (speaker: string, branch: boolean) => {
    const before = provider.completions.length
    const sent = await admin((api) =>
      api.Generate({ chatId: inn.chatId, parentSlotId: inn.leaf, branch, speakerEntityId: named(speaker) })
    )
    if (sent._tag !== "Posted") throw new Error("the reply queued")
    await expect.poll(() => provider.completions.length, { timeout: 60_000 }).toBe(before + 1)
    return { version: sent.entry.version.id as string, request: JSON.stringify(provider.completions.at(-1)!.messages) }
  }
  const aria = await reply("Aria Vance", false)
  const tobias = await reply("Tobias Wren", true)
  expect(aria.request).toContain("two sizes too big")
  expect(tobias.request).not.toContain("two sizes too big")
  replies = { aria: aria.version, tobias: tobias.version }
})

test.afterAll(async () => {
  await provider?.stop()
})

const notesAt = async (page: Page, width: number, theme: "light" | "dark") => {
  await page.setViewportSize({ width, height: 1000 })
  await page.emulateMedia({ colorScheme: theme })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${inn.chatId}`)
  return openPanel(page, "Notes")
}

const noWideScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`notes: collapse, add, pick, save as shared, unlink, switch, condition at ${width} ${theme}`, async ({
      page
    }) => {
      const tab = await notesAt(page, width, theme)
      const own = tab.getByRole("region", { name: "This chat's notes" })
      // Each header says where the note goes and when, open or closed; opening shows its text.
      const row = noteToggle(own, "Aria's outfit")
      await expect(row).toContainText("End of tail")
      await expect(row).toContainText("Aria Vance's turn")
      const outfit = noteBlock(own, "Aria's outfit")
      await expect(await openNoteBlock(outfit, "Aria's outfit")).toBeVisible()
      await closeNoteBlock(outfit, "Aria's outfit")
      await expect(outfit.getByRole("textbox")).toHaveCount(0)
      await expect(row).toContainText("End of tail")
      // An imported group chat has Aria's own author's note off, as ST ignores it there.
      const aria = tab.getByRole("region", { name: "Aria Vance's notes" })
      await expect(aria.getByRole("switch", { name: /Character author's note/ })).not.toBeChecked()
      await expect(noteToggle(aria, "Character author's note")).toContainText("Private")

      // Add a new note: it opens, on from here.
      await own.getByRole("button", { name: "Add note" }).click()
      await expect(page.getByRole("menuitem", { name: "New note" })).toBeInViewport()
      await page.getByRole("menuitem", { name: "New note" }).click({ timeout: 10_000 })
      const fresh = noteBlock(own, "Note").last()
      await expect(fresh).toBeVisible()
      // It opens with its text; its settings are folded under it.
      await expect(fresh.getByRole("textbox", { name: "Text of Note" })).toBeVisible()
      await openNoteSettings(fresh, "Note")
      await expect(fresh.getByRole("spinbutton", { name: /Every how many/ })).toHaveCount(0)
      await expect(own.getByRole("switch", { name: "Note: on in this chat" }).last()).toBeChecked()
      // Its condition and a place above the history: the cache warning.
      await fresh.getByRole("combobox", { name: "When it applies" }).click()
      await page.getByRole("option", { name: "While a chosen character isn't muted" }).click()
      await expect(fresh.getByRole("combobox", { name: "Characters" })).toBeVisible()
      await expect(fresh.getByText(/rewrites the cached part/)).toHaveCount(0)
      await fresh.getByRole("combobox", { name: "Position" }).click()
      await page.getByRole("option", { name: "Start of context" }).click()
      await expect(fresh.getByText(/rewrites the cached part/)).toBeVisible()
      await fresh.getByRole("combobox", { name: "Position" }).click()
      // Exactly the five decided places for a new note, each with what it means.
      await expect(page.getByRole("option")).toHaveText([
        /^Start of context/,
        /^With the definitions/,
        /^In the history/,
        /^Start of the tail/,
        /^End of the tail/
      ])
      await expect(page.getByRole("option", { name: "With the definitions" })).toHaveAccessibleDescription(
        "Right after the preset's main prompt."
      )
      await page.keyboard.press("Escape")
      await saveRevision(fresh)
      await expect(noteToggle(own, "Note").last()).toContainText("Start of context")
      // Its switch turns it off from here.
      await own.getByRole("switch", { name: "Note: on in this chat" }).last().click()
      await expect(own.getByRole("switch", { name: "Note: on in this chat" }).last()).not.toBeChecked()

      // Pick a shared note into this chat: the slot shows it, with the banner.
      await own.getByRole("button", { name: "Add note" }).click()
      await page.getByRole("menuitem", { name: "Pick a shared note…" }).click()
      const picker = page.getByRole("dialog", { name: "Pick a shared note" })
      await picker.getByRole("textbox", { name: "Filter by name" }).fill("harb")
      await picker
        .getByRole("button", { name: /Harbor weather/ })
        .first()
        .click()
      const linked = tab.getByRole("region", { name: "Note Harbor weather" }).last()
      await expect(linked.getByText(/Shared note “Harbor weather”: edits change it in \d+ place/)).toBeVisible()
      await expect(linked.getByRole("button", { name: "Open in Snippets", exact: true })).toBeVisible()
      // Unlink: its own copy of the text, the link gone.
      await linked.getByRole("button", { name: "Unlink" }).click()
      await expect(
        tab
          .getByRole("region", { name: "Note Harbor weather" })
          .last()
          .getByText(/Shared note “/)
      ).toHaveCount(0)

      // Save a card's note as a shared note, from its menu.
      const tobias = tab.getByRole("region", { name: "Tobias Wren's notes" })
      await tobias.getByRole("button", { name: "Add note" }).click()
      // A portaled menu in the fixed phone sheet stays in viewport coordinates;
      // scrolling its trigger must not send the document into a scroll loop.
      await expect(page.getByRole("menuitem", { name: "New note" })).toBeInViewport()
      await expect(page.getByRole("menu", { name: "Add note", exact: true })).toHaveCSS("opacity", "1")
      await page.screenshot({ animations: "disabled", path: join(shots, `new-note-menu-${width}-${theme}.png`) })
      await page.getByRole("menuitem", { name: "New note" }).click({ timeout: 10_000 })
      const his = noteBlock(tobias, "Note").last()
      await his.getByRole("button", { name: "Actions for Note" }).click()
      await page.getByRole("menuitem", { name: "Save as shared note" }).click()
      await expect(
        tab
          .getByRole("region", { name: "Note Note" })
          .last()
          .getByText(/Shared note “Note”/)
      ).toBeVisible()
      await expect(noteBlock(tobias, "Note").last().getByText("Shared note", { exact: true })).toBeAttached()
      await noWideScroll(page)
    })
  }

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`notes walkthrough ${width} ${theme}`, async ({ page }) => {
      const tab = await notesAt(page, width, theme)
      const shoot = async (name: string) => {
        await noWideScroll(page)
        await page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`) })
      }
      const own = tab.getByRole("region", { name: "This chat's notes" })
      await expect(noteToggle(own, "Aria's outfit")).toBeVisible()
      // Every note folded to its header (Collapse all is off when none is open).
      const collapse = tab.getByRole("button", { name: "Collapse all" })
      if (await collapse.isEnabled()) await collapse.click()
      await expect(collapse).toBeDisabled()
      await shoot("notes-collapsed")
      const open = noteBlock(own, "Aria's outfit")
      await openNoteBlock(open, "Aria's outfit")
      await shoot("note-open")
      await openNoteSettings(open, "Aria's outfit")
      await open.getByRole("combobox", { name: "When it applies" }).scrollIntoViewIfNeeded()
      await shoot("condition-position")
      await closeNoteBlock(open, "Aria's outfit")
      // The group's cards, Aria's imported author's note off here.
      await tab.getByRole("region", { name: "Aria Vance's notes" }).scrollIntoViewIfNeeded()
      await shoot("group-notes")
      await own.getByRole("button", { name: "Add note" }).click()
      await page.getByRole("menuitem", { name: "Pick a shared note…" }).click()
      const picker = page.getByRole("dialog", { name: "Pick a shared note" })
      await expect(picker.getByRole("button", { name: /Harbor weather/ }).first()).toBeVisible()
      await shoot("picker")
      await picker
        .getByRole("button", { name: /Harbor weather/ })
        .first()
        .click()
      const linked = tab.getByRole("region", { name: "Note Harbor weather" }).last()
      await expect(linked.getByText(/Shared note “Harbor weather”/)).toBeVisible()
      await linked.scrollIntoViewIfNeeded()
      await shoot("linked")

      // The card editor's notes, collapsed.
      await page.goto(`${server().url}/library/${ariaRef}`)
      await expect(page.getByRole("heading", { level: 1, name: "Aria Vance" })).toBeVisible()
      await cardFieldsTab(page, "Notes")
      const notes = page.getByRole("list", { name: "The card's notes" })
      await expect(notes.getByRole("button").first()).toBeVisible()
      await notes.scrollIntoViewIfNeeded()
      await shoot("card-notes")
      const characterNote = await noteSettings(notes, "Character author's note")
      await expect(characterNote).toBeVisible()
      // ST put it at the author's note: here it's where ST's default note is, a depth like any
      // (owner, 2026-11-01), and nothing about it but the name it was imported with says "author's note".
      await expect(
        characterNote.getByText(/author's note/).filter({ hasNotText: "Character author's note" })
      ).toHaveCount(0)
      await shoot("card-note-open")
      // A card's note "with the definitions" goes inside its card's part.
      await characterNote.getByRole("combobox", { name: "Position" }).click()
      await expect(page.getByRole("option", { name: "With the definitions" })).toHaveAccessibleDescription(
        /this card's own part of the definitions/
      )
      await expect(page.getByRole("option", { name: /author's note/ })).toHaveCount(0)
      await shoot("card-note-positions")
      await page.keyboard.press("Escape")

      // The request inspector: on Aria's turn the note is in the request, with its condition;
      // on Tobias's it isn't (a skipped note sends nothing, so nothing names it).
      for (const [who, version] of [
        ["aria", replies.aria],
        ["tobias", replies.tobias]
      ] as const) {
        await page.goto(`${server().url}/chats/${inn.chatId}/context/${version}`)
        // The note goes at the end of the tail: the messages list is virtual, so to its end.
        const messages = page.getByRole("region", { name: "Messages" })
        await expect(messages.getByText("#1", { exact: true })).toBeVisible({ timeout: 30_000 })
        await messages.getByRole("list").evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        const last = messages.getByText(/^#\d+$/).last()
        await expect(last).toBeVisible()
        if (who === "aria") {
          const line = messages.getByText("Activated by this chat; on Aria Vance's turn; due this turn.").first()
          await expect(line).toBeVisible({ timeout: 30_000 })
          await line.scrollIntoViewIfNeeded()
        } else {
          await expect(messages.getByText("two sizes too big")).toHaveCount(0)
          await expect(messages.getByText("Note “Aria's outfit”")).toHaveCount(0)
          await last.scrollIntoViewIfNeeded()
        }
        await shoot(`inspector-${who}`)
      }
    })
  }
