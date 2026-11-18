// The desktop's columns (owner 2026-11-01: "Columns should have a MINIMUM width, not a maximum
// one"): the sidebar, the chat's side panel and the portrait column drag as far as the middle's
// minimum (440 px) allows, by pointer and by keyboard; a stored width too wide for a smaller
// window shows narrower and comes back on a bigger one; a short window narrows the columns
// before the middle; the sidebar hides and comes back from the header. What lives in the
// columns uses a wide column sensibly: no control stretched across it. Every card is made up.
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { openPanel, panelTab } from "./support/panel.ts"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { shapeCard } from "./support/shapes.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200", FAKE_GENERATOR_TOKENS: "20" })
let adminCookie = ""
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), adminCookie, use)
const shots = process.env.RP_SCREENS
test.setTimeout(120_000)

/** The middle's minimum (ui/columnLayout.ts MIDDLE_MIN). */
const MIDDLE = 440

let provider: FakeProvider
let chatId = ""

const importCard = async (page: Page, data: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data }))
  const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

test.beforeAll(async ({ browser }) => {
  // Setup RPCs share a login, so a longer file cannot exhaust the login limit.
  adminCookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  provider = await startProvider({ reply: "Mira checks the tide table and nods toward the harbor mouth." })
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
      apiKey: "sk-synthetic-width-0001"
    })
  )
  await admin((api) => api.RefreshModels({ connectionId: connection.id }))
  const models = await admin((api) => api.ListModels({ connectionId: connection.id, includeHidden: false }))
  await admin((api) =>
    api.SetGenerationDefaults({
      defaults: { model: { connection: connection.id, model: models[0]!.id }, preset: null }
    })
  )
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  // Mira has a portrait (ST's 400 × 600), for the portrait column.
  const mira = await page.request.post(`${server().url}/library/import?name=Mira.png`, {
    data: shapeCard({ name: "Mira", width: 400, height: 600 }, 0),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(mira.ok()).toBeTruthy()
  await importCard(page, { name: "Wren", description: "A lamplighter who knows every alley." })
  await importCard(page, { name: "Juniper", description: "A traveller mapping drowned villages." })
  for (let i = 1; i <= 16; i++) await importCard(page, { name: `Lantern keeper ${i}`, description: "Made up." })
  const lore = await page.request.post(
    `${server().url}/library/import?name=${encodeURIComponent("Harbor lore.json")}`,
    {
      data: Buffer.from(
        JSON.stringify({
          entries: {
            0: { uid: 0, key: ["tide"], content: "The tide turns at the third bell.", order: 100, position: 0 },
            1: { uid: 1, key: ["lamp"], content: "Seven lamps line the quay.", order: 100, position: 0 }
          }
        })
      ),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    }
  )
  expect(lore.status()).toBe(200)
  await page.close()
  const refs = await admin((api) => api.ListLibrary({ kind: "card" }))
  const ref = (name: string) => refs.find((r) => r.label === name)!
  await admin((api) => api.SetPersona({ entityId: ref("Juniper").entityId as EntityId, persona: true }))
  await admin((api) => api.CreateCardNote({ cardRefId: ref("Mira").id as RefId, title: "Outfit" }))
  const started = await admin((api) =>
    api.StartChat({
      cards: [ref("Mira").entityId as EntityId, ref("Wren").entityId as EntityId],
      persona: ref("Juniper").entityId as EntityId,
      greeting: null,
      first: { _tag: "Send", content: "Is the harbor open tonight?", speakerEntityId: null }
    })
  )
  chatId = started.chat.id
  // A preset to show in the Prompt preset tab: the ST default's prompts.
  const presetPage = await browser.newPage()
  await apiLogin(presetPage.request, server(), ADMIN.handle, ADMIN.password)
  const preset = readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url))
  const uploaded = await presetPage.request.post(`${server().url}/library/import?name=Harbor%20preset.json`, {
    data: preset,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(uploaded.status()).toBe(200)
  await presetPage.close()
  const presets = await admin((api) => api.ListLibrary({ kind: "preset" }))
  const harbor = presets.find((r) => r.label === "Harbor preset")!
  await admin((api) => api.ChangeGenerationDefaults({ change: { preset: harbor.id } }))
})
test.afterAll(async () => {
  await provider?.stop()
})

