import { closeNoteBlock, noteBlock, noteSettings, noteText, noteToggle } from "./support/notes.ts"
import { expectTextBox } from "./support/textbox.ts"
// The card and preset editors (ARCHITECTURE.md §14) in a real browser against the real
// server: edits used as typed, saved as revisions, put back from a field's edit history,
// restored, forked, reordered,
// approved, searched and resolved. Every card and preset here is made up.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { textField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { NOTHING_TO_SAVE, UNSAVED, editHistoryTexts, saveCluster, saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"

const server = serverPerFile(withAdmin)

const fixture = (name: string) =>
  readFile(join(import.meta.dirname, `../../server/test/fixtures/presets/${name}.json`), "utf8")

/** A preset file with its main prompt's text set, as a user's ST would export it. */
const presetFile = async (name: string, main?: string) => {
  const file = JSON.parse(await fixture(name)) as { prompts: Array<{ identifier: string; content: string }> }
  if (main !== undefined) file.prompts.find((p) => p.identifier === "main")!.content = main
  return Buffer.from(JSON.stringify(file))
}

const importPreset = async (page: Page, bytes: Buffer, into?: string) => {
  const response = await page.request.post(
    `${server().url}/library/import?name=preset.json${into ? `&into=${into}` : ""}`,
    { headers: { "content-type": "application/octet-stream", origin: server().url }, data: bytes }
  )
  expect(response.status()).toBe(200)
  return ((await response.json()) as { library: { ref: { id: string } } }).library.ref.id
}

const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

/** A card with these fields saved, made through the API. */
const savedCard = (name: string, fields: Record<string, string>) =>
  admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: name, name })
      for (const [key, content] of Object.entries(fields)) {
        yield* api.SaveEditorDraft({
          draftId: null,
          expectedSession: null,
          refId: card.id,
          field: textField([key]),
          content,
          expectedRowVersion: null,
          baseRevisionId: card.headRevisionId
        })
      }
      const opened = yield* api.OpenEditor({ refId: card.id })
      yield* api.CommitEditorDrafts({
        refId: card.id,
        expectedRowVersion: opened.ref.rowVersion,
        fields: opened.drafts.map((d) => ({ field: d.key.field, draftId: d.id, expectedRowVersion: d.rowVersion })),
        message: null
      })
      return card.id
    })
  )

const open = async (page: Page, refId: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${refId}`)
  // The card's save cluster, first: an open note has its own.
  await expect(saveCluster(page).first()).toHaveAttribute("data-save-state", NOTHING_TO_SAVE)
}

const field = (page: Page, name: string) => page.getByRole("textbox", { name: new RegExp(`^${name}`) })

/** Opens a card's note from its collapsed row (DESIGN §4.1). */
const openNote = async (page: Page, title: string) => {
  await cardFieldsTab(page, "Notes")
  return noteText(page.getByRole("list", { name: "The card's notes" }), title)
}
/** The card's save cluster (an open note has its own). */
const state = (page: Page) => saveCluster(page).first()

/** Waits until what was typed is kept on the server (the toolbar's `data-keeping`). */
const kept = async (page: Page) => {
  const toolbar = page.locator("[data-keeping]")
  await expect(toolbar).toHaveAttribute("data-keeping", "true")
  await expect(toolbar).toHaveAttribute("data-keeping", "false")
  await expect(state(page)).toHaveAttribute("data-save-state", UNSAVED)
}

/** At phone and desktop width: nothing scrolls sideways; with SCREENSHOT_DIR set, saved there. */
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

test("a new card's fields save as a revision with a message, and survive a reload", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library`)
  await page.getByRole("button", { name: "New card" }).click()
  await page.getByRole("textbox", { name: "Display name", exact: true }).fill("Wren")
  await page.getByRole("button", { name: "Create" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Wren" })).toBeVisible()
  await expect(page.getByText("No chat uses it yet.", { exact: true })).toBeVisible()

  await field(page, "Description").fill("A lighthouse keeper who talks to gulls.")
  await kept(page)
  await field(page, "Scenario").fill("A storm is coming.")
  await kept(page)
  await expect(state(page)).toHaveAttribute("data-save-state", UNSAVED)
  await shoot(page, "card-editor")

  await saveRevision(page, "First pass")
  await expect(state(page)).toHaveAttribute("data-save-state", NOTHING_TO_SAVE)

  await page.reload()
  await expectTextBox(field(page, "Description"), "A lighthouse keeper who talks to gulls.")
  await page.getByRole("button", { name: "History", exact: true }).click()
  const revisions = page.getByRole("list", { name: "Revisions" }).getByRole("listitem")
  await expect(revisions).toHaveCount(2)
  await expect(revisions.first()).toContainText("First pass")
  await expect(revisions.first()).toContainText("latest")
  await expect(revisions.first()).toContainText("Saved")
  // What the save changed, in History's comparison with its parent: both fields, the text as typed.
  await revisions
    .first()
    .getByRole("button", { name: /^Revision 2 / })
    .click()
  const changes = page.getByRole("dialog").getByLabel("Revision changes")
  await expect(changes.locator("summary")).toHaveText(["Description", "Scenario"])
  await changes.getByText("Description", { exact: true }).click()
  await expectTextBox(
    changes.getByRole("textbox", { name: "After", exact: true }).first(),
    "A lighthouse keeper who talks to gulls."
  )
})

