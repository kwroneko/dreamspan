// A newer version of a card added from a card source (spec/CARD-SOURCES.md §3.8, §11 phase 5),
// against the fake archive, which publishes a newer version on request: Check for a newer
// version in the card's Metadata, the notice "A newer version is on cardex", More choices… (the
// comparison, Add as a separate card, Replace), Review and merge (the merge review on the staged
// file), and the result tile's "update available". Synthetic cards only; nothing reaches cardex.
import { createServer } from "node:net"
import { expect, test } from "@playwright/test"
import type { Effect } from "effect"
import { asUser, type Client } from "./rpc.ts"
import { ADMIN, apiLogin, startServer, withAdmin } from "./server.ts"
import { expectLayout } from "./layoutAudit.ts"

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

export function cardSourceUpdateTests() {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      test(`${width} ${theme}: a recognized import, checked, merged, replaced and added`, async ({ page }, info) => {
        test.setTimeout(480_000)
        const port = await freePort()
        const fake = `http://127.0.0.1:${port}`
        const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
        const admin = <A>(run: (api: Client) => Effect.Effect<A, unknown>) =>
          asUser(server, ADMIN.handle, ADMIN.password, run)
        try {
          const listed = (await (await fetch(`${fake}/api/v1/search?limit=10&sort=name`)).json()) as {
            items: ReadonlyArray<{ slug: string; name: string }>
          }
          const card = listed.items[0]!
          // Import the exact synthetic archive file, then recognize it through the source page.
          await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
          const batch = (await (await fetch(`${fake}/api/v1/cards/batch?ids=${card.slug}`)).json()) as {
            items: Array<{ file_sha256: string }>
          }
          const bytes = await (
            await fetch(`${fake}/api/v1/download/${batch.items[0]!.file_sha256}?mode=mirrored`)
          ).arrayBuffer()
          const imported = await page.request.post(`${server.url}/library/import?name=recognized.png`, {
            headers: { "content-type": "application/octet-stream" },
            data: Buffer.from(bytes)
          })
          expect(imported.status()).toBe(200)
          await admin((api) => api.SourceCard({ sourceId: "cardex", remoteId: card.slug }))
          const added = await admin((api) => api.AdoptRemoteCard({ sourceId: "cardex", remoteId: card.slug }))
          expect(added.existing).toBe(true)
          expect((await admin((api) => api.CardOrigin({ entityId: added.entityId })))?.recognized).toBe(true)
          let currentSlug = card.slug
          const publish = async () => {
            const response = await fetch(`${fake}/__fake/successor?slug=${currentSlug}&site=chub`)
            expect(response.status).toBe(200)
            currentSlug = ((await response.json()) as { slug: string }).slug
          }
          const description = async () =>
            ((await admin((api) => api.OpenEditor({ refId: added.refId as never }))).doc as { description?: string })
              .description ?? ""
          await publish()
          await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
          await page.setViewportSize({ width, height: 900 })
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
          await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
          await page.goto(`${server.url}/library/${added.refId}`)
          await expect(page.getByRole("heading", { level: 1, name: card.name })).toBeVisible({ timeout: 30_000 })
          const notice = page.getByText("A newer version is on cardex", { exact: true })
          const checkNow = async () => {
            await page.getByRole("tab", { name: "Metadata", exact: true }).click()
            const check = page.getByRole("button", { name: "Check for a newer version", exact: true })
            await check.click()
            await expect(page.getByText("A newer version is on cardex: the notice above offers it.")).toBeVisible()
            await expect(notice).toBeVisible()
          }
          // Nothing is asked of cardex until the user checks: no notice yet.
          await expect(notice).toHaveCount(0)
          await checkNow()
          await expectLayout(page, info, `source-update-metadata-${width}-${theme}`)
          await notice.scrollIntoViewIfNeeded()
          await expect(notice).toBeInViewport()
          await expectLayout(page, info, `source-update-notice-${width}-${theme}`)
          await page.screenshot({ path: info.outputPath("recognized-update.png") })

          // Ignore future updates (owner, 2026-11-16): the notice goes until it's turned back on
          // from the card's Sources row in Metadata.
          await page.getByRole("button", { name: "Ignore future updates", exact: true }).click()
          await expect(notice).toHaveCount(0)
          await page.getByRole("tab", { name: "Metadata", exact: true }).click()
          const ignoring = page.getByRole("checkbox", { name: "Ignore future updates" })
          await expect(ignoring).toBeChecked()
          await expectLayout(page, info, `source-update-ignored-${width}-${theme}`)
          await ignoring.click()
          await expect(ignoring).not.toBeChecked()
          await expect(notice).toBeVisible()
          await notice.scrollIntoViewIfNeeded()

          // More choices…: the comparison with the newer version, then Add as a separate card.
          await page.getByRole("button", { name: "More choices…", exact: true }).click()
          // Closed hint popovers and toasts are dialogs too: find it by its title.
          const dialog = page.getByRole("dialog", { name: /^The newer .+ on /u })
          await expect(dialog.getByRole("heading", { name: "What the newer version changes" })).toBeVisible()
          await expect(dialog.getByRole("button", { name: "Choose another file", exact: true })).toHaveCount(0)
          // A raw imported file has no archive link yet. Review offers adding it; taking
          // a newer version below must retain its current page link.
          await expect(dialog.getByText("Source", { exact: true })).toHaveCount(1)
          await expectLayout(page, info, `source-update-choices-${width}-${theme}`)
          await dialog.getByRole("button", { name: "Add as a separate card", exact: true }).click()
          await expect(dialog).toHaveCount(0)
          await expect(page.getByText(`Added the newer ${card.name} as a separate card`)).toBeVisible()
          await expect
            .poll(
              async () =>
                (await admin((api) => api.ListLibrary({ kind: "card" }))).filter((r) => r.label === card.name).length
            )
            .toBe(2)
          await expect(notice).toHaveCount(0)
          expect((await admin((api) => api.CardOrigin({ entityId: added.entityId })))?.remoteId).toBe(currentSlug)
          expect(await description()).not.toContain("now keeps a garden")

          // Another version: Review and merge stages it and opens the merge review.
          await publish()
          await checkNow()
          await page.getByRole("button", { name: "Review and merge", exact: true }).click()
          const review = page.getByRole("dialog", { name: /^Merge into / })
          await expect(review).toBeVisible()
          await expectLayout(page, info, `source-update-merge-${width}-${theme}`)
          await page.keyboard.press("Escape")
          await expect(review).toHaveCount(0)
          // It waits on the card's import line until it's merged.
          await expect(page.getByText("A newer imported version is waiting", { exact: true })).toBeVisible()
          await expect(notice).toHaveCount(0)

          expect((await admin((api) => api.CardOrigin({ entityId: added.entityId })))?.remoteId).toBe(currentSlug)

          // Another: Replace makes it the card's next revision.
          await publish()
          await checkNow()
          await page.getByRole("button", { name: "More choices…", exact: true }).click()
          await expect(dialog.getByRole("heading", { name: "What the newer version changes" })).toBeVisible()
          await dialog.getByRole("button", { name: "Replace", exact: true }).click()
          await expect(dialog).toHaveCount(0)
          await expect(page.getByText(`${card.name} is now cardex's newer version`)).toBeVisible()
          await expect.poll(description).toContain("Revised 3")
          const sources =
            ((await admin((api) => api.OpenEditor({ refId: added.refId as never }))).doc as { source?: string[] })
              .source ?? []
          expect(sources.filter((entry) => entry === `${fake}/c/${currentSlug}`)).toHaveLength(1)
          expect((await admin((api) => api.CardOrigin({ entityId: added.entityId })))?.remoteId).toBe(currentSlug)
          await expect(notice).toHaveCount(0)

          // Yet another, seen in fresh results: the tile says so.
          await publish()
          await page.goto(`${server.url}/?show=src.cardex&sq=${encodeURIComponent(card.name)}`)
          const tile = page.getByRole("main").locator(`[data-remote-card="${card.slug}"]`)
          await expect(tile.locator("[data-held-update]")).toHaveText("update available", { timeout: 30_000 })
          await expectLayout(page, info, `source-update-tile-${width}-${theme}`, { scope: "main" })
        } finally {
          await server.stop()
        }
      })
    }
}
