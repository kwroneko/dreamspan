// The side panel's Prompt preset tab (owner, 2026-11-01): every prompt expands in place into its
// text, its header into its options; handles reorder right in the column. Text, switches and
// added prompts are live; moving or deleting a prompt waits behind a floating bar that says
// so, with Revert and Save. The large editor shares the drafts both ways and opens at a
// prompt. A made-up card and a made-up 30-prompt preset with unnamed prompts and emoji names.
import { mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { closePanel, openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { NOTHING_TO_SAVE, UNSAVED, expectSaveState, saveButton, saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "40" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-preset-tab-screenshots"))
mkdirSync(shots, { recursive: true })

const base = JSON.parse(
  readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
) as Record<string, unknown> & {
  prompts: Array<Record<string, unknown>>
  prompt_order: Array<{ character_id: number; order: Array<{ identifier: string; enabled: boolean }> }>
}

const paragraph = (topic: string, lines: number) =>
  Array.from(
    { length: lines },
    (_, i) => `${topic}: keep the scene grounded in what {{char}} can see and hear, line ${i + 1}.`
  ).join("\n")

/** Twenty made-up prompts: emoji names, three unnamed, some long, a depth one and a conditioned one. */
const extra = [
  ["🎭 Narrator voice", paragraph("Voice", 6)],
  ["🔥 Pacing", paragraph("Pacing", 3)],
  ["", "Write in close third person, past tense, and never summarize a scene the user is still playing."],
  ["📜 Lore rules", paragraph("Lore", 12)],
  ["Formatting", "Dialogue in quotes, actions in plain prose, thoughts in *asterisks*."],
  ["🌧️ Weather & mood", paragraph("Weather", 4)],
  ["", "Keep replies under four paragraphs unless the user asks for more."],
  ["Banned phrases", "Avoid: shivers down the spine, a mix of, testament to, palpable."],
  ["🗺️ Locations", paragraph("Places", 8)],
  ["Side characters", paragraph("Cast", 5)],
  ["⚔️ Combat", paragraph("Combat", 6)],
  ["", ""],
  ["Inner monologue", "Show {{char}}'s thoughts sparingly, at most once per reply."],
  ["🧭 Agency", "Never decide what {{user}} does, says or feels."],
  ["Time skips", "Only skip time when the user asks."],
  ["Sensory detail", paragraph("Senses", 3)],
  ["💬 Dialogue tags", "Prefer 'said'; vary only when it adds information."],
  ["Continuity", paragraph("Continuity", 4)],
  ["Depth reminder", "Remember the current goal of the scene."],
  ["🎲 Randomness", "Introduce one small surprise every few replies."]
] as const

const preset = () => {
  const prompts = [
    ...base.prompts,
    ...extra.map(([name, content], i) => ({
      identifier: `synthetic-${i}`,
      name,
      role: "system",
      content,
      system_prompt: false,
      marker: false,
      injection_position: name === "Depth reminder" ? 1 : 0,
      injection_depth: 2,
      ...(name === "⚔️ Combat" ? { injection_trigger: ["normal", "swipe"] } : {})
    }))
  ]
  const order = base.prompt_order.find((o) => o.character_id === 100001)!.order
  const at = order.findIndex((e) => e.identifier === "chatHistory")
  const mine = extra.map((_, i) => ({ identifier: `synthetic-${i}`, enabled: i % 5 !== 3 }))
  const merged = [
    ...order.slice(0, 2),
    ...mine.slice(0, 14),
    ...order.slice(2, at + 1),
    ...mine.slice(14),
    ...order.slice(at + 1)
  ]
  return { ...base, prompts, prompt_order: [{ character_id: 100001, order: merged }] }
}

const upload = async (page: Page, name: string, data: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    data: Buffer.from(JSON.stringify(data)),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

const setUp = async (page: Page, name: string, document = preset()) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await upload(page, `Wren ${name}`, {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: `Wren ${name}`, description: "A lighthouse keeper.", first_mes: "The lamp turns." }
  })
  await upload(page, name, document)
  return admin((api) =>
    Effect.gen(function* () {
      const ref = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === name)!
      yield* api.ChangeGenerationDefaults({ change: { preset: ref.id } })
      const card = (yield* api.ListCards()).find((c) => c.name === `Wren ${name}`)!
      const chat = yield* api.CreateChat({ title: name })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      return { chatId: chat.id, refId: ref.id }
    })
  )
}

const open = async (page: Page, chatId: string) => {
  await page.goto(`${server().url}/chats/${chatId}`)
  await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
  const panel = await openPanel(page, "Prompt preset")
  // The tab learns the preset from the next reply's context estimate, slow on a loaded host.
  await expect(panel.getByRole("list", { name: "Preset blocks" })).toBeVisible({ timeout: 60_000 })
  return panel
}

const theme = async (page: Page, width: number, scheme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: scheme })
  await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), scheme)
}

