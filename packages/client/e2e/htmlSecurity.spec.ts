// Adversarial synthetic cards, exercised through the real message renderer and frame CSP.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

test("card selectors cannot style the app or remove message containment", async ({ page }) => {
  const probes: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("css-variable-probe")) probes.push(request.url())
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "CSS attack" })
      yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        reply: false,
        content: [
          "<style>",
          '.box { --address: "/css-variable-probe"; background-image: image-set(var(--address)) }',
          String.raw`.box { font-family: x\7d html\7b background\3a blue }`,
          String.raw`@font-face { font-family: "\49 nter"; src: local("FreeMono") }`,
          ".box { color: rgb(1, 2, 3); & > span { color: rgb(4, 5, 6) }",
          ":is(&, body) [data-security-probe] { color: rgb(11, 22, 33) !important }",
          ":is(&, body) [class~=markdown-html] { contain: none !important } }",
          "+ [data-security-probe] { color: rgb(11, 22, 33) !important }",
          "</style>",
          '<div class="box">Card <span>nested</span></div>'
        ].join("\n")
      })
      return chat
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}`)
  const box = page.locator(".custom-box")
  await expect(box).toHaveCSS("color", "rgb(1, 2, 3)")
  await expect(box.locator("span").first()).toHaveCSS("color", "rgb(4, 5, 6)")
  await page.evaluate(() => {
    const app = document.createElement("div")
    app.dataset.securityProbe = ""
    app.style.color = "rgb(7, 8, 9)"
    app.textContent = "App outside the message"
    document.querySelector(".message-html")!.after(app)
  })
  await expect(page.locator("[data-security-probe]")).toHaveCSS("color", "rgb(7, 8, 9)")
  await expect(page.locator(".message-html")).toHaveCSS("contain", "layout paint")
  expect(await page.evaluate(() => Array.from(document.fonts, (font) => font.family))).not.toContain("Inter")
  expect(probes).toEqual([])
  await expect(box).toHaveCSS("background-image", "none")
})

test("SVG panel links cannot navigate into an attacker document", async ({ page }) => {
  const requests: string[] = []
  await page.route("http://attacker.invalid/**", async (route) => {
    requests.push(route.request().url())
    await route.fulfill({
      contentType: "text/html",
      body: '<script>parent.postMessage({type:"rp:ready"},"*");addEventListener("message",e=>document.body.textContent=JSON.stringify(e.data))</script>'
    })
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "SVG navigation" })
      yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        reply: false,
        content: [
          "```html",
          "<!doctype html><html><body>",
          '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="250" height="50">',
          '<a xlink:href="http://attacker.invalid/panel"><text x="5" y="30">Open panel link</text></a></svg>',
          '<img src="data:image/png,invalid" onerror="document.body.dataset.ran=1">',
          "<script>document.body.dataset.ran=1</script>",
          "<p>Private synthetic expanded content</p></body></html>",
          "```"
        ].join("\n")
      })
      return chat
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}`)
  const panel = page.frameLocator('iframe[title="Panel"]')
  await expect(panel.locator("p")).toHaveText("Private synthetic expanded content")
  const content = page.frames().find((frame) => frame.url().endsWith("/frame/panel"))!
  expect(await content.evaluate(() => document.body.dataset.ran)).toBeUndefined()
  // Exercise both halves of the protocol with the expected window but a forged origin,
  // and with the expected origin but a different window.
  const height = await page.locator('iframe[title="Panel"]').evaluate((frame) => frame.style.height)
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Panel"]')!
    for (const [source, origin] of [
      [frame.contentWindow, location.origin],
      [window, "null"]
    ] as const)
      dispatchEvent(new MessageEvent("message", { source, origin, data: { type: "rp:height", height: 1 } }))
  })
  expect(await page.locator('iframe[title="Panel"]').evaluate((frame) => frame.style.height)).toBe(height)
  expect(
    await content.evaluate(() => {
      const root = document.documentElement.style
      const before = root.getPropertyValue("--rp-vh")
      for (const [source, origin] of [
        [parent, "https://attacker.invalid"],
        [window, new URL(location.href).origin]
      ] as const)
        dispatchEvent(new MessageEvent("message", { source, origin, data: { type: "rp:vh", vh: 1 } }))
      return root.getPropertyValue("--rp-vh") === before
    })
  ).toBe(true)
  const isolation = await content.evaluate(async (url) => {
    const refused = (read: () => unknown) => {
      try {
        read()
        return false
      } catch {
        return true
      }
    }
    return {
      parent: refused(() => parent.document.body),
      storage: refused(() => localStorage.length),
      cookie: refused(() => document.cookie),
      socket: await new Promise<boolean>((resolve) => {
        try {
          const socket = new WebSocket(url.replace(/^http/, "ws") + "/rpc")
          socket.onerror = () => resolve(true)
          socket.onopen = () => {
            socket.close()
            resolve(false)
          }
        } catch {
          resolve(true)
        }
      }),
      rpc: await fetch(url + "/rpc").then(
        () => false,
        () => true
      )
    }
  }, server().url)
  expect(isolation).toEqual({ parent: true, storage: true, cookie: true, socket: true, rpc: true })
  const deliveries = await content.evaluate(async () => {
    const received: unknown[] = []
    const listen = (event: MessageEvent) => {
      if (event.data?.type === "rp:render") received.push(event.data)
    }
    addEventListener("message", listen)
    parent.postMessage({ type: "rp:ready" }, "*")
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    removeEventListener("message", listen)
    return received.length
  })
  expect(deliveries).toBe(0)
  await panel.locator("text").click()
  // A subsequent event in the same document also checks middle-click navigation.
  await panel.locator("text").click({ button: "middle" })
  await expect(panel.locator("p")).toHaveText("Private synthetic expanded content")
  expect(requests).toEqual([])
})
