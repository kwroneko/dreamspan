// The Prompt preset tab shows the preset's prompts for an imported ST preset, in a saved chat
// and in a chat not made yet (presetempty1, 2026-11-17: a new chat's tab showed the picker and
// nothing under it until the first send). A made-up 100-prompt ST preset with regex scripts,
// and the ST default preset fixture, both imported through the library import.
import { readFileSync } from "node:fs"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { replaceEditorText } from "./support/textbox.ts"
import { useSideChatProvider } from "./support/workshopSideChat.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const base = JSON.parse(
  readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
) as Record<string, unknown> & {
  prompts: Array<Record<string, unknown>>
  prompt_order: Array<{ character_id: number; order: Array<{ identifier: string; enabled: boolean }> }>
}
const defaultOrder = base.prompt_order.find((o) => o.character_id === 100001)!.order

/** The default preset with 88 made-up prompts around its markers, some off, and two regex scripts. */
const manyPrompts = () => {
  const extra = Array.from({ length: 88 }, (_, i) => ({
    identifier: `many-${i}`,
    name: i % 11 === 0 ? `<section ${i}>` : `Rule ${i + 1}`,
    role: "system",
    content: `Rule ${i + 1}: keep {{char}} consistent with the scene, line ${i + 1}.`,
    system_prompt: false,
    marker: false,
    injection_position: 0,
    injection_depth: 4,
    forbid_overrides: false
  }))
  const at = defaultOrder.findIndex((e) => e.identifier === "chatHistory")
  const mine = extra.map((p, i) => ({ identifier: p.identifier, enabled: i % 7 !== 3 }))
  return {
    ...base,
    prompts: [...base.prompts, ...extra],
    prompt_order: [
      {
        character_id: 100001,
        order: [
          ...defaultOrder.slice(0, 2),
          ...mine.slice(0, 80),
          ...defaultOrder.slice(2, at + 1),
          ...mine.slice(80),
          ...defaultOrder.slice(at + 1)
        ]
      }
    ],
    extensions: {
      regex_scripts: [
        {
          id: "r1",
          scriptName: "Trim stars",
          findRegex: "/\\*{3,}/g",
          replaceString: "",
          placement: [2],
          disabled: false
        },
        { id: "r2", scriptName: "Quotes", findRegex: "/“|”/g", replaceString: '"', placement: [1, 2], disabled: false }
      ]
    }
  }
}
const defaultIds = defaultOrder.map((entry) => entry.identifier)
const MANY = [...defaultIds, ...Array.from({ length: 88 }, (_, i) => `many-${i}`)]

const upload = async (page: Page, name: string, data: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    data: Buffer.from(JSON.stringify(data)),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

const setUp = async (page: Page, name: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await upload(page, `Wren ${name}`, {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: `Wren ${name}`, description: "A lighthouse keeper.", first_mes: "The lamp turns." }
  })
  await upload(page, `Many ${name}`, manyPrompts())
  await upload(page, `Default ${name}`, base)
  return admin((api) =>
    Effect.gen(function* () {
      const presets = yield* api.ListLibrary({ kind: "preset" })
      const many = presets.find((r) => r.label === `Many ${name}`)!
      yield* api.ChangeGenerationDefaults({ change: { preset: many.id } })
      const card = (yield* api.ListCards()).find((c) => c.name === `Wren ${name}`)!
      const chat = yield* api.CreateChat({ title: name })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      const sent = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, content: "Hello.", branch: false })
      if (sent._tag !== "Posted") throw new Error("expected the message posted")
      return { chatId: chat.id, entityId: card.entityId }
    })
  )
}

