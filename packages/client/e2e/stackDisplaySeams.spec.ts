// A modified copy runs at the existing message display boundary while newer host controls,
// the unfinished-import title and streamed composer text keep their own literal content.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { pluginFolder } from "../../server/src/plugins/repo.ts"
import { card, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { messageMenu } from "./support/message.ts"
import { nextReply } from "./support/strip.ts"
import { startProvider } from "./support/provider.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"

const server = serverPerFile(withAdmin)
let cookie: string
let provider: Awaited<ReturnType<typeof startProvider>>
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
test.beforeEach(async () => {
  provider = await startProvider({ reply: "Synthetic draft.", holdAfterText: true })
  await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: null }
      })
    })
  )
})
test.afterEach(async () => {
  provider.release()
  await provider.stop()
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`copied display rules keep new controls and composer literal at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(240_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((theme) => localStorage.setItem("rp.theme", theme), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const made = await admin((api) =>
        api.CopyBuiltin({
          registry: "displayTransforms",
          id: "display.macros",
          pluginId: `stack-display-${width}-${theme}`
        })
      )
      const user = await admin((api) => api.Whoami())
      const source = await readFile(join(pluginFolder(server().dataDir, user.id, made.id), "src/client.tsx"), "utf8")
      const edited = source.replace(
        /\.register\((\w+)\)/,
        '.register({...$1, transform: input => ({ text: input.text + "\\n\\nDISPLAYONLY", issues: [] })})'
      )
      expect(edited).not.toBe(source)
      const commit = await admin((api) =>
        api.CommitPlugin({
          ...made,
          files: { "src/client.tsx": edited },
          message: "Exercise combined display boundaries"
        })
      )
      expect(await admin((api) => api.CheckPlugin({ ...made, commit }))).toMatchObject({ ok: true })
      expect(await admin((api) => api.EnablePlugin({ ...made, commit, consent: true }))).toMatchObject({ ok: true })
      try {
        const { importId } = await admin((api) => api.StartStImport({ unsupported: [] }))
        const upload = (path: string, bytes: Uint8Array, last: string) =>
          fetch(`${server().url}/st-import/file?${new URLSearchParams({ import: importId, path, part: "0", last })}`, {
            method: "POST",
            headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
            body: new Uint8Array(bytes).buffer
          })
        expect((await upload("characters/Alice.png", card("Alice", "Hello"), "1")).status).toBe(200)
        const bytes = jsonl([
          header({}),
          ...Array.from({ length: 4 }, (_, i) =>
            message({ name: i % 2 ? "Sam" : "Alice", user: i % 2 === 1, mes: `Synthetic import line ${i}.`, minute: i })
          )
        ])
        expect((await upload(`chats/Alice/Display ${width} ${theme}.jsonl`, bytes, "0")).status).toBe(200)
        const chats = await admin((api) => api.ListChats({ limit: 200, before: null }))
        const chat = chats.find((c) => c.title === `Display ${width} ${theme} (import unfinished)`)!
        expect(chat).toBeDefined()
        await admin((api) => api.CancelStImport({ importId }))
        // Add a second character for the existing Auto controls.
        await admin((api) =>
          Effect.gen(function* () {
            for (const name of ["Wren", "Ash"]) {
              const other = yield* api.CreateCard({ label: name, name })
              yield* api.ChangeCast({
                chatId: chat.id,
                slotId: null,
                change: { _tag: "Join", entityId: other.entityId }
              })
            }
          })
        )
        await page.goto(`${server().url}/chats/${chat.id}`)
        const articles = page.locator("article[data-slot]")
        await expect(articles.last()).toContainText("DISPLAYONLY")
        await expect(page.getByRole("heading", { name: `Display ${width} ${theme}`, exact: true })).toBeVisible()
        await expect(page.getByText("import unfinished", { exact: true }).first()).toBeVisible()
        await expect(page.getByTestId("composer")).toHaveValue("")
        await messageMenu(articles.last(), "Select messages")
        const selection = page.getByRole("region", { name: "Selected messages" })
        await expect(selection).toContainText("1 message selected")
        await expect(articles.last().getByRole("checkbox", { name: "Select this message", exact: true })).toBeChecked()
        await expect(selection).not.toContainText("DISPLAYONLY")
        await expectLayout(page, info, "copied rules with selection ticks")
        await selection.getByRole("button", { name: "Cancel", exact: true }).click()
        await expect(nextReply(page).getByRole("button", { name: "Auto…", exact: true })).toBeVisible()
        await nextReply(page).getByRole("button", { name: "Auto…", exact: true }).click()
        const auto = page.getByRole("dialog", { name: "Auto replies" })
        await expect(auto).not.toContainText("DISPLAYONLY")
        await expectLayout(page, info, "copied rules with auto dialog")
        await auto.getByRole("button", { name: "Start", exact: true }).click()
        const strip = page.getByRole("group", { name: "Auto replies", exact: true })
        await expect(strip.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
        await expect(strip).not.toContainText("DISPLAYONLY")
        await expectLayout(page, info, "copied rules with active auto strip")
        await strip.getByRole("button", { name: "Stop", exact: true }).click()
        const count = provider.completionBytes.length
        await page.getByRole("button", { name: "Write for me", exact: true }).click()
        await expect(page.getByTestId("composer")).toHaveValue("Synthetic draft.")
        expect(provider.completionBytes).toHaveLength(count + 1)
        expect(provider.completionBytes.at(-1)).not.toContain("DISPLAYONLY")
        await expectLayout(page, info, "copied rules with streaming draft")
        await page.getByRole("button", { name: "Stop writing", exact: true }).click()
        await expect(page.getByTestId("composer")).toHaveValue("Synthetic draft.")
        expect((await admin((api) => api.GetChat({ chatId: chat.id }))).title).toContain("import unfinished")
      } finally {
        await admin((api) => api.DisablePlugin(made))
      }
    })
