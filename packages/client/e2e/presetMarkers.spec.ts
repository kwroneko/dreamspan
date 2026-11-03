// The lines between the prompt list's rows (owner, 2026-11-02): where the chat goes, what comes
// after it, notes placed inside it, and how much each reply reuses. A made-up card with a note
// inside the chat, one after it and a lore entry that's always on, a made-up 30-prompt preset
// and a few posted messages, in the Prompt preset tab and the large editor.
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { level1 } from "./support/summaries.ts"
import { syntheticPreset } from "./support/syntheticPreset.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "40" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-preset-marker-screenshots"))
mkdirSync(shots, { recursive: true })

const upload = async (page: Page, name: string, data: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    data: Buffer.from(JSON.stringify(data)),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

const note = (id: string, title: string, placement: Record<string, unknown>) => ({
  id,
  title,
  content: `${title} text.`,
  placement,
  on_by_default: true
})

const setUp = async (page: Page, name: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await upload(page, `Wren ${name}`, {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: `Wren ${name}`,
      description: "A lighthouse keeper.",
      first_mes: "The lamp turns.",
      character_book: {
        name: "Lighthouse",
        entries: [
          {
            id: 1,
            keys: [],
            content: "The lighthouse stands on a rock.",
            comment: "Rock",
            enabled: true,
            constant: true
          }
        ]
      },
      extensions: {
        rp_harness: {
          notes: [
            note("n-depth", "Character's Note", { mode: "depth", depth: 2, role: "system" }),
            note("n-tail", "Weather now", { mode: "section", section: "tail_start" })
          ]
        }
      }
    }
  })
  const preset = syntheticPreset()
  preset.prompts.find((p) => p.identifier === "synthetic-0")!.content = "Voice {{roll::1d6}} {{time}}"
  await upload(page, name, preset)
  return admin((api) =>
    Effect.gen(function* () {
      const ref = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === name)!
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: `Cache ${name}`,
          baseUrl: "http://127.0.0.1:1/v1",
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
        overrides: { cacheBreakpoints: "explicit", context: 32000 }
      })
      yield* api.ChangeGenerationDefaults({
        change: { preset: ref.id, model: { connection: connection.id, model: model.id } }
      })
      const card = (yield* api.ListCards()).find((c) => c.name === `Wren ${name}`)!
      const chat = yield* api.CreateChat({ title: name })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      let leaf = (yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId
      for (const [i, content] of ["Is the lamp lit?", "Since dusk.", "Then we wait."].entries()) {
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: leaf,
          branch: false,
          content,
          ...(i % 2 === 1 ? { speakerEntityId: card.entityId } : {}),
          reply: false
        })
        if (sent._tag !== "Posted") throw new Error("not posted")
        leaf = sent.entry.slotId
      }
      const next = yield* api.GetNextContext({ chatId: chat.id, leafSlotId: leaf })
      return { chatId: chat.id, refId: ref.id, cacheAfter: next.presetContext!.cacheAfter, model }
    })
  )
}

// Observe the actual repeated box animation when it starts; focus can settle after it finishes on a busy host.
const observeFlash = (root: Locator) =>
  root.evaluate((element) => {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (!(record.target instanceof HTMLElement) || record.target.dataset.flashing === undefined) continue
        const flashes = record.target
          .getAnimations()
          .some(
            (animation) =>
              animation.effect instanceof KeyframeEffect &&
              (animation.effect.getTiming().iterations ?? 0) >= 2 &&
              animation.effect.getKeyframes().some((frame) => "boxShadow" in frame)
          )
        if (flashes) {
          record.target.dataset.flashObserved = "true"
          observer.disconnect()
        }
      }
    })
    observer.observe(element, { subtree: true, attributes: true, attributeFilter: ["data-flashing"] })
  })

const theme = async (page: Page, width: number, scheme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: scheme })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), scheme)
}

const CACHE_EXPLANATION =
  "Prompt cache breakpoint: everything above it is cached between replies. Editing a prompt above it invalidates the cache from that prompt down. Not every provider supports caching."