const shoot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ animations: "disabled", path: join(shots, `${name}.png`) })
}

const open = async (page: Page, width: number, height: number, theme: "light" | "dark" = "light", path?: string) => {
  await page.setViewportSize({ width, height })
  await page.emulateMedia({ colorScheme: theme })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}${path ?? `/chats/${chatId}`}`)
  // A loaded host can take a while to open the chat.
  if (!path) await expect(page.getByLabel("Message", { exact: true })).toBeEditable({ timeout: 30_000 })
}

const handle = (page: Page, name: string) => page.getByRole("separator", { name, exact: true })
const now = async (locator: Locator) => Number(await locator.getAttribute("aria-valuenow"))
const maxOf = async (locator: Locator) => Number(await locator.getAttribute("aria-valuemax"))
const middle = (page: Page) => page.locator("[data-chat-main]")
const width = async (locator: Locator) => (await locator.boundingBox())!.width

/** Drags a column's grip by `delta` px (positive is to the right). */
const drag = async (page: Page, grip: Locator, delta: number) => {
  const box = (await grip.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + 200, { steps: 10 })
  await page.mouse.up()
}

/** Sets a column's width with its grip's keys: Home to the minimum, then steps up. */
const resizeTo = async (page: Page, name: string, target: number) => {
  const grip = handle(page, name)
  await grip.focus()
  await page.keyboard.press("Home")
  const direction = name === "Resize chat panel" ? "ArrowLeft" : "ArrowRight"
  while ((await now(grip)) + 40 <= target) await page.keyboard.press(`Shift+${direction}`)
  while ((await now(grip)) + 10 <= target) await page.keyboard.press(direction)
  return now(grip)
}

const noSideScroll = (page: Page) =>
  expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)

for (const [vw, vh] of [
  [3840, 2160],
  [1920, 1080],
  [1440, 900]
] as const)
  test(`each column drags to where the middle keeps ${MIDDLE} px, by pointer and keys (${vw}px)`, async ({ page }) => {
    await open(page, vw, vh)
    await openPanel(page, "This chat")
    const sidebar = handle(page, "Resize sidebar")
    const panel = handle(page, "Resize chat panel")
    // No maximum of its own: the sidebar drags until the middle is at its minimum.
    await drag(page, sidebar, vw)
    await expect.poll(async () => Math.round(await width(middle(page)))).toBe(MIDDLE)
    expect(await now(sidebar)).toBe(await maxOf(sidebar))
    expect(await now(sidebar)).toBeGreaterThan(vw - MIDDLE - 416 - 2)
    await noSideScroll(page)
    // Home: its minimum; End: as far as the room goes.
    await sidebar.focus()
    await page.keyboard.press("Home")
    await expect(sidebar).toHaveAttribute("aria-valuenow", "220")
    await page.keyboard.press("ArrowRight")
    await expect(sidebar).toHaveAttribute("aria-valuenow", "230")
    await page.keyboard.press("Shift+ArrowRight")
    await expect(sidebar).toHaveAttribute("aria-valuenow", "270")
    await page.keyboard.press("End")
    await expect.poll(async () => Math.round(await width(middle(page)))).toBe(MIDDLE)
    await page.keyboard.press("Home")
    // The side panel, the other way.
    await drag(page, panel, -vw)
    await expect.poll(async () => Math.round(await width(middle(page)))).toBe(MIDDLE)
    expect(await now(panel)).toBe(vw - MIDDLE - 220)
    await panel.focus()
    await page.keyboard.press("Home")
    await expect(panel).toHaveAttribute("aria-valuenow", "260")
    await page.keyboard.press("ArrowLeft")
    await expect(panel).toHaveAttribute("aria-valuenow", "270")
    await page.keyboard.press("End")
    await expect.poll(async () => Math.round(await width(middle(page)))).toBe(MIDDLE)
    // The composer stays usable at the middle's minimum.
    const send = (await page
      .getByRole("button", { name: /^(Send|.+ replies)/ })
      .first()
      .boundingBox())!
    const aside = (await page.getByRole("complementary", { name: "Chat panel" }).boundingBox())!
    expect(send.x + send.width).toBeLessThanOrEqual(aside.x)
    await noSideScroll(page)
    // The grip says how to use it.
    await panel.hover()
    await expect(page.getByText(/Drag to resize, or use the arrow keys/)).toBeVisible()
    // A double-click returns to the default.
    await panel.dblclick()
    await expect(panel).toHaveAttribute("aria-valuenow", "416")
  })

test("a stored width too wide for the window shows narrower, and comes back on a wider one", async ({ page }) => {
  await open(page, 1920, 1080)
  await openPanel(page, "This chat")
  const sidebar = handle(page, "Resize sidebar")
  const panel = handle(page, "Resize chat panel")
  await resizeTo(page, "Resize sidebar", 600)
  await expect(sidebar).toHaveAttribute("aria-valuenow", "600")
  await resizeTo(page, "Resize chat panel", 800)
  await expect(panel).toHaveAttribute("aria-valuenow", "800")
  const stored = () =>
    page.evaluate(() =>
      Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("rp.panelWidth.")))
    )
  const before = await stored()
  // 1440: 1000 px for the columns; they give way in proportion to how far each is above its minimum.
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect.poll(async () => Math.round(await width(middle(page)))).toBeGreaterThanOrEqual(MIDDLE - 1)
  await expect.poll(async () => Math.round(await width(middle(page)))).toBeLessThanOrEqual(MIDDLE + 1)
  expect(await now(sidebar)).toBeLessThan(600)
  expect(await now(panel)).toBeLessThan(800)
  expect(await now(sidebar)).toBeGreaterThan(220)
  expect(await now(panel)).toBeGreaterThan(260)
  await noSideScroll(page)
  await shoot(page, "squeezed-1440")
  // Storage keeps the choice; a reload at this size shows the same.
  expect(await stored()).toEqual(before)
  await page.reload()
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable({ timeout: 30_000 })
  await expect.poll(async () => Math.round(await width(middle(page)))).toBeLessThanOrEqual(MIDDLE + 1)
  // 1024, the narrowest desktop: 584 px for both, each still above its minimum (220, 260);
  // the phone layout below it.
  await page.setViewportSize({ width: 1024, height: 800 })
  await expect.poll(async () => (await now(sidebar)) + (await now(panel))).toBeGreaterThanOrEqual(582)
  expect((await now(sidebar)) + (await now(panel))).toBeLessThanOrEqual(584)
  expect(await now(sidebar)).toBeGreaterThan(220)
  expect(await now(panel)).toBeGreaterThan(260)
  await expect.poll(async () => Math.round(await width(middle(page)))).toBeGreaterThanOrEqual(MIDDLE)
  await noSideScroll(page)
  // A wider window again: the widths chosen.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expect(sidebar).toHaveAttribute("aria-valuenow", "600")
  await expect(panel).toHaveAttribute("aria-valuenow", "800")
  expect(await stored()).toEqual(before)
})

test("the portrait column gives way first, and the sidebar can push it to its minimum", async ({ page }) => {
  await open(page, 1920, 1080)
  await openPanel(page, "This chat")
  // Mira's portrait, from her greeting.
  await page.locator("article[data-slot]").first().getByRole("button", { name: "View Mira's portrait" }).click()
  const portrait = handle(page, "Resize the portrait")
  await expect(portrait).toBeVisible()
  const sidebar = handle(page, "Resize sidebar")
  const panel = handle(page, "Resize chat panel")
  const sidebarBefore = await now(sidebar)
  const panelBefore = await now(panel)
  await drag(page, portrait, 1920)
  await expect.poll(async () => Math.round(await width(middle(page)))).toBe(MIDDLE)
  // The sidebar wider: the portrait narrows, the panel keeps its width.
  await drag(page, sidebar, 200)
  await expect(sidebar).toHaveAttribute("aria-valuenow", String(sidebarBefore + 200))
  expect(await now(panel)).toBe(panelBefore)
  await expect.poll(async () => Math.round(await width(middle(page)))).toBe(MIDDLE)
  await sidebar.focus()
  await page.keyboard.press("End")
  await expect(portrait).toHaveAttribute("aria-valuenow", "200")
  await expect.poll(async () => Math.round(await width(middle(page)))).toBe(MIDDLE)
  await noSideScroll(page)
})

for (const theme of ["light", "dark"] as const)
  test(`the sidebar hides, leaving the chat alone, and comes back from the header (${theme})`, async ({ page }) => {
    await open(page, 1920, 1080, theme)
    const hide = page.getByRole("button", { name: "Hide the sidebar", exact: true })
    await hide.focus()
    await page.keyboard.press("Enter")
    await expect(handle(page, "Resize sidebar")).toHaveCount(0)
    const show = page.locator("header").getByRole("button", { name: "Show the sidebar", exact: true })
    // Focus moves to the button that brings it back.
    await expect(show).toBeFocused()
    await expect(page.getByText("Click to show the sidebar: your chats, characters and the menu")).toBeVisible()
    // Only the chat: the messages' column centred in the window at the chat width.
    const column = (await page.getByTestId("messages").locator("> div").boundingBox())!
    expect(Math.abs(column.x + column.width / 2 - 960)).toBeLessThanOrEqual(2)
    await noSideScroll(page)
    await shoot(page, `sidebar-hidden-chat-1920-${theme}`)
    // In the tab's URL: a reload keeps it.
    await page.reload()
    await expect(show).toBeVisible()
    await expect(handle(page, "Resize sidebar")).toHaveCount(0)
    // Other pages, through an in-app link (navigation keeps it): a bar with the button.
    await page.evaluate(() => {
      const link = document.createElement("a")
      link.href = "/library"
      document.body.append(link)
      link.click()
      link.remove()
    })
    await expect(page).toHaveURL(/\/library\?(.*&)?sidebar=hidden/)
    const bar = page.getByRole("button", { name: "Show the sidebar", exact: true })
    await expect(bar).toBeVisible()
    await shoot(page, `sidebar-hidden-library-1920-${theme}`)
    // A phone is unaffected: its menu as before.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(bar).toBeHidden()
    await expect(page.getByRole("button", { name: "Chats and menu" }).first()).toBeVisible()
    await page.setViewportSize({ width: 1920, height: 1080 })
    await bar.focus()
    await page.keyboard.press("Enter")
    await expect(handle(page, "Resize sidebar")).toBeVisible()
    await expect(page.getByRole("button", { name: "Hide the sidebar", exact: true })).toBeFocused()
    await expect(page.getByRole("button", { name: "Show the sidebar", exact: true })).toHaveCount(0)
  })

/** The controls in `scope` wider than `max` px: buttons, dropdowns and switches by default. */
const wideControls = (scope: Locator, max: number, selector = GROUPED) =>
  scope.locator(selector).evaluateAll(
    (nodes, limit) =>
      nodes
        .filter((n) => (n as HTMLElement).offsetParent !== null)
        .map((n) => ({
          name: (n.getAttribute("aria-label") ?? n.textContent ?? "").slice(0, 40),
          width: Math.round(n.getBoundingClientRect().width)
        }))
        .filter((n) => n.width > limit),
    max
  )
/**
 * What stays a control's width however wide the panel: buttons (but a disclosure's heading,
 * which spans its section), dropdowns
 * and switches. Multi-line fields and editors take the whole width.
 */
const GROUPED = "button:not([aria-expanded]), select, [role=combobox]:not(input), [role=switch]"

/** A row of controls that belong together (`max-w-controls`, styles.css): 40rem. */
const GROUP = 640
const TABS = ["This chat", "Cast", "Model", "Lorebooks", "Notes", "Summaries", "Interface", "Snippets", "Mira"]

/** The paragraphs in `scope` with a line longer than 80 characters of their own type. */
const longLines = (scope: Locator) =>
  scope.locator("p").evaluateAll((nodes) =>
    nodes
      .filter((n) => (n as HTMLElement).offsetParent !== null)
      .flatMap((n) => {
        const probe = document.createElement("span")
        probe.style.cssText = "position:absolute;visibility:hidden;width:80ch"
        n.append(probe)
        const measure = probe.getBoundingClientRect().width
        probe.remove()
        const width = n.getBoundingClientRect().width
        return width > measure + 1
          ? [`${Math.round(width)} > ${Math.round(measure)}: ${n.textContent?.slice(0, 40)}`]
          : []
      })
  )

/** How many of a grid's items share its first row. */
const firstRow = (grid: Locator) =>
  grid.locator(":scope > *").evaluateAll((nodes) => {
    const tops = nodes.map((n) => Math.round(n.getBoundingClientRect().top))
    return tops.filter((top) => top === tops[0]).length
  })

const openTab = async (page: Page, tab: string) => {
  await panelTab(page, tab)
  const body = page.getByRole("tabpanel", { name: tab })
  await expect(body).toBeVisible()
  // Loaded: its lazy code and its reads.
  await expect(body.getByText(/^(Loading|Still loading)/)).toHaveCount(0, { timeout: 30_000 })
  return body
}

/** Cast's Add characters, opened, and its grid of tiles. */
const addGrid = async (body: Locator) => {
  const add = body.getByRole("button", { name: "Add characters", exact: true })
  if ((await add.getAttribute("aria-expanded")) === "false") await add.click()
  const grid = body.getByLabel("Characters", { exact: true })
  await expect(grid.getByRole("button", { name: /Lantern keeper 1\b/ }).first()).toBeVisible({ timeout: 30_000 })
  return grid
}

for (const theme of ["light", "dark"] as const)
  test(`the panel's tabs at 1000 px and the sidebar at 700 px use the width sensibly (${theme})`, async ({ page }) => {
    await open(page, 2560, 1440, theme)
    await openPanel(page, "This chat")
    expect(await resizeTo(page, "Resize chat panel", 1000)).toBe(1000)
    expect(await resizeTo(page, "Resize sidebar", 700)).toBe(700)
    for (const tab of TABS) {
      const body = await openTab(page, tab)
      expect.soft(await wideControls(body, GROUP), tab).toEqual([])
      expect.soft(await longLines(body), tab).toEqual([])
      await shoot(page, `panel-${tab.toLowerCase().replace(/ /g, "-")}-1000-${theme}`)
    }
    // Model: its numbers four a row, each a number's width, not half the panel.
    await panelTab(page, "Model")
    const temperature = page.locator("[data-model-field=temperature]")
    expect((await temperature.boundingBox())!.width).toBeLessThan(260)
    // Notes: the chat's and each card's side by side.
    await panelTab(page, "Notes")
    const notes = page.getByRole("tabpanel", { name: "Notes" })
    const chatNotes = (await notes.getByRole("region", { name: "This chat's notes" }).boundingBox())!
    const miraNotes = (await notes.getByRole("region", { name: "Mira's notes" }).boundingBox())!
    expect(miraNotes.x).toBeGreaterThan(chatNotes.x + chatNotes.width)
    // Interface: colour swatches, not bars.
    await panelTab(page, "Interface")
    const swatch = page.getByRole("tabpanel", { name: "Interface" }).getByLabel("Main text colour", { exact: true })
    expect((await swatch.boundingBox())!.width).toBeLessThanOrEqual(96)

    // The sidebar's chats: one column, the rows using the width for their text.
    const sidebar = page.getByRole("complementary", { name: "Sidebar" })
    expect(await wideControls(sidebar, GROUP, "button")).toEqual([])
    await shoot(page, `sidebar-700-chats-${theme}`)
    // Its characters: more tiles a row as it widens.
    await sidebar.getByRole("group", { name: "Left panel" }).getByRole("button", { name: "Characters" }).click()
    const tiles = sidebar.getByRole("link", { name: /^Open (Mira|Wren|Lantern keeper)/ })
    await expect(tiles.first()).toBeVisible()
    const tops = await tiles.evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().top)))
    expect(tops.filter((top) => top === tops[0]).length).toBeGreaterThanOrEqual(4)
    await shoot(page, `sidebar-700-characters-${theme}`)
    // At its usual width, two a row as before.
    await handle(page, "Resize sidebar").dblclick()
    await expect(handle(page, "Resize sidebar")).toHaveAttribute("aria-valuenow", "320")
    const usual = await tiles.evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().top)))
    expect(usual.filter((top) => top === usual[0]).length).toBe(2)
    await sidebar.getByRole("group", { name: "Left panel" }).getByRole("button", { name: "Chats" }).click()
  })

