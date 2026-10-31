// Regex scripts (ST 1.19), with synthetic fixtures only: a preset's script rewrites a reply as
// it's saved and the original text can be shown and restored; global scripts are edited in
// settings; a card's scripts are listed and approved in its editor.
import { join } from "node:path"
import { expect, test, type Browser } from "@playwright/test"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import type { RefId } from "@rp/shared/library.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startProvider, type FakeProvider } from "./support/provider.ts"
import { messageMenu } from "./support/message.ts"

const server = serverPerFile(withAdmin)
const REPLY = "<cot>secret plan</cot>Hello there"
let provider: FakeProvider

test.beforeAll(async () => {
  provider = await startProvider({ reply: REPLY })
})
test.afterAll(async () => {
  await provider.stop()
})

const screenshot = async (page: import("@playwright/test").Page, name: string) => {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `${name}.png`) })
}

const open = async (browser: Browser, width: number, colorScheme: "light" | "dark") => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme })
  const page = await context.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  return { context, page }
}

const importJson = async (page: import("@playwright/test").Page, name: string, body: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${name}`, {
    headers: { origin: server().url, "content-type": "application/octet-stream" },
    data: JSON.stringify(body)
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { library: { ref: { id: RefId } } }).library.ref.id
}

for (const width of [1440, 390])
  for (const colorScheme of ["light", "dark"] as const) {
    test(`a preset script rewrites the reply, and the original can be shown and restored: ${width}, ${colorScheme}`, async ({
      browser
    }) => {
      test.setTimeout(120_000)
      const { context, page } = await open(browser, width, colorScheme)
      const refId = await importJson(page, `Strip-${width}-${colorScheme}.json`, {
        openai_max_context: 8192,
        extensions: {
          regex_scripts: [
            {
              id: "strip",
              scriptName: "Strip thinking",
              findRegex: "/<cot>[\\s\\S]*?<\\/cot>\\s*/g",
              replaceString: "",
              placement: [2]
            }
          ]
        }
      })
      const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const opened = yield* api.OpenEditor({ refId })
          yield* api.SetRegexApproval({ refId, approved: true, expectedRowVersion: opened.ref.rowVersion })
          const connection = yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: "Synthetic regex provider",
              baseUrl: provider.baseUrl,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            },
            apiKey: null
          })
          const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
          const card = yield* api.CreateCard({ label: "Regex fixture Mira", name: "Mira" })
          const chat = yield* api.CreateChat({ title: "Regex rewrite — synthetic fixture" })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Preset", ref: refId } })
          yield* api.ChangeCast({
            chatId: chat.id,
            slotId: null,
            change: { _tag: "Model", connection: connection.id, model: model.id }
          })
          const human = yield* api.SendMessage({ chatId: chat.id, parentSlotId: null, branch: false, content: "Hello" })
          if (human._tag !== "Posted") throw new Error("queued")
          yield* api.Generate({ chatId: chat.id, parentSlotId: human.entry.slotId, branch: false })
          return chat
        })
      )
      await page.goto(`${server().url}/chats/${chat.id}`)
      const reply = page.locator("article[data-slot]").last()
      await expect(reply.locator(".markdown")).toHaveText("Hello there", { timeout: 20_000 })
      await expect(reply.getByText("scripts changed this")).toBeVisible()
      await expect(
        reply.getByRole("note").filter({ hasText: "Changed by regex: Strip thinking (preset)." })
      ).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await screenshot(page, `regex-rewritten-${width}-${colorScheme}`)

      await messageMenu(reply, "Show the original text")
      const dialog = page.getByRole("dialog", { name: "The original text" })
      await expect(dialog.getByRole("region", { name: "Original message text" }).locator("pre")).toHaveText(REPLY)
      await screenshot(page, `regex-original-${width}-${colorScheme}`)
      await dialog.getByRole("button", { name: "Restore it", exact: true }).click()
      await expect(dialog).toBeHidden()
      // The restored version is shown, and no script rewrites it.
      await expect(reply.locator(".markdown")).toContainText("secret plan")
      await expect(reply.getByText("scripts changed this")).toHaveCount(0)
      const slotId = (await reply.getAttribute("data-slot")) as SlotId
      const stored = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        api.ReadPath({ chatId: chat.id, leafSlotId: slotId, range: { _tag: "Bottom" }, limit: 1 })
      )
      expect(stored.entries.at(-1)!.version.content).toBe(REPLY)
      expect(stored.entries.at(-1)!.versionCount).toBe(2)
      await context.close()
    })

    test(`global scripts are added, saved and kept: ${width}, ${colorScheme}`, async ({ browser }) => {
      test.setTimeout(60_000)
      const { context, page } = await open(browser, width, colorScheme)
      const name = `Mask ${width} ${colorScheme}`
      await page.goto(`${server().url}/settings/regex`)
      await expect(page.getByRole("heading", { name: "Global regex scripts" })).toBeVisible()
      await page.getByRole("button", { name: "Add a script", exact: true }).click()
      const list = page.getByRole("list", { name: "Global regex scripts" })
      const item = list.getByRole("listitem").last()
      await item.getByRole("textbox", { name: "Name", exact: true }).fill(name)
      // Words no other test shows: the account's global scripts stay for this file's later tests.
      await item.getByRole("textbox", { name: "Find (a regular expression)" }).fill("/masked word/g")
      await item.getByRole("textbox", { name: "Replace with" }).fill("[hidden]")
      await item.getByRole("textbox", { name: /^Remove from each match/ }).fill("x\ny")
      // A new script starts off; its row's switch turns it on.
      const on = item.getByRole("switch", { name: `Run ${name}`, exact: true })
      await expect(on).not.toBeChecked()
      await on.click()
      await expect(on).toBeChecked()
      await expect(item.getByText(/^Rewrites the message itself as it's saved/)).toBeVisible()
      await item.getByRole("checkbox", { name: "What's shown", exact: true }).click()
      await expect(
        item.getByText("Changes only what's shown; the saved message and the prompt keep its text.")
      ).toBeVisible()
      await expect(item.getByRole("checkbox", { name: "Run on edits" })).toBeChecked()
      // Try it: the script alone on a sample, in the display worker.
      await item.getByText("Try it", { exact: true }).click()
      await item.getByRole("textbox", { name: "Sample text" }).fill("a masked word here")
      await expect(item.getByRole("region", { name: "Result" })).toContainText("a [hidden] here")
      await item.getByRole("region", { name: "Result" }).scrollIntoViewIfNeeded()
      await screenshot(page, `regex-global-${width}-${colorScheme}`)
      await page.getByRole("button", { name: "Save the scripts", exact: true }).click()
      await expect(page.getByText("Saved. Your chats use these scripts from now on.")).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.reload()
      await expect(list.getByRole("button", { name: `Edit ${name}`, exact: true })).toBeVisible()
      await expect(list.getByRole("switch", { name: `Run ${name}`, exact: true })).toBeChecked()
      await screenshot(page, `regex-global-list-${width}-${colorScheme}`)
      const saved = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.GetGlobalRegex())
      expect(saved.scripts.find((script) => script.name === name)).toMatchObject({
        find_regex: "/masked word/g",
        replace_string: "[hidden]",
        trim_strings: ["x", "y"],
        disabled: false,
        markdown_only: true,
        run_on_edit: true
      })
      await context.close()
    })

    test(`a card's scripts are listed and need approval: ${width}, ${colorScheme}`, async ({ browser }) => {
      test.setTimeout(60_000)
      const { context, page } = await open(browser, width, colorScheme)
      const refId = await importJson(page, `regex-card-${width}-${colorScheme}.json`, {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: `Regex keeper ${width} ${colorScheme}`,
          description: "Synthetic keeper",
          personality: "",
          scenario: "",
          first_mes: "Hello",
          mes_example: "",
          extensions: {
            regex_scripts: [
              {
                id: "mask",
                scriptName: "Mask the keeper",
                findRegex: "/keeper/gi",
                replaceString: "someone",
                placement: [2],
                markdownOnly: true
              }
            ]
          }
        }
      })
      await page.goto(`${server().url}/library/${refId}`)
      const scripts = page.getByRole("list", { name: "Regex scripts" })
      await expect(scripts.getByRole("button", { name: "Edit Mask the keeper", exact: true })).toBeVisible()
      await expect(page.getByText("These scripts don't run until you allow them")).toBeVisible()
      await expect(page.getByText(/A card from a file never allows its own scripts/)).toBeVisible()
      await scripts.getByRole("button", { name: "Edit Mask the keeper" }).click()
      await expect(scripts.getByRole("textbox", { name: "Find (a regular expression)" })).toHaveValue("/keeper/gi")
      await expect(scripts.getByRole("checkbox", { name: "What's shown", exact: true })).toBeChecked()
      await screenshot(page, `regex-card-${width}-${colorScheme}`)
      await page.getByRole("button", { name: "Allow them", exact: true }).click()
      const confirm = page.getByRole("alertdialog")
      await expect(confirm.getByText("Mask the keeper")).toBeVisible()
      await confirm.getByRole("button", { name: "Allow them", exact: true }).click()
      await expect(page.getByText("These scripts are allowed to run")).toBeVisible()
      const opened = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.OpenEditor({ refId }))
      expect(opened.doc.regex_approved).toBe(true)
      await page.getByRole("button", { name: "Stop them", exact: true }).click()
      await expect(page.getByText("These scripts don't run until you allow them")).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await context.close()
    })
  }
