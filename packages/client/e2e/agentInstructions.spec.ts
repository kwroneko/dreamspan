// The preset's Agent instructions (DESIGN §7.2, owner 2026-11-17) and This chat's request cap,
// at 1440 and 390 with the layout audit. An imported preset has no Agent instructions: the
// editor says the default is sent and adds them on request. Tools on, This chat offers "Model
// requests per reply", saved for the chat. Nothing is generated; every card is made up.
import { expect, test } from "@playwright/test"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { syntheticPreset } from "./support/syntheticPreset.ts"

const server = serverPerFile(withAdmin)
let cookie: string

const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)

const upload = async (name: string, data: unknown) => {
  const response = await fetch(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    method: "POST",
    headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
    body: JSON.stringify(data)
  })
  expect(response.status).toBe(200)
}

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  await upload("Mira", {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: { name: "Mira", description: "Mira keeps the harbour ledger." }
  })
})

test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

for (const width of [1440, 390]) {
  test(`a preset without Agent instructions adds them, at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    const name = `Imported ${width}`
    await upload(name, syntheticPreset())
    const refId = await admin((api) =>
      Effect.map(api.ListLibrary({ kind: "preset" }), (rows) => rows.find((r) => r.label === name)!.id)
    )
    await page.goto(`${server().url}/library/${refId}`)
    const missing = page.locator("[data-agent-instructions-missing]")
    await expect(missing).toContainText("the app's default text at the very end of the request")
    // Wait for lazy CodeMirror prompt editors above to settle so scrolling/hovering isn't shifted away.
    await expect(page.getByText("Loading editor…")).toHaveCount(0)
    await missing.scrollIntoViewIfNeeded()
    const add = missing.getByRole("button", { name: "Add to preset" })
    await add.hover()
    await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
      "empty so the default is still sent"
    )
    await page.mouse.move(0, 0)
    await expectLayout(page, test.info(), `agent-instructions-missing-${width}`, {
      scope: "[data-agent-instructions-missing]"
    })
    await add.click()
    const block = page.locator('[data-prompt="agentInstructions"]')
    await expect(block).toBeVisible()
    await expect(missing).toHaveCount(0)
    await expect(block).toContainText("Empty: the app's default is sent")
    await expect(block.locator("[data-prompt-kind-tag]").first()).toHaveText("Agent instructions")
    await page.mouse.move(0, 0)
    await expectLayout(page, test.info(), `agent-instructions-added-${width}`, {
      scope: '[data-prompt="agentInstructions"]'
    })
  })

  test(`This chat sets the model requests per reply, at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    const chatId = await admin((api) =>
      Effect.gen(function* () {
        const mira = (yield* api.ListCards()).find((card) => card.name === "Mira")!.entityId as EntityId
        const started = yield* api.StartChat({
          cards: [mira],
          persona: null,
          greeting: null,
          greeters: [],
          first: { _tag: "Send", content: "Evening.", speakerEntityId: null }
        })
        return started.chat.id
      })
    )
    const capOf = () =>
      admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.GetChat({ chatId })
          return (yield* api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId })).requestCap
        })
      )
    let refused = false
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        const request = typeof data === "string" ? JSON.parse(data) : null
        if (refused || request?.tag !== "ChangeCast" || request.payload?.change?._tag !== "RequestCap")
          return upstream.send(data)
        refused = true
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: request.id,
            exit: {
              _tag: "Failure",
              cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Synthetic cap write failure" } }]
            }
          })
        )
      })
    })
    await page.goto(`${server().url}/chats/${chatId}`)
    const settings = await openPanel(page, "This chat")
    const field = () => settings.getByRole("spinbutton", { name: /Model requests per reply/ })
    await expect(field()).toHaveCount(0)
    const tools = settings.getByRole("switch", { name: "Tools", exact: true })
    await tools.scrollIntoViewIfNeeded()
    await tools.click()
    await expect(field()).toHaveValue("12")
    await expect(settings.getByText("At most 12 model requests per reply.")).toBeVisible()
    await field().fill("3")
    await field().blur()
    await expect(settings.getByRole("alert")).toContainText("Tools weren't changed")
    await expect(field()).toHaveValue("3")
    expect((await capOf()) ?? 12).toBe(12)
    const ownerId = (await admin((api) => api.Whoami())).id
    await expect
      .poll(() =>
        admin((api) =>
          api.GetUserDraft({ ownerId, targetId: `request-cap:${chatId}`, field: "Model requests per reply" })
        )
      )
      .toMatchObject({ status: "active", content: "3" })
    await page.reload()
    await openPanel(page, "This chat")
    await expect(field()).toHaveValue("3")
    await field().press("Enter")
    await expect.poll(capOf).toBe(3)
    await expect(settings.getByText("At most 3 model requests per reply.")).toBeVisible()
    await field().fill("0")
    await expect(settings.getByText("A whole number from 1 to 100.")).toBeVisible()
    await field().fill("3")
    await page.mouse.move(0, 0)
    await expectLayout(page, test.info(), `request-cap-${width}`, {
      scope: '[role="tabpanel"][aria-label="This chat"]'
    })
    await page.reload()
    await expect(
      (await openPanel(page, "This chat")).getByRole("spinbutton", { name: /Model requests per reply/ })
    ).toHaveValue("3")
  })
}
