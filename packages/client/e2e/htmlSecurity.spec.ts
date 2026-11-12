// Adversarial synthetic cards, exercised through the real message renderer and frame CSP.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { cleanStyle, scopeCss } from "../src/ui/html/css.ts"
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

// Each style reads differently to a lenient CSS parser and to the browser (bad strings, escaped
// braces, unclosed blocks): before the CSS Syntax tokenizer, the first three became global rules.
test("CSS that parsers read differently stays inside the message", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const hostile = [
    '.a[title="x\n]{}[data-security-probe]{color:rgb(11, 22, 33)!important}body{background:rgb(1, 1, 1)!important}/*"]{color:blue}',
    '@media x"\n{}[data-security-probe]{color:rgb(11, 22, 33)!important}/*"{.a{color:blue}}',
    '.a{color:red}\n.b"\n{}body{background:rgb(1, 1, 1)!important}/*"{color:blue}',
    String.raw`.a { color: red\7d [data-security-probe]\7b color\3a rgb(11, 22, 33) }`,
    ".a{color:red;}<!--}[data-security-probe]{color:rgb(11, 22, 33)!important}-->",
    "@media all{.a{color:red}}}[data-security-probe]{color:rgb(11, 22, 33)!important}"
  ]
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "CSS differentials" })
      yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        reply: false,
        content: [
          ...hostile.map((css) => `<style>${css}</style>`),
          "<style>.legit { color: rgb(4, 5, 6) }</style>",
          '<div class="legit">Card</div>'
        ].join("\n")
      })
      return chat
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}`)
  // The message's own legitimate style applies, so the sheet is in place.
  await expect(page.locator(".custom-legit")).toHaveCSS("color", "rgb(4, 5, 6)")
  await page.evaluate(() => {
    const app = document.createElement("div")
    app.dataset.securityProbe = ""
    app.style.color = "rgb(7, 8, 9)"
    app.textContent = "App outside the message"
    document.querySelector(".message-html")!.after(app)
  })
  await expect(page.locator("[data-security-probe]")).toHaveCSS("color", "rgb(7, 8, 9)")
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(1, 1, 1)")
  // Every top-level rule the browser read from message styles is scoped, or a renamed global.
  const topLevel = await page.evaluate(() =>
    document.adoptedStyleSheets.flatMap((sheet) =>
      Array.from(sheet.cssRules, (rule) => (rule instanceof CSSStyleRule ? rule.selectorText : rule.constructor.name))
    )
  )
  expect(topLevel.length).toBeGreaterThan(0)
  for (const rule of topLevel)
    expect(
      ["CSSScopeRule", "CSSKeyframesRule", "CSSFontFaceRule"].includes(rule) || rule.startsWith(".message-html ")
    ).toBe(true)
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

// A message whose markup the HTML step can't turn into a tree (an SVG `<template>`, which has no
// template contents) shows that markup as text; it doesn't take the chat down with it.
test("markup the HTML step can't convert shows as text, and the chat stays", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Unconvertible markup" })
      yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        reply: false,
        content: 'Lantern **lit** <svg class="x"><template id="t">kept</template></svg>'
      })
      return chat
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}`)
  await expect(page.getByRole("heading", { level: 1, name: "Unconvertible markup" })).toBeVisible()
  const message = page.getByRole("article", { name: "Your message" })
  await expect(message.locator("strong")).toHaveText("lit")
  await expect(message).toContainText('<svg class="x"><template id="t">')
  await expect(message.locator("svg.x, template")).toHaveCount(0)
  expect(errors).toEqual([])
})

