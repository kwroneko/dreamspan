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
import type { RefId } from "@dreamspan/shared/library.ts"
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
  return { panel, chatId, refId: tides }
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
  await editor.getByRole("link", { name: "Large editor", exact: true }).click()
  const large = page.getByRole("region", { name: "Lorebook editor", exact: true })
  await expect(large.getByRole("list", { name: "Entries" })).toBeVisible()
  return large
}

const box = async (locator: Locator) => (await locator.boundingBox())!

test("lorebook entry review crops", async ({ page }) => {
  const { panel } = await setUp(page, "review", 1440)
  const editor = await openBook(page, panel, "review")
  await editor.getByRole("button", { name: "Open Harbour", exact: true }).click()
  await editor.getByRole("button", { name: "Settings of Harbour", exact: true }).click()
  await editor.screenshot({ path: join(shots, "panel-settings.png") })
  await editor.getByText("harbour, quay", { exact: true }).click()
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(shots, "panel-keys.png") })
  await page.keyboard.press("Escape")
  const large = await openLarge(page, editor)
  await large.getByRole("button", { name: "Open Harbour", exact: true }).click()
  await large.getByRole("button", { name: "Settings of Harbour", exact: true }).click()
  await large.screenshot({ path: join(shots, "large-settings.png") })
})

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
    await expect(editor.getByRole("link", { name: "Large editor", exact: true })).toBeVisible()
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
  await head.click({ position: { x: 2, y: area.height - 2 } })
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
  // The header's padding remains clickable when expanded.
  const opened = await box(head)
  await head.click({ position: { x: 2, y: opened.height - 2 } })
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
  const exportOnly = settings.getByRole("button", { name: "Card export only of Lamp", exact: true })
  await expect(exportOnly).toHaveText("Card export only")
  await expect(exportOnly.locator("[data-changed]")).toHaveCount(0)
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
  await expect(dialog.locator("[data-setting=sticky] [data-mixed]")).toHaveAccessibleName("Differs: 1 empty, 1 3")
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
  await expect(lamp.getByRole("spinbutton", { name: "Order of Lamp", exact: true })).toHaveValue("77")
})

