// The lorebook editors as reworked on the owner's feedback of 2026-11-02: the header's rows and
// their collapse order at several widths, Search and replace as a pressed toggle with its panel
// below it, the select-all checkbox, whole-header expansion, the settings' accordions with their
// summaries, "Edit N entries" with Mixed values, and the chat's Lorebooks list and placement switch.
// Made-up books and card only.
import { mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { RefId } from "@rp/shared/library.ts"
import { layoutAudit } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-lorebook-rework-screenshots"))
mkdirSync(shots, { recursive: true })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const book = (name: string) => ({
  name,
  entries: {
    0: { uid: 0, key: ["harbour", "quay"], comment: "Harbour", content: "Boats rock at the quay.", order: 10 },
    1: { uid: 1, key: ["lamp"], comment: "Lamp", content: "The lamp burns blue.", order: 20, sticky: 3 },
    2: {
      uid: 2,
      key: ["fog"],
      keysecondary: ["night"],
      selective: true,
      comment: "Fog",
      content: "Fog rolls in at dusk.",
      order: 30,
      disable: true
    }
  }
})

const upload = async (page: Page, name: string, data: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    data: Buffer.from(JSON.stringify(data)),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { library: { ref: { id: RefId } } }).library.ref.id
}

/** A chat with a card whose own book is also added to the chat as a library book, and one more book. */
const setUp = async (page: Page, tag: string, width: number) => {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const tides = await upload(page, `Tides ${tag}`, book(`Tides ${tag}`))
  const twin = await upload(page, `Mira ${tag} 's Lorebook`, {
    name: `Mira ${tag} 's Lorebook`,
    entries: { 0: { uid: 0, key: ["lens"], comment: "Lens", content: "The lens.", order: 1 } }
  })
  await upload(page, `Mira ${tag}`, {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: `Mira ${tag}`,
      description: "A keeper.",
      first_mes: "Hello.",
      character_book: {
        name: `Mira ${tag} 's Lorebook`,
        entries: [{ keys: ["lens"], content: "The lens.", enabled: true, insertion_order: 1, id: 1 }]
      }
    }
  })
  const chatId = await admin((api) =>
    Effect.gen(function* () {
      const card = (yield* api.ListCards()).find((c) => c.name === `Mira ${tag}`)!
      const chat = yield* api.CreateChat({ title: `Rework ${tag}` })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      for (const ref of [tides, twin])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Lorebook", ref, active: true } })
      return chat.id
    })
  )
  await page.goto(`${server().url}/chats/${chatId}`)
  const panel = await openPanel(page, "Lorebooks")
  return { panel, chatId }
}

const openBook = async (page: Page, panel: Locator, tag: string) => {
  await panel
    .getByRole("list", { name: "Lorebooks in this chat" })
    .getByRole("button", { name: new RegExp(`^Tides ${tag}`) })
    .click()
  const editor = panel.getByRole("region", { name: `Lorebook Tides ${tag}`, exact: true })
  await expect(editor.getByRole("list", { name: "Entries" })).toBeVisible()
  return editor
}

const openLarge = async (page: Page, editor: Locator) => {
  await editor.getByRole("button", { name: "Large editor", exact: true }).click()
  const large = page.getByRole("dialog", { name: "Lorebook editor", exact: true })
  await expect(large.getByRole("list", { name: "Entries" })).toBeVisible()
  return large
}

const box = async (locator: Locator) => (await locator.boundingBox())!

