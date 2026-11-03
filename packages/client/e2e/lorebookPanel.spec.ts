// The chat's Lorebooks tab and the lorebook editors (owner, 2026-11-01): one stable list with
// the card's own book, the chat's and the preset's, switches that show at once and keep their
// rows, a book opened below the list with compact entry headers, Expand all, Enable all /
// Disable all and Edit N entries as unsaved changes Revert takes back, search and replace by Content /
// Keys / Both, and a preset sending a book. Made-up books, card and preset only.
import { mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { NOTHING_TO_SAVE, UNSAVED, expectSaveState } from "./support/saveRevision.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-lorebook-panel-screenshots"))
mkdirSync(shots, { recursive: true })

const presetFile = JSON.parse(
  readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
) as Record<string, unknown>

// Synthetic ST world info files.
const tides = (name: string) => ({
  name,
  entries: {
    0: { uid: 0, key: ["harbour", "quay"], comment: "Harbour", content: "Boats rock at the quay.", order: 10 },
    1: { uid: 1, key: ["lamp", "lantern"], comment: "Lamp", content: "The lamp burns blue at night.", order: 20 },
    2: {
      uid: 2,
      key: ["fog"],
      keysecondary: ["night"],
      selective: true,
      comment: "Fog",
      content: "Fog rolls in at dusk.",
      order: 30,
      constant: true,
      position: 4,
      depth: 2,
      role: 1,
      probability: 40,
      useProbability: true
    }
  }
})
const style = (name: string) => ({
  name,
  entries: {
    0: { uid: 0, key: ["fight"], comment: "Combat style", content: "Keep fights short and physical.", order: 5 }
  }
})

const upload = async (page: Page, name: string, data: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    data: Buffer.from(JSON.stringify(data)),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

const setUp = async (page: Page, tag: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await upload(page, `Tides ${tag}`, tides(`Tides ${tag}`))
  await upload(page, `Style ${tag}`, style(`Style ${tag}`))
  await upload(page, `Preset ${tag}`, presetFile)
  await upload(page, `Wren ${tag}`, {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: `Wren ${tag}`,
      description: "A lighthouse keeper.",
      first_mes: "The lamp turns.",
      character_book: {
        name: `Wren's notes ${tag}`,
        entries: [
          { keys: ["lens"], content: "The lens came from a wreck.", enabled: true, insertion_order: 1, id: 1 },
          { keys: ["gull"], content: "A gull named Pell.", enabled: true, insertion_order: 2, id: 2 }
        ]
      }
    }
  })
  return admin((api) =>
    Effect.gen(function* () {
      const preset = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === `Preset ${tag}`)!
      yield* api.ChangeGenerationDefaults({ change: { preset: preset.id } })
      const books = yield* api.ListLibrary({ kind: "lorebook" })
      const book = books.find((r) => r.label === `Tides ${tag}`)!
      const card = (yield* api.ListCards()).find((c) => c.name === `Wren ${tag}`)!
      const chat = yield* api.CreateChat({ title: `Lore ${tag}` })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Lorebook", ref: book.id, active: true } })
      return { chatId: chat.id, bookId: book.id, presetId: preset.id }
    })
  )
}

const theme = async (page: Page, width: number, scheme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 })
  await page.emulateMedia({ colorScheme: scheme })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), scheme)
}

/** The chat's own books as the server has them now, on or off. */
const listed = (chatId: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.GetChat({ chatId: chatId as never })
      const cast = yield* api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId, forkId: chat.currentForkId })
      return cast.listedLorebooks.map(({ on }) => ({ on }))
    })
  )

const books = (panel: Locator) => panel.getByRole("list", { name: "Lorebooks in this chat" })
const bookNames = (panel: Locator) =>
  books(panel)
    .getByRole("listitem")
    .evaluateAll((items) => items.map((item) => item.querySelector("button[aria-pressed] span")?.textContent ?? ""))

const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)

