// The chat's side panel with a realistic cast, and a card edited from the chat (DESIGN §6.2):
// characters as a cast strip apart from the panel's tools, a character's definitions edited in
// place, a field opened large over the chat, and the full editor back to the same chat. Every
// card here is made up.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId } from "@rp/shared/chat.ts"
import { textField } from "@rp/shared/editing.ts"
import { closePortrait, portraitView, portraitPng } from "./support/portrait.ts"
import { asUser } from "./support/rpc.ts"
import {
  NOTHING_TO_SAVE,
  UNSAVED,
  editHistoryTexts,
  expectSaveState,
  saveButton,
  saveRevision
} from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "200" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(180_000)

const shots = process.env.SCREENSHOT_DIR
const shoot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

// Imported ST files often carry Windows line endings.
const long = (name: string) =>
  [
    `${name} keeps the lighthouse at the end of the causeway, where the tide comes in twice as fast as anywhere else on the coast.`,
    `They have a habit of naming every gull, and a ledger of the ships that passed in fog, written in a hand nobody else can read.`,
    `When strangers arrive, ${name} offers tea first and questions later, and remembers every answer.`
  ]
    .join("\r\n\r\n")
    .repeat(3)

const NAMES = [
  "Model",
  "Seraphina Valentina Montgomery-Blackwood",
  "History",
  "Captain Bartholomew Ironside the Third",
  "Wren",
  "Lady Isadora of the Silver Marches",
  "Professor Augustin Llewellyn-Hargreaves",
  "Tamsin"
]

const importCard = async (page: Page, data: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data }))
  const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

let group = ""
let single = ""
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const name of [...NAMES, "Juniper Ashgrove"])
    await importCard(page, {
      name,
      description: long(name),
      personality: `Patient, dry, observant.\r\nSlow to anger.`,
      scenario: `A storm has closed the causeway; everyone is stuck in ${name}'s lighthouse until morning.`,
      first_mes: `${name} looks up from the ledger. "You're late."`,
      mes_example: `<START>\r\n{{char}}: Mind the third step.\r\n{{user}}: Why?\r\n{{char}}: It isn't there.`,
      system_prompt: "",
      post_history_instructions: ""
    })
  const refs = await admin((api) => api.ListLibrary({ kind: "card" }))
  const id = (name: string) => refs.find((ref) => ref.label === name)!.entityId as EntityId
  // One portrait with an image, for the lightbox and the strip.
  await page.goto(`${server().url}/library/${refs.find((ref) => ref.label === "Wren")!.id}`)
  await cardFieldsTab(page, "Metadata")
  await page
    .getByLabel("Choose an avatar, or drop it here")
    .setInputFiles({ name: "wren.png", mimeType: "image/png", buffer: portraitPng() })
  // A new picture goes through the cutout chooser (§14.5c); its default cutout is saved.
  await page
    .getByRole("dialog", { name: /new picture$/ })
    .getByRole("button", { name: "Save picture" })
    .click()
  await expect(page.getByRole("img", { name: "The card's avatar" })).toBeVisible()
  await page.close()
  await admin((api) => api.SetPersona({ entityId: id("Juniper Ashgrove"), persona: true }))
  const started = await admin((api) =>
    Effect.all([
      api.StartChat({
        cards: NAMES.map(id),
        persona: id("Juniper Ashgrove"),
        greeting: null,
        first: { _tag: "Send", content: "Is anyone here?", speakerEntityId: null }
      }),
      api.StartChat({
        cards: [id("Wren")],
        persona: id("Juniper Ashgrove"),
        greeting: null,
        first: { _tag: "Send", content: "Hello, Wren.", speakerEntityId: null }
      })
    ])
  )
  group = started[0].chat.id
  single = started[1].chat.id
})

const ids = async () => {
  const refs = await admin((api) => api.ListLibrary({ kind: "card" }))
  return (name: string) => refs.find((ref) => ref.label === name)!
}

const textBox = (scope: Page | ReturnType<Page["getByRole"]>, name: string) =>
  scope.getByRole("textbox", { name, exact: true })