/** The toolbar's rows: each one line, nothing wrapping into fragments, the filter field bounded. */
const checkToolbar = async (scope: Locator, label: string) => {
  const toolbar = scope.locator("[data-lorebook-toolbar]")
  for (const name of ["Editing", "Filter entries"]) {
    const row = toolbar.getByRole(name === "Editing" ? "toolbar" : "group", { name, exact: true })
    if ((await row.count()) === 0) continue
    // The editing row is one line; in the filter row, Show and the sort stay on one line
    // together (the filter field and a leading Add entry may each take their own line).
    const middles = await row.evaluate((element, editing) => {
      const group = editing ? element : element.querySelector(":scope > div:has([aria-label='Sort entries by'])")!
      return [...group.children]
        .filter((child) => (child as HTMLElement).offsetParent !== null)
        .map((child) => Math.round((child.getBoundingClientRect().top + child.getBoundingClientRect().bottom) / 2))
    }, name === "Editing")
    expect(new Set(middles).size, `${label}: ${name} controls on one line`).toBe(1)
  }
  const filter = toolbar.getByRole("searchbox", { name: "Filter by titles, keys and content" })
  expect((await box(filter)).width, `${label}: filter width bounded`).toBeLessThanOrEqual(385)
  // Layout findings inside the toolbar and the list header only.
  const area = await box(toolbar)
  const violations = (await layoutAudit(scope.page())).filter(
    (v) => v.box && v.box.y >= area.y - 1 && v.box.y + v.box.height <= area.y + area.height + 1
  )
  expect.soft(violations, `${label}: layout findings in the toolbar`).toEqual([])
}

for (const width of [390, 1024, 1440, 1920])
  test(`the header rows keep one line each and collapse in order at ${width}px`, async ({ page }, info) => {
    test.setTimeout(120_000)
    const tag = `w${width}`
    const { panel } = await setUp(page, tag, width)
    const editor = await openBook(page, panel, tag)
    // Title row: the name, then the icon buttons.
    await expect(editor.getByRole("button", { name: "Large editor", exact: true })).toBeVisible()
    await expect(editor.getByRole("button", { name: "Close the lorebook", exact: true })).toBeVisible()
    // Editing row: Add entry, the save cluster beside it, then Search and replace.
    const editing = editor.getByRole("toolbar", { name: "Editing", exact: true })
    await expect(editing.getByRole("button", { name: "Add entry" })).toBeVisible()
    await expect(editing.getByRole("button", { name: "Search and replace", exact: true })).toBeVisible()
    await expect(editor.getByRole("status").filter({ hasText: "3 entries" })).toBeVisible()
    await page.screenshot({ path: join(shots, `panel-${width}-pre.png`) })
    await checkToolbar(editor, `side panel ${width}`)
    await info.attach(`panel-${width}`, {
      body: await page.screenshot({ path: join(shots, `panel-${width}.png`) }),
      contentType: "image/png"
    })
    if (width >= 1024) {
      const large = await openLarge(page, editor)
      await checkToolbar(large, `large editor ${width}`)
      await info.attach(`large-${width}`, {
        body: await page.screenshot({ path: join(shots, `large-${width}.png`) }),
        contentType: "image/png"
      })
    }
  })

test("Search and replace opens below its button, pressed, and closes by its X or Escape", async ({ page }) => {
  const tag = "find"
  const { panel } = await setUp(page, tag, 1440)
  const editor = await openBook(page, panel, tag)
  const button = editor.getByRole("button", { name: "Search and replace", exact: true })
  await expect(button).toHaveAttribute("aria-pressed", "false")
  await button.hover()
  await expect(page.getByText("Click to open search and replace").filter({ visible: true })).toBeVisible()
  await button.click()
  await expect(button).toHaveAttribute("aria-pressed", "true")
  await page.mouse.move(0, 0)
  await button.hover()
  await expect(page.getByText("Click to close search and replace").filter({ visible: true })).toBeVisible()
  const findPanel = editor.getByRole("region", { name: "Search and replace", exact: true })
  await expect(findPanel).toBeVisible()
  expect((await box(findPanel)).y).toBeGreaterThan((await box(button)).y + (await box(button)).height - 1)
  await findPanel.getByRole("button", { name: "Close", exact: true }).click()
  await expect(findPanel).toHaveCount(0)
  await expect(button).toHaveAttribute("aria-pressed", "false")
  await expect(button).toBeFocused()
  await button.click()
  await findPanel.getByRole("textbox", { name: "Find" }).fill("Lamp")
  await page.keyboard.press("Escape")
  await expect(findPanel).toHaveCount(0)
  await expect(button).toBeFocused()

  // Go to a match in a title: the entry opens with its title focused, the match selected.
  await button.click()
  await findPanel.getByRole("textbox", { name: "Find" }).fill("Harb")
  await findPanel.getByRole("button", { name: "Find", exact: true }).click()
  await findPanel
    .getByRole("button", { name: /^Go to .*title/i })
    .first()
    .click()
  const title = editor.getByRole("textbox", { name: "Title of Harbour" })
  await expect(title).toBeFocused()
  expect(
    await title.evaluate((input: HTMLInputElement) => input.value.slice(input.selectionStart!, input.selectionEnd!))
  ).toBe("Harb")
})