// Exercise each containment layer by itself. The scope-only variant deliberately removes
// our selector prefixes; the prefix variant emits no @scope at all.
for (const layer of ["scope", "prefix", "scope-only"] as const)
  test(`CSS parser edge cases and painting stay contained with ${layer}`, async ({ page }) => {
    const payloads = [
      '.a[title="x\n]{}[data-outside]{color:red!important}/*"]{color:blue}',
      '@media x"\r\n{}[data-outside]{color:red!important}/*"{.a{color:blue}}',
      String.raw`.a[title="x\"]{}[data-outside]{color:red!important}/*"]{color:blue}`,
      String.raw`.a\7d [data-outside]\7b color\3a red {color:blue}`,
      ".a\0 {color:red} [data-outside]{color:red!important}",
      ".a\ud800 {color:red} [data-outside]{color:red!important}",
      String.raw`.a\0 {color:red} .a\d800 {color:red}`,
      '.a{background:url("bad\n")} [data-outside]{color:red!important}',
      '.a{background:url(bad"url)} [data-outside]{color:red!important}',
      "<!-- [data-outside]{color:red!important} -->",
      ".a/**/,[data-outside]{color:red!important}",
      ".a{color:red; /*",
      ".a{color:rgb(1,2,3)",
      "@media all{.a{color:red}",
      '@import "https://media.invalid/forbidden";',
      "@namespace x url(https://media.invalid/forbidden);",
      '@charset "utf-8"; [data-outside]{color:red!important}',
      '@property --x {syntax:"<color>";inherits:true;initial-value:red}',
      "@font-face{font-family:Inter;src:url(https://media.invalid/forbidden);unicode-range:U+0-10FFFF}",
      "@layer attack{[data-outside]{color:red!important}}",
      "@container (min-width:0px){[data-outside]{color:red!important}}",
      "@supports (display:block){[data-outside]{color:red!important}}",
      "@scope (body){[data-outside]{color:red!important}}",
      ":root,:host,:scope,:is(body,[data-outside]),:where([data-outside]),:has(.a){color:red!important}",
      "+ [data-outside],~ [data-outside]{color:red!important}",
      ".a{ & + [data-outside]{color:red!important} :is(&,body) [data-outside]{color:red!important}}",
      '.a{--x:"https://media.invalid/forbidden";background:image-set(var(--x));content:attr(data-x);background-image:env(--x,url(https://media.invalid/forbidden))}',
      '.a{--x:url(https://media.invalid/forbidden);background:var(--x);background:image-set("https://media.invalid/forbidden");background:u\\72l(https://media.invalid/forbidden)}',
      ".a{position:fixed;inset:-10000px;z-index:2147483647;background:red!important;transform:scale(100);box-shadow:0 0 0 10000px red}"
    ]
    const mode = layer === "prefix" ? "prefix" : "scope"
    const css =
      payloads.map((input) => scopeCss(input, null, mode).css).join("\n") +
      scopeCss(".ok{color:rgb(4,5,6)}", null, mode).css
    const output = layer === "scope-only" ? css.replaceAll(":scope ", "") : css
    const style = cleanStyle(
      'color:rgb(9,8,7)!important;--x:"https://media.invalid/forbidden";background:image-set(var(--x));background:url(https://media.invalid/forbidden)'
    ).style
    const requests: string[] = []
    page.on("request", (request) => requests.push(request.url()))
    await page.setContent(
      '<div data-outside>Before</div><section class="message-html"><div class="custom-a"></div><div class="custom-ok">Inside</div><div id="inline">Inline</div></section><div data-outside>After</div>'
    )
    await page.evaluate(
      ({ output, style }) => {
        document.body.style.margin = "0"
        document.body.style.color = "rgb(7, 8, 9)"
        document.body.style.background = "rgb(10, 11, 12)"
        document.body.dataset.outside = ""
        for (const element of document.querySelectorAll<HTMLElement>("[data-outside]"))
          element.style.color = "rgb(7, 8, 9)"
        const message = document.querySelector<HTMLElement>(".message-html")!
        Object.assign(message.style, { contain: "layout paint", isolation: "isolate", width: "200px", height: "100px" })
        Object.assign(document.querySelector<HTMLElement>("#inline")!.style, style)
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(output)
        document.adoptedStyleSheets = [sheet]
      },
      { output, style }
    )
    await expect(page.locator(".custom-ok")).toHaveCSS("color", "rgb(4, 5, 6)")
    await expect(page.locator("#inline")).toHaveCSS("color", "rgb(9, 8, 7)")
    for (const element of await page.locator("[data-outside]").all())
      await expect(element).toHaveCSS("color", "rgb(7, 8, 9)")
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(10, 11, 12)")
    expect(await page.evaluate(() => document.elementFromPoint(300, 50)?.closest(".message-html") !== null)).toBe(false)
    expect(requests).toEqual([])
  })
