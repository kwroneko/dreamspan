// The card and preset editors (ARCHITECTURE.md §13) in a real browser against the real
// server: edits kept as drafts, saved as revisions, undone, restored, forked, reordered,
// approved, searched and resolved. Every card and preset here is made up.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { textField } from "@rp/shared/editing.ts"
import type { RefId } from "@rp/shared/library.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

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
        fields: opened.drafts.map((d) => ({ field: d.key.field, expectedRowVersion: d.rowVersion })),
        message: null
      })
      return card.id
    })
  )

const open = async (page: Page, refId: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${refId}`)
  await expect(page.getByRole("status").filter({ hasText: "Everything is saved." })).toBeVisible()
}

const field = (page: Page, name: string) => page.getByRole("textbox", { name: new RegExp(`^${name}`) })
const state = (page: Page) => page.getByRole("status").filter({ hasText: /saved|changes|Keeping/ })

/** Waits until what was typed is kept on the server as a draft. */
const kept = async (page: Page) => {
  await expect(state(page)).toHaveText("Keeping your changes…")
  await expect(state(page)).toContainText("kept as drafts")
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

test("a new card's fields save as a revision, after a diff, and survive a reload", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library`)
  await page.getByRole("button", { name: "New card" }).click()
  await page.getByRole("textbox", { name: "Name" }).fill("Wren")
  await page.getByRole("button", { name: "Create" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Wren" })).toBeVisible()
  await expect(page.getByText("used by 0 chats")).toBeVisible()

  await field(page, "Description").fill("A lighthouse keeper who talks to gulls.")
  await kept(page)
  await field(page, "Scenario").fill("A storm is coming.")
  await kept(page)
  await expect(state(page)).toHaveText("2 fields have changes, kept as drafts until you save a revision.")
  await shoot(page, "card-editor")

  await page.getByRole("button", { name: "Save (2)" }).click()
  const dialog = page.getByRole("dialog", { name: "Save a revision" })
  const changes = dialog.getByRole("list", { name: "Changes" })
  await expect(changes.getByRole("listitem")).toHaveCount(2)
  await expect(changes.getByRole("listitem").first()).toContainText("Description")
  await expect(changes.getByLabel("Added").first()).toHaveText("A lighthouse keeper who talks to gulls.")
  await dialog.getByRole("textbox", { name: "What changed (optional)" }).fill("First pass")
  await dialog.getByRole("button", { name: "Save revision" }).click()
  await expect(page.getByText("Saved a revision.")).toBeVisible()
  await expect(state(page)).toHaveText("Everything is saved.")

  await page.reload()
  await expect(field(page, "Description")).toHaveValue("A lighthouse keeper who talks to gulls.")
  await page.getByRole("button", { name: "History", exact: true }).click()
  const revisions = page.getByRole("list", { name: "Revisions" }).getByRole("listitem")
  await expect(revisions).toHaveCount(2)
  await expect(revisions.first()).toContainText("First pass")
  await expect(revisions.first()).toContainText("saved version")
})

test("undo brings a field's text back after select-all and a stray key", async ({ page }) => {
  const refId = await savedCard("Undo", {})
  await open(page, refId)
  const greeting = field(page, "First message")
  await greeting.fill("The lamp needs oil before the storm comes in from the west.")
  await kept(page)
  await greeting.fill("x")
  await kept(page)
  await page.getByRole("button", { name: "Undo First message" }).click()
  await expect(greeting).toHaveValue("The lamp needs oil before the storm comes in from the west.")
  // The history: the text as first saved, the wipe, and the undo, which can be undone too.
  await page.getByRole("button", { name: "History of First message" }).click()
  const states = page.getByRole("list", { name: "Earlier states" }).getByRole("listitem")
  await expect(states).toHaveCount(3)
  await expect(states.first()).toContainText("Restored.")
})

