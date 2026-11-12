import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { createServer, type ViteDevServer } from "vite"
import { expectLayout } from "./support/layoutAudit.ts"

// A registered renderer can fail in render or an effect. Its plain-text fallback must be
// usable at message widths, and must not parse the text as HTML or lose adjacent messages.
const harness = `<!doctype html><html><body><main id="root" class="p-4"></main>
<script type="module">
import "/src/styles.css"
import { createElement, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { Markdown, messageRenderers } from "/src/ui/Markdown.tsx"
messageRenderers.register({id:"synthetic",order:100,component:({text})=>{
  useEffect(()=>{ if(text === "Effect failure") throw Error("synthetic effect failure") },[text])
  if(text.includes("<img")) throw Error("synthetic renderer failure")
  return createElement("strong",null,text)
}})
const root=createRoot(document.getElementById("root"),{onCaughtError:()=>{}})
const render=(text)=>root.render(createElement("div",{className:"flex flex-col gap-4"},
  createElement("article",{"aria-label":"Failed message"},createElement(Markdown,{text,streaming:false})),
  createElement("article",{"aria-label":"Next message"},createElement(Markdown,{text:"Neighbour is readable",streaming:false}))))
addEventListener("render-text",e=>render(e.detail))
render('<img src="/should-not-load" onerror="alert(1)">')
</script></body></html>`
let server: ViteDevServer

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await createServer({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("..", import.meta.url)),
    appType: "custom",
    server: { host: "127.0.0.1", port: 0 }
  })
  server.middlewares.use("/boundary.html", (_request, response, next) => {
    void server.transformIndexHtml("/boundary.html", harness).then((html) => {
      response.setHeader("Content-Type", "text/html")
      response.end(html)
    }, next)
  })
  await server.listen()
})
test.afterAll(async () => server?.close())

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a failed message stays readable at ${width} in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      const requests: string[] = []
      page.on("request", (request) => {
        if (request.url().includes("should-not-load")) requests.push(request.url())
      })
      await page.goto(`${server.resolvedUrls!.local[0]}boundary.html`)
      const failed = page.getByRole("article", { name: "Failed message" })
      await expect(failed).toHaveText('<img src="/should-not-load" onerror="alert(1)">')
      await expect(failed.locator("img")).toHaveCount(0)
      await expect(page.getByRole("article", { name: "Next message" }).locator("strong")).toHaveText(
        "Neighbour is readable"
      )
      await expectLayout(page, info, `message-fallback-${width}-${theme}`)
      await page.evaluate(() => dispatchEvent(new CustomEvent("render-text", { detail: "Effect failure" })))
      await expect(failed.locator(".markdown")).toHaveText("Effect failure")
      await page.evaluate(() => dispatchEvent(new CustomEvent("render-text", { detail: "Recovered" })))
      await expect(failed.locator("strong")).toHaveText("Recovered")
      expect(requests).toEqual([])
    })
