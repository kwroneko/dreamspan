import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "10000", FAKE_GENERATOR_TOKENS: "10" })
for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const)
    test(`group greetings follow pending cast at ${width} (${theme})`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      let holdAdd = false
      let releaseAdd: (() => void) | undefined
      await page.routeWebSocket(/\/rpc$/, (socket) => {
        const upstream = socket.connectToServer()
        socket.onMessage((data) => {
          const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string }) : null
          if (holdAdd && request?.tag === "GetCardForChat") releaseAdd = () => upstream.send(data)
          else upstream.send(data)
        })
        upstream.onMessage((data) => socket.send(data))
      })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const name = `Mira ${width} ${theme}`
      const second = `Tobin ${width} ${theme}`
      for (const data of [
        {
          name,
          first_mes: "Mira opens the door.",
          alternate_greetings: ["Mira waves."],
          group_only_greetings: ["Mira welcomes the crew."]
        },
        { name: second, first_mes: "Tobin nods.", group_only_greetings: ["Tobin greets everyone."] }
      ]) {
        const response = await page.request.post(`${server().url}/library/import?name=fixture.json`, {
          data: Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data })),
          headers: { origin: server().url, "content-type": "application/octet-stream" }
        })
        expect(response.status()).toBe(200)
      }
      await page.goto(`${server().url}/library`)
      await page.getByRole("link", { name: `Start a chat with ${name}`, exact: true }).click()
      const greeting = page.getByRole("article", { name: `Greeting from ${name}`, exact: true })
      const next = greeting.getByRole("button", { name: `Next greeting from ${name}` })
      await next.click()
      await expect(greeting).toContainText("Mira waves.")
      await expect(next).toBeDisabled()
      const add = async (whileLoading?: () => Promise<void>) => {
        holdAdd = whileLoading !== undefined
        releaseAdd = undefined
        await page.getByLabel("Add character", { exact: true }).click()
        await page.getByRole("option", { name: second, exact: true }).click()
        if (whileLoading) {
          await expect.poll(() => releaseAdd !== undefined).toBe(true)
          await whileLoading()
          holdAdd = false
          releaseAdd!()
        }
        await expect(page.getByRole("article", { name: `Greeting from ${second}`, exact: true })).toBeVisible()
      }
      await add(async () => {
        await greeting.getByRole("button", { name: `Previous greeting from ${name}` }).click()
        await expect(greeting).toContainText("Mira opens the door.")
      })
      // Loading the second card must keep the latest greeting choice.
      await expect(greeting).toContainText("Mira opens the door.")
      await expect(page.getByLabel("Reply from", { exact: true })).toBeVisible()
      await next.click()
      // Ordinary greetings remain selectable alongside the group greetings.
      await expect(greeting).toContainText("Mira waves.")
      await next.click()
      await expect(greeting).toContainText("Mira welcomes the crew.")
      await expect(greeting).toContainText("group greeting")
      const secondGreeting = page.getByRole("article", { name: `Greeting from ${second}`, exact: true })
      await secondGreeting.getByRole("button", { name: `Next greeting from ${second}` }).click()
      await expect(secondGreeting).toContainText("Tobin greets everyone.")
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `group-${width}-${theme}.png`) })
      // Playing an added card excludes it from the character count and automatic replies.
      await page.getByLabel("Reply from", { exact: true }).click()
      await page.getByRole("option", { name: second, exact: true }).click()
      await page.getByLabel(/^Playing as /).click()
      await page.getByRole("tab", { name: "All cards", exact: true }).click()
      await page.getByRole("combobox", { name: "Find a card to play as" }).fill(second)
      await page.getByRole("option", { name: second, exact: true }).click()
      await expect(greeting).toContainText("Mira opens the door.")
      await expect(page.getByRole("status")).toContainText("selected group greeting is no longer available")
      await expect(page.getByText("group greeting", { exact: true })).toHaveCount(0)
      await expect(page.getByLabel("Reply from", { exact: true })).toContainText(name)
      await page.getByLabel(/^Playing as /).click()
      await page.getByRole("button", { name: "No persona", exact: true }).click()
      await next.click()
      await next.click()
      await expect(greeting).toContainText("Mira welcomes the crew.")
      await page.getByRole("button", { name: `Remove ${second} from pending cast` }).click()
      await expect(greeting).toContainText("Mira opens the door.")
      await expect(page.getByRole("status")).toContainText("selected group greeting is no longer available")
      await expect(page.getByText("group greeting", { exact: true })).toHaveCount(0)
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `fallback-${width}-${theme}.png`) })
      await next.click()
      await expect(next).toBeDisabled()
      await add()
      await next.click()
      await expect(greeting).toContainText("Mira welcomes the crew.")
      await page.getByLabel("Reply from", { exact: true }).click()
      await page.getByRole("option", { name: second, exact: true }).click()
      await page.getByLabel("Message", { exact: true }).fill("Hello crew.")
      await page.getByRole("button", { name: "Send", exact: true }).click()
      await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
      await expect(
        page.getByRole("article", { name: "Reply", exact: true }).filter({ hasText: "Mira welcomes the crew." })
      ).toBeVisible()
      await expect(page.getByRole("article", { name: "Reply", exact: true }).last().locator("header")).toContainText(
        second
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    })
}

test("a pending group can restore a removed original member", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const names = ["Group Mira", "Group Tobin"]
  for (const name of names) {
    const response = await page.request.post(`${server().url}/library/import?name=fixture.json`, {
      data: Buffer.from(
        JSON.stringify({
          spec: "chara_card_v3",
          spec_version: "3.0",
          data: { name, first_mes: `${name} waves.`, group_only_greetings: [`${name} welcomes everyone.`] }
        })
      ),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.status()).toBe(200)
  }
  const started = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListCards()
      return yield* api.StartChat({
        cards: names.map((name) => cards.find((card) => card.name === name)!.entityId),
        persona: null,
        greeting: 0,
        first: { _tag: "Send", content: "Hello group.", speakerEntityId: null }
      })
    })
  )
  await page.goto(`${server().url}/groups/${started.chat.id}/new`)
  const greeting = page.getByRole("article", { name: "Greeting from Group Mira", exact: true })
  const next = greeting.getByRole("button", { name: "Next greeting from Group Mira" })
  if (await next.isEnabled()) await next.click()
  await expect(greeting).toContainText("group greeting")
  await page.getByRole("button", { name: "Remove Group Tobin from pending cast" }).click()
  await expect(greeting).toContainText("Group Mira waves.")
  await expect(page.getByRole("status")).toContainText("selected group greeting is no longer available")
  await page.getByLabel("Add character", { exact: true }).click()
  await page.getByRole("option", { name: "Group Tobin", exact: true }).click()
  await expect(page.getByRole("article", { name: "Greeting from Group Tobin", exact: true })).toBeVisible()
  await next.click()
  await expect(greeting).toContainText("Group Mira welcomes everyone.")
})