const rowNames = (panel: Locator) =>
  panel
    .getByRole("list", { name: "Preset blocks" })
    .locator("[data-prompt]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-prompt")))

/** The panel's scrolling container. */
const scroller = (panel: Locator) => panel

const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)

// Each test makes its own chat and 30-prompt preset and walks many steps: 40-90 s alone at a
// load of 60-140 on the 48-core host.
test.setTimeout(180_000)

for (const width of [1440, 390])
  for (const scheme of ["light", "dark"] as const)
    test(`the tab edits the preset in place, with the unsaved bar (${width}px ${scheme})`, async ({ page }) => {
      await theme(page, width, scheme)
      const { chatId } = await setUp(page, `Tab ${width} ${scheme}`)
      const panel = await open(page, chatId)
      const shot = async (name: string) => {
        await noOverflow(page)
        await page.screenshot({ path: join(shots, `tab-${name}-${width}-${scheme}.png`) })
      }
      // Closed rows: a name and the first line of the text, editors not mounted.
      await expect(panel.getByRole("textbox", { name: /^Prompt: / })).toHaveCount(0)
      await expect(panel.getByRole("button", { name: "Expand 🎭 Narrator voice", exact: true })).toContainText(
        "Voice: keep the scene grounded"
      )
      // An unnamed prompt is named by its first words; one with no text says so.
      await expect(
        panel.getByRole("button", { name: "Expand Write in close third person, past…", exact: true })
      ).toBeVisible()
      await expect(panel.getByRole("button", { name: "Expand Unnamed prompt", exact: true })).toBeVisible()
      await expect(panel.locator('[data-prompt="chatHistory"]')).toContainText(/[\d,]+ tokens/)
      await expect(panel.getByRole("region", { name: "Unsaved changes" })).toHaveCount(0)
      await expectSaveState(panel, NOTHING_TO_SAVE)
      // Each row's end: kind, tokens, options and ⋯ centred on one line with even gaps; the
      // tokens and ⋯ line up across rows, markers included (owner, 2026-11-03).
      const ends = await panel.locator("[data-prompt-end]").evaluateAll((rows) =>
        rows.map((row) => {
          const items = [
            row.querySelector("[data-prompt-kind-tag]"),
            row.querySelector("[data-prompt-tokens]"),
            ...row.querySelectorAll("button")
          ]
            .filter((el): el is Element => el !== null)
            .map((el) => el.getBoundingClientRect())
          const tokens = row.querySelector("[data-prompt-tokens]")?.getBoundingClientRect()
          return {
            centres: items.map((r) => r.top + r.height / 2),
            tokensRight: tokens ? tokens.right : null,
            right: row.getBoundingClientRect().right
          }
        })
      )
      expect(ends.length).toBeGreaterThan(2)
      for (const end of ends) {
        for (const centre of end.centres) expect(Math.abs(centre - end.centres[0]!)).toBeLessThanOrEqual(1)
      }
      for (const end of ends) expect(Math.abs(end.right - ends[0]!.right)).toBeLessThanOrEqual(1)
      const tokenRights = ends.flatMap((end) => (end.tokensRight === null ? [] : [end.tokensRight]))
      for (const right of tokenRights) expect(Math.abs(right - tokenRights[0]!)).toBeLessThanOrEqual(1)
      await shot("collapsed")

      // Expand: the text in the code editor; the header's Options open the prompt's options.
      await panel.getByRole("button", { name: "Expand 🔥 Pacing", exact: true }).click()
      const pacing = panel.getByRole("textbox", { name: "Prompt: 🔥 Pacing", exact: true })
      await expect(pacing).toBeVisible()
      await panel.getByRole("button", { name: "Options of 🔥 Pacing", exact: true }).click()
      const block = panel.locator('[data-prompt="synthetic-1"]')
      await expect(block.getByText("Condition", { exact: true })).toBeVisible()
      await expect(block.getByText("Generation types")).toBeVisible()
      await expect(block.getByRole("combobox").first()).toBeVisible()
      await pacing.click()
      await page.keyboard.press("Control+End")
      await page.keyboard.type(" Slow down for quiet scenes.")
      // Typed text is live: Save says there's something to save, and no unsaved bar holds it.
      const bar = panel.getByRole("region", { name: "Unsaved changes" })
      await expectSaveState(panel, UNSAVED)
      await expect(bar).toHaveCount(0)
      await block.scrollIntoViewIfNeeded()
      await shot("expanded-options")

      // Keyboard: a focused handle moves its prompt; the move waits behind the bar.
      await panel.getByRole("button", { name: "Collapse 🔥 Pacing", exact: true }).click()
      const before = await rowNames(panel)
      await panel.getByRole("button", { name: "Move 🗺️ Locations", exact: true }).focus()
      await page.keyboard.press("ArrowUp")
      await expect.poll(() => rowNames(panel)).not.toEqual(before)
      const moved = await rowNames(panel)
      expect(moved.indexOf("synthetic-8")).toBe(before.indexOf("synthetic-8") - 1)
      await expect(panel.getByRole("button", { name: "Move 🗺️ Locations", exact: true })).toBeFocused()
      await expect(bar).toContainText("new order")

      // The bar stays at the bottom of the panel while the column scrolls.
      for (const to of ["bottom", "middle", "top"] as const) {
        await scroller(panel).evaluate((e, where) => {
          e.scrollTop = where === "top" ? 0 : where === "bottom" ? e.scrollHeight : e.scrollHeight / 2
        }, to)
        await expect(bar).toBeInViewport({ ratio: 1 })
        const [box, pane] = [(await bar.boundingBox())!, (await panel.boundingBox())!]
        expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height + 1)
        if (to === "middle") await shot("unsaved-bar-scrolled")
      }

      // Pointer: drag a handle down past two rows.
      const handle = panel.getByRole("button", { name: "Move Formatting", exact: true })
      // Both ends in sight, clear of the unsaved bar at the panel's foot.
      await panel.locator('[data-prompt="synthetic-7"]').evaluate((row) => row.scrollIntoView({ block: "center" }))
      await handle.scrollIntoViewIfNeeded()
      const from = (await handle.boundingBox())!
      const target = (await panel.locator('[data-prompt="synthetic-7"]').boundingBox())!
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(from.x + from.width / 2, target.y + target.height * 0.75, { steps: 8 })
      // A bar shows where it would land.
      await expect(panel.locator('[class*="before:bg-accent"]')).toHaveCount(1)
      await shot("mid-drag")
      await page.mouse.up()
      await expect
        .poll(async () => {
          const names = await rowNames(panel)
          return names.indexOf("synthetic-4") > names.indexOf("synthetic-7")
        })
        .toBe(true)

      // The large editor shows the tab's drafts, at the prompt asked for.
      await panel.getByRole("button", { name: "Actions for 🔥 Pacing", exact: true }).click()
      await page.getByRole("menuitem", { name: "Open in the large editor", exact: true }).click()
      const overlay = page.getByRole("region", { name: "Preset editor", exact: true })
      await expect(overlay).toBeVisible()
      await expect(overlay.locator('[data-prompt="synthetic-1"]')).toBeInViewport()
      await expectTextBox(
        overlay.getByRole("textbox", { name: "Prompt: 🔥 Pacing", exact: true }),
        `${paragraph("Pacing", 3)} Slow down for quiet scenes.`
      )
      const order = await overlay
        .getByRole("list", { name: "Prompt order" })
        .locator("[data-prompt]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-prompt")))
      expect(order).toEqual(await (width < 600 ? Promise.resolve(order) : rowNames(panel)))
      // And the tab shows the large editor's.
      const agency = overlay.getByRole("textbox", { name: "Prompt: 🧭 Agency", exact: true })
      await agency.click()
      await page.keyboard.press("Control+End")
      await page.keyboard.type(" Not even in a time skip.")
      await overlay.getByRole("button", { name: "Close", exact: true }).first().click()
      const again = width < 600 ? await openPanel(page, "Prompt preset") : panel
      await again.getByRole("button", { name: "Expand 🧭 Agency", exact: true }).click()
      await expectTextBox(
        again.getByRole("textbox", { name: "Prompt: 🧭 Agency", exact: true }),
        "Never decide what {{user}} does, says or feels. Not even in a time skip."
      )
      const unsaved = again.getByRole("region", { name: "Unsaved changes" })
      await expect(unsaved).toContainText("new order")
      await expect(unsaved).not.toContainText("text of")

      // The one header Revert restores both the order and the unsaved text.
      await again.getByRole("button", { name: "Revert", exact: true }).click()
      await expect(page.getByRole("alertdialog")).toHaveCount(0)
      await expect(unsaved).toHaveCount(0)
      expect(await rowNames(again)).toEqual(before)
      await expectTextBox(
        again.getByRole("textbox", { name: "Prompt: 🧭 Agency", exact: true }),
        "Never decide what {{user}} does, says or feels."
      )
      await expectSaveState(again, NOTHING_TO_SAVE)
      if (width < 600) await closePanel(page)
    })