// Owner, 2026-11-23: on a large screen the dialog was a narrow column to scroll through.
for (const [width, height] of [
  [2560, 1440],
  [1440, 1000],
  [390, 844]
] as const)
  test(`Edit N entries uses the screen's width at ${width}`, async ({ page }) => {
    const tag = `bulkwide${width}`
    const { panel } = await setUp(page, tag, width)
    await page.setViewportSize({ width, height })
    const editor = await openBook(page, panel, tag)
    await editor.getByRole("checkbox", { name: "Select Harbour", exact: true }).click()
    await editor.getByRole("checkbox", { name: "Select Lamp", exact: true }).click()
    await editor.getByRole("button", { name: "Edit 2 entries", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Edit 2 entries", exact: true })
    await expect(dialog.getByRole("region", { name: "Card export only" })).toBeVisible()
    // Let the opening scale settle before measuring.
    await expect
      .poll(() => dialog.evaluate((el) => getComputedStyle(el).scale), { timeout: 2000 })
      .toMatch(/^(none|1)$/)
    await page.screenshot({ path: join(shots, `mass-edit-${width}.png`) })
    const size = await dialog.evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      scroll: el.scrollHeight - el.clientHeight
    }))
    const columns = async (names: ReadonlyArray<string>) =>
      new Set(
        await Promise.all(names.map(async (name) => Math.round((await box(dialog.getByRole("region", { name }))).x)))
      ).size
    const boxes = ["Secondary keys", "Matching", "Inclusion group", "Recursion and budget", "Timing and filters"]
    if (width === 2560) {
      expect(size.width).toBeGreaterThan(1400)
      expect(size.scroll, "no vertical scrollbar").toBeLessThanOrEqual(0)
      expect(await columns(boxes), "boxed groups in columns").toBeGreaterThanOrEqual(3)
      // The top fields side by side.
      const order = await box(dialog.getByRole("spinbutton", { name: "Order", exact: true }))
      const depth = await box(dialog.getByRole("spinbutton", { name: "Depth", exact: true }))
      expect(Math.abs(order.y - depth.y)).toBeLessThan(2)
    }
    if (width === 1440) expect(await columns(boxes)).toBeGreaterThanOrEqual(2)
    if (width === 390) {
      expect(await columns(boxes), "one column on a phone").toBe(1)
      expect(size.width).toBeLessThanOrEqual(390)
    }
    expect.soft(await layoutAudit(page, { scope: '[role="dialog"]' }), `layout findings at ${width}`).toEqual([])
    // Still applies.
    await dialog.getByRole("checkbox", { name: "Change Order", exact: true }).click()
    await dialog.getByRole("spinbutton", { name: "Order", exact: true }).fill("55")
    await dialog.getByRole("button", { name: "Apply to 2 entries", exact: true }).click()
    await expect(dialog).toHaveCount(0)
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
  await panel.getByRole("button", { name: "Why below the history", exact: true }).click()
  await expect(page.getByText("When off, each entry uses its own position.", { exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
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

/** Measure the actual hit targets, so wrapper padding cannot hide an uneven gap. */
const equalHeaderGaps = async (scope: Locator, title: string) => {
  const header = scope
    .locator("[data-entry-header]")
    .filter({ has: scope.page().getByRole("textbox", { name: `Title of ${title}`, exact: true }) })
  const controls = header
    .locator(
      '[role=checkbox], [role=switch], [role=combobox], input[aria-label^="Title of "], input[type=number], button[aria-label^="Open "], button[aria-label^="Close "], button[aria-label^="More for "], button[aria-label^="Settings of "]'
    )
    .filter({ visible: true })
  const rects = await controls.evaluateAll((elements) =>
    elements
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return { name: element.getAttribute("aria-label"), x: rect.x, right: rect.right }
      })
      .sort((a, b) => a.x - b.x)
  )
  expect(rects.length).toBeGreaterThanOrEqual(5)
  const gaps = rects.slice(1).map((rect, i) => rect.x - rects[i]!.right)
  expect(Math.max(...gaps) - Math.min(...gaps), JSON.stringify({ rects, gaps })).toBeLessThanOrEqual(1)
  for (const gap of gaps) expect(gap).toBeCloseTo(8, 0)
}

const checkEntryControls = async (scope: Locator, width: number, large = false) => {
  const page = scope.page()
  await equalHeaderGaps(scope, "Harbour")
  await scope.getByRole("button", { name: "Open Harbour", exact: true }).click()
  await equalHeaderGaps(scope, "Harbour")
  if (large) {
    await expect(scope.getByRole("combobox", { name: "Strategy of Harbour", exact: true })).toBeVisible()
    await expect(scope.getByRole("combobox", { name: "Position of Harbour", exact: true })).toBeVisible()
  }
  const entry = scope.getByRole("group", { name: "Lorebook entry 0", exact: true })
  await entry.getByRole("button", { name: "Settings of Harbour", exact: true }).click()
  await expect(entry.getByRole("button", { name: /^Strategy and position/ })).toHaveCount(0)
  for (const name of ["Strategy", "Position", "Depth", "Order", "Trigger %"]) {
    await expect(scope.getByRole("button", { name: `About ${name}`, exact: true })).toBeVisible()
    await expect(
      scope.getByRole(name === "Strategy" || name === "Position" ? "combobox" : "spinbutton", {
        name: `${name} of Harbour`,
        exact: true
      })
    ).toBeVisible()
  }
  // Editing by pointer or keyboard never opens an explanation on the field itself.
  const keys = entry.getByRole("textbox", { name: "Primary keys", exact: true })
  const keyExplanation = page
    .getByText(
      "Include the entry when any key appears in the messages it checks. One key per line; /pattern/flags is a regular expression.",
      { exact: true }
    )
    .filter({ visible: true })
  await entry.locator("[data-entry-keys] span[data-own-click]").click()
  await expect(keys).toBeFocused()
  await keys.hover()
  await page.waitForTimeout(650)
  await expect(keyExplanation).toHaveCount(0)
  await keys.click()
  await keys.fill("harbour\nquay\n/pier/i")
  await expect(keyExplanation).toHaveCount(0)
  await keys.blur()
  await keys.focus()
  await page.waitForTimeout(650)
  await expect(keyExplanation).toHaveCount(0)
  const help = entry.getByRole("button", { name: "About Primary keys", exact: true })
  const row = entry.locator("[data-entry-keys]")
  expect((await box(help)).x).toBeGreaterThan((await box(keys)).x)
  expect(Math.abs((await box(help)).y - (await box(row)).y)).toBeLessThanOrEqual(6)
  await help.click()
  await expect(keyExplanation).toBeVisible()
  await expect(entry.getByRole("button", { name: "Close Harbour", exact: true })).toBeVisible()
  for (const [name, count] of [
    ["Strategy", 3],
    ["Position", 8]
  ] as const) {
    const select = scope.getByRole("combobox", { name: `${name} of Harbour`, exact: true })
    // The shared Select is a button with the same styled trigger as the preset editor.
    await expect(select).toHaveJSProperty("tagName", "BUTTON")
    await expect(select).toHaveClass(/bg-surface/)
    await select.click()
    const options = page.getByRole("option")
    await expect(options).toHaveCount(count)
    for (const option of await options.all()) {
      const explanation = await option.getAttribute("data-explain")
      expect(explanation?.length).toBeGreaterThan(15)
      await option.hover()
      if (width < 640) await expect(option.locator("[aria-hidden=true]").last()).toHaveText(explanation!)
      else await expect(page.locator("[data-explanation]")).toHaveText(explanation!)
    }
    await page.keyboard.press("Escape")
  }
}

for (const width of [390, 1024, 1440])
  test(`entry header gaps, field help and always-visible placement controls at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000)
    page.setDefaultTimeout(15_000)
    const tag = `controls${width}`
    const { panel, refId } = await setUp(page, tag, width)
    const editor = await openBook(page, panel, tag)
    await checkEntryControls(editor, width)
    const large = await openLarge(page, editor)
    await checkEntryControls(large, width, true)
    // The library page also exercises the wide table, which the chat overlay may not fit.
    await page.goto(`${server().url}/library/${refId}`)
    const main = page.getByRole("main")
    // Each view's open entries are its own URL's (owner, 2026-11-18): the library page opens
    // with Harbour closed, whatever the chat's views had open.
    await expect(main.getByRole("button", { name: "Open Harbour", exact: true })).toBeVisible()
    await checkEntryControls(main, width, true)
  })
