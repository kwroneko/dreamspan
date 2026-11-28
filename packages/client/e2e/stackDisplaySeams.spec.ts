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
import { openPanel } from "./support/panel.ts"
import { startProvider } from "./support/provider.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { expectTextBox } from "./support/textbox.ts"

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
      yield* api.SetDisplayPrefs({
        prefs: { chatDensity: process.env.STACK_DENSITY === "compact" ? "compact" : "comfortable" }
      })
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
      await page.addInitScript((theme) => localStorage.setItem("dreamspan.theme", theme), theme)
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
        await admin((api) =>
          Effect.gen(function* () {
            const path = yield* api.ReadPath({
              chatId: chat.id,
              leafSlotId: null,
              range: { _tag: "Bottom" },
              limit: 20
            })
            for (const change of [
              { _tag: "DecisionPoints", off: ["lore"] },
              { _tag: "SendPresence", mode: "required" }
            ] as const)
              yield* api.ChangeCast({ chatId: chat.id, slotId: path.entries.at(-1)!.slotId, change })
          })
        )
        await page.goto(`${server().url}/chats/${chat.id}`)
        const articles = page.locator("article[data-slot]")
        await expect(articles.last()).toContainText("DISPLAYONLY")
        await expect(page.getByRole("heading", { name: `Display ${width} ${theme}`, exact: true })).toBeVisible()
        await expect(page.getByText("import unfinished", { exact: true }).first()).toBeVisible()
        await expectTextBox(page.getByTestId("composer"), "")
        const marks = page.locator("[data-state-markers]")
        await expect(marks).toContainText("2 changes")
        await marks.getByRole("button", { name: /2 changes/ }).click()
        await expect(marks).toContainText("Decisions changed for this chat")
        await expect(marks).toContainText("Who is present in replies: off → required")
        await expect(marks).not.toContainText("DISPLAYONLY")
        await page.screenshot({ path: info.outputPath(`markers-${width}-${theme}.png`), animations: "disabled" })
        await messageMenu(articles.last(), "Select messages")
        const selection = page.getByRole("region", { name: "Selected messages" })
        await expect(selection).toContainText("1 message selected")
        await expect(articles.last().getByRole("checkbox", { name: "Select this message", exact: true })).toBeChecked()
        await expect(selection).not.toContainText("DISPLAYONLY")
        await expectLayout(page, info, "copied rules with selection ticks")
        await page.screenshot({ path: info.outputPath(`selection-${width}-${theme}.png`), animations: "disabled" })
        await selection.getByRole("button", { name: "Cancel", exact: true }).click()
        const cast = await openPanel(page, "Cast")
        await expect(cast.getByRole("button", { name: "Auto replies", exact: true })).toBeVisible()
        await cast.getByRole("button", { name: "Auto replies", exact: true }).click()
        const auto = page.getByRole("dialog", { name: "Auto replies" })
        await expect(auto).not.toContainText("DISPLAYONLY")
        await expectLayout(page, info, "copied rules with auto dialog")
        await auto.getByRole("button", { name: "Start", exact: true }).click()
        await expect(auto).toHaveCount(0)
        // Starting Auto closes the phone's sheet and exposes the composer.
        if (width === 390) await expect(page.getByRole("tablist", { name: "Chat panel" })).toBeHidden()
        const strip = page.getByRole("group", { name: "Auto replies", exact: true })
        await expect(strip.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
        await expect(strip).not.toContainText("DISPLAYONLY")
        await expectLayout(page, info, "copied rules with active auto strip")
        await page.screenshot({ path: info.outputPath(`auto-${width}-${theme}.png`), animations: "disabled" })
        await strip.getByRole("button", { name: "Stop", exact: true }).click()
        expect((await admin((api) => api.GetChat({ chatId: chat.id }))).title).toContain("import unfinished")
      } finally {
        await admin((api) => api.DisablePlugin(made))
      }
    })