test("unbroken prompt titles and previews fit narrow preset rows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const document = preset()
  const prompt = document.prompts.find((prompt) => prompt.identifier === "synthetic-1")!
  const name = "UnbrokenTitle".repeat(20)
  const content = "PromptIdentifier".repeat(20)
  prompt.name = name
  prompt.content = content
  const { chatId } = await setUp(page, "Unbroken prompt", document)
  await page.goto(`${server().url}/chats/${chatId}?cpw=260`)
  const panel = await openPanel(page, "Prompt preset")
  const row = panel.locator('[data-prompt="synthetic-1"]')
  const title = row.locator("[data-layout-name]")
  const preview = row.locator("[data-prompt-column-preview]")
  await expect(title).toHaveText(name)
  await expect(preview).toBeVisible()
  await expect(preview).toHaveText(content)
  expect.soft(await title.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  expect.soft(await preview.evaluate((element) => getComputedStyle(element).textOverflow)).toBe("ellipsis")
  expect(await row.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
})

test("switches are live; a reorder waits for Save, and Revert puts it back without asking", async ({ page }) => {
  await theme(page, 1440, "light")
  const { chatId, refId } = await setUp(page, "Tab save")
  const panel = await open(page, chatId)
  const bar = panel.getByRole("region", { name: "Unsaved changes" })
  const pacing = panel.getByRole("switch", { name: "Send 🔥 Pacing", exact: true })
  await expect(pacing).toBeChecked()
  await pacing.click()
  await expect(pacing).not.toBeChecked()
  await expectSaveState(panel, UNSAVED)
  await expect(bar).toHaveCount(0)

  // The header Revert puts the order and every changed field back to the revision.
  const before = await rowNames(panel)
  await panel.getByRole("button", { name: "Move 🎭 Narrator voice", exact: true }).focus()
  await page.keyboard.press("ArrowDown")
  await expect(bar).toContainText("new order")
  await expect(bar).not.toContainText("switch")
  await panel.getByRole("button", { name: "Revert", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect(bar).toHaveCount(0)
  expect(await rowNames(panel)).toEqual(before)
  await expect(pacing).toBeChecked()
  await pacing.click()

  // The reorder again, saved from the bar with the switch: no dialog.
  await panel.getByRole("button", { name: "Move 🎭 Narrator voice", exact: true }).focus()
  await page.keyboard.press("ArrowDown")
  await expect(bar).toContainText("new order")
  await panel.getByRole("button", { name: "Save", exact: true }).click()
  await expect(bar).toHaveCount(0)
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expectSaveState(panel, NOTHING_TO_SAVE)
  const saved = await admin((api) => api.OpenEditor({ refId: refId as never }))
  const doc = saved.doc as { order: Array<{ identifier: string; enabled: boolean }> }
  const at = (id: string) => doc.order.findIndex((e) => e.identifier === id)
  expect(doc.order.find((e) => e.identifier === "synthetic-1")?.enabled).toBe(false)
  expect(at("synthetic-0")).toBe(at("synthetic-1") + 1)
})

test("adding and deleting a prompt in the column", async ({ page }) => {
  await theme(page, 1440, "dark")
  const { chatId, refId } = await setUp(page, "Tab add")
  const panel = await open(page, chatId)
  await panel.getByRole("button", { name: "Actions for Formatting", exact: true }).click()
  await page.getByRole("menuitem", { name: "Insert a prompt below", exact: true }).click()
  // The new prompt opens, renamed in its header: pencil, field, Enter.
  await panel.getByRole("button", { name: "Rename New prompt", exact: true }).click()
  const name = panel.getByRole("textbox", { name: "New name for New prompt", exact: true })
  await expect(name).toBeFocused()
  await name.fill("🪶 Style notes")
  await name.press("Enter")
  await expect(name).toHaveCount(0)
  await panel.getByRole("textbox", { name: "Prompt: 🪶 Style notes", exact: true }).fill("Short sentences.")
  const names = await rowNames(panel)
  expect(names[names.indexOf("synthetic-4") + 1]).not.toMatch(/^synthetic-/)
  // Adding and deleting both wait behind the bar (owner, 2026-11-02), shown at once.
  const bar = panel.getByRole("region", { name: "Unsaved changes" })
  await expect(bar).toContainText("1 prompt added")
  await panel.getByRole("button", { name: "Actions for Banned phrases", exact: true }).click()
  await page.getByRole("menuitem", { name: "Delete the prompt", exact: true }).click()
  await expect(panel.locator('[data-prompt="synthetic-7"]')).toHaveCount(0)
  await expect(bar).toContainText("1 prompt added · 1 prompt deleted")
  // Revert brings the deleted prompt back and takes the added one away, without asking.
  await panel.getByRole("button", { name: "Revert", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect(bar).toHaveCount(0)
  await expect(panel.locator('[data-prompt="synthetic-7"]')).toHaveCount(1)
  const inserted = names[names.indexOf("synthetic-4") + 1]
  expect(await rowNames(panel)).toEqual(names.filter((n) => n !== inserted))
  await expect(panel.getByRole("textbox", { name: "Prompt: 🪶 Style notes", exact: true })).toHaveCount(0)
  // Added again and saved with the bar's Save: then it's in the preset, where it was put.
  await panel.getByRole("button", { name: "Actions for Formatting", exact: true }).click()
  await page.getByRole("menuitem", { name: "Insert a prompt below", exact: true }).click()
  await expect(bar).toContainText("1 prompt added")
  await panel.getByRole("button", { name: "Save", exact: true }).click()
  await expect(bar).toHaveCount(0)
  const added = await rowNames(panel)
  expect(added[added.indexOf("synthetic-4") + 1]).not.toMatch(/^synthetic-/)
  const savedOrder = await admin((api) =>
    Effect.map(
      api.OpenEditor({ refId: refId as never }),
      (editor) => (editor.doc as { order: Array<{ identifier: string }> }).order
    )
  )
  const ids = savedOrder.map((e) => e.identifier)
  expect(ids[ids.indexOf("synthetic-4") + 1]).toBe(added[added.indexOf("synthetic-4") + 1])
})

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true })
  test("a finger drags a prompt by its handle at 390 px", async ({ page }) => {
    await theme(page, 390, "light")
    const { chatId } = await setUp(page, "Tab touch")
    const panel = await open(page, chatId)
    const before = await rowNames(panel)
    const handle = panel.getByRole("button", { name: "Move 🔥 Pacing", exact: true })
    await handle.scrollIntoViewIfNeeded()
    const from = (await handle.boundingBox())!
    const target = (await panel.locator('[data-prompt="synthetic-4"]').boundingBox())!
    const cdp = await page.context().newCDPSession(page)
    const point = (y: number) => [{ x: from.x + from.width / 2, y }]
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.y + from.height / 2) })
    for (let step = 1; step <= 8; step++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(from.y + from.height / 2 + ((target.y + target.height * 0.75 - from.y) * step) / 8)
      })
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await expect
      .poll(async () => {
        const names = await rowNames(panel)
        return names.indexOf("synthetic-1") > names.indexOf("synthetic-4")
      })
      .toBe(true)
    expect(before.indexOf("synthetic-1")).toBeLessThan(before.indexOf("synthetic-4"))
    await expect(panel.getByRole("region", { name: "Unsaved changes" })).toContainText("new order")
  })
})