test("the header checkbox selects all shown, none, or shows some; whole headers open entries", async ({ page }) => {
  const tag = "select"
  const { panel } = await setUp(page, tag, 1440)
  const editor = await openBook(page, panel, tag)
  const all = editor.getByRole("checkbox", { name: "Select all entries shown", exact: true })
  await expect(all).not.toBeChecked()
  await editor.getByRole("checkbox", { name: "Select Lamp", exact: true }).click()
  await expect(all).toHaveAttribute("aria-checked", "mixed")
  await expect(editor.getByText("1 selected", { exact: true })).toBeVisible()
  await all.click()
  await expect(all).toBeChecked()
  await expect(editor.getByText("3 selected", { exact: true })).toBeVisible()
  await all.click()
  await expect(all).not.toBeChecked()
  await expect(editor.getByText(/selected$/)).toHaveCount(0)

  // The header's empty space toggles; its controls keep their own clicks.
  const header = editor.getByRole("listitem").filter({ has: page.getByRole("textbox", { name: "Title of Harbour" }) })
  const toggle = (open: boolean) => editor.getByRole("button", { name: `${open ? "Close" : "Open"} Harbour` })
  const head = header.locator("[data-entry-header]")
  const area = await box(head)
  await page.mouse.click(area.x + area.width - 90, area.y + area.height - 4)
  await expect(toggle(true)).toHaveAttribute("aria-expanded", "true")
  await editor.getByRole("textbox", { name: "Title of Harbour" }).click()
  await expect(toggle(true)).toBeVisible()
  await header.getByRole("switch", { name: "Harbour enabled" }).click()
  await expect(toggle(true)).toBeVisible()
  await header.getByRole("checkbox", { name: "Select Harbour" }).click()
  await expect(toggle(true)).toBeVisible()
  await header.getByText("harbour, quay", { exact: true }).click()
  await expect(header.getByRole("textbox", { name: "Primary keys" })).toBeFocused()
  await page.keyboard.press("Escape")
  // Under the switch, beside the keys line: the header's own space.
  const opened = await box(head)
  const under = await box(header.getByRole("switch", { name: "Harbour enabled" }))
  await page.mouse.click(under.x + under.width / 2, opened.y + opened.height - 3)
  await expect(toggle(false)).toHaveAttribute("aria-expanded", "false")
})

test("an entry's settings are closed accordions with summaries and a marker", async ({ page }) => {
  const tag = "accordion"
  const { panel } = await setUp(page, tag, 1440)
  const editor = await openBook(page, panel, tag)
  await editor.getByRole("button", { name: "Open Lamp" }).click()
  const lamp = editor.getByRole("group", { name: /^Lorebook entry/ })
  await lamp.getByRole("button", { name: "Settings of Lamp" }).click()
  const settings = lamp.getByRole("region", { name: "Entry settings" })
  // The text comes first, the settings after it.
  expect((await box(lamp.getByRole("textbox", { name: "Entry content" }))).y).toBeLessThan((await box(settings)).y)
  const timing = settings.getByRole("button", { name: /^Timing and filters of Lamp/ })
  await expect(timing).toHaveAttribute("aria-expanded", "false")
  await expect(timing).toHaveAccessibleName("Timing and filters of Lamp, changed from the defaults")
  await expect(timing).toContainText("Sticky 3")
  await expect(settings.getByRole("button", { name: "Inclusion group of Lamp", exact: true })).toContainText(
    "Default settings"
  )
  await expect(settings.getByRole("button", { name: /^Card export only of Lamp/ })).toBeVisible()
  await expect(lamp.getByText(/kept for export/i)).toHaveCount(0)
  await timing.click()
  await expect(settings.getByRole("spinbutton", { name: "Sticky" })).toHaveValue("3")
})

