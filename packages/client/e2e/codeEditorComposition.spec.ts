import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { createServer, type ViteDevServer } from "vite"
import { expectTextBox } from "./support/textbox.ts"

// Isolate controlled-prop interleavings without depending on server draft timing.
const harness = `<!doctype html><html><body>
<div id="root"></div><output id="value"></output><output id="changes">0</output>
<script type="module">
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import CodeEditor from "/src/ui/CodeEditorView.tsx"
const root = createRoot(document.getElementById("root"))
let changes = 0
const render = (value) => {
  document.getElementById("value").textContent = value
  flushSync(() => root.render(createElement(CodeEditor, {
    label: "Composition probe", base: "Original text", value,
    onChange: (next) => {
      document.getElementById("changes").textContent = String(++changes)
      render(next)
    }
  })))
}
window.addEventListener("external-value", (event) => render(event.detail))
render("Original text")
</script></body></html>`

let server: ViteDevServer
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000)
  server = await createServer({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("..", import.meta.url)),
    appType: "custom",
    server: { host: "127.0.0.1", port: 0 },
    // Limit a fallback scan to the probe's imports; normally global setup has pre-bundled them.
    optimizeDeps: { entries: ["src/ui/CodeEditorView.tsx"] }
  })
  // Plugin names enter Vite's dependency-cache hash. Serve the probe without adding a
  // plugin, so it reuses global setup's pre-bundle instead of deleting and rebuilding it.
  server.middlewares.use("/composition.html", (_request, response, next) => {
    void server.transformIndexHtml("/composition.html", harness).then((html) => {
      response.setHeader("Content-Type", "text/html")
      response.end(html)
    }, next)
  })
  await server.listen()
  // Compile the probe before timing composition, as the other Vite-backed specs do.
  const warm = await browser.newPage()
  try {
    await warm.goto(`${server.resolvedUrls!.local[0]}composition.html`)
    await expect(warm.getByRole("textbox", { name: "Composition probe", exact: true })).toBeVisible({
      timeout: 120_000
    })
  } finally {
    await warm.close()
  }
})
test.afterAll(async () => {
  await server?.close()
})

for (const latest of ["Original text日本語", "Latest external text"])
  test(`composition ends with the latest controlled value: ${latest}`, async ({ page }) => {
    await page.goto(`${server.resolvedUrls!.local[0]}composition.html`)
    const box = page.getByRole("textbox", { name: "Composition probe", exact: true })
    await box.focus()
    await box.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, composed: true }))
      const line = element.querySelector(".cm-line")!
      line.textContent = "Original text日本語"
      const range = document.createRange()
      range.selectNodeContents(line)
      range.collapse(false)
      const selection = (element.getRootNode() as ShadowRoot & { getSelection: () => Selection }).getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      element.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertCompositionText",
          data: "日本語",
          isComposing: true,
          bubbles: true,
          composed: true
        })
      )
    })
    await expectTextBox(box, "Original text日本語")
    await expect(page.locator("#value")).toHaveText("Original text日本語")
    expect(
      await box.evaluate(
        (element) =>
          (element as HTMLElement & { cmTile: { root: { view: { composing: boolean } } } }).cmTile.root.view.composing
      )
    ).toBe(true)
    const changes = await page.locator("#changes").textContent()
    for (const value of ["Intermediate external text", latest])
      await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("external-value", { detail })), value)
    await expectTextBox(box, "Original text日本語")
    await box.evaluate((element) =>
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, composed: true }))
    )
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expectTextBox(box, latest)
    await expect(page.locator("#value")).toHaveText(latest)
    await expect(page.locator("#changes")).toHaveText(changes!)
  })
