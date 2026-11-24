// A card's message fields look like the messages they become (owner, 2026-11-24): the first
// message, the alternate and group greetings and the example dialogue are in the message editor's
// box with its styling (ui/MessageTextEditor.tsx), italics and dialogue in the chat's colours, a
// {{macro}} still a macro inside them; the example dialogue's <START> lines and speaker prefixes
// stay plain; the description and the other prompt fields are unstyled. The same in the full
// editor, the chat's side panel and a field's own tab; the text and what's copied are the
// stored text. Screenshots at 1340 and 390 dark go to SCREENSHOT_DIR. Every card here is made up.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { textBoxValue } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(150_000)

const shots = process.env.SCREENSHOT_DIR
const shoot = async (page: Page, name: string) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" })
}

const GREETING = `*She sets the lantern down.* "Quoted {{char}} speech, for {{user}}," she says.`
const ALTERNATE = `*The tide is out.* "Another {{char}} hello."`
const EXAMPLES = [
  "<START>",
  `{{user}}: *waves* "Hello there."`,
  `{{char}}: "Quoted {{char}} speech," *she smiles*.`,
  "<START>",
  "{{char}}: The tide turns at noon."
].join("\n")
const DESCRIPTION = `{{char}} keeps the lighthouse. *Not italic here* and "no quote colour" either.`
// A quote colour of the user's own (Display settings): the fields take it as the chat does.
const QUOTE = "#2f8f6a"
const QUOTE_RGB = "rgb(47, 143, 106)"

const importCard = async (page: Page, name: string) => {
  const data = {
    name,
    description: DESCRIPTION,
    personality: "Careful, warm.",
    scenario: "A foggy morning at the harbour office.",
    first_mes: GREETING,
    mes_example: EXAMPLES,
    creator_notes: "Made for testing.",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [ALTERNATE],
    group_only_greetings: [],
    tags: [],
    creator: "Synthetic",
    character_version: "1.0",
    extensions: {}
  }
  const body = Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data }))
  const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
    data: body,
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  return (await response.json()).library.ref as { id: RefId; entityId: EntityId }
}

const prepare = async (page: Page, width: number, theme: "light" | "dark") => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await admin((api) => api.SetDisplayPrefs({ prefs: { quoteTextColor: QUOTE } }))
}

const color = (element: Locator) => element.evaluate((node) => getComputedStyle(node).color)
/** A colour token's value here, as computed. */
const tokenColor = (page: Page, token: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("span")
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }, token)

/** A greeting's box: italics and dialogue styled, the macro in the quote still a macro. */
const expectStyledGreeting = async (page: Page, box: Locator, quoted: string) => {
  await expect(box.locator(".rp-md-em").first()).toBeVisible()
  const em = box.locator(".rp-md-em").first()
  expect(await em.evaluate((node) => getComputedStyle(node).fontStyle)).toBe("italic")
  expect(await color(em)).toBe(await tokenColor(page, "--color-message-italics"))
  const quote = box.locator(".rp-md-quote").filter({ hasText: quoted })
  await expect(quote).toHaveCount(1)
  expect(await color(quote)).toBe(QUOTE_RGB)
  // The macro is inside the quote, innermost, so its own colour shows.
  const macro = quote.locator(".rp-macro-value").filter({ hasText: "{{char}}" })
  await expect(macro).toHaveCount(1)
  const macroColor = await color(macro)
  expect(macroColor).toBe(await tokenColor(page, "--macro-value"))
  expect(macroColor).not.toBe(QUOTE_RGB)
}

/** The description box: no message styling, its macro highlighted as before. */
const expectPlainDescription = async (box: Locator) => {
  await expect(box.locator(".rp-macro-value").first()).toHaveText("{{char}}")
  await expect(box.locator("[class*='rp-md-']")).toHaveCount(0)
  expect(await box.evaluate((node) => node.closest(".cm-editor")!.classList.contains("rp-message-text"))).toBe(false)
  expect(await textBoxValue(box)).toBe(DESCRIPTION)
}

/** Example dialogue: the messages styled, the separators and prefixes as they were. */
const expectStyledExamples = async (page: Page, box: Locator) => {
  await expectStyledGreeting(page, box, "Quoted {{char}} speech,")
  await expect(box.locator(".rp-md-em").filter({ hasText: "waves" })).toHaveCount(1)
  // No style mark covers a <START> line or a "{{user}}:" / "{{char}}:" prefix.
  const marked = await box.evaluate((node) =>
    [...node.querySelectorAll(".cm-line")].map((line) =>
      [...line.querySelectorAll("[class*='rp-md-']")].map((mark) => mark.textContent).join("|")
    )
  )
  expect(marked[0]).toBe("")
  expect(marked[3]).toBe("")
  expect(marked[4]).toBe("")
  for (const line of marked) expect(line).not.toMatch(/START|\{\{(user|char)\}\}:/)
  const prefix = box.locator(".cm-line").nth(1).locator(".rp-macro-value").first()
  await expect(prefix).toHaveText("{{user}}")
  expect(await textBoxValue(box)).toBe(EXAMPLES)
}

/** What's copied from the box is its stored text, marks and all. */
const expectCopy = async (page: Page, box: Locator, text: string) => {
  await box.click()
  await box.press("ControlOrMeta+a")
  await box.press("ControlOrMeta+c")
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text)
}