const check = async (page: Page, root: Locator, name: string) => {
  const points = root.locator("[data-cache-breakpoint]")
  await expect(points.first()).toBeVisible({ timeout: 60_000 })
  await expect(root.locator('[data-prompt="summaries"]')).toHaveCount(1)
  const ids = await root
    .locator("[data-prompt]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-prompt")))
  expect(ids.indexOf("summaries") + 1).toBe(ids.indexOf("chatHistory"))
  const kinds = await points.evaluateAll((lines) => lines.map((line) => line.getAttribute("data-cache-breakpoint")))
  for (const [i, kind] of kinds.entries())
    await expect(points.nth(i)).toContainText(
      `Cache breakpoint · ${kind === "summary" ? "summaries" : kind === "pinned" ? "prefix" : kind}`
    )
  await expect(root.locator('[data-note-slot="Notes inside the chat"]')).toContainText("Character's Note (depth 2)")
  await expect(root.locator('[data-prompt="synthetic-0"] [data-volatile-warning]')).toBeVisible()
  await expect(root.locator('[data-prompt="main"] [data-prompt-kind-tag]')).toHaveText("Main")
  await expect(root.locator('[data-prompt="chatHistory"]')).toHaveAttribute("data-prompt-type", "history")
  await expect(root.locator('[data-prompt="charDescription"]')).toHaveAttribute("data-prompt-type", "placeholder")
  await expect(root.locator('[data-prompt="charDescription"] [role="textbox"]')).toHaveCount(0)
  const background = (id: string) =>
    root.locator(`[data-prompt="${id}"]`).evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(await background("main")).toBe(await background("synthetic-0"))
  expect(await background("charDescription")).not.toBe(await background("synthetic-0"))
  expect(await background("chatHistory")).not.toBe(await background("charDescription"))
  const slotColor = (id: string) =>
    root.locator(`[data-prompt="${id}"] [data-prompt-kind-tag]`).evaluate((element) => getComputedStyle(element).color)
  expect(await slotColor("main")).not.toBe(await slotColor("nsfw"))
  const historySize = await root
    .locator('[data-prompt="chatHistory"]')
    .getByText("Chat history", { exact: true })
    .evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
  const mainSize = await root
    .locator('[data-prompt="main"]')
    .getByText("Main Prompt", { exact: true })
    .evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
  expect(historySize).toBeGreaterThan(mainSize)
  await expect(root.locator('[data-prompt="summaries"]').getByRole("button")).toHaveCount(0)
  await root.locator('[data-prompt="synthetic-0"] [data-volatile-warning]').hover()
  await expect(
    page.getByText(
      "Contains {{roll}}, {{time}}: the cache stops here, so everything below is sent in full each reply. Move it below the chat history to keep the cache.",
      { exact: true }
    )
  ).toBeVisible()
  await page.mouse.move(0, 0)
  await points.first().scrollIntoViewIfNeeded()
  await root.screenshot({ path: join(shots, `${name}-top.png`) })
  await points.first().getByRole("button").click()
  const popup = page.getByRole("dialog", { name: "Cache breakpoint", exact: true })
  await expect(popup).toContainText(CACHE_EXPLANATION)
  await page.keyboard.press("Escape")
  await expect(popup).toHaveCount(0)
}

const header = async (root: Locator) => {
  const row = root.locator("[data-preset-edit-row]")
  const boxes = await row.locator("button").evaluateAll((buttons) =>
    buttons
      .filter((button) => button.getBoundingClientRect().width > 0)
      .map((button) => {
        const b = button.getBoundingClientRect()
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }
      })
  )
  expect(Math.max(...boxes.map((b) => b.top)) - Math.min(...boxes.map((b) => b.top))).toBeLessThanOrEqual(3)
  const area = (await row.boundingBox())!
  expect(Math.max(...boxes.map((b) => b.right))).toBeLessThanOrEqual(area.x + area.width + 1)
  await expect(root.getByRole("checkbox", { name: "Auto-expand options" })).toBeVisible()
}

