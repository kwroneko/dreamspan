// Synthetic fixtures only: stable prompt bindings and retained length-cutoff replies.
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { showActions } from "./support/message.ts"
import { openPanel, closePanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const partial = "Mira reaches for the ledger, but the sentence stops here"
const more = ". Then she opens it."
let provider: ReturnType<typeof createServer>
let baseUrl: string

test.beforeAll(async () => {
  provider = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      const data = JSON.parse(body) as { messages: Array<{ role: string }> }
      const continuing = data.messages.at(-1)?.role === "assistant"
      res.writeHead(200, { "content-type": "text/event-stream" })
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content: continuing ? more : partial }, null],
        [{}, continuing ? "stop" : "length"]
      ]) {
        res.write(
          `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        )
      }
      res.end("data: [DONE]\n\n")
    })
  })
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done))
  baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`
})
test.afterAll(async () => {
  provider.closeAllConnections()
  await new Promise<void>((done) => provider.close(() => done()))
})

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const) {
    test(`stable bindings and length cutoff at ${width} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      for (const name of ["Mira", "Tobin"]) {
        const response = await page.request.post(`${server().url}/library/import?name=${name}.json`, {
          data: Buffer.from(
            JSON.stringify({
              spec: "chara_card_v2",
              spec_version: "2.0",
              data: { name, description: `${name} lives by the harbor.` }
            })
          ),
          headers: { origin: server().url, "content-type": "application/octet-stream" }
        })
        expect(response.status()).toBe(200)
      }
      const { chat, mira, tobin } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const cards = yield* api.ListCards()
          const mira = cards.find((c) => c.name === "Mira")!.entityId
          const tobin = cards.find((c) => c.name === "Tobin")!.entityId
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Synthetic",
              baseUrl,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            }
          })
          const model = yield* api.AddUserModel({
            connectionId: connection.id,
            key: "synthetic",
            overrides: { prefill: "assistant" }
          })
          yield* api.SetGenerationDefaults({
            defaults: { model: { connection: connection.id, model: model.id }, preset: null }
          })
          const chat = yield* api.CreateChat({ title: "Stable prompt names" })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: mira } })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: tobin } })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [tobin] } })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "Open the ledger.",
            speakerEntityId: tobin
          })
          if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
          yield* api.Generate({
            chatId: chat.id,
            parentSlotId: sent.entry.slotId,
            branch: false,
            speakerEntityId: mira
          })
          return { chat, mira, tobin }
        })
      )
      await page.goto(`${server().url}/chats/${chat.id}`)
      const reply = page.getByRole("article").last()
      await expect(reply.getByText(/Failed \(length_cutoff\)/)).toBeVisible()
      await expect(reply).toContainText(partial)
      await showActions(reply)
      await expect(reply.getByRole("button", { name: /^Continue:/ })).toBeVisible()
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `cutoff-${width}-${colorScheme}.png`) })
      await reply.getByRole("button", { name: /^Continue:/ }).click()
      await expect(reply).toContainText(partial + more)
      await expect(reply.getByText(/Failed \(length_cutoff\)/)).toHaveCount(0)

      const panel = await openPanel(page, "This chat")
      await panel.getByText("Advanced: names in prompts", { exact: true }).click()
      const names = panel.getByRole("region", { name: "Names in prompts" })
      await expect(names.getByLabel("Your name in prompts {{user}}", { exact: true })).toHaveValue("Tobin")
      await expect(names.getByLabel("The character's name in prompts {{char}}", { exact: true })).toHaveValue("Mira")
      await names.getByLabel("Your name in prompts {{user}}", { exact: true }).fill("Captain")
      // Another tab's save must not erase an override already being typed here.
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
          yield* api.ChangeCast({
            chatId: chat.id,
            slotId: path.entries.at(-1)!.slotId,
            change: { _tag: "MacroBinding", name: "user", value: "Remote captain" }
          })
        })
      )
      await expect(names.getByText("Kept as you set it: Remote captain.", { exact: true })).toBeVisible()
      await expect(names.getByLabel("Your name in prompts {{user}}", { exact: true })).toHaveValue("Captain")
      const user = (scope: typeof names) => scope.getByRole("form", { name: "Your name in prompts" })
      const char = (scope: typeof names) => scope.getByRole("form", { name: "The character's name in prompts" })
      await user(names).getByRole("button", { name: "Keep this name instead", exact: true }).click()
      await expect(names.getByText("Kept as you set it: Captain.", { exact: true })).toBeVisible()
      await char(names).getByRole("button", { name: "Keep this name", exact: true }).click()
      await expect(names.getByText("Kept as you set it: Mira.", { exact: true })).toBeVisible()
      await page.reload()
      const again = await openPanel(page, "This chat")
      await again.getByText("Advanced: names in prompts", { exact: true }).click()
      const reloaded = again.getByRole("region", { name: "Names in prompts" })
      await expect(reloaded.getByLabel("Your name in prompts {{user}}", { exact: true })).toHaveValue("Captain")
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `bindings-${width}-${colorScheme}.png`) })
      // A cast/persona change cannot move pinned names; unpin resumes the live set.
      await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
          yield* api.ChangeCast({
            chatId: chat.id,
            slotId: path.entries.at(-1)!.slotId,
            change: { _tag: "PlayedByMe", entityIds: [mira] }
          })
        })
      )
      await expect(reloaded.getByLabel("Your name in prompts {{user}}", { exact: true })).toHaveValue("Captain")
      await user(reloaded).getByRole("button", { name: "Follow the persona again", exact: true }).click()
      await expect(reloaded.getByLabel("Your name in prompts {{user}}", { exact: true })).toHaveValue("Mira")
      await char(reloaded).getByRole("button", { name: "Follow the cast again", exact: true }).click()
      await expect(reloaded.getByLabel("The character's name in prompts {{char}}", { exact: true })).toHaveValue(
        "Tobin"
      )
      expect(tobin).not.toBe(mira)
      await closePanel(page)
    })
  }
