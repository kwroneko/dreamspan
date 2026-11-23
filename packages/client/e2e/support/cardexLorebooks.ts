// Standalone lorebooks from a card source (spec/CARD-SOURCES.md §3.9) against the fake archive,
// whose synthetic lorebooks a search for "gazetteer" finds: the Lorebook badge on result tiles,
// the Kind choice's four options, the tile menu (no Inspect, no chat), Add to my lorebooks,
// opening one (a click, and the add-and-open page a new tab loads) into the lorebook editor,
// and there Check for a newer version and Update, which merges the newer file in. Synthetic
// lorebooks only; nothing reaches cardex.
import { createServer } from "node:net"
import { expect, test } from "@playwright/test"
import type { Effect } from "effect"
import { asUser, type Client } from "./rpc.ts"
import { ADMIN, apiLogin, startServer, withAdmin } from "./server.ts"
import { openPanel } from "./panel.ts"
import { expectLayout } from "./layoutAudit.ts"
import { closePanel, openPanel as openFilterPanel } from "./sourceFilters.ts"

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

export function cardexLorebookTests() {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      test(`${width} ${theme}: lorebooks among the results, added, opened and updated`, async ({ page }, info) => {
        test.setTimeout(480_000)
        const port = await freePort()
        const fake = `http://127.0.0.1:${port}`
        const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
        const admin = <A>(run: (api: Client) => Effect.Effect<A, unknown>) =>
          asUser(server, ADMIN.handle, ADMIN.password, run)
        try {
          const listed = (await (
            await fetch(`${fake}/api/v1/search?q=gazetteer&kind=lorebook&sort=name&limit=10`)
          ).json()) as {
            items: ReadonlyArray<{ slug: string; name: string; creator: string }>
          }
          const [first, second, third] = listed.items
          await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
          await page.setViewportSize({ width, height: 900 })
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
          await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
          await page.goto(`${server.url}/?show=src.cardex&sq=gazetteer`)
          const main = page.getByRole("main")
          const tile = (slug: string) => main.locator(`[data-remote-card="${slug}"]`)
          // Unchosen, the kind is both: the words find lorebooks, each marked as one.
          const books = main.locator("[data-remote-lorebook]")
          await expect(books.first()).toBeVisible({ timeout: 30_000 })
          await expect(books.first().locator("[data-lorebook-badge]")).toHaveText("Lorebook")
          await books.first().locator("[data-lorebook-badge]").hover()
          await expect(
            page.getByText("A lorebook, not a character. Opening it adds it to your lorebooks.")
          ).toBeVisible()
          await expectLayout(page, info, `lorebook-results-${width}-${theme}`, { scope: "main", hovered: true })

          // The Kind choice offers all four.
          const kind = await openFilterPanel(page, main, "Kind")
          for (const option of ["Characters and lorebooks", "Characters", "Characters with a lorebook", "Lorebooks"])
            await expect(kind.getByRole("radio", { name: option, exact: true })).toBeVisible()
          await expectLayout(page, info, `lorebook-kind-${width}-${theme}`)
          await kind.getByRole("radio", { name: "Lorebooks", exact: true }).click()
          await closePanel(page, "Kind")
          const active = main.getByRole("group", { name: "Active filters", exact: true })
          await expect(active).toContainText("Kind: Lorebooks")
          // Neither default applies to lorebooks.
          await expect(active).not.toContainText("(default)")
          await expect(tile(first!.slug)).toBeVisible({ timeout: 30_000 })

          // The menu: no Inspect, no chat, no card; Add to my lorebooks adds it without opening it.
          await tile(first!.slug).getByRole("link").click({ button: "right" })
          for (const item of ["Open", "Add to my lorebooks", "Open in a new browser tab", "Open on cardex"])
            await expect(page.getByRole("menuitem", { name: item, exact: true })).toBeVisible()
          await expect(page.getByRole("menuitem", { name: /^More by / })).toBeVisible()
          await expect(page.getByRole("menuitem", { name: /^Cards by / })).toHaveCount(0)
          for (const item of ["Inspect", "Add to my cards", "Start a chat"])
            await expect(page.getByRole("menuitem", { name: item, exact: true })).toHaveCount(0)
          await expectLayout(page, info, `lorebook-menu-${width}-${theme}`)
          await page.getByRole("menuitem", { name: "Add to my lorebooks", exact: true }).click()
          await expect(page.getByText(`Added ${first!.name} to your lorebooks.`)).toBeVisible()
          await expect(tile(first!.slug).locator("[data-held-badge]")).toBeVisible()
          await expect(tile(first!.slug).locator("[data-held-badge]")).toHaveAttribute(
            "aria-label",
            "You have this lorebook"
          )
          const lorebooks = await admin((api) => api.ListLibrary({ kind: "lorebook" }))
          const firstRef = lorebooks.find((ref) => ref.label === first!.name)!
          await expect(tile(first!.slug).getByRole("link")).toHaveAttribute("href", `/library/${firstRef.id}`)
          expect(await admin((api) => api.ListLibrary({ kind: "card" }))).toHaveLength(0)

          // A click adds the second and opens it in the lorebook editor.
          await tile(second!.slug).getByRole("link").click()
          await expect(page).toHaveURL(/\/library\/[^/?]+/, { timeout: 30_000 })
          await expect(page.getByRole("heading", { level: 1, name: second!.name })).toBeVisible({ timeout: 30_000 })
          const secondRef = (await admin((api) => api.ListLibrary({ kind: "lorebook" }))).find(
            (ref) => ref.label === second!.name
          )!
          expect(page.url()).toContain(`/library/${secondRef.id}`)
          const notice = page.getByText("A newer version is on cardex", { exact: true })
          await expect(notice).toHaveCount(0)
          const check = page.getByRole("button", { name: "Check for a newer version", exact: true })
          await check.click()
          await expect(page.getByText("You have cardex's latest version.")).toBeVisible()

          // The author adds an entry: Check finds it, Update merges it in.
          expect((await fetch(`${fake}/__fake/publish?slug=${second!.slug}`)).status).toBe(200)
          await check.click()
          await expect(page.getByText("A newer version is on cardex: the notice above offers it.")).toBeVisible()
          await expect(notice).toBeVisible()
          await notice.scrollIntoViewIfNeeded()
          await expectLayout(page, info, `lorebook-update-${width}-${theme}`)
          await page.screenshot({ path: info.outputPath("lorebook-update.png") })
          await page.getByRole("button", { name: "Review and merge", exact: true }).click()
          const review = page.getByRole("dialog", { name: /^Merge into / })
          await expect(review).toBeVisible()
          await expectLayout(page, info, `lorebook-review-${width}-${theme}`)
          expect(
            ((await admin((api) => api.OpenEditor({ refId: secondRef.id }))).doc as { entries: unknown[] }).entries
          ).toHaveLength(2)
          // Cancel keeps the in-use book intact. The ordinary pending-merge notice reopens the review.
          await page.keyboard.press("Escape")
          await expect(review).toHaveCount(0)
          expect(
            ((await admin((api) => api.OpenEditor({ refId: secondRef.id }))).doc as { entries: unknown[] }).entries
          ).toHaveLength(2)
          await page.getByRole("button", { name: "Review and merge", exact: true }).click()
          await expect(review).toBeVisible()
          await review.getByRole("button", { name: "Merge", exact: true }).click()
          await expect(page.getByText(`Merged into ${second!.name}`)).toBeVisible()
          await expect(notice).toHaveCount(0)
          await expect
            .poll(
              async () =>
                (
                  (await admin((api) => api.OpenEditor({ refId: secondRef.id }))).doc as {
                    entries: ReadonlyArray<unknown>
                  }
                ).entries.length
            )
            .toBe(3)
          expect((await admin((api) => api.CardOrigin({ entityId: secondRef.entityId })))?.newerVersion).toBeNull()

          // The compact editor has the same review, with an attached book in use by a chat.
          const chat = await admin((api) => api.CreateChat({ title: "Lorebook review fixture" }))
          await admin((api) =>
            api.ChangeCast({
              chatId: chat.id,
              slotId: null,
              change: { _tag: "Lorebook", ref: secondRef.id, active: true }
            })
          )
          await page.goto(`${server.url}/chats/${chat.id}`)
          const panel = await openPanel(page, "Lorebooks")
          await panel
            .getByRole("list", { name: "Lorebooks in this chat" })
            .getByRole("button", { name: new RegExp(`^${second!.name}`) })
            .click()
          expect((await fetch(`${fake}/__fake/publish?slug=${second!.slug}`)).status).toBe(200)
          await panel.getByRole("button", { name: "Check for a newer version", exact: true }).click()
          const compactNotice = panel.getByText("A newer version is on cardex", { exact: true })
          await expect(compactNotice).toBeVisible()
          await compactNotice.scrollIntoViewIfNeeded()
          await expectLayout(page, info, `lorebook-compact-update-${width}-${theme}`)
          await panel.getByRole("button", { name: "Review and merge", exact: true }).click()
          await expect(review).toBeVisible()
          await expectLayout(page, info, `lorebook-compact-review-${width}-${theme}`)
          expect(
            ((await admin((api) => api.OpenEditor({ refId: secondRef.id }))).doc as { entries: unknown[] }).entries
          ).toHaveLength(3)
          await page.keyboard.press("Escape")
          await expect(review).toHaveCount(0)
          await panel.getByRole("button", { name: "Review and merge", exact: true }).click()
          await review.getByRole("button", { name: "Merge", exact: true }).click()
          await expect(page.getByText(`Merged into ${second!.name}`)).toBeVisible()
          expect(
            ((await admin((api) => api.OpenEditor({ refId: secondRef.id }))).doc as { entries: unknown[] }).entries
          ).toHaveLength(4)

          // A new browser tab loads the add-and-open page, which replaces itself with the editor.
          await page.goto(`${server.url}/sources/cardex/lorebooks/${encodeURIComponent(third!.slug)}`)
          await expect(page.getByRole("heading", { level: 1, name: third!.name })).toBeVisible({ timeout: 30_000 })
          await expect(page).toHaveURL(/\/library\/[^/?]+/)
          // Opened again, it is the same lorebook.
          await page.goto(`${server.url}/sources/cardex/lorebooks/${encodeURIComponent(third!.slug)}`)
          await expect(page.getByRole("heading", { level: 1, name: third!.name })).toBeVisible({ timeout: 30_000 })
          expect(
            (await admin((api) => api.ListLibrary({ kind: "lorebook" }))).filter((ref) => ref.label === third!.name)
          ).toHaveLength(1)
          // The recent list remembers a lorebook and returns to its editor, never a character chat.
          await page.goto(`${server.url}/?show=src.cardex&sq=gazetteer`)
          const recent = page.locator("[data-source-recent]")
          await recent.locator("summary").click()
          const recentBook = recent.getByRole("link").filter({ hasText: third!.name })
          await expect(recentBook).toHaveAttribute("href", `/sources/cardex/lorebooks/${third!.slug}`)
          await expectLayout(page, info, `lorebook-recent-${width}-${theme}`)
          await recentBook.click()
          await expect(page).toHaveURL(new RegExp(`/library/`))
          await expect(page.getByRole("heading", { level: 1, name: third!.name })).toBeVisible()
        } finally {
          await server.stop()
        }
      })
    }
}
