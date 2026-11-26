import type { UpdateStatus } from "@dreamspan/shared/updates.ts"
import { expect, test, type Page } from "@playwright/test"
import { serverPerFile } from "./support/server.ts"

const server = serverPerFile()
const original = "a".repeat(40)
const target = "b".repeat(40)
const next = "c".repeat(40)
const status: UpdateStatus = {
  state: "idle",
  automaticChecks: true,
  currentCommit: original.slice(0, 12),
  currentBranch: "master",
  branch: "master",
  remoteCommit: target,
  behindCount: 2,
  incoming: [
    { commit: "bbbbbbb", subject: "Improve the server status page" },
    { commit: "abbbbbb", subject: "Keep recent commits visible on smaller screens" }
  ],
  canAutoUpdate: true,
  autoUpdateReason: null,
  lastCheckedAt: 1_800_000_000_000,
  lastError: null
}

const mockUpdates = (
  page: Page,
  getStatus: () => UpdateStatus,
  onCheck = () => {},
  apply?: () => Promise<{ started: true; targetCommit: string }>
) =>
  page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage(async (data) => {
      const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
      if (request?.tag === "CheckForUpdates") onCheck()
      const value =
        request?.tag === "GetUpdateStatus" || request?.tag === "CheckForUpdates"
          ? getStatus()
          : request?.tag === "ApplyServerUpdate" && apply
            ? await apply()
            : undefined
      if (value === undefined) upstream.send(data)
      else socket.send(JSON.stringify({ _tag: "Exit", requestId: request?.id, exit: { _tag: "Success", value } }))
    })
  })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`admin update banner fits and dismisses by commit at ${width} in ${theme}`, async ({ page }) => {
      let current: UpdateStatus =
        width === 390 ? { ...status, canAutoUpdate: false, autoUpdateReason: "dirty_worktree" } : status
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme })
      await mockUpdates(
        page,
        () => current,
        () => {
          current = { ...current, remoteCommit: next, behindCount: 3 }
        }
      )
      await page.goto(`${server().url}/settings/status`)
      const ribbon = page.getByRole("region", { name: "Dreamspan update" })
      await expect(ribbon.getByText("Update available (2 new commits)")).toBeVisible()
      await expect(page.locator("html")).toHaveCSS("color-scheme", theme)
      if (width === 390) {
        await expect(ribbon.getByText("The checkout has local changes.")).toBeVisible()
        await expect(ribbon.getByRole("button", { name: "Copy command" })).toBeVisible()
      } else await expect(ribbon.getByRole("button", { name: "Update & restart" })).toBeEnabled()
      await ribbon.getByText("Incoming commits").click()
      await expect(ribbon.getByText("Improve the server status page")).toBeVisible()
      expect(
        await ribbon.evaluate((ribbon) => {
          const bounds = ribbon.getBoundingClientRect()
          return [
            bounds.left >= 0,
            bounds.right <= innerWidth,
            ribbon.scrollWidth <= ribbon.clientWidth,
            document.documentElement.scrollWidth <= innerWidth
          ]
        })
      ).toEqual([true, true, true, true])

      await ribbon.getByRole("button", { name: "Dismiss update" }).click()
      await expect(ribbon).toHaveCount(0)
      expect(await page.evaluate(() => localStorage.getItem("dreamspan.updateDismissedCommit"))).toBe(target)
      await page.reload()
      await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeVisible()
      await expect(page.getByText("Current commit", { exact: true })).toBeVisible()
      await expect(page.getByText("Improve the server status page")).toBeVisible()
      await expect(ribbon).toHaveCount(0)
      await page.getByRole("button", { name: "Check now" }).click()
      await expect(ribbon.getByText("Update available (3 new commits)")).toBeVisible()
    })

test("reloads the tab when the updated server commit starts answering", async ({ page }) => {
  const build = Promise.withResolvers<void>()
  let runningCommit = original
  await mockUpdates(
    page,
    () => (runningCommit === target ? { ...status, behindCount: 0, canAutoUpdate: false, incoming: [] } : status),
    () => {},
    async () => {
      await build.promise
      return { started: true, targetCommit: target }
    }
  )
  await page.route("**/healthz", (route) =>
    route.fulfill({
      status: 200,
      body: "ok",
      headers: { "x-app-commit": runningCommit.slice(0, 12), "x-client-build": "synthetic-next-build" }
    })
  )
  await page.goto(`${server().url}/settings/status`)
  const ribbon = page.getByRole("region", { name: "Dreamspan update" })
  await ribbon.getByRole("button", { name: "Update & restart" }).click()
  await expect(ribbon.getByRole("button", { name: "Updating…" })).toBeDisabled()
  build.resolve()
  await expect(ribbon.getByRole("button", { name: "Restarting Dreamspan…" })).toBeDisabled()
  const reloaded = page.waitForEvent("load")
  runningCommit = target
  await reloaded
  await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeVisible()
  await expect(ribbon).toHaveCount(0)
})
