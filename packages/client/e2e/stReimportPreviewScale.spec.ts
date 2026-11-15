// Opt-in memory measurement with synthetic long chats only. The normal browser gate
// runs the functional preview spec; ST_PLAN_BROWSER_SCALE=1 runs this longer measurement.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { card, message, writeStBranchFamily } from "../../server/test/support/stFolder.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
test.skip(process.env.ST_PLAN_BROWSER_SCALE !== "1", "opt-in large preview memory measurement")
test("hundreds of large files retain at most fifty mounted file rows", async ({ page, context }) => {
  test.setTimeout(20 * 60_000)
  const root = mkdtempSync(join(tmpdir(), "rp-preview-browser-scale-"))
  try {
    const folder = join(root, "ST/data/default-user")
    const family = writeStBranchFamily(folder, { branches: 200, messages: 2000, bodyRepeats: 4 })
    mkdirSync(join(folder, "characters"), { recursive: true })
    writeFileSync(join(folder, "characters/Alice.png"), card("Alice", "Synthetic greeting."))
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const { importId } = yield* api.StartStPathImport({ path: root, prefix: "ST/data/default-user/" })
        for (;;) {
          if ((yield* api.GetStImport({ importId })).job.status !== "running") break
          yield* Effect.sleep(100)
        }
      })
    )
    for (const [i, file] of family.files.entries())
      appendFileSync(
        join(folder, file.path),
        "\n" +
          JSON.stringify(message({ name: "Sam", user: true, mes: `A synthetic addition for file ${i}.`, minute: 2001 }))
      )
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/import/st`)
    await page.getByRole("button", { name: "Import ST data again" }).click()
    const cdp = await context.newCDPSession(page)
    await cdp.send("Performance.enable")
    const heap = async () =>
      (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "JSHeapUsedSize")!.value
    const before = await heap()
    const started = Date.now()
    await page.getByLabel("Folder path").fill(join(root, "ST/data"))
    await page.getByRole("button", { name: "Look in this folder" }).click()
    const skipAll = page
      .getByRole("region", { name: "Chats already here" })
      .getByRole("button", { name: "Skip all", exact: true })
    await expect(skipAll).toBeDisabled({ timeout: 120_000 })
    await expect(page.getByRole("button", { name: "Import", exact: true })).toBeEnabled({ timeout: 15 * 60_000 })
    await expect(skipAll).toBeEnabled()
    const rows = page.getByRole("list", { name: "Files for chats already here" }).getByRole("listitem")
    await expect(rows).toHaveCount(50)
    await page.getByRole("button", { name: "Next files", exact: true }).click()
    await expect(rows).toHaveCount(50)
    const after = await heap()
    const measurement = {
      files: family.files.length,
      folderBytes: family.bytes,
      previewMs: Date.now() - started,
      heapBefore: before,
      heapAfter: after,
      heapGrowth: after - before,
      mountedRows: await rows.count()
    }
    console.log("browser preview memory", JSON.stringify(measurement))
    if (process.env.ST_PLAN_BROWSER_OUT)
      writeFileSync(process.env.ST_PLAN_BROWSER_OUT, JSON.stringify(measurement, null, 1))
    expect(after - before).toBeLessThan(128 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
