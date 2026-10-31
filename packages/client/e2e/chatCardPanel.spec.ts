// The chat's side panel with a realistic cast, and a card edited from the chat (DESIGN §6.2):
// characters as a cast strip apart from the panel's tools, a character's definitions edited in
// place, a field opened large over the chat, and the full editor back to the same chat. Every
// card here is made up.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId } from "@rp/shared/chat.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

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
  await page.close()
  const refs = await admin((api) => api.ListLibrary({ kind: "card" }))
  const id = (name: string) => refs.find((ref) => ref.label === name)!.entityId as EntityId
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
        await expect(cast.getByRole("tab", { name: "Juniper Ashgrove", exact: true })).toBeVisible()
        await page.waitForTimeout(300)
        await shoot(page, `panel-${label}-${tag}`)
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
    await expect(tab.getByText(/Saving changes .* in 1 chat|no other chat uses it/)).toBeVisible()
    // An imported text's line endings rewritten by the first key aren't a deletion: no bin notice.
    await description.click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type(" Added in the panel.")
    await expect(tab.getByText("1 field has changes, kept as drafts until you save.")).toBeVisible()
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
    await large.getByRole("button", { name: "Done", exact: true }).click()
    await expect(textBox(tab, "Scenario")).toContainText("The kettle is on.")
    await expect(tab.getByText("2 fields have changes, kept as drafts until you save.")).toBeVisible()
    // Save, with the changes shown first.
    await tab.getByRole("button", { name: "Save (2)", exact: true }).click()
    const save = page.getByRole("dialog", { name: "Save a revision", exact: true })
    await save.getByRole("button", { name: "Save revision", exact: true }).click()
    await expect(tab.getByText("Saved.", { exact: true })).toBeVisible()
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
    // Text typed and then mostly replaced in one session is kept, and the notice says so plainly.
    await textBox(tab, "Personality").click()
    await page.keyboard.press("Control+End")
    await page.keyboard.type(" Keeps a dog called Ledger, who is older than the lighthouse.")
    await page.waitForTimeout(1500)
    await page.keyboard.press("Control+A")
    await page.keyboard.type("Brisk.")
    await tab.getByRole("button", { name: "Save (1)", exact: true }).click()
    await save.getByRole("button", { name: "Save revision", exact: true }).click()
    const notice = tab.getByText(
      "What Personality had before you replaced most of it is kept in the bin, under Recovered text, in case you want it back."
    )
    await expect(notice).toBeVisible()
    await shoot(page, `bin-notice-${width}`)
    await tab.getByRole("button", { name: "Dismiss", exact: true }).click()
    await expect(notice).toHaveCount(0)
    // The full editor opens over the chat and goes back to it, the URL never leaving it.
    await tab.getByRole("button", { name: `Open ${name} in the full editor`, exact: true }).click()
    const overlay = page.getByRole("dialog", { name: "Card editor", exact: true })
    await expect(overlay.getByRole("heading", { level: 1, name, exact: true })).toBeVisible()
    await expect(
      textBox(overlay, "Alternate greetings").or(overlay.getByRole("button", { name: "Add a greeting" }))
    ).toBeVisible()
    await shoot(page, `full-editor-over-chat-${width}`)
    await overlay.getByRole("button", { name: "More actions", exact: true }).click()
    await shoot(page, `full-editor-more-${width}`)
    await page.keyboard.press("Escape")
    await overlay.getByRole("button", { name: "Back to the chat", exact: true }).click()
    await expect(overlay).toHaveCount(0)
    expect(page.url()).toBe(url)
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
      await expect(page.getByText("Used by 1 chat: saving changes it there.")).toBeVisible()
      await expect(page.getByText(/in the bin/)).toHaveCount(0)
      await page.waitForTimeout(300)
      await shoot(page, `editor-${width}-${scheme}`)
    })