test("a field's edit history brings its text back after select-all and a stray key", async ({ page }) => {
  const refId = await savedCard("Undo", {})
  await open(page, refId)
  await cardFieldsTab(page, "Greetings")
  const greeting = field(page, "First message")
  await greeting.fill("The lamp needs oil before the storm comes in from the west.")
  await kept(page)
  await greeting.fill("x")
  await kept(page)
  await page.getByRole("button", { name: "Edit history of First message" }).click()
  const dialog = page.getByRole("dialog", { name: "Edit history: First message" })
  // The state before the wipe is picked to begin with; putting it back makes it the newest.
  await expect(dialog.getByLabel("Text of the state")).toHaveText(
    "The lamp needs oil before the storm comes in from the west."
  )
  await dialog.getByRole("button", { name: "Put this text in the box" }).click()
  await expect(dialog).toHaveCount(0)
  await expectTextBox(greeting, "The lamp needs oil before the storm comes in from the west.")
  // The history: the text put back is the newest state, after the wipe, which stays in the list.
  await page.getByRole("button", { name: "Edit history of First message" }).click()
  const states = dialog.getByRole("list", { name: "Earlier states" }).getByRole("listitem")
  await expect(states.first()).toContainText("Put back from this list")
  await expect(states.nth(1)).toContainText("1 characters")
})

test("a field another tab typed on meanwhile keeps that tab's text in its edit history", async ({ page }) => {
  const refId = (await savedCard("Two tabs", {})) as RefId
  await open(page, refId)
  await cardFieldsTab(page, "Greetings")
  const greeting = field(page, "First message")
  await greeting.fill("hello")
  await kept(page)
  // Another tab, which saw "hello", types on.
  await admin((api) =>
    Effect.gen(function* () {
      const opened = yield* api.OpenEditor({ refId })
      const draft = opened.drafts.find((d) => d.status === "active")!
      yield* api.SaveEditorDraft({
        draftId: draft.id,
        refId,
        field: draft.key.field,
        content: "hello from the other tab",
        expectedRowVersion: draft.rowVersion,
        expectedSession: draft.session,
        baseRevisionId: null
      })
    })
  )
  await greeting.fill("hello from this tab")
  await kept(page)
  await saveRevision(page)
  await expect(state(page)).toHaveAttribute("data-save-state", NOTHING_TO_SAVE)
  const texts = await admin((api) => editHistoryTexts(api, refId, textField(["first_mes"])))
  expect(texts[0]).toBe("hello from this tab")
  expect(texts).toContain("hello from the other tab")
})