for (const width of [1440, 390])
  for (const scheme of ["light", "dark"] as const)
    test(`the panel's tools and cast, at ${width} ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const tag = `${width}-${scheme}`
      const ref = await ids()
      for (const [chat, label, name] of [
        [group, "group", "Seraphina Valentina Montgomery-Blackwood"],
        [single, "single", "Wren"]
      ] as const) {
        await page.goto(`${server().url}/chats/${chat}?panel=card:${ref(name).entityId}`)
        await expect(page.getByRole("tabpanel", { name, exact: true })).toBeVisible({ timeout: 30_000 })
        const tools = page.getByRole("tablist", { name: "Chat panel", exact: true })
        const cast = page.getByRole("tablist", { name: "Characters", exact: true })
        // The tools are one line at any width; the rest are under More.
        const box = (await tools.boundingBox())!
        expect(box.height).toBeLessThan(44)
        await expect(tools.getByRole("tab", { name: "This chat", exact: true })).toBeVisible()
        // Characters are their own strip: a character named "Model" is never a tool.
        await expect(cast.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true")
        if (label === "group") {
          await expect(cast.getByRole("tab", { name: "Model", exact: true })).toHaveCount(1)
          await expect(cast.getByRole("tab")).toHaveCount(NAMES.length + 2)
          const strip = (await cast.boundingBox())!
          expect(strip.height).toBeLessThan(52)
        }
        await expect(cast.getByRole("tab", { name: "Juniper Ashgrove", exact: true })).toBeAttached()
        // Eight characters with long names fit the strip at the panel's default width: the
        // others as portraits, named on hover, without scrolling.
        if (width === 1440)
          expect(await cast.evaluate((strip) => strip.scrollWidth <= strip.clientWidth + 1)).toBeTruthy()
        await page.waitForTimeout(300)
        await shoot(page, `panel-${label}-${tag}`)
        // The tab's portrait opens the whole image (beside the chat, or over it on a phone), the
        // panel kept; the Picture button over it changes it (§14.5c). One without a picture has
        // nothing to view.
        const panel = page.getByRole("tabpanel", { name, exact: true })
        await expect(panel.getByRole("button", { name: "Picture", exact: true })).toBeVisible()
        if (label === "group") {
          await expect(panel.getByRole("button", { name: `View ${name}'s picture`, exact: true })).toHaveCount(0)
          continue
        }
        await panel.getByRole("button", { name: `View ${name}'s picture`, exact: true }).click()
        const lightbox = portraitView(page, name)
        await expect(lightbox).toBeVisible()
        await expect(lightbox.getByRole("img", { name: `${name}'s full portrait` })).toBeVisible()
        await page.waitForTimeout(300)
        await shoot(page, `lightbox-${tag}`)
        await closePortrait(page)
        await expect(lightbox).toHaveCount(0)
        await expect(page.getByRole("tabpanel", { name, exact: true })).toBeVisible()
      }
      // A tool under More opens like any tab.
      const more = page.getByRole("button", { name: "More tools", exact: true })
      if (await more.isVisible()) {
        await more.click()
        await page.getByRole("menuitem", { name: "History edits" }).click()
        await expect(page.getByRole("tab", { name: "History edits", exact: true })).toHaveAttribute(
          "aria-selected",
          "true"
        )
      }
    })

