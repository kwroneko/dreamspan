// Synthetic text only. Sending copies text without leaving or checkpointing the source.
import { expect, type Page, type TestInfo, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { expectTextBox } from "./support/textbox.ts"
import { layoutAudit } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
let cookie: Promise<string> | null = null
const admin = async <A>(use: Parameters<typeof withCookie<A>>[2]) =>
  withCookie(server(), await (cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)

// Use the shared geometry detector on the notice, retaining measured crops for any finding.
const auditNotice = async (page: Page, info: TestInfo, surface: string) => {
  if (!process.env.LAYOUT_AUDIT) return
  const notice = page.locator("[data-toast]").filter({ hasText: "Added to snippet" }).last()
  await notice.hover() // Keep the notice alive during inspection.
  const box = (await notice.boundingBox())!
  const findings = (await layoutAudit(page)).filter(
    ({ box: b }) =>
      b.x < box.x + box.width && b.x + b.width > box.x && b.y < box.y + box.height && b.y + b.height > box.y
  )
  for (const [i, finding] of findings.entries()) {
    finding.crop = info.outputPath(`${surface}-${i}-${finding.kind}.png`)
    await page.screenshot({ path: finding.crop, clip: finding.box })
    await info.attach(`${surface}-${i}`, { path: finding.crop, contentType: "image/png" })
  }
  await info.attach(surface, { body: JSON.stringify(findings, null, 2), contentType: "application/json" })
  const screenshot = info.outputPath(`${surface}-notice.png`)
  await notice.screenshot({ path: screenshot })
  await info.attach(`${surface}-notice`, { path: screenshot, contentType: "image/png" })
  expect.soft(findings, `${surface} notice layout`).toEqual([])
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`pending card text stays through sending and opening a snippet ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const card = await admin((api) => api.CreateCard({ label: "Synthetic keeper", name: "Keeper" }))
      const { chat } = await admin((api) =>
        api.StartChat({
          cards: [card.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "A synthetic harbour.", speakerEntityId: null }
        })
      )
      // A named snippet, plus another to prove the notice targets its own snippet.
      const target = await admin((api) =>
        api.CreateSnippet({ chatId: chat.id, title: "Harbour notebook", content: "Earlier passage." })
      )
      await admin((api) => api.CreateSnippet({ chatId: chat.id, title: "Other notebook", content: "Other passage." }))
      await page.goto(`${server().url}/chats/${chat.id}`)
      const snippets = await openPanel(page, "Snippets")
      await snippets.getByRole("textbox", { name: "Text of Harbour notebook" }).click()
      const panel = await openPanel(page, "Keeper")
      const field = panel.getByRole("textbox", { name: "Description", exact: true })
      const text = "The keeper watches the harbour. Pending words stay here."
      const before = await admin((api) => api.ListRevisions({ refId: card.id, limit: 100 }))
      await field.fill(text)
      // Snippets isn't shown, so a menu chooses where it goes.
      await panel.getByRole("button", { name: "Send text to snippet", exact: true }).first().click()
      await page.getByRole("menuitem", { name: /^Harbour notebook/ }).click()
      await expect(page.getByText("Added to snippet “Harbour notebook”", { exact: true })).toBeVisible()
      await expect(panel).toBeVisible()
      await expect(field).toBeFocused()
      await expectTextBox(field, text)
      await expect(panel.getByText("edited", { exact: true })).toBeVisible()
      await auditNotice(page, info, "card-panel")
      expect(await admin((api) => api.ListRevisions({ refId: card.id, limit: 100 }))).toEqual(before)
      await page.getByRole("button", { name: "Open", exact: true }).click()
      await expect(snippets).toBeVisible()
      await expectTextBox(
        snippets.getByRole("textbox", { name: "Text of Harbour notebook" }),
        `Earlier passage.\n\n${text}`
      )
      expect(
        (await admin((api) => api.ListSnippets({ chatId: chat.id }))).find((s) => s.ref.id === target.ref.id)?.content
      ).toContain(text)
      await openPanel(page, "Keeper")
      await field.click()
      await expectTextBox(field, text)
      await expect(panel.getByText("edited", { exact: true })).toBeVisible()
      // Closing/remounting the panel also retains pending text, still with no revision.
      await closePanel(page)
      await openPanel(page, "Keeper")
      await field.click()
      await expectTextBox(field, text)
      await expect(panel.getByText("edited", { exact: true })).toBeVisible()
      expect(await admin((api) => api.ListRevisions({ refId: card.id, limit: 100 }))).toEqual(before)
    })

    test(`sending outside a chat keeps the sheet closed ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      for (const item of await admin((api) => api.ListSnippets({ chatId: null })))
        await admin((api) => api.DeleteNote({ noteRefId: item.ref.id }))
      const card = await admin((api) => api.CreateCard({ label: "Synthetic notebook", name: "Keeper" }))
      await page.goto(`${server().url}/library/${card.id}`)
      const field = page.getByRole("textbox", { name: "Description", exact: true })
      const text = "A keeper watches the harbour."
      const before = await admin((api) => api.ListRevisions({ refId: card.id, limit: 100 }))
      await field.fill(text)
      await field.press("Control+Home")
      await field.press("Control+Shift+End")
      await page.getByRole("button", { name: "Send selection to snippet", exact: true }).click()
      await page.getByRole("menuitem", { name: /^New snippet/ }).click()
      await expect(page.getByText(`Added to snippet “${text}”`, { exact: true })).toBeVisible()
      await expect(field).toBeFocused()
      await expectTextBox(field, text)
      await expect(page.getByRole("dialog", { name: "Snippets" })).toHaveCount(0)
      await auditNotice(page, info, "library")
      await page.getByRole("button", { name: "Open", exact: true }).click()
      const sheet = page.getByRole("dialog", { name: "Snippets" })
      await expectTextBox(sheet.getByRole("textbox", { name: "Text of Untitled snippet" }), text)
      await sheet.getByRole("button", { name: "Close", exact: true }).click()
      await field.click()
      await expectTextBox(field, text)
      await expect(page.getByText("edited", { exact: true })).toBeVisible()
      expect(await admin((api) => api.ListRevisions({ refId: card.id, limit: 100 }))).toEqual(before)
    })
  }