test("an earlier revision restores as a new one", async ({ page }) => {
  const refId = await savedCard("Restore", { scenario: "A storm." })
  await admin((api) =>
    Effect.gen(function* () {
      const opened = yield* api.OpenEditor({ refId: refId as RefId })
      const draft = opened.drafts[0]!
      yield* api.SaveEditorDraft({
        draftId: draft.id,
        expectedSession: draft.session,
        refId: refId as RefId,
        field: draft.key.field,
        content: "A calm sea.",
        expectedRowVersion: draft.rowVersion,
        baseRevisionId: opened.ref.headRevisionId
      })
      const again = yield* api.OpenEditor({ refId: refId as RefId })
      yield* api.CommitEditorDrafts({
        refId: refId as RefId,
        expectedRowVersion: again.ref.rowVersion,
        fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: again.drafts[0]!.rowVersion }],
        message: "Calm"
      })
    })
  )
  await open(page, refId)
  await expectTextBox(field(page, "Scenario"), "A calm sea.")
  await page.getByRole("button", { name: "History", exact: true }).click()
  const revisions = page.getByRole("list", { name: "Revisions" }).getByRole("listitem")
  await expect(revisions).toHaveCount(3)
  await revisions
    .nth(1)
    .getByRole("button", { name: /^Revision \d+ / })
    .click()
  await page.getByRole("dialog").getByRole("radio", { name: "As it is now" }).click()
  await page.getByRole("dialog").getByText("Scenario", { exact: true }).click()
  await expectTextBox(page.getByRole("dialog").getByRole("textbox", { name: "Before", exact: true }), "A storm.")
  await expectTextBox(page.getByRole("dialog").getByRole("textbox", { name: "After", exact: true }), "A calm sea.")
  await page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true }).click()
  await expect(revisions).toHaveCount(4)
  await expect(revisions.first()).toContainText("Restored the revision of")
  await page.getByRole("button", { name: "Close" }).click()
  await expectTextBox(field(page, "Scenario"), "A storm.")
})

test("forking a card is one action, and takes the unsaved changes along", async ({ page }) => {
  const refId = await savedCard("Wren", { description: "A keeper." })
  await open(page, refId)
  await field(page, "Description").fill("A keeper in the rain.")
  await kept(page)
  await page.getByRole("button", { name: "Fork", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Fork card" })
  await dialog.getByRole("textbox", { name: "Display name", exact: true }).fill("Noir Wren")
  // Nothing to choose: a card's fork always takes them (owner, 2026-11-02).
  await expect(dialog.getByRole("checkbox")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Fork card" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Noir Wren" })).toBeVisible()
  await expect(page.getByText("variant", { exact: true })).toHaveCount(0)
  await expectTextBox(field(page, "Description"), "A keeper in the rain.")
  await page.goto(`${server().url}/library/${refId}`)
  await expect(page.getByRole("heading", { level: 1, name: "Wren" })).toBeVisible()
  await expectTextBox(field(page, "Description"), "A keeper.")
  await expect(state(page)).toHaveAttribute("data-save-state", NOTHING_TO_SAVE)
  // The original's edit history keeps the moved text: one pick puts it back.
  await page.getByRole("button", { name: "Edit history of Description" }).click()
  const history = page.getByRole("dialog", { name: "Edit history: Description" })
  await expect(history.getByLabel("Text of the state")).toHaveText("A keeper in the rain.")
  await history.getByRole("button", { name: "Put this text in the box" }).click()
  await expectTextBox(field(page, "Description"), "A keeper in the rain.")
})

