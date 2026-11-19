import { test, expect } from "@playwright/test"
import { readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { withCookie, loginCookie } from "./rpc.ts"
import { expectLayout } from "./layoutAudit.ts"
import { pluginFolder } from "../../../server/src/plugins/repo.ts"
import { startMockProvider, sse, completionChunks } from "../../../server/test/support/mockProvider.ts"

export const pluginDisplayCopyTests = (options: { readonly layoutOnly?: boolean } = {}) => {
  const server = serverPerFile(withAdmin)
  let cookie: Promise<string> | undefined
  const admin = async <A>(use: Parameters<typeof withCookie<A>>[2]) =>
    withCookie(server(), await (cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)
  let mock: Awaited<ReturnType<typeof startMockProvider>>
  test.beforeAll(async () => {
    mock = await startMockProvider((_request, response) =>
      sse(
        response,
        completionChunks(["Synthetic reply."], { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 })
      )
    )
  })
  test.afterAll(async () => {
    await mock?.close()
  })
  const parts = [
    ["displayTransforms", "display.macros", "Display macros"],
    ["displayTransforms", "display.regex", "Display regex"],
    ["displayScriptLists", "display-regex.global", "Global display scripts"],
    ["displayScriptLists", "display-regex.preset", "Preset display scripts"],
    ["displayScriptLists", "display-regex.character", "Character display scripts"],
    ["timelineTransforms", "timeline.merges", "Merged chat rows"],
    ["timelineTransforms", "timeline.history-budget", "History budget divider"],
    ["timelineTransforms", "timeline.lcm", "Summary rows and divider"],
    ["timelineTransforms", "timeline.threads", "Parallel thread dividers"]
  ] as const
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`copied display rules ${width} ${theme}`, async ({ page }, info) => {
        test.setTimeout(600_000)
        await page.setViewportSize({ width, height: 1000 })
        await page.emulateMedia({ colorScheme: theme })
        await page.addInitScript((theme) => localStorage.setItem("dreamspan.theme", theme), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const fixture = await admin((api) =>
          Effect.gen(function* () {
            const connection = yield* api.CreateConnection({
              kind: "openai-chat",
              settings: {
                name: "Synthetic display",
                baseUrl: mock.url + "/v1",
                compat: {},
                cacheTtlS: null,
                maxConcurrent: null,
                presetOverrideRefId: null
              }
            })
            const model = yield* api.AddUserModel({ connectionId: connection.id, key: "display-model", overrides: {} })
            const chat = yield* api.CreateChat({ title: `Display copies ${width} ${theme}` })
            yield* api.ChangeCast({
              chatId: chat.id,
              slotId: null,
              change: { _tag: "Model", connection: connection.id, model: model.id }
            })
            yield* api.SetDisplayPrefs({ prefs: { displayRegex: true, outputMacros: false } })
            const sent = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: null,
              branch: false,
              content:
                "Original **nested _format_**\n\n```html\n<b>code</b>\n```\n\n<div><b>HTML card</b></div>\n\nPartial **stream"
            })
            if (sent._tag !== "Posted") throw new Error("Unexpected queue")
            return { chat, sent: sent.entry, user: yield* api.Whoami() }
          })
        )
        const chatUrl = `${server().url}/chats/${fixture.chat.id}`
        await page.goto(chatUrl)
        const body = page.locator(`article[data-slot="${fixture.sent.slotId}"] .markdown`).first()
        await expect(body).toContainText("Original")
        await expect(body.locator("strong")).toContainText("nested")
        const originalDom = await body.innerHTML()
        const request = async () => {
          const count = mock.requests().length
          await admin((api) =>
            api.Generate({ chatId: fixture.chat.id, parentSlotId: fixture.sent.slotId, branch: true })
          )
          await expect.poll(() => mock.requests().length).toBeGreaterThan(count)
          return mock.requests().at(-1)!.raw
        }
        const originalRequest = await request()
        for (const [registry, id, label] of options.layoutOnly ? [parts[0]] : parts) {
          const made = await admin((api) =>
            api.CopyBuiltin({
              registry,
              id,
              pluginId: `display-${parts.findIndex((p) => p[1] === id)}-${width}-${theme}`
            })
          )
          const folder = pluginFolder(server().dataDir, fixture.user.id, made.id)
          const originalEntry = await readFile(join(folder, "src/client.tsx"), "utf8")
          // Unchanged copies must render the existing corpus identically first.
          expect(await admin((api) => api.EnablePlugin({ ...made, consent: true }))).toMatchObject({ ok: true })
          await page.goto(chatUrl)
          await expect(body).toContainText("Original")
          await expect.poll(() => body.innerHTML()).toBe(originalDom)
          expect(await request()).toBe(originalRequest)
          await admin((api) => api.DisablePlugin(made))
          const marker = `Copied ${id}`
          const policy =
            registry === "displayTransforms"
              ? `transform: input => ({text: input.text + ${JSON.stringify("\n\n" + marker + '<img src="bad" onerror="globalThis.displayInjected=1"><script>globalThis.displayInjected=1</script>')}, issues: []})`
              : registry === "displayScriptLists"
                ? `scripts: () => [{id:"synthetic",name:"Synthetic display",find_regex:"/Original/g",replace_string:${JSON.stringify(marker)},trim_strings:[],placement:[1,2,6],disabled:false,markdown_only:true,prompt_only:false,run_on_edit:false,substitute_regex:"none",min_depth:null,max_depth:null}]`
                : `transform: input => [...input.rows,{key:"copied-notice",estimate:44,from:Infinity,to:-1,body:{kind:"text",text:${JSON.stringify(marker)}}}]`
          const edited = originalEntry.replace(/\.register\((\w+)\)/, `.register({...$1, ${policy}})`)
          expect(edited).not.toBe(originalEntry)
          const commit = await admin((api) =>
            api.CommitPlugin({ ...made, files: { "src/client.tsx": edited }, message: "Change a display rule" })
          )
          expect(await admin((api) => api.CheckPlugin({ ...made, commit }))).toMatchObject({ ok: true })
          // Exact-version consent names the part and browser-only execution.
          await page.goto(`${server().url}/settings/plugins/user~${made.id}`)
          await page.getByRole("button", { name: "Turn on", exact: true }).first().click()
          await expect(page.getByRole("dialog")).toContainText(`Replaces ${label}.`)
          await expect(page.getByRole("dialog")).toContainText("Runs only in your browser.")
          if (id === "display.macros") await expectLayout(page, info, "display-copy-consent")
          await page.getByRole("dialog").getByRole("button", { name: "Turn on", exact: true }).click()
          await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 90000 })
          await page.goto(chatUrl + "?panel=interface")
          await expect(page.locator(".markdown").filter({ hasText: marker }).first()).toBeVisible()
          await expect(page.getByRole("list", { name: "Replaced display rules" })).toContainText(label)
          await expect(page.getByRole("list", { name: "Replaced display rules" })).toContainText("Replaced by")
          await page.getByRole("list", { name: "Replaced display rules" }).scrollIntoViewIfNeeded()
          expect(
            await page.evaluate(() => (globalThis as unknown as { displayInjected?: number }).displayInjected)
          ).toBeUndefined()
          expect(await request()).toBe(originalRequest)
          if (id === "display.macros") {
            await expectLayout(page, info, "display-copy-rules")
            if (process.env.SCREENSHOT_DIR) {
              await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
              await page.screenshot({
                path: join(process.env.SCREENSHOT_DIR, `display-rules-${width}-${theme}.png`),
                fullPage: true,
                animations: "disabled"
              })
            }
          }
          await admin((api) => api.DisablePlugin(made))
          await page.goto(chatUrl)
          await expect(body).toContainText("Original")
          await expect.poll(() => body.innerHTML()).toBe(originalDom)
          expect(await request()).toBe(originalRequest)
        }
        if (width === 1440 && theme === "light") {
          const made = await admin((api) =>
            api.CopyBuiltin({ registry: "displayTransforms", id: "display.macros", pluginId: "display-loop" })
          )
          const source = await readFile(
            join(pluginFolder(server().dataDir, fixture.user.id, made.id), "src/client.tsx"),
            "utf8"
          )
          for (const failure of ["throw new Error('broken copy')", "for (;;) {}"]) {
            const commit = await admin((api) =>
              api.CommitPlugin({
                ...made,
                files: {
                  "src/client.tsx": source.replace(
                    /\.register\((\w+)\)/,
                    `.register({...$1,transform:()=>{${failure}}})`
                  )
                },
                message: "Exercise display recovery"
              })
            )
            expect(await admin((api) => api.CheckPlugin({ ...made, commit }))).toMatchObject({ ok: true })
            expect(await admin((api) => api.EnablePlugin({ ...made, commit, consent: true }))).toMatchObject({
              ok: true
            })
            await page.goto(chatUrl)
            await expect(page.getByRole("status", { name: "Plugins", exact: true })).toContainText(
              "failed and is off here"
            )
            await expect(body).toContainText("Original")
            await page.getByRole("textbox", { name: "Message", exact: true }).fill("The page remains responsive.")
            await admin((api) => api.DisablePlugin(made))
          }
        }
        // Search groups remain tab URL state.
        await page.goto(`${server().url}/settings/plugins`)
        for (const group of ["Display rules", "Display script lists", "Timeline rules"])
          await page.getByRole("region", { name: group, exact: true }).getByRole("searchbox").fill("display")
        await page.reload()
        for (const group of ["Display rules", "Display script lists", "Timeline rules"])
          await expect(page.getByRole("region", { name: group, exact: true }).getByRole("searchbox")).toHaveValue(
            "display"
          )
        await expectLayout(page, info, "display-copy-picker")
      })
}
