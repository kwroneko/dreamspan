// "Only tried" in Archive unused cards… (spec/CARD-SOURCES.md §9 D3, §11 phase 6): with cardex
// on, the dialog offers the criterion with its count; checked, it lists the cards added from
// cardex with at most N of the user's messages, and archives them in one step. With cardex
// off it isn't offered. Synthetic cards from the fake archive only; nothing reaches cardex.
import { createServer } from "node:net"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
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

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`${width} ${theme}: Only tried archives cards added from cardex and barely used`, async ({ page }, info) => {
      const port = await freePort()
      const server = await startServer({ ...withAdmin, FAKE_CARD_SOURCE: String(port) })
      const admin = <A>(run: (api: Client) => Effect.Effect<A, unknown>) =>
        asUser(server, ADMIN.handle, ADMIN.password, run)
      try {
        const listed = (await (await fetch(`http://127.0.0.1:${port}/api/v1/search?limit=10&sort=name`)).json()) as {
          items: ReadonlyArray<{ slug: string; name: string }>
        }
        const tried = listed.items.slice(0, 2)
        for (const card of tried) await admin((api) => api.AdoptRemoteCard({ sourceId: "cardex", remoteId: card.slug }))
        await admin((api) => api.CreateCard({ label: "Ava Local", name: "Ava" }))
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
        await page.goto(`${server.url}/?show=archived`)
        const main = page.getByRole("main")
        await main.getByRole("button", { name: "Archive unused cards…", exact: true }).click()
        const dialog = page.getByRole("dialog", { name: "Archive unused cards", exact: true })
        const criterion = dialog.locator('[data-archive-criterion="tried"]')
        const label = "Only tried: added from cardex, with at most"
        await expect(criterion.getByRole("checkbox", { name: label, exact: true })).not.toBeChecked()
        await expect(criterion.locator('[data-criterion-count="tried"]')).toHaveText("2 cards")
        await expect(criterion.getByText("of your messages in all its chats", { exact: true })).toBeVisible()
        await criterion.getByRole("checkbox", { name: label, exact: true }).click()
        for (const card of tried)
          await expect(dialog.getByRole("checkbox", { name: card.name, exact: true })).toBeChecked()
        await expect(dialog.getByRole("checkbox", { name: "Ava Local", exact: true })).toHaveCount(0)
        await expect(dialog.getByText("0 messages of yours").first()).toBeVisible()
        await expectLayout(page, info, `archive-tried-${width}-${theme}`, { scope: '[role="dialog"]' })
        await dialog.getByRole("button", { name: "Archive 2 cards", exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect(page.locator("[data-toast]").filter({ hasText: "2 cards archived" })).toBeVisible()
        await expect
          .poll(() =>
            admin((api) =>
              Effect.map(api.ListLibrary({ kind: "card", archived: true }), (cards) => cards.map((c) => c.label).sort())
            )
          )
          .toEqual(tried.map((card) => card.name).sort())
        // With cardex off, the criterion isn't offered.
        await admin((api) => api.SetCardSourceEnabled({ sourceId: "cardex", enabled: false }))
        await page.reload()
        await main.getByRole("button", { name: "Archive unused cards…", exact: true }).click()
        await expect(dialog.getByRole("checkbox", { name: "Never used, added more than", exact: true })).toBeVisible()
        await expect(dialog.locator('[data-archive-criterion="tried"]')).toHaveCount(0)
      } finally {
        await server.stop()
      }
    })
  }
