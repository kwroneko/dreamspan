// A selection coming and going moves nothing in an editor's strip (owner, 2026-11-24): every
// element of the strip, and the box around it, keeps its place and size as text is selected,
// whether the selection's buttons stay in place disabled (`keepSelection`) or come and go at the
// strip's free end. A code editor's (a card's Description) stay: on a phone one coming wrapped the
// token count onto a second line. A prose text box's (Summarization instruction) and the
// composition's bar over the swipe shown (two-digit swipe count) have room, and come and go.
// At 1340 and 390. Synthetic text, fake generator.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { messageMenu } from "./support/message.ts"
import { loginCookie, withCookie, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { replaceEditorText } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "2000", FAKE_GENERATOR_TOKENS: "20" })
let cookie: string | undefined
const admin = async <A>(use: (client: Client) => Effect.Effect<A, unknown>) => {
  cookie ??= await loginCookie(server(), ADMIN.handle, ADMIN.password)
  return withCookie(server(), cookie, use)
}

const TEXT = "The lamp is lit, and the harbour is quiet tonight."
const SELECTION_ACTIONS = '[data-text-action="snippets.send"], [data-text-action="version.add-selection"]'
const HOLDERS = "[data-text-tool], [data-field-reveal], span.flex-1:empty"

/** Tags every element of `scope` so the same nodes can be measured again. */
const tag = (scope: Locator) =>
  scope.evaluate((root) => {
    let n = 0
    for (const node of [root, ...root.querySelectorAll("*")]) node.setAttribute("data-shift-id", String(n++))
  })

/**
 * Every tagged element's rect, but a selection button's and the unseen holders of the buttons
 * (the toolbar, the strip's revealed part, the spacer before them): where a selection button
 * comes and goes, at the end-aligned buttons' free start, they grow or shrink by it.
 */
const rects = (scope: Locator) =>
  scope.evaluate(
    (root, [skip, holders]) => {
      const out: Record<string, string> = {}
      for (const node of [root, ...root.querySelectorAll("[data-shift-id]")]) {
        if (node.closest(skip) || node.matches(holders)) continue
        const r = node.getBoundingClientRect()
        const name = `${node.getAttribute("data-shift-id")} ${node.tagName.toLowerCase()} ${
          node.getAttribute("aria-label") ?? node.getAttribute("data-text-action") ?? ""
        }`.trim()
        out[name] = [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 2) / 2).join(",")
      }
      return out
    },
    [SELECTION_ACTIONS, HOLDERS] as const
  )

/** Nothing measured before moved after; nothing measured went away. */
const expectNoShift = async (scope: Locator, select: () => Promise<void>, deselect: () => Promise<void>) => {
  await tag(scope)
  const before = await rects(scope)
  await select()
  await expect(scope.locator('[data-text-action="snippets.send"]:not([aria-disabled])')).toHaveCount(1)
  const selected = await rects(scope)
  await deselect()
  await expect(scope.locator('[data-text-action="snippets.send"]:not([aria-disabled])')).toHaveCount(0)
  const after = await rects(scope)
  // A node only measured before (say, the selection's button with no selection) is skipped above.
  expect(Object.keys(before).length).toBeGreaterThan(3)
  expect(selected).toEqual(before)
  expect(after).toEqual(before)
}

const open = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
}

for (const width of [1340, 390]) {
  test(`a prose box's strip doesn't move as a selection comes and goes ${width}`, async ({ page }) => {
    await open(page, width)
    await page.goto(`${server().url}/settings/chats`)
    const box = page.getByRole("textbox", { name: "Summarization instruction", exact: true })
    await expect(box).toBeEditable()
    await box.fill(TEXT)
    await box.press("End")
    const frame = page.locator("[data-field-frame]").filter({ has: box })
    await expect(frame.locator(SELECTION_ACTIONS)).toHaveCount(0)
    await expectNoShift(
      frame,
      async () => {
        for (let i = 0; i < 6; i++) await box.press("Shift+ArrowLeft")
      },
      () => box.press("End")
    )
  })

  test(`a code editor's strip doesn't move as a selection comes and goes ${width}`, async ({ page }) => {
    await open(page, width)
    const card = await admin((api) => api.CreateCard({ label: `Mira ${width}`, name: "Mira" }))
    await page.goto(`${server().url}/library/${card.id}`)
    const box = page.getByRole("textbox", { name: "Description", exact: true })
    await replaceEditorText(box, TEXT)
    await box.press("End")
    const frame = page.locator("[data-field-frame]").filter({ has: box })
    await expect(frame.getByRole("button", { name: "Send text to snippet" })).toBeVisible()
    // Its selection's button stays, disabled without a selection, and says why on hover.
    const button = frame.locator('[data-text-action="snippets.send"]')
    await expect(button).toHaveAttribute("aria-disabled", "true")
    await expect(button).toHaveAccessibleDescription("Select text to add it to a snippet.")
    await button.hover()
    await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"][data-open]')).toContainText(
      "Select text to add it to a snippet."
    )
    await box.focus()
    await expectNoShift(
      frame,
      () => box.press("Shift+Home"),
      () => box.press("End")
    )
  })

  test(`the composition's bar doesn't move as a selection comes and goes ${width}`, async ({ page }) => {
    test.setTimeout(90_000)
    await open(page, width)
    await page.goto(`${server().url}/chats`)
    await page.getByLabel("Title of the new chat").fill(`Snippet shift ${width}`)
    await page.getByRole("button", { name: "New chat", exact: true }).click()
    const composer = page.getByLabel("Message", { exact: true })
    const send = page.getByRole("button", { name: "Send", exact: true })
    await expect(async () => {
      await replaceEditorText(composer, TEXT)
      await expect(send).toBeEnabled({ timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
    await send.click()
    const reply = page.getByRole("article", { name: "Reply", exact: true })
    await expect(reply).toHaveCount(1)
    await expect(page.getByText("generating", { exact: true })).toHaveCount(0, { timeout: 20_000 })
    // Swipes as many as a real chat's (20–50): the bar's count is two digits wide.
    const chatId = /\/chats\/([^/?#]+)/.exec(page.url())![1] as ChatId
    for (let i = 0; i < 29; i++)
      await admin((api) =>
        Effect.gen(function* () {
          const window = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
          const entry = window.entries.at(-1)!
          yield* api.WriteVersion({
            slotId: entry.slotId as SlotId,
            forkId: window.forkId as ForkId,
            content: `Swipe ${i + 2}: the harbour is quiet tonight.`,
            expectedRowVersion: entry.rowVersion
          })
        })
      )
    await page.reload()
    await expect(reply.getByRole("group", { name: "Swipes" })).toContainText("30/30")
    await messageMenu(reply, "Write your own swipe")
    const shown = reply.getByRole("region", { name: "Swipe shown" })
    await expect(shown).toBeVisible()
    const body = shown.locator(":scope > div").last()
    const word = (await body.innerText()).trim().split(/\s+/)[0]!
    const select = (text: string | null) =>
      body.evaluate((element, wanted) => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        const selection = document.getSelection()!
        selection.removeAllRanges()
        if (wanted === null) return
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent!.indexOf(wanted)
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(node, at)
          range.setEnd(node, at + wanted.length)
          selection.addRange(range)
          return
        }
        throw new Error(`No "${wanted}" in the swipe shown`)
      }, text)
    await select(null)
    // Its selection's buttons come and go at the bar's free end, before the whole text's.
    await expect(shown.locator(SELECTION_ACTIONS)).toHaveCount(0)
    await expectNoShift(
      shown,
      () => select(word),
      () => select(null)
    )
  })
}
