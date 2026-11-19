// The captured request is a place, including which turns and text view are open.
import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, ForkId, VersionId } from "@dreamspan/shared/chat.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"

const server = serverPerFile(withAdmin)
let connectionId = ""
let provider: FakeProvider
let chat: ChatId, fork: ForkId, version: VersionId

test.beforeAll(async () => {
  provider = await startProvider()
  const login = await fetch(`${server().url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ADMIN)
  })
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!
  for (const [name, data] of [
    [
      "Inspector card.json",
      JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: { name: "Url Inspector", description: "A synthetic harbor keeper.", scenario: "A rainy harbor." }
      })
    ],
    [
      "Inspector preset.json",
      readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
    ]
  ]) {
    const response = await fetch(`${server().url}/library/import?name=${encodeURIComponent(name!)}`, {
      method: "POST",
      headers: { cookie, origin: server().url, "content-type": "application/octet-stream" },
      body: data!
    })
    expect(response.status).toBe(200)
  }

  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "URL test provider",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "synthetic-url-test"
      })
      connectionId = connection.id
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: {
          model: { connection: connection.id, model: model.id },
          preset: (yield* api.ListLibrary({ kind: "preset" }))[0]!.id
        }
      })
      const card = (yield* api.ListCards()).find((c) => c.name === "Url Inspector")!
      const started = yield* api.StartChat({
        cards: [card.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "A synthetic request to inspect.", speakerEntityId: null }
      })
      chat = started.chat.id
      const generated = yield* api.Generate({ chatId: chat, parentSlotId: started.entry.slotId, branch: false })
      if (generated._tag !== "Posted") throw new Error("queued reply")
      version = generated.entry.version.id
      fork = (yield* api.GetChat({ chatId: chat })).currentForkId!
    })
  )
})
test.afterAll(async () => {
  await provider?.stop()
})

test("inspector: expanded turns and raw text reload, with the viewed branch intact", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await expect
    .poll(async () =>
      asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.GetRunContext({ versionId: version }).pipe(
          Effect.map((run) => run.capture !== "unavailable"),
          Effect.orElseSucceed(() => false)
        )
      )
    )
    .toBe(true)
  await page.goto(`${server().url}/chats/${chat}/context/${version}?fork=${fork}`)
  await page.getByRole("button", { name: "Collapse every turn", exact: true }).click()
  const url = page.url()
  await page.reload()
  await expect(page.getByRole("button", { name: "Expand every turn", exact: true })).toBeVisible()
  expect(page.url()).toBe(url)
  await page.getByRole("button", { name: "Expand every turn", exact: true }).click()
  const raw = page.getByRole("button", { name: "Show as one text", exact: true }).first()
  await raw.click()
  await page.reload()
  await expect(page.getByRole("button", { name: "Show by source", exact: true }).first()).toBeVisible()
  await page.getByRole("link", { name: /Back to the reply/ }).click()
  await expect(page).toHaveURL(new RegExp(`fork=${fork}`))
  await page.goBack()
  await expect(page.getByRole("button", { name: "Show by source", exact: true }).first()).toBeVisible()
})

test("settings dialogs: model and connection headers reopen after reload and Back", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/${connectionId}`)
  await page.getByRole("button", { name: "Edit fake-small", exact: true }).click()
  await expect(page).toHaveURL(/model=/)
  await page.reload()
  await expect(page.getByRole("dialog", { name: "Edit fake-small", exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("dialog", { name: "Edit fake-small", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Add headers", exact: true }).click()
  await expect(page).toHaveURL(/connectionDialog=headers/)
  await page.reload()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("dialog")).toHaveCount(0)
})