test("a preset's prompts reorder by dragging and by keyboard, and toggle", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const refId = await importPreset(page, await presetFile("default"))
  await open(page, refId)
  const order = page.getByRole("list", { name: "Prompt order" })
  const names = () =>
    order
      .getByRole("button", { name: /^Move / })
      .evaluateAll((handles) => handles.map((handle) => handle.getAttribute("aria-label")!.slice("Move ".length)))
  expect((await names()).slice(0, 3)).toEqual(["Main Prompt", "World Info (before)", "Persona Description"])

  await page.getByRole("button", { name: "Collapse all", exact: true }).click()
  // Drag "Persona Description" above "Main Prompt".
  const handle = order.getByRole("button", { name: "Move Persona Description" })
  const target = (await order.getByRole("listitem").first().boundingBox())!
  const from = (await handle.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2, target.y + 4, { steps: 8 })
  await page.mouse.up()
  expect((await names()).slice(0, 3)).toEqual(["Persona Description", "Main Prompt", "World Info (before)"])

  // The keyboard: the handle keeps its focus as its prompt moves.
  await order.getByRole("button", { name: "Move Main Prompt" }).focus()
  await page.keyboard.press("ArrowDown")
  await expect(order.getByRole("button", { name: "Move Main Prompt" })).toBeFocused()
  expect((await names()).slice(0, 3)).toEqual(["Persona Description", "World Info (before)", "Main Prompt"])

  // The new order waits behind the unsaved bar; the switch is live.
  const held = page.getByRole("region", { name: "Unsaved changes" })
  await expect(held).toContainText("new order")
  await page.getByRole("switch", { name: "Send Chat Examples" }).click()
  await expect(page.getByRole("switch", { name: "Send Chat Examples" })).not.toBeChecked()
  await expect(state(page)).toHaveAttribute("data-save-state", UNSAVED)
  await shoot(page, "preset-editor")
  await held.getByRole("button", { name: "Save", exact: true }).click()
  await expect(held).toHaveCount(0)
  await page.reload()
  await expect(state(page)).toHaveAttribute("data-save-state", NOTHING_TO_SAVE)
  expect((await names()).slice(0, 3)).toEqual(["Persona Description", "World Info (before)", "Main Prompt"])
  await expect(page.getByRole("switch", { name: "Send Chat Examples" })).not.toBeChecked()
})

test("a preset's regex scripts run only once the user allows them", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const refId = await importPreset(page, await presetFile("full"))
  await open(page, refId)
  await expect(page.getByText("These scripts don't run until you allow them")).toBeVisible()
  await page.getByRole("button", { name: "Allow them" }).click()
  const confirm = page.getByRole("alertdialog")
  await expect(confirm).toContainText("Strip thinking from the prompt")
  await confirm.getByRole("button", { name: "Allow them" }).click()
  await expect(page.getByText("These scripts are allowed to run")).toBeVisible()
  await page.getByRole("button", { name: "History", exact: true }).click()
  await expect(page.getByRole("list", { name: "Revisions" }).getByRole("listitem").first()).toContainText(
    "Allowed the regex scripts to run"
  )
})