test("an earlier revision restores as a new one", async ({ page }) => {
  const refId = await savedCard("Restore", { scenario: "A storm." })
  await admin((api) =>
    Effect.gen(function* () {
      const opened = yield* api.OpenEditor({ refId: refId as RefId })
      const draft = opened.drafts[0]!
      yield* api.SaveEditorDraft({
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
        fields: [{ field: draft.key.field, expectedRowVersion: again.drafts[0]!.rowVersion }],
        message: "Calm"
      })
    })
  )
  await open(page, refId)
  await expect(field(page, "Scenario")).toHaveValue("A calm sea.")
  await page.getByRole("button", { name: "History", exact: true }).click()
  const revisions = page.getByRole("list", { name: "Revisions" }).getByRole("listitem")
  await expect(revisions).toHaveCount(3)
  await revisions.nth(1).getByRole("button", { name: "Compare" }).click()
  await expect(revisions.nth(1).getByLabel("Removed")).toHaveText("storm")
  await revisions.nth(1).getByRole("button", { name: "Restore" }).click()
  await expect(revisions).toHaveCount(4)
  await expect(revisions.first()).toContainText("Restored the revision of")
  await page.getByRole("button", { name: "Close" }).click()
  await expect(field(page, "Scenario")).toHaveValue("A storm.")
})