for (const width of [390, 1440, 1920])
  for (const scheme of ["light", "dark"] as const)
    test(`the markers between prompts (${width}px ${scheme})`, async ({ page }) => {
      await theme(page, width, scheme)
      const { chatId, cacheAfter } = await setUp(page, `Markers ${width} ${scheme}`)
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
      const panel = await openPanel(page, "Prompt preset")
      await expect(panel.getByRole("list", { name: "Preset blocks" })).toBeVisible({ timeout: 60_000 })
      await expect(panel.locator("[data-cache-breakpoint]")).toHaveCount(cacheAfter.length)
      await header(panel)
      await check(page, panel, `tab-${width}-${scheme}`)
      await panel.getByRole("button", { name: "Open the preset in the large editor", exact: true }).click()
      const overlay = page.getByRole("dialog", { name: "Preset editor", exact: true })
      await expect(overlay).toBeVisible()
      await expect(overlay.locator("[data-cache-breakpoint]")).toHaveCount(cacheAfter.length)
      await header(overlay)
      await check(page, overlay, `large-${width}-${scheme}`)
    })

/**
 * Adding (owner, 2026-11-02): no "+" between the prompts, but New prompt and Definitions block
 * in the list's toolbar, once, in the tab as in the large editor. A new prompt goes at the end,
 * open and ready to type, waiting behind the unsaved bar; the definitions block can exist once.
 * Wide rows keep the chips, count and actions by the name, and a closed prompt shows its first
 * line there.
 */