test("search and replace runs across fields, and a pattern that backtracks forever is stopped", async ({ page }) => {
  const refId = await savedCard("Search", {
    description: "The keeper keeps the lamp.",
    first_mes: "Hello, keeper.",
    personality: `${"a".repeat(34)}!`
  })
  await open(page, refId)
  await page.getByRole("button", { name: "Search and replace", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Search and replace" })
  await dialog.getByRole("textbox", { name: "Find" }).fill("keeper")
  await dialog.getByRole("button", { name: "Find" }).click()
  await expect(dialog.getByRole("status")).toHaveText("2 matches.")
  await dialog.getByRole("textbox", { name: "Replace with" }).fill("warden")
  // Changing the replacement invalidates the old preview; Find again before applying it.
  await expect(dialog.getByRole("list", { name: "Matches", exact: true })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Replace all" })).toBeDisabled()
  await dialog.getByRole("button", { name: "Find" }).click()
  await expect(dialog.getByRole("status")).toHaveText("2 matches.")
  await expect(dialog.getByRole("list", { name: "Matches", exact: true }).getByRole("listitem")).toHaveText([
    /→ warden/,
    /→ warden/
  ])
  await dialog.getByRole("button", { name: "Replace all" }).click()
  await expect(dialog.getByRole("status")).toHaveText("No matches.")

  // A regular expression with a group, then one that would run for minutes.
  await dialog.getByRole("checkbox", { name: "Regular expression" }).click()
  await dialog.getByRole("textbox", { name: "Find" }).fill("(lamp)")
  await dialog.getByRole("textbox", { name: "Replace with" }).fill("great $1")
  await dialog.getByRole("button", { name: "Find" }).click()
  await expect(dialog.getByRole("status")).toHaveText("1 match.")
  await dialog.getByRole("button", { name: "Replace all" }).click()
  await dialog.getByRole("textbox", { name: "Find" }).fill("(a+)+$")
  await dialog.getByRole("button", { name: "Find" }).click()
  await expect(dialog.getByText(/took over 2 seconds, so it was stopped/)).toBeVisible()
  await dialog.press("Escape")

  await expectTextBox(field(page, "Description"), "The warden keeps the great lamp.")
  await cardFieldsTab(page, "Greetings")
  await expectTextBox(field(page, "First message"), "Hello, warden.")
  // The page stayed responsive: typing still works.
  await cardFieldsTab(page, "Definition")
  await field(page, "Scenario").fill("Still here.")
  await expectTextBox(field(page, "Scenario"), "Still here.")
})

test("an update with a conflict is resolved field by field", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const refId = await importPreset(page, await presetFile("default", "Write vivid prose."))
  await admin((api) =>
    Effect.gen(function* () {
      const opened = yield* api.OpenEditor({ refId: refId as RefId })
      const draft = yield* api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId: refId as RefId,
        field: textField(["prompts", "identifier=main", "content"]),
        content: "Write calm prose.",
        expectedRowVersion: null,
        baseRevisionId: opened.ref.headRevisionId
      })
      yield* api.CommitEditorDrafts({
        refId: refId as RefId,
        expectedRowVersion: opened.ref.rowVersion,
        fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
    })
  )
  await importPreset(page, await presetFile("default", "Write terse prose."), refId)
  await open(page, refId)
  await page.getByRole("button", { name: "Review the update" }).click()
  const dialog = page.getByRole("dialog", { name: "Update" })
  const conflict = dialog.getByRole("list", { name: "Conflicts" }).getByRole("listitem")
  await expect(conflict).toHaveCount(1)
  await expect(conflict).toContainText("Prompt “Main Prompt”: Content")
  await expect(conflict).toContainText("Write calm prose.")
  await expect(conflict).toContainText("Write terse prose.")
  await conflict.getByRole("radio", { name: "Edit it" }).click()
  await conflict.getByRole("textbox").fill("Write terse, calm prose.")
  await dialog.getByRole("button", { name: "Apply these" }).click()
  await expect(page.getByText("A newer version of the file was imported")).toHaveCount(0)
  await expectTextBox(page.getByRole("textbox", { name: /^Prompt: Main Prompt/ }), "Write terse, calm prose.")
})

/** Records each request to /library/drafts: whether it was sent with `keepalive`, and how it went. */
const recordBeacons = (page: Page, fail = 0) =>
  page.evaluate((fail) => {
    const original = window.fetch
    const sent: Array<boolean> = []
    let failing = fail
    Object.assign(window, { __beacons: sent })
    window.fetch = (input, init) => {
      if (input !== "/library/drafts") return original(input, init)
      sent.push(init?.keepalive === true)
      return failing-- > 0 ? Promise.reject(new Error("offline")) : original(input, init)
    }
  }, fail)

const beacons = (page: Page) => page.evaluate(() => (window as unknown as { __beacons: Array<boolean> }).__beacons)

test("note text typed just before closing the tab is kept, with a warning first", async ({ page }) => {
  const { card, note } = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Notes", name: "Notes" })
      const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "Outfit" })
      return { card, note }
    })
  )
  await open(page, card.id)
  await recordBeacons(page)
  await openNote(page, "Outfit")
  const content = page.getByRole("region", { name: "Note Outfit" }).getByRole("textbox", { name: /^Text of/ })
  await content.fill("A grey coat, typed in the last moment.")
  const warned = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(warned).toBe(true)
  // Closing goes ahead: what was typed leaves with the page, in a request that outlives it.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
  expect(await beacons(page)).toEqual([true])
  await page.close()
  await expect
    .poll(async () => {
      const opened = await admin((api) => api.OpenEditor({ refId: note.id }))
      return opened.drafts.filter((d) => d.status === "active").map((d) => d.content)
    })
    .toEqual(["A grey coat, typed in the last moment."])
})