// The owner's report (2026-11-02): the right panel's tabs stopped at a fixed width with the
// rest empty. Dragged to 1700 px, fields and grids use it all, what belongs together stays
// together, and text keeps a readable line.
test("a panel dragged to 1700 px uses its width: fields and grids widen, groups stay together (3840px)", async ({
  page
}) => {
  // Every tab, then the grid at two widths, on the window's 4K: a loaded host needs the time.
  test.setTimeout(360_000)
  await open(page, 3840, 2160)
  await openPanel(page, "This chat")
  expect(await resizeTo(page, "Resize chat panel", 1700)).toBe(1700)
  for (const tab of TABS) {
    const body = await openTab(page, tab)
    expect.soft(await wideControls(body, GROUP), tab).toEqual([])
    expect.soft(await longLines(body), tab).toEqual([])
  }
  // The card's prose: the whole width, no empty band beside it.
  const mira = await openTab(page, "Mira")
  const description = mira.getByRole("textbox", { name: "Description", exact: true })
  await expect(description).toBeVisible()
  expect(await width(description)).toBeGreaterThan(1600)
  // Cast: who you play and its Switch together; Add characters' tiles as many a row as fit.
  const cast = await openTab(page, "Cast")
  expect(await width(cast.getByRole("group", { name: "Your persona" }))).toBeLessThanOrEqual(GROUP)
  const grid = await addGrid(cast)
  const wide = await firstRow(grid)
  expect(wide).toBeGreaterThanOrEqual(10)
  // The search and the filter bar stay a bar's width above it.
  expect(await width(cast.getByRole("searchbox", { name: "Find a character to add" }))).toBeLessThanOrEqual(GROUP)
  // Model: a limit's pencil beside its figure, not at the far edge.
  const model = await openTab(page, "Model")
  const pencil = (await model.getByRole("button", { name: "Set the context window yourself" }).boundingBox())!
  const panel = (await page.getByRole("complementary", { name: "Chat panel" }).boundingBox())!
  expect(pencil.x - panel.x).toBeLessThanOrEqual(GROUP + 40)
  await noSideScroll(page)
  // Narrower, fewer tiles a row: the grid follows the panel.
  await resizeTo(page, "Resize chat panel", 800)
  await panelTab(page, "Cast")
  await expect.poll(() => firstRow(grid)).toBeLessThan(wide)
  expect(await firstRow(grid)).toBeGreaterThanOrEqual(4)
})

