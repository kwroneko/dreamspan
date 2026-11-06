// Deep families remain readable in the same dialog on desktop and phone.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

for (const width of [390, 1440])
  test(`a deep library family fits its dialog at ${width}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const deep = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        let ref = yield* api.CreatePreset({ label: `Family original ${width}` })
        for (let depth = 1; depth <= 40; depth++)
          ref = yield* api.ForkVariant({ refId: ref.id, label: `Fork ${depth}`, subtitle: "", moveDrafts: false })
        return ref
      })
    )
    await page.goto(`${server().url}/library/${deep.id}`)
    await page.getByRole("button", { name: "Family", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Family", exact: true })
    const tree = dialog.getByRole("list", { name: "Family tree", exact: true })
    await expect(tree.getByRole("link")).toHaveCount(41)
    await dialog.screenshot({ path: info.outputPath("family-before-scroll.png") })
    const overflow = await tree.evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow, "Family members must fit without horizontal scrolling").toBeLessThanOrEqual(1)
    const last = tree.getByRole("link", { name: "Fork 40", exact: true })
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
    await dialog.screenshot({ path: info.outputPath("family-deepest.png") })
    if (process.env.LAYOUT_AUDIT) {
      await dialog.evaluate((element) => element.setAttribute("data-family-audit", ""))
      await expectLayout(page, info, `deep-family-${width}`, { scope: "[data-family-audit]" })
    }
  })
