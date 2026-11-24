// Cardex listing and family details in the full editor, with an editor link for each relative.
// Synthetic archive only. CARDEX_DETAILS_SHOTS saves the three editor views per viewport and theme.
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
const shots = process.env.CARDEX_DETAILS_SHOTS

for (const [width, height] of [
  [1340, 900],
  [1920, 1080],
  [390, 844]
] as const)
  test.describe(`${width}px`, () => {
    test.use({ hasTouch: width === 390, isMobile: width === 390, viewport: { width, height } })
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
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
          await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)

          // Existing bookmarks land in the editor. Both buttons open the same popover.
          const added = await admin((api) => api.AdoptRemoteCard({ sourceId: "cardex", remoteId: parent }))
          await page.goto(`${server.url}/sources/cardex/cards/${fork}`)
          await expect(page).toHaveURL(/\/library\/src%3Acardex%3A/)
          const header = page.locator("[data-cardex-editor-header]")
          const details = header.getByRole("button", { name: "cardex details", exact: true })
          const versions = header.getByRole("button", { name: "Versions", exact: true })
          const popup = page.getByRole("dialog", { name: "cardex details", exact: true })
          const listingTab = popup.getByRole("tab", { name: "Listing", exact: true })
          const familyTab = popup.getByRole("tab", { name: "Versions and forks", exact: true })
          await expect(versions).toBeVisible()
          const name = header.getByRole("heading")
          const initial = await name.boundingBox()
          if (width === 390) {
            expect((await versions.boundingBox())?.y).toBe((await details.boundingBox())?.y)
            for (const action of [details, versions, header.getByRole("link", { name: "Start a chat" })])
              expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44)
          }
          await expectLayout(page, info, `cardex-editor-${width}-${theme}`, { scope: "[data-cardex-editor-header]" })
          if (shots) {
            await expect(header.locator("img").first()).toBeVisible()
            await page.screenshot({ path: `${shots}/${width}-${theme}-editor.png` })
          }

          await details.click()
          await expect(listingTab).toHaveAttribute("aria-selected", "true")
          const listing = popup.getByRole("tabpanel", { name: "Listing", exact: true })
          await expect(listing.getByText("Counted by cardex with o200k_base.")).toBeAttached()
          await expect(
            listing
              .locator("dl > div")
              .filter({ has: page.getByText("Description", { exact: true }) })
              .locator("dd")
          ).toHaveText("40")
          await expect(listing.getByRole("link", { name: /^Earlier listing(?: on .+)?$/ })).toHaveAttribute(
            "href",
            /\/o\//
          )
          await expect(details).toHaveAttribute("aria-controls", (await popup.getAttribute("id"))!)
          expect(await name.boundingBox()).toEqual(initial)
          await page.mouse.move(0, 0)
          await expectLayout(page, info, `cardex-listing-${width}-${theme}`, { scope: '[role="dialog"]' })
          const listingLeft = (await popup.boundingBox())?.x
          if (shots) await page.screenshot({ path: `${shots}/${width}-${theme}-listing.png` })
          await page.keyboard.press("Escape")
          await expect(popup).toHaveCount(0)

          await versions.click()
          await expect(familyTab).toHaveAttribute("aria-selected", "true")
          await expect(versions).toHaveAttribute("aria-controls", (await popup.getAttribute("id"))!)
          const family = popup.locator("[data-source-family]")
          const from = family.locator(`[data-family-card="${parent}"]`)
          await expect(from).toContainText("Forked from", { timeout: 30_000 })
          await expect(from.locator("[data-family-held]")).toHaveText("Yours")
          const editor = from.getByRole("link", { name: "Open in editor", exact: true })
          const yours = from.getByRole("link", { name: "Open yours", exact: true })
          await expect(yours).toHaveAttribute("href", `/cards/${added.entityId}`)
          const earlier = family.locator("[data-family-card]").filter({ hasText: "Earlier listing" })
          await expect(earlier).toHaveCount(1)
          const chat = earlier.getByRole("link", { name: "Chat", exact: true })
          const tooltip = page.locator('[data-layout-overlay="Tooltip floats above the page"][data-open]')
          for (const [action, hint] of [
            [editor, /^Opens your copy of .+ in the editor\.$/],
            [yours, /^Opens your .+ character page\.$/],
            [chat, /^Opens a new chat with .+ when you send\.$/]
          ] as const) {
            await expect(action).toHaveCSS("border-top-width", "1px")
            if (width === 390) await expect(action).toHaveCSS("height", "44px")
            else {
              const bounds = await action.boundingBox()
              await action.hover()
              await expect(tooltip).toHaveText(hint)
              await expect(tooltip).toBeVisible()
              expect(await action.boundingBox()).toEqual(bounds)
            }
          }
          await expect(family.getByRole("link", { name: /^(View(?: beside)?|Inspect)$/ })).toHaveCount(0)
          expect(await name.boundingBox()).toEqual(initial)
          await page.mouse.move(0, 0)
          await expectLayout(page, info, `cardex-family-${width}-${theme}`, { scope: '[role="dialog"]' })
          expect((await popup.boundingBox())?.x).toBe(listingLeft)
          if (shots) await page.screenshot({ path: `${shots}/${width}-${theme}-versions.png` })
          await listingTab.click()
          await expect(listingTab).toHaveAttribute("aria-selected", "true")
          await familyTab.click()
          await editor.click()
          await expect(page).toHaveURL(new RegExp(`/library/${added.refId}(?:\\?|$)`))

          // The library card's Metadata offers the same editor destinations.
          await page.getByRole("tab", { name: "Metadata", exact: true }).click()
          const ask = page.getByRole("button", { name: "Versions and forks on cardex", exact: true })
          await ask.click()
          await expect(ask).toHaveAttribute("aria-expanded", "true")
          const child = page.locator(`[data-card-source-family] [data-family-card="${fork}"]`)
          await expect(child).toContainText("Fork", { timeout: 30_000 })
          await expect(child.getByRole("link", { name: "Chat", exact: true })).toBeVisible()
          await page.locator("[data-card-source-family] [data-family-card]").first().scrollIntoViewIfNeeded()
          await expectLayout(page, info, `cardex-family-metadata-${width}-${theme}`)
          await child.getByRole("link", { name: "Open in editor", exact: true }).click()
          await expect(page).toHaveURL(new RegExp(`/library/src%3Acardex%3A${fork}(?:\\?|$)`))
        } finally {
          await server.stop()
        }
      })
    }
  })
