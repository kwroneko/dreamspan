// The card and preset editors (ARCHITECTURE.md §14) in a real browser against the real
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

test("a field another tab typed on meanwhile keeps that tab's text, recovered once saved", async ({ page }) => {
  const refId = (await savedCard("Two tabs", {})) as RefId
  await open(page, refId)
  const greeting = field(page, "First message")
  await greeting.fill("hello")
  await kept(page)
  // Another tab, which saw "hello", types on.
  await admin((api) =>
    Effect.gen(function* () {
      const opened = yield* api.OpenEditor({ refId })
      const draft = opened.drafts.find((d) => d.status === "active")!
      yield* api.SaveEditorDraft({
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
  await page.getByRole("button", { name: "Save (1)" }).click()
  await page.getByRole("dialog", { name: "Save a revision" }).getByRole("button", { name: "Save revision" }).click()
  await expect(state(page)).toHaveText("Everything is saved.")
  const recovered = await admin((api) =>
    Effect.flatMap(api.ListRecoveredTexts({ limit: 10, before: null }), (texts) =>
      Effect.succeed(texts.map((t) => t.content))
    )
  )
  expect(recovered).toContain("hello from the other tab")
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
  const content = page.getByRole("region", { name: "Note Outfit" }).getByRole("textbox", { name: /^Content/ })
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
  const content = () => page.getByRole("region", { name: "Note Long" }).getByRole("textbox", { name: /^Content/ })
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
  await expect(page.getByText("Brought back from this browser")).toBeVisible()
  await expect(content()).toHaveValue("y".repeat(70_000))
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

/** The editors' copies in this browser (backup.ts), as stored. */
const storedCopies = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Array<StoredCopy>>((resolve) => {
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
            resolve(all.result as Array<StoredCopy>)
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
          transaction.objectStore("copies").put({ ...copy, key: `${copy.userId}\n${copy.refId}\n${copy.field}` })
          transaction.oncomplete = () => {
            db.close()
            resolve()
          }
        }
      }),
    copy
  )

test("text kept in this browser is its user's: logging out or another user's session clears it", async ({ page }) => {
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

  // A session that ended without a logout leaves the copy; the next user's session clears it.
  await leaveCopy(page, copy)
  await apiLogin(page.request, server(), "copy-reader", "reader-password-1")
  await page.goto(`${server().url}/library`)
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible()
  await expect.poll(() => storedCopies(page)).toEqual([])
})

test("copies go with a deleted note, after a week, and oldest first past a size", async ({ page }) => {
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
  await leaveCopy(page, { userId: me.id, refId: note.id, field, content: "Unsent.", at: Date.now() })
  await page.getByRole("region", { name: "Note Gone" }).getByRole("button", { name: "Delete the note" }).click()
  await expect.poll(async () => (await storedCopies(page)).filter((c) => c.refId === note.id)).toEqual([])

  const day = 24 * 60 * 60 * 1000
  const now = Date.now()
  await leaveCopy(page, { userId: me.id, refId: "old", field, content: "A week ago.", at: now - 8 * day })
  for (const [index, refId] of ["a", "b", "c"].entries()) {
    await leaveCopy(page, { userId: me.id, refId, field, content: "x".repeat(3_500_000), at: now - (3 - index) * 1000 })
  }
  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: "Copies" })).toBeVisible()
  await expect.poll(async () => (await storedCopies(page)).map((copy) => copy.refId).sort()).toEqual(["b", "c"])
})
