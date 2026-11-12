// A card's versions and forks on cardex (spec/CARD-SOURCES.md §3.7): on a source card's page,
// the card it was forked from, its earlier listing and versions, each inspectable, the user's own
// marked; and on request in a card's Metadata. Synthetic archive only; nothing reaches cardex.
import { createServer } from "node:net"
import { expect, test } from "@playwright/test"
import type { Effect } from "effect"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, startServer, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"

test.setTimeout(300_000)

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

type Detail = { origins: ReadonlyArray<{ fork: { forked_from: { card_slug: string } | null } }> }

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`cardex family: ${width} ${theme}`, async ({ page }, info) => {
      const port = await freePort()
      const fake = `http://127.0.0.1:${port}`
      const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
      const admin = <A>(run: (api: Client) => Effect.Effect<A, unknown>) =>
        asUser(server, ADMIN.handle, ADMIN.password, run)
      try {
        // A synthetic fork and the card it was forked from.
        const listed = (await (await fetch(`${fake}/api/v1/search?limit=20&sort=newest`)).json()) as {
          items: ReadonlyArray<{ slug: string; name: string }>
        }
        let pair: { fork: string; parent: string } | null = null
        for (const item of listed.items) {
          const detail = (await (await fetch(`${fake}/api/v1/cards/${item.slug}`)).json()) as Detail
          const from = detail.origins[0]?.fork.forked_from
          if (from) {
            pair = { fork: item.slug, parent: from.card_slug }
            break
          }
        }
        expect(pair).not.toBeNull()
        const { fork, parent } = pair!
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)

        // The fork's page lists the card it came from; the user's own is marked.
        const added = await admin((api) => api.AdoptRemoteCard({ sourceId: "cardex", remoteId: parent }))
        await page.goto(`${server.url}/sources/cardex/cards/${fork}`)
        const family = page.locator("[data-remote-card-page] [data-source-family]")
        const from = family.locator(`[data-family-card="${parent}"]`)
        await expect(from).toContainText("Forked from", { timeout: 30_000 })
        await expect(from.locator("[data-family-held]")).toHaveText("Yours")
        await expect(from.getByRole("link", { name: "Open yours", exact: true })).toHaveAttribute(
          "href",
          `/cards/${added.entityId}`
        )
        await expect(family.locator("[data-family-card]").filter({ hasText: "Earlier listing" })).toHaveCount(1)
        await from.scrollIntoViewIfNeeded()
        await expectLayout(page, info, `cardex-family-page-${width}-${theme}`)
        await family.locator("[data-family-card]").last().scrollIntoViewIfNeeded()
        await expectLayout(page, info, `cardex-family-page-end-${width}-${theme}`)

        await page.screenshot({ path: info.outputPath("family-page.png") })
        // Inspect opens the relative's page, which lists this card among its forks.
        await from.getByRole("link", { name: "Inspect", exact: true }).click()
        await expect(page).toHaveURL(new RegExp(`/sources/cardex/cards/${parent}$`))
        const child = family.locator(`[data-family-card="${fork}"]`)
        await expect(child).toContainText("Fork", { timeout: 30_000 })
        await expect(child.getByRole("link", { name: "Chat", exact: true })).toBeVisible()

        // In the card's Metadata, on request.
        await page.goto(`${server.url}/library/${added.refId}`)
        await page.getByRole("tab", { name: "Metadata", exact: true }).click()
        const ask = page.getByRole("button", { name: "Versions and forks on cardex", exact: true })
        await ask.click()
        await expect(ask).toHaveAttribute("aria-expanded", "true")
        await expect(page.locator(`[data-card-source-family] [data-family-card="${fork}"]`)).toBeVisible({
          timeout: 30_000
        })
        await page.locator("[data-card-source-family] [data-family-card]").first().scrollIntoViewIfNeeded()
        await expectLayout(page, info, `cardex-family-metadata-${width}-${theme}`)
        await page.screenshot({ path: info.outputPath("family-metadata.png") })
      } finally {
        await server.stop()
      }
    })
  }
