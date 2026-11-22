import { expect, test } from "@playwright/test"
import { showAppNavigation } from "./support/appMenu.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

for (const width of [390, 1440]) {
  test(`bin limits convert, validate and retain adjacent Save buttons at ${width}`, async ({ page }) => {
    await admin((api) => api.ChangeBinLimit({ key: "deletedItems", value: 10000 }))
    await admin((api) => api.ChangeBinLimit({ key: "deletedBytes", value: 2147483648 }))
    await admin((api) => api.ChangeBinLimit({ key: "recoveredBytes", value: 209715200 }))
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/bin`)
    if (width >= 1024) await showAppNavigation(page)
    await page.getByText("Bin capacity", { exact: true }).click()
    const items = page.getByRole("textbox", { name: "Deleted items: item limit", exact: true })
    await expect(items).toHaveValue("10,000")
    await items.fill("12345")
    await expect(items).toHaveValue("12345")
    await items.blur()
    await expect(items).toHaveValue("12,345")
    const itemSave = items.locator("xpath=ancestor::form").getByRole("button", { name: "Save", exact: true })
    await itemSave.click()
    await expect(itemSave).toBeDisabled()
    const size = page.getByRole("textbox", { name: "Deleted items: size limit", exact: true })
    const form = size.locator("xpath=ancestor::form")
    const unit = form.getByRole("combobox")
    await expect(size).toHaveValue("2")
    await expect(unit).toHaveText("GB")
    await expect(page.getByRole("textbox", { name: "Recovered text: size limit", exact: true })).toHaveValue("200")
    await size.fill("-1")
    await expect(form.getByText("Enter a positive size within the supported range.")).toBeVisible()
    await expect(form.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    await size.fill("9007199254740991")
    await expect(form.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    await size.fill("1.5")
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await expect(form.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    expect((await admin((api) => api.GetBinLimits())).deletedBytes).toBe(1610612736)
    await unit.click()
    await page.getByRole("option", { name: "MB", exact: true }).click()
    await size.fill("256")
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await expect(form.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    const boxes = await Promise.all([
      size.boundingBox(),
      unit.boundingBox(),
      form.getByRole("button", { name: "Save", exact: true }).boundingBox()
    ])
    const [inputBox, unitBox, saveBox] = boxes
    expect(inputBox && unitBox && saveBox).toBeTruthy()
    expect(unitBox!.width).toBe(80)
    expect(saveBox!.x + saveBox!.width).toBeLessThan(width)
    expect(Math.abs(unitBox!.x - inputBox!.x - inputBox!.width - 8)).toBeLessThan(1)
    expect(Math.abs(saveBox!.x - unitBox!.x - unitBox!.width - 8)).toBeLessThan(1)
    await page.reload()
    // Bin capacity stays open through the reload (URL state).
    await expect(items).toHaveValue("12,345")
    await expect(size).toHaveValue("256")
    expect((await admin((api) => api.GetBinLimits())).deletedBytes).toBe(268435456)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
