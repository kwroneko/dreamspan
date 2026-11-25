// The model picker's refresh button reads model lists again: every connection with "All
// connections", only the filtered one otherwise; the connections page's Refresh all models reads
// every connection. Two synthetic upstreams whose lists grow. SHOTS_DIR saves screenshots.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { join } from "node:path"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { withCookie } from "./support/rpc.ts"
import { serverPerFile } from "./support/server.ts"
import { filterModels, modelChip } from "./support/strip.ts"

const server = serverPerFile()
const alpha = [{ id: "alpha-one", name: "Alpha One", context_length: 8192 }]
const beta = [{ id: "beta-one", name: "Beta One", context_length: 8192 }]
let providers: Array<FakeProvider> = []
let chatId = ""
test.beforeAll(async () => {
  providers = [await startProvider({ models: alpha }), await startProvider({ models: beta })]
  chatId = await withCookie(server(), "", (api) =>
    Effect.gen(function* () {
      for (const [i, provider] of providers.entries()) {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: ["Alpha gate", "Beta router"][i]!,
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: 300,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          apiKey: null
        })
        yield* api.RefreshModels({ connectionId: connection.id })
      }
      const chat = yield* api.CreateChat({ title: "Refresh synthetic" })
      return chat.id
    })
  )
})
test.afterAll(async () => {
  await Promise.all(providers.map((provider) => provider.stop()))
})

const list = (page: Page) => page.getByRole("radiogroup", { name: "Model", exact: true })
const refresh = (page: Page) => page.getByRole("button", { name: "Refresh model lists", exact: true })
const shots: ReadonlyArray<readonly [number, "dark" | "light"]> = [
  [1920, "dark"],
  [1250, "dark"],
  [390, "light"]
]

test("refresh reads every connection, or only the filtered one", async ({ page }) => {
  await page.goto(`${server().url}/chats/${chatId}`)
  await modelChip(page).click()
  await expect(list(page).getByRole("radio")).toHaveCount(2)
  const before = providers.map((provider) => provider.listings)

  alpha.push({ id: "alpha-two", name: "Alpha Two", context_length: 8192 })
  beta.push({ id: "beta-two", name: "Beta Two", context_length: 8192 })
  await refresh(page).hover()
  await expect(page.getByText("Fetch the latest model lists from all connections").last()).toBeVisible()
  await refresh(page).click()
  await expect(list(page).getByRole("radio")).toHaveCount(4)
  expect(providers.map((provider) => provider.listings)).toEqual(before.map((n) => n + 1))

  alpha.push({ id: "alpha-three", name: "Alpha Three", context_length: 8192 })
  beta.push({ id: "beta-three", name: "Beta Three", context_length: 8192 })
  await filterModels(page, "Beta router")
  await refresh(page).hover()
  await expect(page.getByText("Fetch the latest model list from Beta router").last()).toBeVisible()
  const mid = providers.map((provider) => provider.listings)
  await refresh(page).click()
  await expect(list(page).getByRole("radio", { name: /beta-three/ })).toBeVisible()
  expect(providers.map((provider) => provider.listings)).toEqual([mid[0], mid[1]! + 1])
  // Alpha was not asked: its newest model isn't there, its earlier one is.
  await filterModels(page, "All connections")
  await expect(list(page).getByRole("radio", { name: /alpha-three/ })).toHaveCount(0)
  await expect(list(page).getByRole("radio", { name: /alpha-two/ })).toHaveCount(1)
})

if (process.env.SHOTS_DIR)
  for (const [width, theme] of shots)
    test(`picker shot ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`${server().url}/chats/${chatId}`)
      await modelChip(page).click()
      await expect(list(page)).toBeVisible()
      const manage = await page.getByRole("link", { name: "Manage connections…" }).boundingBox()
      const button = await refresh(page).boundingBox()
      expect(button!.x + button!.width).toBeLessThanOrEqual(width - 4)
      expect(button!.x).toBeGreaterThanOrEqual(manage!.x + manage!.width - 1)
      expect(Math.abs(button!.y + button!.height / 2 - (manage!.y + manage!.height / 2))).toBeLessThan(3)
      await page.screenshot({ path: join(process.env.SHOTS_DIR!, `refresh-${width}-${theme}.png`) })
    })

test("Refresh all models on the connections page reads every connection and names a failure", async ({ page }) => {
  await withCookie(server(), "", (api) =>
    api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Dead end",
        baseUrl: "http://127.0.0.1:1/v1",
        compat: {},
        cacheTtlS: 300,
        maxConcurrent: null,
        presetOverrideRefId: null
      },
      apiKey: null
    })
  )
  const before = providers.map((provider) => provider.listings)
  await page.goto(`${server().url}/settings/connections`)
  const button = page.getByRole("button", { name: "Refresh all models", exact: true })
  await button.hover()
  await expect(page.getByText("Fetch the latest model lists from all connections").last()).toBeVisible()
  await button.click()
  await expect(page.getByText(/Couldn't refresh Dead end: /)).toBeVisible()
  await expect(button).toBeEnabled()
  expect(providers.map((provider) => provider.listings)).toEqual(before.map((n) => n + 1))
  if (process.env.SHOTS_DIR)
    for (const [width, theme] of shots) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      const box = await button.boundingBox()
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      await page.screenshot({ path: join(process.env.SHOTS_DIR, `connections-${width}-${theme}.png`) })
    }
})