for (const width of [1440, 390])
  test(`a character's definitions are edited in the panel, at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const ref = await ids()
    const name = width === 1440 ? "Tamsin" : "Wren"
    const url = `${server().url}/chats/${width === 1440 ? group : single}?panel=card:${ref(name).entityId}`
    await page.goto(url)
    const tab = page.getByRole("tabpanel", { name, exact: true })
    const description = textBox(tab, "Description")
    await expect(description).toBeVisible({ timeout: 30_000 })
    await expect(tab.getByText(/as you type/)).toHaveCount(0)
    // An imported text's line endings rewritten by the first key aren't a deletion: no bin notice.
    await description.click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type(" Added in the panel.")
    await expectSaveState(tab, UNSAVED)
    await page.waitForTimeout(1500)
    await expect(tab.getByText(/in the bin/)).toHaveCount(0)
    await shoot(page, `edit-in-panel-${width}`)
    // Large, over the chat: the same draft.
    await tab.getByRole("button", { name: "Open Scenario large", exact: true }).click()
    const large = page.getByRole("dialog", { name: "Scenario", exact: true })
    await textBox(large, "Scenario").click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type(" The kettle is on.")
    await shoot(page, `expanded-${width}`)
    await large.getByRole("button", { name: "Close", exact: true }).click()
    await expect(textBox(tab, "Scenario")).toContainText("The kettle is on.")
    await expectSaveState(tab, UNSAVED)
    // Save asks nothing.
    await saveRevision(tab)
    await expectSaveState(tab, NOTHING_TO_SAVE)
    // (On a phone the panel is itself a dialog; no other opened.)
    await expect(page.getByRole("dialog", { name: "Changed meanwhile" })).toHaveCount(0)
    await expect(tab.getByText(/in the bin/)).toHaveCount(0)
    const saved = await admin((api) =>
      api.ListChatCards({
        chatId: width === 1440 ? (group as never) : (single as never),
        slotId: null,
        entityIds: [ref(name).entityId]
      })
    )
    expect(saved[0]!.definition.description).toContain("Added in the panel.")
    expect(saved[0]!.definition.scenario).toContain("The kettle is on.")
    // Text typed and then mostly replaced in one session is kept in the field's edit history.
    await textBox(tab, "Personality").click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type(" Keeps a dog called Ledger, who is older than the lighthouse.")
    await page.waitForTimeout(1500)
    await page.keyboard.press("Control+A")
    await page.keyboard.type("Brisk.")
    // Save has one fixed home in the card header, above the fields.
    await expect(tab.locator("[data-card-header]").getByRole("group", { name: "Save", exact: true })).toHaveCount(1)
    await saveButton(tab).scrollIntoViewIfNeeded()
    await expect(saveButton(tab)).toBeInViewport()
    await saveRevision(tab)
    await expect(tab.getByText(/in the bin/)).toHaveCount(0)
    const personality = await admin((api) => editHistoryTexts(api, ref(name).id, textField(["personality"])))
    expect(personality).toContain("Brisk.")
    expect(personality.some((text) => text.includes("Keeps a dog called Ledger"))).toBe(true)
    await tab.getByRole("button", { name: "Edit history of Personality", exact: true }).click()
    const history = page.getByRole("dialog", { name: "Edit history: Personality", exact: true })
    await expect(history.getByRole("list", { name: "Earlier states" }).getByRole("listitem")).not.toHaveCount(0)
    await shoot(page, `edit-history-${width}`)
    await history.getByRole("button", { name: "Close", exact: true }).click()
    await expect(history).toHaveCount(0)
    // The full editor opens over the chat and goes back to it, the URL never leaving it.
    await tab.getByRole("button", { name: `Open ${name} in the full editor`, exact: true }).click()
    const overlay = page.getByRole("dialog", { name: "Card editor", exact: true })
    await expect(overlay.getByRole("heading", { level: 1, name, exact: true })).toBeVisible()
    await cardFieldsTab(overlay, "Greetings")
    await expect(overlay.getByRole("button", { name: "Add a greeting" })).toBeVisible()
    await shoot(page, `full-editor-over-chat-${width}`)
    await overlay.getByRole("button", { name: "More actions", exact: true }).click()
    await shoot(page, `full-editor-more-${width}`)
    await page.keyboard.press("Escape")
    await overlay.getByRole("button", { name: "Back to the chat", exact: true }).click()
    await expect(overlay).toHaveCount(0)
    // The same chat and fork; on a phone the sheet closed as the editor opened, as for a preset.
    expect(new URL(page.url()).pathname).toBe(new URL(url).pathname)
    expect(new URL(page.url()).searchParams.has("fork")).toBe(true)
    expect(new URL(page.url()).searchParams.get("panel")).toBe(width === 390 ? null : `card:${ref(name).entityId}`)
    expect(new URL(page.url()).searchParams.has("editor")).toBe(false)
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible()
  })

for (const width of [1440, 390])
  for (const scheme of ["light", "dark"] as const)
    test(`the card editor page's header, at ${width} ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const ref = await ids()
      await page.goto(`${server().url}/library/${ref("Lady Isadora of the Silver Marches").id}`)
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
      await expect(page.getByText("Used by 1 chat.", { exact: true })).toBeVisible()
      await expect(page.getByText(/in the bin/)).toHaveCount(0)
      await page.waitForTimeout(300)
      await shoot(page, `editor-${width}-${scheme}`)
    })
