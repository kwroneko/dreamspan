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
  await upload(page, name, syntheticPreset())
  return admin((api) =>
    Effect.gen(function* () {
      const ref = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === name)!
      yield* api.ChangeGenerationDefaults({ change: { preset: ref.id } })
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
      return chat.id
    })
  )
}

const theme = async (page: Page, width: number, scheme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.emulateMedia({ colorScheme: scheme })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), scheme)
}

const EVERY = "Above this line: reused by every reply"
const UNTIL = "Above this line: reused until old messages drop out"
const CHAT = "The chat goes here"
const AFTER = "After the chat: sent last"

/**
 * The lines, in order, each as wide as the prompt rows and lined up with them, in text the
 * rows' size; the notes inside the chat as a row among them. Screenshots at the first line
 * and at the last.
 */
const check = async (page: Page, root: Locator, name: string) => {
  const lines = root.locator("[data-section-line]")
  await expect(lines.first()).toBeVisible({ timeout: 60_000 })
  await expect(lines).toHaveText([EVERY, CHAT, UNTIL, AFTER])
  // The chat goes right after the line every reply reuses: the new chat's opening line ends it.
  await expect(root.locator("[data-section-line]:has-text('reused by every reply') + [data-section-line]")).toHaveText(
    CHAT
  )
  await expect(root.locator("[data-note-slot='Notes inside the chat']")).toContainText("Character's Note (depth 2)")
  await expect(root.locator("[data-note-slot='Notes after the chat']")).toContainText("Weather now")
  const row = (await root.locator('[data-prompt="chatHistory"]').boundingBox())!
  const geometry = await lines.evaluateAll((all) =>
    all.map((line) => {
      const box = line.getBoundingClientRect()
      const label = line.querySelector("span.font-semibold")!
      return { left: box.left, right: box.right, size: parseFloat(getComputedStyle(label).fontSize) }
    })
  )
  for (const line of geometry) {
    expect(Math.abs(line.left - row.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(line.right - (row.x + row.width))).toBeLessThanOrEqual(1)
    expect(line.size).toBeGreaterThanOrEqual(14)
  }
  const slot = (await root.locator("[data-note-slot='Notes inside the chat']").boundingBox())!
  expect(Math.abs(slot.x - row.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(slot.width - row.width)).toBeLessThanOrEqual(1)

  await lines.first().scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(shots, `${name}-top.png`) })
  await lines.last().scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(shots, `${name}-bottom.png`) })
  // The "?" says what the line means for where a prompt goes.
  await lines
    .first()
    .getByRole("button", { name: `What “${EVERY}” means` })
    .click()
  const popup = page.getByRole("dialog", { name: "Reused between replies" })
  await expect(popup).toContainText("Prompts that rarely change belong up here.")
  await page.screenshot({ path: join(shots, `${name}-explained.png`) })
  await page.keyboard.press("Escape")
  await expect(popup).toHaveCount(0)
}

for (const width of [1440, 1024, 390])
  for (const scheme of ["light", "dark"] as const)
    test(`the markers between prompts (${width}px ${scheme})`, async ({ page }) => {
      await theme(page, width, scheme)
      const chatId = await setUp(page, `Markers ${width} ${scheme}`)
      await page.goto(`${server().url}/chats/${chatId}`)
      await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
      const panel = await openPanel(page, "Prompt preset")
      await expect(panel.getByRole("list", { name: "Preset blocks" })).toBeVisible({ timeout: 60_000 })
      await check(page, panel, `tab-${width}-${scheme}`)
      await panel.getByRole("button", { name: "Open the preset in the large editor", exact: true }).click()
      const overlay = page.getByRole("dialog", { name: "Preset editor", exact: true })
      await expect(overlay).toBeVisible()
      await check(page, overlay, `large-${width}-${scheme}`)
    })