test("a card's notes are blocks, and the card has no modules section (DESIGN §5.0)", async ({ page }) => {
  const refId = await savedCard("Rows", {})
  await admin((api) => api.CreateCardNote({ cardRefId: refId as RefId, title: "Scarf" }))
  await open(page, refId)
  await expect(page.getByRole("button", { name: "Add a module" })).toHaveCount(0)
  await cardFieldsTab(page, "Notes")
  const list = page.getByRole("list", { name: "The card's notes" })
  // Its header says where it goes, open or closed; its settings are folded under its text.
  await expect(noteToggle(list, "Scarf")).toContainText("End of tail")
  await closeNoteBlock(noteBlock(list, "Scarf"), "Scarf")
  await expect(noteToggle(list, "Scarf")).toContainText("End of tail")
  await noteSettings(list, "Scarf")
  // In the card editor, a note's condition can name the card itself.
  await page.getByRole("region", { name: "Note Scarf" }).getByRole("combobox", { name: "When it applies" }).click()
  await page.getByRole("option", { name: "On a chosen character's turn" }).click()
  await expect(
    page.getByRole("region", { name: "Note Scarf" }).getByRole("toolbar").getByText("Rows", { exact: true })
  ).toBeVisible()
})

test("a send that failed as the page went is sent again the next time it goes", async ({ page }) => {
  const refId = await savedCard("Retry", {})
  await open(page, refId)
  await recordBeacons(page, 1)
  await field(page, "Description").fill("Sent twice if need be.")
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
  await expect.poll(() => beacons(page)).toEqual([true])
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
  await expect.poll(() => beacons(page)).toEqual([true, true])
})

test("text too long to send as the page goes: the warning stops a close, and a reload brings it back", async ({
  page
}) => {
  const { card, note } = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Long note", name: "Long" })
      const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "Long" })
      return { card, note }
    })
  )
  await open(page, card.id)
  await openNote(page, "Long")
  const content = () => page.getByRole("region", { name: "Note Long" }).getByRole("textbox", { name: /^Text of/ })
  const saved = async () => {
    const opened = await admin((api) => api.OpenEditor({ refId: note.id }))
    return opened.drafts.filter((d) => d.status === "active").map((d) => d.content.length)
  }
  // Closing asks first, and staying lets the text reach the server.
  const dialogs: Array<string> = []
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type())
    void (dialogs.length === 1 ? dialog.dismiss() : dialog.accept())
  })
  await content().fill("x".repeat(70_000))
  await page.close({ runBeforeUnload: true })
  await expect.poll(() => dialogs).toEqual(["beforeunload"])
  expect(page.isClosed()).toBe(false)
  await expect.poll(saved).toEqual([70_000])

  // A reload that goes ahead anyway: too long for the request, the copy in the browser keeps it.
  await content().fill("y".repeat(70_000))
  await page.reload()
  await openNote(page, "Long")
  await expect(page.getByText("Brought back from this browser")).toBeVisible()
  await expectTextBox(content(), "y".repeat(70_000))
  await expect
    .poll(async () => (await admin((api) => api.OpenEditor({ refId: note.id }))).drafts[0]?.content[0])
    .toBe("y")
})

interface StoredCopy {
  readonly userId: string
  readonly refId: string
  readonly field: string
  readonly content: string
  readonly at: number
}