const SWEEP = [...TABS.slice(0, 3), "Prompt preset", ...TABS.slice(3), "History edits", "Juniper"]
const CARD_TABS = ["Greetings", "Metadata", "Lorebook", "Notes", "Extra"]

// Screens for review (RP_SCREENS): every tab at 400, 800, 1200, 1700 and 2400 px with its
// card's tabs, the sidebar from 320 to 1700 px, and each tab on a phone, in both themes.
for (const theme of ["light", "dark"] as const)
  test(`screens of every tab at each width (${theme})`, async ({ page }) => {
    test.skip(!shots, "Screenshot capture requested through RP_SCREENS")
    test.setTimeout(1_800_000)
    // The whole sweep is long; a missing control should fail within one action's budget.
    page.setDefaultTimeout(30_000)
    const slug = (s: string) => s.toLowerCase().replace(/ /g, "-")
    await open(page, 3840, 1400, theme)
    // A lorebook in this chat, open below the list.
    const lore = await openPanel(page, "Lorebooks")
    const inChat = lore.getByRole("list", { name: "Lorebooks in this chat" })
    // The other theme's run added it already: wait for the list before deciding.
    const none = lore.getByText("No lorebook is in this chat.")
    await expect(inChat.or(none).first()).toBeVisible()
    if (await none.isVisible()) {
      await lore.getByRole("button", { name: "Add a lorebook" }).click()
      await lore.getByRole("searchbox").fill("harbor")
      await lore
        .getByRole("list", { name: "Lorebooks to add" })
        .getByRole("button", { name: /Harbor lore/ })
        .click()
    }
    await inChat
      .getByRole("button", { name: /Harbor lore/ })
      .first()
      .click()
    for (const w of [400, 800, 1200, 1700, 2400]) {
      expect(await resizeTo(page, "Resize chat panel", w)).toBe(w)
      for (const tab of SWEEP) {
        const body = await openTab(page, tab)
        if (tab === "Cast") await addGrid(body)
        await shoot(page, `panel-${slug(tab)}-${w}-${theme}`)
        if (tab === "Mira" || tab === "Juniper") {
          for (const sub of CARD_TABS) {
            await body.getByRole("tab", { name: sub, exact: true }).first().click()
            await shoot(page, `panel-${slug(tab)}-${slug(sub)}-${w}-${theme}`)
          }
          await body.getByRole("tab", { name: "Definition", exact: true }).first().click()
        }
      }
      await noSideScroll(page)
    }
    await handle(page, "Resize chat panel").dblclick()
    const sidebar = page.getByRole("complementary", { name: "Sidebar" })
    const left = sidebar.getByRole("group", { name: "Left panel" })
    for (const w of [320, 800, 1200, 1700]) {
      expect(await resizeTo(page, "Resize sidebar", w)).toBe(w)
      await left.getByRole("button", { name: "Chats" }).click()
      await shoot(page, `sidebar-chats-${w}-${theme}`)
      await left.getByRole("button", { name: "Characters" }).click()
      await expect(sidebar.getByRole("link", { name: /^Open Mira/ })).toBeVisible()
      await shoot(page, `sidebar-characters-${w}-${theme}`)
    }
    await left.getByRole("button", { name: "Chats" }).click()
    // A phone: the panel is a sheet over the chat.
    await page.setViewportSize({ width: 390, height: 844 })
    for (const tab of SWEEP) {
      const body = await openPanel(page, tab)
      await expect(body.getByText(/^(Loading|Still loading)/)).toHaveCount(0, { timeout: 30_000 })
      if (tab === "Cast") await addGrid(body)
      await shoot(page, `phone-${slug(tab)}-390-${theme}`)
      await noSideScroll(page)
    }
  })