for (const [width, scheme] of [
  [1920, "dark"],
  [1440, "light"],
  [390, "dark"]
] as const)
  test(`adding from the toolbar, and the large editor's rows (${width}px ${scheme})`, async ({ page }) => {
    await theme(page, width, scheme)
    const { chatId, refId } = await setUp(page, `Adding ${width} ${scheme}`)
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
    const panel = await openPanel(page, "Prompt preset")
    const list = panel.getByRole("list", { name: "Preset blocks" })
    await expect(list).toBeVisible({ timeout: 60_000 })
    await expect(panel.getByRole("button", { name: /^Insert prompt|^Add a prompt/ })).toHaveCount(0)
    await observeFlash(list)
    await panel.getByRole("button", { name: "Add prompt", exact: true }).click()
    await expect(list.locator("[data-prompt]").last()).toContainText("New prompt")
    const text = panel.getByRole("textbox", { name: "Prompt: New prompt", exact: true })
    await expect(text).toBeFocused({ timeout: 30_000 })
    const added = list.locator("[data-prompt]").last()
    await expect(added).toHaveAttribute("data-flash-observed", "true")
    const addedBounds = (await added.boundingBox())!
    expect(addedBounds.y).toBeGreaterThanOrEqual(0)
    expect(addedBounds.y + addedBounds.height).toBeLessThanOrEqual(page.viewportSize()!.height)
    await page.keyboard.type("Typed straight away.")
    const bar = page.getByRole("region", { name: "Unsaved changes" })
    await expect(bar).toContainText("1 prompt added")
    await page.screenshot({ path: join(shots, `tab-added-${width}-${scheme}.png`) })

    // The definitions block goes where the separate definitions start (Persona Description), once.
    const definitions = panel.getByRole("button", { name: "Add definitions block", exact: true })
    await observeFlash(list)
    await definitions.click()
    await expect(list.locator('[data-prompt="charDefinitions"]')).toHaveCount(1)
    await expect(list.locator('[data-prompt="charDefinitions"]')).toHaveAttribute("data-flash-observed", "true")
    const ids = await list
      .locator("[data-prompt]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-prompt")))
    expect(ids.indexOf("charDefinitions")).toBe(ids.indexOf("personaDescription") - 1)
    await expect(definitions).toBeDisabled()
    await definitions.locator("xpath=..").hover()
    await expect(
      page.getByText("The preset already has its definitions block; drag the block to move it.")
    ).toBeVisible()
    await panel.getByRole("button", { name: "Revert", exact: true }).click()
    await expect(bar).toHaveCount(0)

    // The large editor as a page: the same toolbar, and rows whose details sit by their names.
    await page.goto(`${server().url}/library/${refId}`)
    const order = page.getByRole("list", { name: "Prompt order" })
    await expect(order).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole("button", { name: "Add prompt", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: /^Insert prompt/ })).toHaveCount(0)
    await page.getByRole("button", { name: "Collapse all", exact: true }).click()
    const main = order.locator('[data-prompt="main"]')
    await expect(main.locator("header")).toContainText("You narrate a story")
    if (width >= 1024) {
      const positions = await main.evaluate((row) => {
        const title = row.querySelector("[data-prompt-title-row]")!
        const name = title.querySelector("button[aria-expanded]")!.getBoundingClientRect()
        const options = title.querySelector('button[aria-label^="Options"]')!.getBoundingClientRect()
        const menu = title.querySelector("button[aria-haspopup]")!.getBoundingClientRect()
        const info = row.querySelector("[data-prompt-info]")!
        const role = info.querySelector("[data-prompt-role]")!.getBoundingClientRect()
        const tokens = info.querySelector("[data-prompt-tokens]")!.getBoundingClientRect()
        const preview = row.querySelector("[data-prompt-preview]")!.getBoundingClientRect()
        return {
          name: name.right,
          options: options.left,
          menu: menu.left,
          role: role.left,
          tokens: tokens.left,
          preview: preview.top,
          title: name.bottom,
          last: info.lastElementChild?.hasAttribute("data-prompt-tokens")
        }
      })
      expect(positions.name).toBeLessThan(positions.options)
      expect(positions.options).toBeLessThan(positions.menu)
      expect(positions.menu).toBeLessThan(positions.role)
      expect(positions.role).toBeLessThan(positions.tokens)
      expect(positions.preview).toBeGreaterThanOrEqual(positions.title)
      expect(positions.last).toBe(true)
    }
    await page.screenshot({ path: join(shots, `large-rows-${width}-${scheme}.png`) })
    // Both add actions also reveal the entire new block below the large sticky toolbar.
    await observeFlash(order)
    await page.getByRole("button", { name: "Add prompt", exact: true }).click()
    const largeAdded = order.locator("[data-prompt]").last()
    await expect(largeAdded).toHaveAttribute("data-flash-observed", "true")
    await expect(page.getByRole("textbox", { name: "Prompt: New prompt", exact: true })).toBeFocused()
    const toolbar = page.locator("[data-keeping]")
    const bounds = (await largeAdded.boundingBox())!
    expect(bounds.y).toBeGreaterThanOrEqual((await toolbar.boundingBox())!.y + (await toolbar.boundingBox())!.height)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height)
    await observeFlash(order)
    await page.getByRole("button", { name: "Add definitions block", exact: true }).click()
    const largeDefinitions = order.locator('[data-prompt="charDefinitions"]')
    await expect(largeDefinitions).toHaveAttribute("data-flash-observed", "true")
    const definitionsBounds = (await largeDefinitions.boundingBox())!
    expect(definitionsBounds.y).toBeGreaterThanOrEqual(
      (await toolbar.boundingBox())!.y + (await toolbar.boundingBox())!.height
    )
    expect(definitionsBounds.y + definitionsBounds.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  })