/** Copy identities only: transferring multi-megabyte payloads makes the capacity poll time out. */
const storedCopies = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Array<Pick<StoredCopy, "refId">>>((resolve) => {
        const request = indexedDB.open("rp-editor-copies", 1)
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore("copies", { keyPath: "key" })
          store.createIndex("userId", "userId")
          store.createIndex("ref", ["userId", "refId"])
        }
        request.onsuccess = () => {
          const db = request.result
          const all = db.transaction("copies").objectStore("copies").getAll()
          all.onsuccess = () => {
            db.close()
            resolve((all.result as Array<StoredCopy>).map(({ refId }) => ({ refId })))
          }
        }
      })
  )

/** A copy as a page that closed before the server had the text leaves it. */
const leaveCopy = (page: Page, copy: StoredCopy) =>
  page.evaluate(
    (copy) =>
      new Promise<void>((resolve) => {
        const request = indexedDB.open("rp-editor-copies", 1)
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore("copies", { keyPath: "key" })
          store.createIndex("userId", "userId")
          store.createIndex("ref", ["userId", "refId"])
        }
        request.onsuccess = () => {
          const db = request.result
          const transaction = db.transaction("copies", "readwrite")
          transaction.objectStore("copies").put({
            ...copy,
            key: crypto.randomUUID(),
            ancestors: [],
            save: {
              kind: "editor",
              payload: {
                refId: copy.refId,
                field: copy.field,
                content: copy.content,
                draftId: null,
                expectedRowVersion: null,
                expectedSession: null,
                baseRevisionId: null
              }
            }
          })
          transaction.oncomplete = () => {
            db.close()
            resolve()
          }
        }
      }),
    copy
  )

test("text kept in this browser is saved before logout and survives another user's session", async ({ page }) => {
  const me = await admin((api) => api.Whoami())
  await admin((api) =>
    api.CreateUser({ handle: "copy-reader", displayName: "Reader", role: "user", password: "reader-password-1" })
  )
  const refId = await savedCard("Kept", {})
  await open(page, refId)
  const copy = { userId: me.id, refId, field: textField(["description"]), content: "Unsent.", at: Date.now() }
  await leaveCopy(page, copy)
  await page.getByRole("button", { name: "Log out" }).first().click()
  await expect(page).toHaveURL(/\/login/)
  expect(await storedCopies(page)).toEqual([])

  // A different account cannot read or delete the earlier account's pending copy.
  await leaveCopy(page, copy)
  await apiLogin(page.request, server(), "copy-reader", "reader-password-1")
  await page.goto(`${server().url}/library`)
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible()
  expect(await storedCopies(page)).toHaveLength(1)
})

test("copies stay with a note in the bin and survive age and capacity limits", async ({ page }) => {
  const me = await admin((api) => api.Whoami())
  const { card, note } = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Copies", name: "Copies" })
      const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "Gone" })
      return { card, note }
    })
  )
  await open(page, card.id)
  const field = textField(["content"])
  await openNote(page, "Gone")
  await page.getByRole("button", { name: "Actions for Gone" }).click()
  await page.getByRole("menuitem", { name: "Delete the note" }).click()
  await expect(page.getByRole("region", { name: "Note Gone" })).toHaveCount(0)
  // A copy of the note left behind: kept while the note is in the bin, saved once it's back.
  await leaveCopy(page, { userId: me.id, refId: note.id, field, content: "Unsent.", at: Date.now() })
  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: "Copies" })).toBeVisible()
  expect((await storedCopies(page)).filter((c) => c.refId === note.id)).toHaveLength(1)
  const [item] = await admin((api) => api.ListBin({ limit: 10, before: null }))
  await admin((api) => api.RestoreBinItem({ itemId: item!.id }))
  await page.reload()
  await openNote(page, "Gone")
  await expectTextBox(
    page.getByRole("region", { name: "Note Gone" }).getByRole("textbox", { name: /^Text of/ }),
    "Unsent."
  )
  await expect.poll(async () => (await storedCopies(page)).filter((c) => c.refId === note.id)).toEqual([])

  const day = 24 * 60 * 60 * 1000
  const now = Date.now()
  await leaveCopy(page, { userId: me.id, refId: "old", field, content: "A week ago.", at: now - 8 * day })
  for (const [index, refId] of ["a", "b", "c"].entries()) {
    await leaveCopy(page, { userId: me.id, refId, field, content: "x".repeat(3_500_000), at: now - (3 - index) * 1000 })
  }
  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: "Copies" })).toBeVisible()
  await expect
    .poll(async () => (await storedCopies(page)).map((copy) => copy.refId).sort())
    .toEqual(["a", "b", "c", "old"])
})

