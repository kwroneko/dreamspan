import { readFileSync, writeFileSync } from "node:fs"
import { expect, type Page, test } from "@playwright/test"
import { layoutAudit } from "./support/layoutAudit.ts"
import { apiLogin, ADMIN, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const source = "{{char}} {{setvar::x::{{user}}}} {{// hidden {{roll::6}}}} {{if::1}}yes{{else}}no{{/if}} {{unknown}}"

const openPreset = async (page: Page, content = source) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const file = JSON.parse(
    readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
  )
  file.prompts.find((p: { identifier: string }) => p.identifier === "main").content = content
  const response = await page.request.post(`${server().url}/library/import?name=highlight.json`, {
    data: Buffer.from(JSON.stringify(file)),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.ok()).toBe(true)
  const ref = (await response.json()).library.ref.id
  await page.goto(`${server().url}/library/${ref}`)
  const editor = page.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
  await expect(editor).toBeVisible()
  return editor
}

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`prompt highlighting and safe version reload ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      let sockets = 0
      let blockedThrough = 0
      let blockedDrafts = 0
      await page.routeWebSocket("**/rpc", (socket) => {
        const id = ++sockets
        const remote = socket.connectToServer()
        socket.onMessage((message) => {
          if (id <= blockedThrough && String(message).includes("SaveEditorDraft")) blockedDrafts++
          else remote.send(message)
        })
      })
      const editor = await openPreset(page)
      await expect(editor.locator(".rp-macro-value").first()).toHaveText("{{char}}")
      await expect(editor.locator(".rp-macro-comment")).toHaveText("{{// hidden {{roll::6}}}}")
      await expect(editor.locator(".rp-macro-directive")).toContainText([
        "{{setvar::x::",
        "{{if::1}}",
        "{{else}}",
        "{{/if}}"
      ])
      expect(
        await editor.evaluate((el) =>
          [...el.querySelectorAll(".rp-macro-value, .rp-macro-directive, .rp-macro-comment")].some((mark) =>
            mark.textContent?.includes("unknown")
          )
        )
      ).toBe(false)
      const colors = await editor
        .locator(".rp-macro-value")
        .first()
        .evaluate((el) => ({ value: getComputedStyle(el).color, text: getComputedStyle(el.parentElement!).color }))
      expect(colors.value).not.toBe(colors.text)
      await page.screenshot({ path: info.outputPath(`highlight-${width}-${theme}.png`) })

      // A deploy is reported by the existing health route. Reconnect the real RPC socket.
      await page.route("**/healthz", async (route) => {
        const response = await route.fetch()
        expect(response.headers()["x-client-build"]).toBeTruthy()
        await route.fulfill({ response, headers: { ...response.headers(), "x-client-build": "next-deployment" } })
      })
      await server().restart()
      const notice = page.getByRole("status", { name: "New version" })
      await expect(notice.getByText("A new version is available.", { exact: true })).toBeVisible({ timeout: 30_000 })
      // Audit only the touched surface; retain full measured findings and a screenshot.
      await page.mouse.move(0, 0)
      const findings = (await layoutAudit(page)).filter(
        (v) =>
          v.selector.includes("#client-version-notice") ||
          v.related?.includes("#client-version-notice") ||
          v.name.includes("Reload")
      )
      await info.attach("version-notice-layout", {
        body: JSON.stringify(findings, null, 2),
        contentType: "application/json"
      })
      expect(findings).toEqual([])
      await notice.screenshot({ path: info.outputPath(`version-${width}-${theme}.png`) })
      // No debounce wait: click Reload immediately after typing, with SaveEditorDraft unavailable.
      // Dark profiles also exercise a draft write that cannot reach the server before reload.
      if (theme === "dark") {
        blockedThrough = sockets
        await page.route("**/library/drafts", (route) => route.abort())
      }
      page.on("dialog", (dialog) => dialog.accept())
      const typed = `Fresh text ${width} ${theme} {{char}}`
      await editor.fill(typed)
      await page.unroute("**/healthz")
      await notice.getByRole("button", { name: "Reload", exact: true }).click()
      await expect(editor).toHaveText(typed)
      await expect(notice).toHaveCount(0)
      if (theme === "dark") expect(blockedDrafts).toBeGreaterThan(0)
    })
  }
}

test("5,000-line prompt decorates the viewport and stays editable at its end", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const text = Array.from({ length: 5000 }, (_, i) => `Line ${i}: {{char}} {{getvar::x}}`).join("\n")
  const editor = await openPreset(page, text)
  await editor.press("ControlOrMeta+End")
  await expect(editor.locator(".rp-macro-value").last()).toBeVisible()
  expect(await editor.locator(".cm-line").count()).toBeLessThan(300)
  // Measure browser work from input through the next animation frame, excluding driver latency.
  await editor.evaluate((el) => {
    const samples: number[] = []
    ;(window as unknown as { highlightInputs: number[] }).highlightInputs = samples
    el.addEventListener("beforeinput", () => {
      const start = performance.now()
      requestAnimationFrame(() => samples.push(performance.now() - start))
    })
  })
  await editor.pressSequentially(" more text", { delay: 30 })
  await expect(editor).toContainText(" more text")
  const samples = await page.evaluate(() => (window as unknown as { highlightInputs: number[] }).highlightInputs)
  writeFileSync(info.outputPath("5000-line-input-ms.json"), JSON.stringify(samples))
  await info.attach("5000-line-input-ms", { body: JSON.stringify(samples), contentType: "application/json" })
  await editor.pressSequentially(" {{user}}")
  await expect(editor.locator(".rp-macro-value").last()).toHaveText("{{user}}")
})