test("making a variant is one action, and takes the unsaved changes along", async ({ page }) => {
  const refId = await savedCard("Wren", { description: "A keeper." })
  await open(page, refId)
  await field(page, "Description").fill("A keeper in the rain.")
  await kept(page)
  await page.getByRole("button", { name: "Make a variant" }).click()
  const dialog = page.getByRole("dialog", { name: "Make a variant" })
  await dialog.getByRole("textbox", { name: "Library label" }).fill("Noir Wren")
  await expect(dialog.getByRole("checkbox", { name: "Take my unsaved changes to the variant" })).toBeChecked()
  await dialog.getByRole("button", { name: "Make the variant" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Noir Wren" })).toBeVisible()
  await expect(page.getByText("variant", { exact: true })).toBeVisible()
  await expect(field(page, "Description")).toHaveValue("A keeper in the rain.")
  const variants = page.getByRole("navigation", { name: "Variants" })
  await variants.getByRole("link", { name: "Wren" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Wren" })).toBeVisible()
  await expect(field(page, "Description")).toHaveValue("A keeper.")
  await expect(state(page)).toHaveText("Everything is saved.")
})

test("a preset's prompts reorder by dragging and by keyboard, and toggle", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const refId = await importPreset(page, await presetFile("default"))
  await open(page, refId)
  const order = page.getByRole("list", { name: "Prompt order" })
  const names = () =>
    order
      .getByRole("button", { name: /^Move / })
      .evaluateAll((handles) => handles.map((handle) => handle.getAttribute("aria-label")!.slice("Move ".length)))
  expect((await names()).slice(0, 3)).toEqual(["Main Prompt", "World Info (before)", "Persona Description"])

  // Drag "Persona Description" above "Main Prompt".
  const handle = page.getByRole("button", { name: "Move Persona Description" })
  const target = (await order.getByRole("listitem").first().boundingBox())!
  const from = (await handle.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2, target.y + 4, { steps: 8 })
  await page.mouse.up()
  expect((await names()).slice(0, 3)).toEqual(["Persona Description", "Main Prompt", "World Info (before)"])

  // The keyboard: the handle keeps its focus as its prompt moves.
  await page.getByRole("button", { name: "Move Main Prompt" }).focus()
  await page.keyboard.press("ArrowDown")
  await expect(page.getByRole("button", { name: "Move Main Prompt" })).toBeFocused()
  expect((await names()).slice(0, 3)).toEqual(["Persona Description", "World Info (before)", "Main Prompt"])

  await page.getByRole("switch", { name: "Send Chat Examples" }).click()
  await kept(page)
  await shoot(page, "preset-editor")
  await page.getByRole("button", { name: "Save (1)" }).click()
  await page.getByRole("dialog", { name: "Save a revision" }).getByRole("button", { name: "Save revision" }).click()
  await expect(page.getByText("Saved a revision.")).toBeVisible()
  await page.reload()
  await expect(state(page)).toHaveText("Everything is saved.")
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
  await page.getByRole("button", { name: "Search" }).click()
  const dialog = page.getByRole("dialog", { name: "Search and replace" })
  await dialog.getByRole("textbox", { name: "Find" }).fill("keeper")
  await dialog.getByRole("button", { name: "Find" }).click()
  await expect(dialog.getByRole("status")).toHaveText("2 matches.")
  await dialog.getByRole("textbox", { name: "Replace with" }).fill("warden")
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

  await expect(field(page, "Description")).toHaveValue("The warden keeps the great lamp.")
  await expect(field(page, "First message")).toHaveValue("Hello, warden.")
  // The page stayed responsive: typing still works.
  await field(page, "Scenario").fill("Still here.")
  await expect(field(page, "Scenario")).toHaveValue("Still here.")
})

test("an update with a conflict is resolved field by field", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const refId = await importPreset(page, await presetFile("default", "Write vivid prose."))
  await admin((api) =>
    Effect.gen(function* () {
      const opened = yield* api.OpenEditor({ refId: refId as RefId })
      const draft = yield* api.SaveEditorDraft({
        refId: refId as RefId,
        field: textField(["prompts", "identifier=main", "content"]),
        content: "Write calm prose.",
        expectedRowVersion: null,
        baseRevisionId: opened.ref.headRevisionId
      })
      yield* api.CommitEditorDrafts({
        refId: refId as RefId,
        expectedRowVersion: opened.ref.rowVersion,
        fields: [{ field: draft.key.field, expectedRowVersion: draft.rowVersion }],
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
  await page.getByRole("button", { name: "Edit Main Prompt" }).click()
  await expect(page.getByRole("textbox", { name: /^Prompt/ })).toHaveValue("Write terse, calm prose.")
})

test("note text typed just before closing the tab is kept, with a warning first", async ({ page }) => {
  const { card, note } = await admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Notes", name: "Notes" })
      const note = yield* api.CreateCardNote({ cardRefId: card.id, title: "Outfit" })
      return { card, note }
    })
  )
  await open(page, card.id)
  const content = page.getByRole("region", { name: "Note Outfit" }).getByRole("textbox", { name: /^Content/ })
  await content.fill("A grey coat, typed in the last moment.")
  const warned = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(warned).toBe(true)
  // Closing goes ahead: what was typed leaves with the page.
  await page.close()
  await expect
    .poll(async () => {
      const opened = await admin((api) => api.OpenEditor({ refId: note.id }))
      return opened.drafts.filter((d) => d.status === "active").map((d) => d.content)
    })
    .toEqual(["A grey coat, typed in the last moment."])
})

test("removing an edited module takes its drafts with it, and the card still saves", async ({ page }) => {
  const refId = await savedCard("Modules", {})
  await open(page, refId)
  await page.getByRole("button", { name: "Add a module", exact: true }).click()
  const module = page.getByRole("region", { name: "Module New module" })
  await module.getByRole("textbox", { name: /^Content/ }).fill("A draft that goes with its module.")
  await kept(page)
  await page.getByRole("button", { name: "Remove the module", exact: true }).click()
  await field(page, "Scenario").fill("Still saved.")
  await kept(page)
  // The module's content draft ended with it; nothing hidden is left to save.
  const drafts = await admin((api) => api.OpenEditor({ refId: refId as RefId }))
  expect(drafts.drafts.filter((d) => d.status === "active" && d.key.field.endsWith('"content"]'))).toEqual([])
  await page.getByRole("button", { name: /^Save \(/ }).click()
  await page.getByRole("dialog", { name: "Save a revision" }).getByRole("button", { name: "Save revision" }).click()
  await expect(page.getByText("Saved a revision.")).toBeVisible()
  await expect(state(page)).toHaveText("Everything is saved.")
  const opened = await admin((api) => api.OpenEditor({ refId: refId as RefId }))
  expect(opened.doc.modules).toEqual([])
  expect(opened.doc.scenario).toBe("Still saved.")
})