test("Main can be switched off and moved but a custom Main cannot be deleted", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const file = JSON.parse(await fixture("default"))
  file.prompts.find((p: { identifier: string }) => p.identifier === "main").system_prompt = false
  const refId = await importPreset(page, Buffer.from(JSON.stringify(file)))
  await open(page, refId)
  const main = page.locator('[data-prompt="main"]')
  await main.getByRole("button", { name: "Actions for Main Prompt" }).click()
  await expect(page.getByRole("menuitem", { name: "Insert a prompt below" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Delete the prompt" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  const send = main.getByRole("switch", { name: "Send Main Prompt" })
  await send.click()
  await expect(send).not.toBeChecked()
  await main.getByRole("button", { name: "Move Main Prompt" }).press("ArrowDown")
  await expect(page.locator("[data-prompt]").nth(1)).toHaveAttribute("data-prompt", "main")
  // The switch is live; the move waits behind the unsaved bar, kept on the server like typing.
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toContainText("new order")
  await expect(state(page)).toHaveAttribute("data-save-state", UNSAVED)
  await page.reload()
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toContainText("new order")
  await expect(page.locator("[data-prompt]").nth(1)).toHaveAttribute("data-prompt", "main")
  await expect(main.getByRole("switch", { name: "Send Main Prompt" })).not.toBeChecked()
  await expect(main.getByRole("button", { name: "Delete the prompt" })).toHaveCount(0)

  // A prompt added waits behind the bar with the move (owner, 2026-11-02), across a reload,
  // its text typed at once; Save puts both in the preset.
  await main.getByRole("button", { name: "Actions for Main Prompt" }).click()
  await page.getByRole("menuitem", { name: "Insert a prompt below" }).click()
  const bar = page.getByRole("region", { name: "Unsaved changes" })
  await expect(bar).toContainText("new order · 1 prompt added")
  await page.getByRole("textbox", { name: "Prompt: New prompt", exact: true }).fill("Added in the large editor.")
  await page.reload()
  await expect(bar).toContainText("1 prompt added")
  await expectTextBox(
    page.getByRole("textbox", { name: "Prompt: New prompt", exact: true }),
    "Added in the large editor."
  )
  await bar.getByRole("button", { name: "Save", exact: true }).click()
  await expect(bar).toHaveCount(0)
  const saved = await page.evaluate(() => document.querySelectorAll("[data-prompt]").length)
  await page.reload()
  await expect(page.locator("[data-prompt]")).toHaveCount(saved)
  await expect(page.locator("[data-prompt]").nth(2).getByText("New prompt", { exact: true })).toBeVisible()
})

test("card search opens and selects code editor and single-line matches", async ({ page }) => {
  const refId = await savedCard("Find keeper", { description: "The keeper keeps the lamp." })
  await open(page, refId)
  for (const label of ["Description", "Display name"]) {
    await page.getByRole("button", { name: "Search and replace", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Search and replace" })
    await dialog.getByRole("textbox", { name: "Find", exact: true }).fill("keeper")
    await dialog.getByRole("button", { name: "Find", exact: true }).click()
    await dialog.getByRole("button", { name: `Go to ${label}`, exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const target = page.getByRole("textbox", { name: label, exact: true })
    await expect(target).toBeFocused()
    await expect
      .poll(() =>
        target.evaluate((e) =>
          e instanceof HTMLInputElement
            ? e.value.slice(e.selectionStart!, e.selectionEnd!)
            : (e.getRootNode() as ShadowRoot & { getSelection: () => Selection | null }).getSelection()?.toString()
        )
      )
      .toBe("keeper")
  }
})