test.use({ permissions: ["clipboard-read", "clipboard-write"] })

for (const [width, theme] of [
  [1340, "dark"],
  [1340, "light"],
  [390, "dark"]
] as const)
  test(`the full editor styles the greetings and example dialogue, ${width} ${theme}`, async ({ page }, info) => {
    await prepare(page, width, theme)
    const ref = await importCard(page, `Maren ${width} ${theme}`)
    await page.goto(`${server().url}/library/${ref.id}`)

    const definition = await cardFieldsTab(page, "Definition")
    const description = definition.getByRole("textbox", { name: "Description", exact: true })
    await expectPlainDescription(description)
    // The plain description above the styled example dialogue.
    await description.evaluate((node) => node.scrollIntoView({ block: "center" }))
    const examples = definition.getByRole("textbox", { name: "Example messages", exact: true })
    await shoot(page, `page-description-${width}-${theme}`)
    await examples.scrollIntoViewIfNeeded()
    await expectStyledExamples(page, examples)
    // The fields keep one look: the same font, size and line height as the description's.
    const metrics = (box: Locator) =>
      box.evaluate((node) => {
        const style = getComputedStyle(node.querySelector(".cm-line")!)
        return [style.fontFamily, style.fontSize, style.lineHeight, style.paddingLeft]
      })
    expect(await metrics(examples)).toEqual(
      await metrics(definition.getByRole("textbox", { name: "Description", exact: true }))
    )
    await shoot(page, `page-definition-${width}-${theme}`)

    const greetings = await cardFieldsTab(page, "Greetings")
    const first = greetings.getByRole("textbox", { name: "First message", exact: true })
    await expectStyledGreeting(page, first, "Quoted {{char}} speech")
    const alternate = greetings.getByRole("textbox", { name: "Alternate greeting 1", exact: true })
    await expectStyledGreeting(page, alternate, "Another {{char}} hello.")
    await expectCopy(page, first, GREETING)

    // Typed text is styled as it will render, and the text stays as typed.
    await first.press("ControlOrMeta+End")
    await page.keyboard.type(` "Fresh {{user}} words," *typed in*.`)
    await expect(first.locator(".rp-md-quote").filter({ hasText: "Fresh" })).toHaveCount(1)
    await expect(
      first
        .locator(".rp-md-quote")
        .filter({ hasText: "Fresh" })
        .locator(".rp-macro-value")
        .filter({ hasText: "{{user}}" })
    ).toHaveCount(1)
    await expect(first.locator(".rp-md-em").filter({ hasText: "typed in" })).toHaveCount(1)
    expect(await textBoxValue(first)).toBe(`${GREETING} "Fresh {{user}} words," *typed in*.`)
    await page.keyboard.press("ControlOrMeta+z")
    await expect.poll(() => textBoxValue(first)).toBe(GREETING)
    await expectLayout(page, info, `card-greetings-${width}-${theme}`, { scope: '[data-card-tabs="page"]' })
    await shoot(page, `page-greetings-${width}-${theme}`)

    if (width === 1340) {
      // A field in its own tab is the same box.
      await first.click()
      await page.getByRole("link", { name: "Open First message in a tab", exact: true }).click()
      const own = page.locator("[data-field-tab]").getByRole("textbox", { name: "First message", exact: true })
      await expectStyledGreeting(page, own, "Quoted {{char}} speech")
      await shoot(page, `field-tab-${width}-${theme}`)
    }
  })

for (const width of [1340, 390])
  test(`the chat's side panel styles them the same, ${width} dark`, async ({ page }, info) => {
    await prepare(page, width, "dark")
    const ref = await importCard(page, `Isolde ${width}`)
    const started = await admin((api) =>
      api.StartChat({
        cards: [ref.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Hello from the pier.", speakerEntityId: null }
      })
    )
    await page.goto(`${server().url}/chats/${started.chat.id}?panel=card:${ref.entityId}`)
    const panel = page.getByRole("tabpanel").filter({ has: page.locator('[data-card-tabs="panel"]') })
    await expect(panel.getByRole("tablist", { name: "Card fields" })).toBeVisible({ timeout: 30_000 })
    const definition = await cardFieldsTab(panel, "Definition")
    await expectPlainDescription(definition.getByRole("textbox", { name: "Description", exact: true }))
    const examples = definition.getByRole("textbox", { name: "Example messages", exact: true })
    await examples.scrollIntoViewIfNeeded()
    await expectStyledExamples(page, examples)
    await shoot(page, `panel-definition-${width}-dark`)
    const greetings = await cardFieldsTab(panel, "Greetings")
    const first = greetings.getByRole("textbox", { name: "First message", exact: true })
    await expectStyledGreeting(page, first, "Quoted {{char}} speech")
    await expectStyledGreeting(
      page,
      greetings.getByRole("textbox", { name: "Alternate greeting 1", exact: true }),
      "Another {{char}} hello."
    )
    await expectLayout(page, info, `panel-greetings-${width}`, { scope: '[data-card-tabs="panel"]' })
    await shoot(page, `panel-greetings-${width}-dark`)
    await expectCopy(page, first, GREETING)
  })
