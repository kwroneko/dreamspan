// The database check on Settings → Server status: rows that point at missing rows when the server
// starts don't stop it; admins see what the check found, at 1440 and 390, light and dark.
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { expect, test } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

test.beforeAll(async () => {
  // Damaged while the server is down, then started on it.
  await server().pause()
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL("./support/orphanPinsWorker.ts", import.meta.url), {
      workerData: { dbPath: join(server().dataDir, "dreamspan.db"), chats: ["synthetic-gone", "synthetic-lost"] }
    })
    worker.once("error", reject)
    worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`))))
  })
  await server().restart()
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the server starts anyway and shows admins what the check found, at ${width} ${theme}`, async ({
      page
    }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/settings/status`)
      await expect(page.getByRole("heading", { name: "Admin diagnostics" })).toBeVisible()
      await expect(page.getByText("Database check", { exact: true })).toBeVisible()
      await expect(page.getByText("2 records point at ones that are missing", { exact: true })).toBeVisible()
      await expect(page.getByText(/^The server started anyway/)).toBeVisible()
      await expect(page.getByRole("listitem").filter({ hasText: "2 in chat_pins, pointing into chats" })).toBeVisible()
      await expectLayout(page, info, `database-check-${width}-${theme}`)
      const dir = process.env.SCREENSHOT_DIR
      if (dir) await page.screenshot({ path: join(dir, `database-check-${width}-${theme}.png`), fullPage: true })
    })