/** The tab names the preset in its header, then lists every prompt of its order (and the harness's own rows). */
const expectRows = async (panel: Locator, label: string, identifiers: ReadonlyArray<string>) => {
  await expect(panel.locator("[data-editor-header]")).toContainText(label, { timeout: 60_000 })
  const list = panel.getByRole("list", { name: "Preset blocks" })
  await expect(list).toBeVisible()
  await expect
    .poll(async () => {
      const shown = new Set(
        await list.locator("[data-prompt]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-prompt")))
      )
      return identifiers.filter((identifier) => !shown.has(identifier))
    })
    .toEqual([])
  await expect(panel.getByRole("button", { name: "Add prompt", exact: true })).toBeVisible()
}

const choose = async (page: Page, panel: Locator, label: string) => {
  await panel.getByRole("button", { name: /^Prompt preset for the next reply: / }).click()
  await page.getByRole("radiogroup", { name: "Prompt preset", exact: true }).getByRole("radio", { name: label }).click()
  await expect(
    panel.getByRole("button", { name: `Prompt preset for the next reply: ${label}. Change it` })
  ).toBeVisible()
}

test.setTimeout(180_000)

test.describe("first replies", () => {
  const provider = useSideChatProvider(server)
  for (const action of ["Generate", "Send"] as const)
    test(`first ${action} uses unsaved changes to the open preset`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      const { entityId } = await setUp(page, `First ${action}`)
      // Simulate a save still in flight when the first reply is requested.
      await page.routeWebSocket(/\/rpc$/, (socket) => {
        const upstream = socket.connectToServer()
        socket.onMessage((data) => {
          if (typeof data === "string" && JSON.parse(data).tag === "SaveEditorDraft")
            setTimeout(() => upstream.send(data), 1200)
          else upstream.send(data)
        })
      })
      await page.goto(`${server().url}/cards/${entityId}/chat`)
      const composer = page.getByLabel("Message", { exact: true })
      await expect(composer).toBeEditable()
      if (action === "Send") await composer.fill("I open the ledger.")
      const panel = await openPanel(page, "Prompt preset")
      await expect(panel.getByRole("list", { name: "Preset blocks" })).toBeVisible()
      const expand = panel.getByRole("button", { name: /^Expand Main Prompt/ }).first()
      if (await expand.count()) await expand.click()
      const field = panel.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
      const edited = "Check the tally in the newly updated ledger."
      await replaceEditorText(field, edited)
      const before = provider().bodies.length
      await page.getByRole("button", { name: action === "Send" ? /^Send$/ : /^Generate/ }).click()
      await expect(page).toHaveURL(/\/chats\/[^/?]+/)
      await expect.poll(() => provider().bodies.length).toBeGreaterThan(before)
      expect(JSON.stringify(provider().bodies[before])).toContain(edited)
    })
})

for (const width of [1440, 390])
  test(`the Prompt preset tab lists an imported preset's prompts, before and after the first send (${width}px)`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
    const errors: Array<string> = []
    page.on("pageerror", (error) => errors.push(error.message))
    const name = `Tab ${width}`
    const { chatId, entityId } = await setUp(page, name)

    // A saved chat: the many-prompt preset, every prompt listed.
    await page.goto(`${server().url}/chats/${chatId}`)
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
    let panel = await openPanel(page, "Prompt preset")
    await expectRows(panel, `Many ${name}`, MANY)
    await expect(panel.locator('[data-prompt="many-0"]')).toContainText("<section 0>")
    if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, `preset-tab-saved-${width}`)

    // A chat not made yet with the same card: its tab edits the account's preset the same way.
    await page.goto(`${server().url}/cards/${entityId}/chat`)
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
    panel = await openPanel(page, "Prompt preset")
    await expectRows(panel, `Many ${name}`, MANY)
    if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, `preset-tab-pending-${width}`)
    // Choosing another preset there shows that one's prompts.
    await choose(page, panel, `Default ${name}`)
    await expectRows(panel, `Default ${name}`, defaultIds)
    await expect(panel.locator('[data-prompt="main"]')).toContainText("Main Prompt")
    expect(errors).toEqual([])
  })