// Short values stay control-sized even when their editor or side panel is wide.
for (const theme of ["light", "dark"] as const)
  for (const viewport of [2560, 1440, 390])
    test(`short fields stay capped and prose keeps its width (${viewport}px, ${theme})`, async ({ page }) => {
      test.setTimeout(180_000)
      await open(page, viewport, viewport === 390 ? 844 : 1200, theme)
      const capture = async (name: string, field: Locator) => {
        await expect(field).toBeVisible()
        await field.scrollIntoViewIfNeeded()
        expect(await width(field), name).toBeLessThanOrEqual(GROUP)
        const tooWide = await page
          .locator("input:visible")
          .evaluateAll((nodes) => nodes.filter((n) => n.getBoundingClientRect().width > 640.5).map((n) => n.outerHTML))
        expect(tooWide, name).toEqual([])
        await shoot(page, `fieldwidth-${name}-${viewport}-${theme}`)
        await noSideScroll(page)
      }
      const chat = await openPanel(page, "This chat")
      if (viewport >= 1440) {
        const grip = handle(page, "Resize chat panel")
        await drag(page, grip, -1000)
        expect(await now(grip)).toBeGreaterThan(viewport === 2560 ? 1400 : 640)
      }
      await chat.getByText("Advanced: names in prompts", { exact: true }).click()
      await capture("names", chat.getByRole("textbox", { name: "Your name in prompts" }))

      const card = await openTab(page, "Mira")
      const description = card.getByRole("textbox", { name: "Description", exact: true })
      await expect(description).toBeVisible()
      if (viewport === 2560) expect(await width(description)).toBeGreaterThan(1300)
      await card.getByRole("tab", { name: "Metadata", exact: true }).click()
      await capture("card-panel", card.getByRole("textbox", { name: "Creator", exact: true }))

      const refs = await admin((api) => api.ListLibrary({ kind: "card" }))
      await page.goto(`${server().url}/library/${refs.find((r) => r.label === "Mira")!.id}`)
      await page.getByRole("tab", { name: "Metadata", exact: true }).click()
      await capture("card-editor", page.getByRole("textbox", { name: "Creator", exact: true }))

      for (const [kind, label] of [
        ["preset", "Harbor preset"],
        ["lorebook", "Harbor lore"]
      ] as const) {
        const entries = await admin((api) => api.ListLibrary({ kind }))
        await page.goto(`${server().url}/library/${entries.find((r) => r.label === label)!.id}`)
        await page.getByRole("button", { name: `Rename ${label}`, exact: true }).click()
        await capture(`${kind}-editor`, page.getByRole("textbox", { name: `New name for ${label}`, exact: true }))
        await page.getByRole("button", { name: "Cancel renaming", exact: true }).click()
      }

      const connections = await admin((api) => api.ListConnections())
      await page.goto(`${server().url}/settings/connections/${connections[0]!.id}`)
      await capture("connection", page.getByRole("textbox", { name: "Name", exact: true }))
      expect(await width(page.getByRole("textbox", { name: "Concurrent requests", exact: true }))).toBeLessThanOrEqual(
        128
      )
    })
