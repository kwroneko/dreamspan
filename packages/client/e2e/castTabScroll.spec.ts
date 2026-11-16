// Synthetic cast cards: ordinary tab navigation starts at the card header.
import { expect, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile({
  ...withAdmin,
  ...(process.env.CAST_TAB_CLIENT_DIST ? { CLIENT_DIST: process.env.CAST_TAB_CLIENT_DIST } : {})
})

test("cast tabs open at the top of the panel", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: "dark" })
  await page.addInitScript(() => localStorage.setItem("rp.theme", "dark"))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const cards: EntityId[] = []
  for (const name of ["Alice", "Sam"]) {
    const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
      headers: { origin: server().url, "content-type": "application/octet-stream" },
      data: Buffer.from(
        JSON.stringify({
          spec: "chara_card_v3",
          spec_version: "3.0",
          data: {
            name,
            description: Array.from({ length: 30 }, (_, i) => `${name} watches the harbour. Synthetic line ${i}.`).join(
              "\n"
            ),
            personality: "Patient.",
            scenario: "A harbour.",
            first_mes: "Hello.",
            mes_example: "",
            creator_notes: "Synthetic navigation beacon.",
            system_prompt: "",
            post_history_instructions: "",
            alternate_greetings: [],
            tags: [],
            creator: "Synthetic",
            character_version: "1.0",
            extensions: {}
          }
        })
      )
    })
    expect(response.ok()).toBeTruthy()
    cards.push((await response.json()).library.ref.entityId)
  }
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.StartChat({
      cards,
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "A synthetic harbour scene.", speakerEntityId: null }
    })
  )
  await page.goto(`${server().url}/chats/${chat.chat.id}`)
  for (const name of ["Alice", "Sam", "Alice"]) {
    const panel = await openPanel(page, name)
    await expect(panel.locator('[data-card-tabs="panel"]')).toBeVisible()
    // Let lazy editor mounting and any layout-triggered scroll settle.
    await page.waitForTimeout(1700)
    const positions = await panel.evaluate((element) => {
      const result = []
      for (let node: Element | null = element; node; node = node.parentElement)
        if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY))
          result.push(node.scrollTop)
      return result
    })
    if (name === "Alice") await page.screenshot({ path: info.outputPath("cast-tab-1440-dark.png") })
    expect(positions.length).toBeGreaterThan(0)
    expect(positions).toEqual(positions.map(() => 0))
  }
  // Explicit search navigation still opens and reveals the requested field's tab.
  const panel = page.getByRole("tabpanel", { name: "Alice · 1.0", exact: true })
  await panel.getByRole("button", { name: "Search and replace", exact: true }).click()
  const search = panel.getByRole("region", { name: "Search and replace", exact: true })
  await search.getByRole("textbox", { name: "Find", exact: true }).fill("navigation beacon")
  await search.getByRole("button", { name: "Find", exact: true }).click()
  await search.getByRole("button", { name: "Go to Creator's notes", exact: true }).click()
  await expect(panel.getByRole("tab", { name: "Metadata", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(panel.getByRole("textbox", { name: "Creator's notes", exact: true })).toBeInViewport()
  await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
})
