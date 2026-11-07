import { expect, type Locator, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openEntry } from "./support/lorebook.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const source = "{{char}} keeps watch.\n{{setvar::lamp::blue}} {{// hidden {{user}}}} {{unknown}}"
const changed = source.replace("keeps watch", "lights the lamp") + "\nA new line."
const markers = (editor: Locator) => editor.locator("..").locator(".rp-line-added, .rp-line-modified, .rp-line-deleted")

async function highlighting(editor: Locator) {
  await expect(editor.locator(".rp-macro-value")).toHaveText("{{char}}")
  await expect(editor.locator(".rp-macro-directive")).toHaveText("{{setvar::lamp::blue}}")
  await expect(editor.locator(".rp-macro-comment")).toHaveText("{{// hidden {{user}}}}")
  const colours = await editor.evaluate((el) => {
    const value = el.querySelector(".rp-macro-value")!
    return { value: getComputedStyle(value).color, text: getComputedStyle(el).color }
  })
  expect(colours.value).not.toBe(colours.text)
  await expect(editor.locator('[class^="rp-macro-"]', { hasText: "unknown" })).toHaveCount(0)
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`lorebook and snippet macro colours and revision marks ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const label = `Lantern ${width} ${theme}`
      const response = await page.request.post(
        `${server().url}/library/import?name=${encodeURIComponent(label)}.json`,
        {
          headers: { "content-type": "application/octet-stream", origin: server().url },
          data: Buffer.from(
            JSON.stringify({
              name: label,
              entries: { 0: { uid: 0, key: ["lamp"], comment: "Watch", content: source } }
            })
          )
        }
      )
      expect(response.ok()).toBe(true)
      const ref = (await response.json()).library.ref
      const chat = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Synthetic macro editors" })
          yield* api.ChangeCast({
            chatId: chat.id,
            slotId: null,
            change: { _tag: "Lorebook", ref: ref.id, active: true }
          })
          yield* api.CreateSnippet({ chatId: chat.id, title: "Watch text", content: source })
          return chat
        })
      )

      await page.goto(`${server().url}/library/${ref.id}`)
      await openEntry(page, "Watch")
      const content = page.getByRole("textbox", { name: "Entry content", exact: true })
      await expectTextBox(content, source)
      await highlighting(content)
      await content.fill(changed)
      await expect(content.locator("..").locator(".rp-line-added").first()).toBeVisible()
      await expect(content.locator("..").locator(".rp-line-modified").first()).toBeVisible()
      await expectLayout(page, info, "lorebook-entry", { scope: '[role="group"][aria-label="Lorebook entry 0"]' })
      await page.screenshot({ path: info.outputPath("lorebook-entry.png") })
      await saveRevision(page)
      await expect(markers(content)).toHaveCount(0)
      await content.fill(source)
      await content.blur()
      await expect(page.locator("[data-keeping=true]")).toHaveCount(0)
      await page.reload()
      await expectTextBox(content, source)
      await expect(markers(content)).not.toHaveCount(0)

      await page.goto(`${server().url}/chats/${chat.id}`)
      const books = await openPanel(page, "Lorebooks")
      await books
        .getByRole("list", { name: "Lorebooks in this chat" })
        .getByRole("button", { name: /^Lantern/ })
        .click()
      await openEntry(books, "Watch")
      const compact = books.getByRole("textbox", { name: "Entry content", exact: true })
      await highlighting(compact)
      await expect(markers(compact)).not.toHaveCount(0)
      await compact.scrollIntoViewIfNeeded()
      await expectLayout(page, info, "panel-lorebook-entry", { scope: '[role="group"][aria-label="Lorebook entry 0"]' })

      const snippets = await openPanel(page, "Snippets")
      const block = snippets.getByRole("region", { name: "Snippet Watch text", exact: true })
      await expect(block).toBeVisible()
      const expand = block.getByRole("button", { name: "Expand Watch text", exact: true })
      if (await expand.count()) await expand.click()
      const snippet = block.getByRole("textbox", { name: "Text of Watch text", exact: true })
      await highlighting(snippet)
      await snippet.fill(changed)
      await expect(snippet.locator("..").locator(".rp-line-added").first()).toBeVisible()
      await expect(snippet.locator("..").locator(".rp-line-modified").first()).toBeVisible()
      await snippet.scrollIntoViewIfNeeded()
      await expectLayout(page, info, "snippet", { scope: '[aria-label="Snippet Watch text"]' })
      await saveRevision(block)
      await expect(markers(snippet)).toHaveCount(0)
      await block.getByRole("button", { name: "Open Watch text in the large editor", exact: true }).click()
      const large = page.getByRole("region", { name: "Snippet editor", exact: true })
      const largeText = large.getByRole("textbox", { name: "Text of Watch text", exact: true })
      await highlighting(largeText)
      await largeText.fill(source)
      await expect(markers(largeText)).not.toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    })