test("Edit N entries changes two settings at once, shows Mixed, and clears an empty field", async ({ page }) => {
  const tag = "bulk"
  const { panel } = await setUp(page, tag, 1440)
  const editor = await openBook(page, panel, tag)
  await editor.getByRole("checkbox", { name: "Select Harbour", exact: true }).click()
  await editor.getByRole("checkbox", { name: "Select Lamp", exact: true }).click()
  await editor.getByRole("button", { name: "Edit 2 entries", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Edit 2 entries", exact: true })
  // Sticky differs (none and 3): an empty control with "Mixed" as its placeholder, and the marker.
  const sticky = dialog.getByRole("spinbutton", { name: "Sticky" })
  await expect(sticky).toBeDisabled()
  await expect(sticky).toHaveValue("")
  await expect(sticky).toHaveAttribute("placeholder", "Mixed")
  await expect(dialog.locator("[data-setting=sticky] [data-mixed]")).toHaveAccessibleName("Mixed: 1 empty, 1 3")
  // Order is shared? No: 10 and 20, also Mixed. Depth is shared: shown greyed.
  await expect(dialog.getByRole("spinbutton", { name: "Depth", exact: true })).toHaveValue("4")
  await expect(dialog.getByRole("button", { name: /^Apply to 0 entries/ })).toBeDisabled()
  // Two at once: Order to 77, and Sticky ticked empty, which clears it.
  await dialog.getByRole("checkbox", { name: "Change Order", exact: true }).click()
  await dialog.getByRole("spinbutton", { name: "Order", exact: true }).fill("77")
  await dialog.getByRole("checkbox", { name: "Change Sticky", exact: true }).click()
  await expect(sticky).toBeEnabled()
  await dialog.getByRole("button", { name: "Apply to 2 entries", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await editor.getByRole("button", { name: "Open Lamp" }).click()
  const lamp = editor.getByRole("group", { name: /^Lorebook entry/ })
  await lamp.getByRole("button", { name: "Settings of Lamp" }).click()
  await expect(lamp.getByRole("button", { name: "Timing and filters of Lamp", exact: true })).toContainText(
    "Default settings"
  )
  await lamp.getByRole("button", { name: /^Strategy and position of Lamp/ }).click()
  await expect(lamp.getByRole("spinbutton", { name: "Order of Lamp" }).or(lamp.getByLabel("Order"))).toHaveValue("77")
})

test("the Lorebooks list shows every source and count, the twin, and the placement switch", async ({ page }) => {
  const tag = "list"
  const { panel } = await setUp(page, tag, 1440)
  const list = panel.getByRole("list", { name: "Lorebooks in this chat" })
  await expect(list.getByText(`Mira ${tag}'s own lorebook · 1 entry`)).toBeVisible()
  await expect(list.getByText("Added to this chat · 3 entries", { exact: true })).toBeVisible()
  await expect(
    list.getByText(`Added to this chat · 1 entry · Also active as Mira ${tag}'s own lorebook`, { exact: true })
  ).toBeVisible()
  const force = panel.getByRole("switch", { name: "Force all lorebook entries below the history" })
  await expect(force).toBeChecked()
  await expect(panel.getByText("Applies to this chat, for all lorebooks.", { exact: true })).toBeVisible()
  await force.click()
  await expect(force).not.toBeChecked()
})

test("Go to a match in a preset prompt's name opens its name with the match selected", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const preset = JSON.parse(
    readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
  ) as unknown
  const ref = await upload(page, "Go to preset", preset)
  await page.goto(`${server().url}/library/${ref}`)
  const button = page.getByRole("button", { name: "Search and replace", exact: true })
  await button.click()
  await expect(button).toHaveAttribute("aria-pressed", "true")
  const findPanel = page.getByRole("region", { name: "Search and replace", exact: true })
  await findPanel.getByRole("button", { name: "Prompt names", exact: true }).click()
  await findPanel.getByRole("textbox", { name: "Find" }).fill("Auxiliary")
  await findPanel.getByRole("button", { name: "Find", exact: true }).click()
  await findPanel
    .getByRole("button", { name: /^Go to / })
    .first()
    .click()
  const name = page.getByRole("textbox", { name: "New name for Auxiliary Prompt", exact: true })
  await expect(name).toBeFocused()
  expect(
    await name.evaluate((input: HTMLInputElement) => input.value.slice(input.selectionStart!, input.selectionEnd!))
  ).toBe("Auxiliary")
  await page.keyboard.press("Escape")
})