for (const width of [390, 1440, 1920])
  test(`options and search (${width}px)`, async ({ page }, info) => {
    await theme(page, width, "light")
    const { chatId } = await setUp(page, `Options ${width}`)
    await page.goto(`${server().url}/chats/${chatId}`)
    const panel = await openPanel(page, "Prompt preset")
    const exercise = async (root: Locator) => {
      await header(root)
      const main = root.locator('[data-prompt="main"]')
      const auto = root.getByRole("checkbox", { name: "Auto-expand options" })
      await auto.uncheck()
      const collapse = root.getByRole("button", { name: "Collapse all", exact: true })
      if (await collapse.isVisible()) await collapse.click()
      await main.getByRole("button", { name: "Options of Main Prompt", exact: true }).click()
      await expect(main.getByLabel("Role", { exact: true })).toBeVisible()
      await auto.check()
      await auto.uncheck()
      await expect(main.getByLabel("Role", { exact: true })).toHaveCount(0)
      await auto.check()
      await expect(main.getByLabel("Role", { exact: true })).toBeVisible()
      await auto.uncheck()
      await main.getByRole("button", { name: "Collapse Main Prompt", exact: true }).click()
      await auto.check()
      await main.getByRole("button", { name: "Expand Main Prompt", exact: true }).click()
      await expect(main.getByLabel("Role", { exact: true })).toBeVisible()
      await main.getByRole("button", { name: "Options of Main Prompt", exact: true }).click()
      await expect(main.getByLabel("Role", { exact: true })).toHaveCount(0)
      await main.getByRole("button", { name: "Options of Main Prompt", exact: true }).click()
      await expect(main.getByLabel("Role", { exact: true })).toBeVisible()
      await auto.uncheck()
      const search = root.getByRole("button", { name: "Search and replace", exact: true })
      const idleSearch = await search.evaluate((element) => getComputedStyle(element).backgroundColor)
      await search.click()
      await expect(search).toHaveAttribute("aria-pressed", "true")
      await expect
        .poll(() => search.evaluate((element) => getComputedStyle(element).backgroundColor))
        .not.toBe(idleSearch)
      await search.click()
      await expect(search).toHaveAttribute("aria-pressed", "false")
      await root.getByRole("button", { name: "Collapse all", exact: true }).click()
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, root === panel ? "preset-panel" : "preset-large")
      await root.screenshot({ path: join(shots, `header-${root === panel ? "panel" : "large"}-${width}.png`) })
    }
    await exercise(panel)
    await panel.getByRole("button", { name: "Open the preset in the large editor", exact: true }).click()
    await exercise(page.getByRole("dialog", { name: "Preset editor", exact: true }))
  })

test("automatic-cache models keep breakpoint lines quiet", async ({ page }) => {
  const { chatId, model } = await setUp(page, "Automatic cache")
  await admin((api) =>
    api.EditModel({
      modelId: model.id,
      overrides: { ...model.overrides, cacheBreakpoints: "auto" },
      expectedRowVersion: model.rowVersion
    })
  )
  await page.goto(`${server().url}/chats/${chatId}`)
  const panel = await openPanel(page, "Prompt preset")
  await expect(panel.getByRole("list", { name: "Preset blocks" })).toBeVisible()
  await expect(panel.locator("[data-cache-breakpoint]")).toHaveCount(0)
  await expect(panel.locator("[data-volatile-warning]")).toHaveCount(0)
  await panel.getByRole("checkbox", { name: "Auto-expand options" }).check()
  await page.reload()
  const restored = await openPanel(page, "Prompt preset")
  await expect(restored.getByRole("checkbox", { name: "Auto-expand options" })).toBeChecked()
})

test("summary breakpoints stay beside the summary layer", async ({ page }) => {
  const { chatId } = await setUp(page, "Summary cache")
  const entries = await admin((api) =>
    Effect.gen(function* () {
      yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "LoreBelowHistory", on: false } })
      return (yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })).entries
    })
  )
  await level1(server().dataDir, chatId, entries.slice(0, 1), "The lamp was lit at dusk.")
  const next = await admin((api) => api.GetNextContext({ chatId, leafSlotId: null }))
  const points = next.presetContext!.cacheAfter
  expect(points.some((p) => p.reason === "summary")).toBe(true)
  await page.goto(`${server().url}/chats/${chatId}`)
  const panel = await openPanel(page, "Prompt preset")
  await expect(panel.locator("[data-cache-breakpoint]")).toHaveCount(points.length)
  await expect(panel.locator('[data-prompt="summaries"] + [data-cache-breakpoint="summary"]')).toHaveCount(1)
  await panel.getByRole("button", { name: "Open the preset in the large editor", exact: true }).click()
  await expect(
    page.getByRole("dialog", { name: "Preset editor", exact: true }).locator("[data-cache-breakpoint]")
  ).toHaveCount(points.length)
})
