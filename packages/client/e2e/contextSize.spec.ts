// A model's context size is never a silent guess (owner report 2026-10-31): the model list says
// where each window comes from and marks an assumed one; a budget refusal sits in the composer's
// column, names its numbers' sources and opens the model's settings at the field. Synthetic data.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { card, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

const shoot = async (page: import("@playwright/test").Page, name: string) => {
  if (!process.env.SCREENSHOT_DIR) return
  mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`) })
}

const themes = async (page: import("@playwright/test").Page, each: (width: number, theme: string) => Promise<void>) => {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme: theme })
      await page.evaluate((value) => localStorage.setItem("rp.theme", value), theme)
      await page.reload()
      await each(width, theme)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    }
  await page.setViewportSize({ width: 1440, height: 960 })
}

test("the model list says where each window comes from, and marks an assumed one", async ({ page }) => {
  const { connection } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Proxy",
          baseUrl: "http://127.0.0.1:5999/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      yield* api.AddUserModel({ connectionId: connection.id, key: "my-local-finetune", overrides: {} })
      yield* api.AddUserModel({ connectionId: connection.id, key: "claude-sonnet-4-20250514", overrides: {} })
      return { connection }
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/${connection.id}`)
  const models = page.getByRole("list", { name: "Models" })
  const local = models.getByRole("listitem").filter({ hasText: "my-local-finetune" })
  const sonnet = models.getByRole("listitem").filter({ hasText: "claude-sonnet-4-20250514" })
  await expect(local).toContainText("128k (assumed)")
  await expect(sonnet).toContainText("200k")
  await expect(sonnet.getByTitle(/^From pi-ai's catalog/).first()).toBeVisible()
  // Its settings say what an empty window field means, and why.
  await local.getByRole("button", { name: "Edit my-local-finetune" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("assumed 128,000")
  await expect(dialog).toContainText("nothing reports this model’s window")
  await shoot(page, "model-assumed-1440-light")
})

test("a budget refusal sits in the composer's column, names its sources and opens the window field", async ({
  page
}) => {
  test.setTimeout(120_000)
  const { importId, model } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Tiny",
          baseUrl: "http://127.0.0.1:5999/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "tiny-window",
        overrides: { context: 3000 }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      return { importId: yield* api.StartStImport({ unsupported: [] }).pipe(Effect.map((r) => r.importId)), model }
    })
  )
  const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  const upload = async (path: string, body: Uint8Array) => {
    const response = await fetch(`${server().url}/st-import/file?${new URLSearchParams({ import: importId, path })}`, {
      method: "POST",
      headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
      body: new Uint8Array(body)
    })
    expect(response.status).toBe(200)
  }
  await upload("characters/Mira.png", card("Mira", "Hello.", {}, { description: "x".repeat(20_000) }))
  await upload(
    "chats/Mira/Tiny.jsonl",
    jsonl([
      header({}),
      ...Array.from({ length: 6 }, (_, i) =>
        message({ name: i % 2 ? "Sam" : "Mira", user: i % 2 === 1, minute: i, mes: `Turn ${i}.` })
      )
    ])
  )
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ListChats({ limit: 10, before: null }).pipe(Effect.map((chats) => chats.find((c) => c.title === "Tiny")!))
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const refusal = page.getByRole("alert").filter({ hasText: "Can't prepare the next reply" })
  await expect(refusal).toContainText("context size of 3,000 tokens (your setting for the model's window)")
  await expect(refusal).toContainText("the reply reserves 1,500 (default)")
  const composer = page.locator("div.max-w-3xl", { has: page.getByTestId("composer") }).last()
  await themes(page, async (width, theme) => {
    await expect(refusal).toBeVisible()
    const box = (await refusal.boundingBox())!
    const column = (await composer.boundingBox())!
    // The same column as the composer, never wider than it.
    expect(Math.abs(box.x - column.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(box.width - column.width)).toBeLessThanOrEqual(1)
    if (width === 1440) expect(box.width).toBeLessThanOrEqual(768)
    await shoot(page, `refusal-${width}-${theme}`)
  })
  // The action opens the model's settings at the window field; a larger window clears the refusal.
  await refusal.getByRole("button", { name: "Change the context size" }).click()
  const dialog = page.getByRole("dialog", { name: "Edit tiny-window" })
  await expect(dialog).toBeVisible()
  const field = dialog.locator('[data-model-field="context"]')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue("3000")
  await field.fill("32000")
  await dialog.getByRole("button", { name: "Save model settings" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(refusal).toHaveCount(0)
  const edited = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ListModels({ connectionId: model.connectionId, includeHidden: true })
  )
  expect(edited.find((m) => m.id === model.id)?.overrides.context).toBe(32000)
})
