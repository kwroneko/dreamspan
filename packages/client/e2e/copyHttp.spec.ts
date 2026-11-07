import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { card, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { messageMenu } from "./support/message.ts"
import { openPanel } from "./support/panel.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const body = '  *Original* text, "quoted".\n\n`source` & <tags>\n'
const reasoning = "**Raw reasoning**\n\nKeep the _marks_.\n"
const snippet = "Snippet: *keep these marks*\n\n  and spacing.\n"
const recovered = 'Recovered *source* with "quotes".\n\n'.repeat(12)

for (const width of [1440, 390]) {
  test(`message, reasoning, snippet and recovered text copy without Clipboard API at ${width}`, async ({
    page,
    context
  }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 1000 })
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await page.addInitScript(() => {
      // Retain only a reader to verify the OS clipboard; every app write must use execCommand.
      const clipboard = navigator.clipboard
      Object.assign(window, { readCopiedText: () => clipboard.readText() })
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
    })
    const readCopied = () =>
      page.evaluate(() => (window as unknown as { readCopiedText: () => Promise<string> }).readCopiedText())

    const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
    const { importId } = await admin((api) => api.StartStImport({ unsupported: [] }))
    const title = `HTTP copy ${width}`
    const files = new Map([
      ["characters/CopyBot.png", card("CopyBot", "Hello.")],
      [
        `chats/CopyBot/${title}.jsonl`,
        jsonl([
          header({}),
          message({ name: "Sam", user: true, mes: "Hello", minute: 1 }),
          message({ name: "CopyBot", mes: body, reasoning, minute: 2 })
        ])
      ]
    ])
    for (const [path, bytes] of files) {
      const response = await fetch(
        `${server().url}/st-import/file?${new URLSearchParams({ import: importId, path })}`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/octet-stream" },
          body: new Uint8Array(bytes)
        }
      )
      expect(response.status).toBe(200)
      expect((await response.json()).outcome).not.toBe("failed")
    }
    await admin((api) => api.FinishStImport({ importId, notSent: [] }))
    const chat = await admin((api) =>
      Effect.map(api.ListChats({ limit: 100, before: null }), (chats) => chats.find((c) => c.title === title)!)
    )
    await admin((api) => api.CreateSnippet({ chatId: chat.id, title, content: snippet }))

    // A large composer replacement followed by sending keeps the prior text in the bin.
    await admin((api) =>
      Effect.gen(function* () {
        const draft = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
        const save = (content: string, rowVersion: number) =>
          api.SaveComposer({
            next: false,
            operationId: crypto.randomUUID(),
            chatId: chat.id,
            draftId: draft.id,
            rowVersion,
            session: draft.session,
            content
          })
        const long = yield* save(recovered, draft.rowVersion)
        const short = yield* save("x", long.draft!.rowVersion)
        const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
        yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: path.entries.at(-1)!.slotId,
          branch: false,
          content: "x",
          composer: { draftId: short.draft!.id, session: short.draft!.session }
        })
      })
    )
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat.id}`)
    expect(await page.evaluate(() => navigator.clipboard)).toBeUndefined()
    const reply = page.getByRole("article").filter({ hasText: "Original text" })
    await messageMenu(reply, "Copy text")
    await expect(page.getByText("Text copied", { exact: true })).toBeVisible()
    expect(await readCopied()).toBe(body)
    const toggle = reply.getByRole("button", { name: /^Reasoning/ })
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click()
    await reply.getByRole("button", { name: "Copy reasoning", exact: true }).click()
    await expect(page.getByText("Reasoning copied", { exact: true })).toBeVisible()
    expect(await readCopied()).toBe(reasoning)

    const panel = await openPanel(page, "Snippets")
    await panel.getByRole("button", { name: `Copy ${title}`, exact: true }).click()
    await expect(page.getByText("Snippet copied", { exact: true })).toBeVisible()
    expect(await readCopied()).toBe(snippet)

    await page.goto(`${server().url}/bin`)
    await page.getByRole("tab", { name: "Recovered text", exact: true }).click()
    const row = page.getByRole("listitem").filter({ hasText: `Composer in “${title}”` })
    await row.getByRole("button", { name: "Show all", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: /Recovered from/ })
    await expect(dialog.getByRole("textbox", { name: "Recovered text" })).toHaveValue(recovered)
    await dialog.getByRole("button", { name: "Copy", exact: true }).click()
    await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeVisible()
    expect(await readCopied()).toBe(recovered)
    await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeFocused()
    expect(await page.locator('textarea[aria-hidden="true"]').count()).toBe(0)
  })
}
