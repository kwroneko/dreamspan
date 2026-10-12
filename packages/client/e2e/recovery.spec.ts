import { expect, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test("reverting a field links to its recovered text", async ({ page }) => {
  const card = await admin((api) => api.CreateCard({ label: "N5 revert", name: "N5 revert" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  const box = page.getByRole("textbox", { name: /^Description/ })
  await box.fill("N5 REVERT RECOVERY 857194")
  await expect
    .poll(() => admin((api) => api.OpenEditor({ refId: card.id })).then((x) => x.drafts[0]?.content))
    .toBe("N5 REVERT RECOVERY 857194")
  await page.getByRole("button", { name: "Revert Description", exact: true }).click()
  await expect(box).toHaveValue("")
  const recovered = await admin((api) => api.ListRecoveredTexts({ limit: 10, before: null }))
  expect(recovered.some((x) => x.content === "N5 REVERT RECOVERY 857194")).toBe(true)
  const links = await page.locator('a[href="/bin?section=recovered"]').count()
  expect(links).toBeGreaterThan(0)
})

test("removing a module keeps its source recovery link", async ({ page }) => {
  const card = await admin((api) => api.CreateCard({ label: "Module recovery", name: "Synthetic" }))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${card.id}`)
  await page.getByRole("button", { name: "Add a module", exact: true }).click()
  const module = page.getByRole("region", { name: "Module New module", exact: true })
  await module.getByRole("textbox", { name: /^Content/ }).fill("Module text kept after removal")
  await expect
    .poll(() =>
      admin((api) => api.OpenEditor({ refId: card.id })).then((editor) =>
        editor.drafts.some((draft) => draft.content === "Module text kept after removal")
      )
    )
    .toBe(true)
  await module.getByRole("button", { name: "Remove the module", exact: true }).click()
  await expect(module).toHaveCount(0)
  await expect(page.locator('a[href="/bin?section=recovered"]')).toHaveCount(1)
  expect(
    (await admin((api) => api.ListRecoveredTexts({ limit: 10, before: null }))).some(
      (text) => text.content === "Module text kept after removal"
    )
  ).toBe(true)
})