for (const width of [2560, 1440, 390])
  for (const scheme of ["light", "dark"] as const)
    test(`the large editor's blocks, outline and options (${width}px ${scheme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: width > 2000 ? 1440 : width < 600 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), scheme)
      const name = `Large ${width} ${scheme}`
      const { chatId } = await setUp(page, name)
      const panel = await open(page, chatId)
      await panel.getByRole("link", { name: "Open the preset in the large editor", exact: true }).click()
      const overlay = page.getByRole("region", { name: "Preset editor", exact: true })
      await expect(overlay).toBeVisible()
      const shot = async (what: string) => {
        await noOverflow(page)
        await page.screenshot({ path: join(shots, `large-${what}-${width}-${scheme}.png`) })
      }
      // The name shows once, in the sticky bar, renamed in place; Save is there, with nothing to save yet.
      await expect(overlay.getByText(name, { exact: true })).toHaveCount(1)
      await expect(overlay.getByRole("button", { name: `Rename ${name}`, exact: true })).toBeVisible()
      await expect(overlay.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0)
      await expect(saveButton(overlay)).toBeDisabled()
      // Options are folded away, so the texts sit close together.
      await expect(overlay.getByRole("textbox", { name: "Prompt: 🔥 Pacing", exact: true })).toBeVisible()
      await expect(overlay.getByText("Generation types")).toHaveCount(0)
      await shot("top")
      await overlay.getByTestId("preset-scroll").evaluate((e) => {
        e.scrollTop = e.scrollHeight / 3
      })
      await shot("scrolled")
      await overlay.getByRole("button", { name: "Options of 🔥 Pacing", exact: true }).click()
      const block = overlay.locator('[data-prompt="synthetic-1"]')
      await expect(block.getByText("Generation types")).toBeVisible()
      await block.scrollIntoViewIfNeeded()
      await shot("options")
      // A prompt is renamed in its header.
      await block.getByRole("button", { name: "Rename 🔥 Pacing", exact: true }).click()
      const field = block.getByRole("textbox", { name: "New name for 🔥 Pacing", exact: true })
      await field.fill("🔥 Pacing and rhythm")
      await shot("rename")
      await field.press("Enter")
      await expect(overlay.getByRole("textbox", { name: "Prompt: 🔥 Pacing and rhythm", exact: true })).toBeVisible()
      await expect(saveButton(overlay)).toBeEnabled()
      await overlay.getByRole("checkbox", { name: "Auto-expand options", exact: true }).check()
      await expect(overlay.getByText("Generation types").first()).toBeVisible()
      await shot("all-options")
      await overlay.getByRole("checkbox", { name: "Auto-expand options", exact: true }).uncheck()
      await saveRevision(overlay)
      await expect(overlay.getByRole("textbox", { name: "Prompt: 🔥 Pacing and rhythm", exact: true })).toBeVisible()
    })