for (const [width, scheme] of [
  [1440, "light"],
  [390, "dark"]
] as const) {
  test(`the Lorebooks tab lists every book once, switches at once and opens a book below it (${width}px ${scheme})`, async ({
    page
  }) => {
    test.setTimeout(180_000)
    await theme(page, width, scheme)
    const tag = `${width}`
    const { chatId } = await setUp(page, tag)
    await page.goto(`${server().url}/chats/${chatId}`)
    const panel = await openPanel(page, "Lorebooks")
    await expect(books(panel).getByRole("listitem")).toHaveCount(2)
    expect(await bookNames(panel)).toEqual([`Wren's notes ${tag}`, `Tides ${tag}`])

    // Off keeps the row, in its place, at once; it's still there after a reload.
    const tidesSwitch = books(panel).getByRole("switch", { name: `Tides ${tag}`, exact: true })
    await tidesSwitch.click()
    await expect(tidesSwitch).not.toBeChecked()
    expect(await bookNames(panel)).toEqual([`Wren's notes ${tag}`, `Tides ${tag}`])
    await expect(books(panel).getByText("Off in this chat")).toBeVisible()
    // The switch shows at once; the reload waits for the server to have it (slow under load).
    await expect.poll(() => listed(chatId), { timeout: 60_000 }).toEqual([{ on: false }])
    await page.reload()
    const again = await openPanel(page, "Lorebooks")
    await expect(books(again).getByRole("switch", { name: `Tides ${tag}`, exact: true })).not.toBeChecked()
    await books(again)
      .getByRole("switch", { name: `Tides ${tag}`, exact: true })
      .click()
    await expect(books(again).getByRole("switch", { name: `Tides ${tag}`, exact: true })).toBeChecked()

    // Picking the row opens the book below the list; the list doesn't move.
    await books(again)
      .getByRole("button", { name: new RegExp(`^Tides ${tag}`) })
      .click()
    const editor = again.getByRole("region", { name: `Lorebook Tides ${tag}` })
    await expect(editor.getByRole("list", { name: "Entries" })).toBeVisible()
    expect(await bookNames(again)).toEqual([`Wren's notes ${tag}`, `Tides ${tag}`])
    // Compact headers: keys under the title and the essentials as badges.
    const fog = editor.getByRole("listitem").filter({ has: page.getByRole("textbox", { name: "Title of Fog" }) })
    await expect(fog.getByText("Constant", { exact: true })).toBeVisible()
    await expect(fog.getByText("40%", { exact: true })).toBeVisible()
    await expect(fog.getByText("AND ANY: night", { exact: true })).toBeVisible()
    await expect(editor.getByRole("button", { name: /^Keys of Lamp: lamp, lantern/ })).toBeVisible()
    await page.screenshot({ path: join(shots, `panel-${width}-${scheme}.png`), fullPage: false })

    // Expand all (owner, 2026-11-02: open entries are for skimming): each shows its title, its
    // keys on a quiet line under it and its text, and none of its settings.
    await editor.getByRole("button", { name: "Expand all", exact: true }).click()
    await expect(editor.getByRole("textbox", { name: "Entry content" })).toHaveCount(3)
    await expect(editor.getByRole("textbox", { name: "Primary keys" })).toHaveCount(3)
    const lamp = editor.getByRole("group", { name: /^Lorebook entry/ }).filter({
      has: page.getByRole("textbox", { name: "Title of Lamp" })
    })
    await expect(lamp.getByText("lamp, lantern", { exact: true })).toBeVisible()
    await expect(lamp.getByRole("textbox", { name: "Entry content" })).toBeVisible()
    await expect(editor.getByRole("region", { name: "Entry settings" })).toHaveCount(0)
    for (const control of ["Use secondary keys", "Case sensitive", "Group", "Strategy"])
      await expect(editor.getByLabel(control, { exact: true })).toHaveCount(0)
    await expect(editor.getByText(/One per line|regular expression/)).toHaveCount(0)
    // The keys line is edited in place: clicked, it's the box, one key per line.
    await lamp.getByText("lamp, lantern", { exact: true }).click()
    await expect(lamp.getByRole("textbox", { name: "Primary keys" })).toBeFocused()
    await expect(lamp.getByRole("textbox", { name: "Primary keys" })).toHaveValue("lamp\nlantern")
    await page.keyboard.press("Escape")
    await expect(lamp.getByText("lamp, lantern", { exact: true })).toBeVisible()
    await lamp.getByRole("button", { name: "Settings of Lamp" }).click()
    await lamp.getByRole("button", { name: /^Secondary keys of Lamp/ }).click()
    await expect(lamp.getByRole("switch", { name: "Use secondary keys" })).toBeVisible()
    await expect(editor.getByRole("region", { name: "Entry settings" })).toHaveCount(1)
    await editor.getByRole("button", { name: "Collapse all", exact: true }).click()
    await expect(editor.getByRole("textbox", { name: "Entry content" })).toHaveCount(0)

    // Disable all is an ordinary unsaved change (owner, 2026-11-02): no revision, no Undo of its
    // own; Revert beside Save takes it back.
    await editor.getByRole("button", { name: "More for all entries", exact: true }).click()
    await page.getByRole("menuitem", { name: "Disable all" }).click()
    const toast = page.getByText("Disabled all 3 entries", { exact: true })
    await expect(toast).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0)
    for (const title of ["Harbour", "Lamp", "Fog"])
      await expect(editor.getByRole("switch", { name: `${title} enabled` })).not.toBeChecked()
    await expectSaveState(editor, UNSAVED, {
      timeout: 30_000
    })
    await editor.getByRole("button", { name: "Revert", exact: true }).click()
    for (const title of ["Harbour", "Lamp", "Fog"])
      await expect(editor.getByRole("switch", { name: `${title} enabled` })).toBeChecked({ timeout: 30_000 })
    await expectSaveState(editor, NOTHING_TO_SAVE, {
      timeout: 30_000
    })

    // Edit 2 entries: the ticked setting on the chosen entries; the others keep theirs.
    await editor.getByRole("checkbox", { name: "Select Harbour" }).click()
    await editor.getByRole("checkbox", { name: "Select Lamp" }).click()
    await editor.getByRole("button", { name: "Edit 2 entries", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Edit 2 entries" })
    await dialog.getByRole("checkbox", { name: "Change Strategy", exact: true }).click()
    await dialog.getByRole("combobox", { name: "Strategy" }).click()
    await page.getByRole("option", { name: "Vectorized" }).click()
    await dialog.getByRole("button", { name: "Apply to 2 entries", exact: true }).click()
    await expect(page.getByText("Changed Strategy on 2 entries", { exact: true })).toBeVisible({
      timeout: 30_000
    })
    for (const title of ["Harbour", "Lamp"])
      await expect(
        editor
          .getByRole("listitem")
          .filter({ has: page.getByRole("textbox", { name: `Title of ${title}` }) })
          .getByText("Vector", { exact: true })
      ).toBeVisible()
    await expect(fog.getByText("Constant", { exact: true })).toBeVisible()
    await editor.getByRole("checkbox", { name: "Select all entries shown" }).click()
    await editor.getByRole("checkbox", { name: "Select all entries shown" }).click()
    await expect(editor.getByRole("checkbox", { name: "Select all entries shown" })).not.toBeChecked()
    // Unsaved too, until Save keeps it as the next revision.
    await expectSaveState(editor, UNSAVED)
    await editor.getByRole("button", { name: "Save", exact: true }).first().click()
    await expectSaveState(editor, NOTHING_TO_SAVE, {
      timeout: 30_000
    })

    // Search and replace in the keys only.
    await editor.getByRole("button", { name: "Search and replace", exact: true }).click()
    // On a phone "Look in" folds behind Options with the other options.
    if (width < 640) await editor.getByRole("button", { name: /^Options/ }).click()
    await editor.getByRole("button", { name: "Keys", exact: true }).click()
    await editor.getByRole("textbox", { name: "Find" }).fill("lamp")
    await editor.getByRole("textbox", { name: "Replace with" }).fill("torch")
    await editor.getByRole("button", { name: "Find", exact: true }).click()
    await expect(editor.getByText("1 match.")).toBeVisible()
    await editor.getByRole("button", { name: "Replace all", exact: true }).click()
    await expect(editor.getByRole("button", { name: /^Keys of Lamp: torch, lantern/ })).toBeVisible({ timeout: 30_000 })

    // The card's own book opens the same way, rooted in the card.
    await books(again)
      .getByRole("button", { name: new RegExp(`^Wren's notes ${tag}`) })
      .click()
    const own = again.getByRole("region", { name: `Lorebook Wren's notes ${tag}` })
    await expect(own.getByText(/saving it saves the card/)).toHaveCount(0)
    await expect(own.getByRole("button", { name: /^Keys of .*: lens/ })).toBeVisible()
    await noOverflow(page)
    await page.screenshot({ path: join(shots, `panel-card-${width}-${scheme}.png`), fullPage: false })
  })
}

test("a preset sends a book: attached in the Prompt preset tab, listed from the preset in the Lorebooks tab", async ({
  page
}) => {
  test.setTimeout(180_000)
  await theme(page, 1440, "light")
  const { chatId } = await setUp(page, "preset")
  await page.goto(`${server().url}/chats/${chatId}`)
  const presetTab = await openPanel(page, "Prompt preset")
  const attached = presetTab.getByRole("list", { name: "Lorebooks sent with this preset" })
  await presetTab.getByRole("button", { name: "Attach a lorebook", exact: true }).click({ timeout: 60_000 })
  await presetTab.getByRole("list", { name: "Lorebooks to add" }).getByText("Style preset", { exact: true }).click()
  await expect(attached.getByRole("switch", { name: "Style preset" })).toBeChecked()
  // Attaching waits behind the unsaved bar (owner, 2026-11-02): Revert takes it off again.
  const bar = presetTab.getByRole("region", { name: "Unsaved changes" })
  await expect(bar).toContainText("1 lorebook attached")
  await page.screenshot({ path: join(shots, "preset-block-1440.png"), fullPage: false })
  await presetTab.getByRole("button", { name: "Revert", exact: true }).click()
  await expect(attached).toHaveCount(0)
  await presetTab.getByRole("button", { name: "Attach a lorebook", exact: true }).click()
  await presetTab.getByRole("list", { name: "Lorebooks to add" }).getByText("Style preset", { exact: true }).click()
  await presetTab.getByRole("button", { name: "Save", exact: true }).click()
  await expect(bar).toHaveCount(0)
  await expect(attached.getByRole("switch", { name: "Style preset" })).toBeChecked()
  // Taking it off waits too: it's still sent until Save, and Revert puts it back.
  await attached.getByRole("button", { name: "Take Style preset off the preset", exact: true }).click()
  await expect(bar).toContainText("1 lorebook taken off")
  await presetTab.getByRole("button", { name: "Revert", exact: true }).click()
  await expect(attached.getByRole("switch", { name: "Style preset" })).toBeChecked()

  const panel = await openPanel(page, "Lorebooks")
  await expect(books(panel).getByText("From the preset Preset preset", { exact: true })).toBeVisible()
  // Its switch is the preset's: off there too.
  await books(panel).getByRole("switch", { name: "Style preset", exact: true }).click()
  await expect(books(panel).getByText("In the preset, switched off there")).toBeVisible()
  const back = await openPanel(page, "Prompt preset")
  await expect(
    back.getByRole("list", { name: "Lorebooks sent with this preset" }).getByRole("switch")
  ).not.toBeChecked()
  // The book's page names the preset once it's saved.
  await back.getByRole("button", { name: "Save", exact: true }).first().click()
})

test("the large editor: Look in, the pencil rename, text and keys first, Revert", async ({ page }) => {
  test.setTimeout(120_000)
  await theme(page, 1440, "dark")
  const { bookId } = await setUp(page, "page")
  await page.goto(`${server().url}/library/${bookId}`)
  await page.getByRole("button", { name: "Rename Tides page", exact: true }).click()
  await page.getByRole("textbox", { name: "New name for Tides page" }).fill("Tides renamed")
  await page.getByRole("textbox", { name: "New name for Tides page" }).press("Enter")
  await expect(page.getByRole("heading", { name: "Tides renamed" })).toBeVisible()
  await page.getByRole("button", { name: "Search and replace", exact: true }).click()
  const search = page.getByRole("region", { name: "Search and replace" })
  for (const scope of ["Content", "Keys", "Both", "Everything"])
    await expect(search.getByRole("button", { name: scope, exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Open Harbour", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Entry content" })).toHaveValue("Boats rock at the quay.")
  await expect(page.getByRole("textbox", { name: "Primary keys" })).toHaveValue("harbour\nquay")
  await expect(page.getByRole("combobox", { name: "Logic" })).toHaveCount(0)
  await page.getByRole("textbox", { name: "Entry content" }).fill("Boats knock at the quay.")
  await page.getByRole("button", { name: "Revert", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Entry content" })).toHaveValue("Boats rock at the quay.")
  await page.screenshot({ path: join(shots, "large-1440-dark.png"), fullPage: false })
})
