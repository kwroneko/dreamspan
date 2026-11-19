// A model's context size is never a silent guess (owner report 2026-10-31): the model list says
// where each window comes from and marks an assumed one; a budget refusal sits in the composer's
// column, names its numbers' sources and opens the model's settings at the field. Synthetic data.
import { CHAT_WIDTH } from "@dreamspan/shared/chatApi.ts"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { card, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openModelSettings } from "./support/strip.ts"

const server = serverPerFile(withAdmin)

const shoot = async (page: import("@playwright/test").Page, name: string) => {
  if (!process.env.SCREENSHOT_DIR) return
  mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`) })
}

/** Synthetic roleplay turns, so the screenshots look like a real chat. */
const PROSE = [
  '*The lantern sputters as Mira sets it on the map table.* "The pass closes at dusk. If we leave now we make the ridge before the snow does."',
  '"Then we leave now." *Sam shoulders the pack and checks the rope twice, the way the old guide taught him.* "How far to the hut?"',
  '*She traces the route with a gloved finger, past the frozen falls and the cairns.* "Four hours, if the bridge still holds. Six if it doesn\'t."',
  '*Sam glances at the window, where the first flakes are already drifting past.* "And if the hut is gone?"',
  '"Then we dig in and wait it out together." *She folds the map into her coat and blows out the lantern.* "Come on. The mules won\'t wait."',
  "*Outside, the wind has teeth. Sam pulls his scarf over his nose and follows the bobbing light of her headlamp up the switchbacks.*"
]
const turns = (count: number, character = "Mira") =>
  Array.from({ length: count }, (_, i) =>
    message({ name: i % 2 ? "Sam" : character, user: i % 2 === 1, minute: i, mes: PROSE[i % PROSE.length]! })
  )
const MIRA =
  "Mira is a mountain guide in her thirties, patient, dry-humoured and careful with her words. She grew up in the high valleys and knows every pass by its old name. "

const themes = async (page: import("@playwright/test").Page, each: (width: number, theme: string) => Promise<void>) => {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme: theme })
      await page.evaluate((value) => localStorage.setItem("dreamspan.theme", value), theme)
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
  // The provider's limits, read-only (ftabs): the assumed window, and why it's assumed.
  await expect(dialog).toContainText("128,000 tokens")
  await expect(dialog).toContainText("Assumed: nothing reports this model's window")
  await shoot(page, "model-assumed-1440-light")
})

test("a budget refusal sits in the composer's column, names its sources and opens the window field", async ({
  page
}) => {
  test.setTimeout(300_000)
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
  await upload(
    "characters/Mira.png",
    card("Mira", '*Mira looks up from the map.* "You\'re late."', {}, { description: MIRA.repeat(110) })
  )
  await upload("chats/Mira/Tiny.jsonl", jsonl([header({}), ...turns(8)]))
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ListChats({ limit: 10, before: null }).pipe(Effect.map((chats) => chats.find((c) => c.title === "Tiny")!))
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const refusal = page.getByRole("status").filter({ hasText: "The next reply doesn't fit the context size" })
  await expect(refusal).toContainText("context size of 3,000 tokens (your setting for the model's window)")
  await expect(refusal).toContainText("the reply reserves 1,500 (default)")
  // It is the one explanation: the history note doesn't repeat it above.
  await expect(page.getByRole("status").filter({ hasText: "aren’t sent to the model" })).toHaveCount(0)
  const composer = page.locator("div.chat-column", { has: page.getByTestId("composer") }).last()
  await themes(page, async (width, theme) => {
    // After a reload the refusal waits for the next-context estimate, slow on a loaded host.
    await expect(refusal).toBeVisible({ timeout: 30_000 })
    const box = (await refusal.boundingBox())!
    const column = (await composer.boundingBox())!
    // The same column as the composer, never wider than it.
    expect(Math.abs(box.x - column.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(box.width - column.width)).toBeLessThanOrEqual(1)
    if (width === 1440) expect(box.width).toBeLessThanOrEqual(CHAT_WIDTH.default)
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

  // The model chip's "Model settings…" opens the model the chat's reply uses, named, in the Model tab.
  await openModelSettings(page)
  await expect(page.getByTestId("model-panel-name")).toHaveText("tiny-window on Tiny")
  await expect(page.getByText("Your current model for chats without a lock.")).toBeVisible()

  // A learned size, forgotten, stays forgotten when an edited draft is saved after it.
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.SaveLearnedContext({ modelId: model.id, context: 24_000 })
  )
  await page.reload()
  await openModelSettings(page)
  await page.getByRole("textbox", { name: "Display name" }).fill("Tiny window")
  await page.getByRole("button", { name: "Forget it" }).click()
  await expect(page.getByText("Learned context size")).toHaveCount(0)
  await page.getByRole("button", { name: "Save model settings" }).click()
  await expect(page.getByTestId("model-panel-name")).toContainText("Tiny window")
  const forgotten = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ListModels({ connectionId: model.connectionId, includeHidden: true })
  )
  const after = forgotten.find((m) => m.id === model.id)!
  expect(after.overrides.name).toBe("Tiny window")
  expect(after.overrides.learned).toBeUndefined()
})

test("the history note sits in the message column of a real-looking chat, naming its sources", async ({ page }) => {
  test.setTimeout(300_000)
  const { importId } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
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
      const model = yield* api.AddUserModel({
        connectionId: connection.id,
        key: "small-window",
        overrides: { context: 4000 }
      })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
      return { importId: yield* api.StartStImport({ unsupported: [] }).pipe(Effect.map((r) => r.importId)) }
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
  await upload(
    "characters/Ines.png",
    card("Ines", '*Ines looks up from the map.* "You\'re late."', {}, { description: MIRA.repeat(8) })
  )
  await upload("chats/Ines/Ridge.jsonl", jsonl([header({}), ...turns(60, "Ines")]))
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ListChats({ limit: 10, before: null }).pipe(Effect.map((chats) => chats.find((c) => c.title === "Ridge")!))
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${chat.id}`)
  const note = page.getByRole("status").filter({ hasText: "aren’t sent to the model" })
  const article = page.locator("article").first()
  await themes(page, async (width, theme) => {
    // The list is virtualized: scroll up from the newest messages until the boundary renders.
    await page.mouse.move(width / 2, 400)
    for (let i = 0; i < 60 && (await note.count()) === 0; i++) await page.mouse.wheel(0, -300)
    await note.scrollIntoViewIfNeeded()
    await expect(note).toContainText("allows 4,000 tokens (your setting for the model's window)")
    await expect(note.getByRole("button", { name: "Change the context size" })).toBeVisible()
    const box = (await note.boundingBox())!
    const column = (await article.boundingBox())!
    // Within the message column, never wider.
    expect(box.x).toBeGreaterThanOrEqual(column.x - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(column.x + column.width + 1)
    await shoot(page, `history-note-${width}-${theme}`)
  })
})
