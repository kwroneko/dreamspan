import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { loginCookie, withCookie, type Client } from "./support/rpc.ts"
import { openPanel, closePanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)
test.describe.configure({ mode: "serial" })
let cookie = ""
let ownerId: import("@rp/shared/domain.ts").UserId
const api = <A>(use: (client: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  ownerId = await api((client) => Effect.map(client.Whoami(), (user) => user.id))
})
const draftText = (targetId: string, field: string) =>
  api((client) => Effect.map(client.GetUserDraft({ ownerId, targetId, field }), (draft) => draft?.content))
const shots = process.env.SCREENSHOT_DIR
async function shot(page: Page, name: string) {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false })
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`${width} ${theme}: instructions, settings and pending prose survive a fresh device`, async ({
      page,
      browser
    }) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/settings/chats`)
      const instruction = page.getByLabel("Summarization instruction", { exact: true })
      const prose = `Summary direction ${width} ${theme}: preserve the lighthouse keeper's promises.`
      await instruction.fill(prose)
      await expect.poll(() => draftText("Settings → Chats", "Summarization instruction")).toBe(prose)
      await page.reload()
      await expect(instruction).toHaveValue(prose)
      await instruction.scrollIntoViewIfNeeded()
      await shot(page, `account-${width}-${theme}`)
      // Another device has no IndexedDB copies at all.
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme })
      const other = await context.newPage()
      await apiLogin(other.request, server(), ADMIN.handle, ADMIN.password)
      await other.goto(`${server().url}/settings/chats`)
      await expect(other.getByLabel("Summarization instruction", { exact: true })).toHaveValue(prose)
      await context.close()
      await instruction.fill("x")
      await expect.poll(() => draftText("Settings → Chats", "Summarization instruction")).toBe("x")
      await page.getByRole("button", { name: "Undo field change", exact: true }).click()
      await expect(instruction).toHaveValue(prose)
      await page.getByRole("button", { name: "Field undo history", exact: true }).click()
      await expect(page.getByRole("list", { name: "Field undo history", exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Save summarization instruction", exact: true }).click()
      await expect(page.getByRole("list", { name: "Field undo history", exact: true })).toHaveCount(0)
      await expect
        .poll(() =>
          api((client) =>
            Effect.map(
              client.GetUserDraft({ ownerId, targetId: "Settings → Chats", field: "Summarization instruction" }),
              (draft) => draft?.status
            )
          )
        )
        .toBe("committed")

      const ref = await api((client) =>
        client.CreateCard({ label: `Draft fixture ${width} ${theme}`, name: `Keeper ${width} ${theme}` })
      )
      const started = await api((client) =>
        client.StartChat({
          cards: [ref.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "A synthetic opening.", speakerEntityId: null }
        })
      )
      await page.goto(`${server().url}/chats/${started.chat.id}`)
      await openPanel(page, "This chat")
      const forkBox = page.getByRole("textbox", { name: "This chat's summarization instruction", exact: true })
      await forkBox.fill(`Fork direction ${width} ${theme}`)
      const targetId = `chat:${started.chat.id}:fork:${started.chat.currentForkId}`
      await expect.poll(() => draftText(targetId, "Summarization instruction")).toBe(`Fork direction ${width} ${theme}`)
      await closePanel(page)
      await openPanel(page, "This chat")
      await expect(forkBox).toHaveText(`Fork direction ${width} ${theme}`)
      await page.getByRole("button", { name: "Field undo history", exact: true }).scrollIntoViewIfNeeded()
      await shot(page, `fork-${width}-${theme}`)

      const connection = await api((client) =>
        client.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Synthetic local",
            baseUrl: "http://127.0.0.1:1/v1",
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
      )
      await page.goto(`${server().url}/settings/connections/${connection.id}`)
      await page.getByRole("textbox", { name: "Name", exact: true }).fill(`Uncommitted connection ${width}`)
      await page.getByRole("textbox", { name: "Base URL", exact: true }).fill("http://127.0.0.1:9876/v1")
      await expect
        .poll(async () => JSON.parse((await draftText(`connection:${connection.id}`, "Settings")) ?? "{}").baseUrl)
        .toBe("http://127.0.0.1:9876/v1")
      await page.reload()
      await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
        `Uncommitted connection ${width}`
      )
      await shot(page, `connection-${width}-${theme}`)
      const model = await api((client) =>
        client.AddUserModel({ connectionId: connection.id, key: "synthetic", overrides: {} })
      )
      await page.reload()
      await page.getByRole("button", { name: "Edit synthetic", exact: true }).click()
      await page.getByLabel("Display name", { exact: true }).fill("Uncommitted model name")
      await page.getByLabel("Advanced model settings (JSON)", { exact: true }).fill('{"stop":["STILL WRITING"')
      await expect
        .poll(async () => JSON.parse((await draftText(`model:${model.id}`, "Custom settings")) ?? "{}").name)
        .toBe("Uncommitted model name")
      await page.reload()
      await page.getByRole("button", { name: "Edit synthetic", exact: true }).click()
      await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Uncommitted model name")
      await expect(page.getByLabel("Advanced model settings (JSON)", { exact: true })).toHaveValue(
        '{"stop":["STILL WRITING"'
      )
      await page.getByLabel("Advanced model settings (JSON)", { exact: true }).scrollIntoViewIfNeeded()
      await shot(page, `model-${width}-${theme}`)
      await page.goto(`${server().url}/cards/${ref.entityId}/chat`)
      const message = page.getByRole("textbox", { name: "Message", exact: true })
      await message.fill(`Unsent opening ${width} ${theme}`)
      await expect
        .poll(() => draftText(`pending-chat:${ref.entityId}`, "First message"))
        .toBe(`Unsent opening ${width} ${theme}`)
      await page.reload()
      await expect(message).toHaveValue(`Unsent opening ${width} ${theme}`)
      await message.fill("x")
      await expect.poll(() => draftText(`pending-chat:${ref.entityId}`, "First message")).toBe("x")
      await page.getByRole("button", { name: "Undo field change", exact: true }).click()
      await expect(message).toHaveValue(`Unsent opening ${width} ${theme}`)
      await page.reload()
      await expect(message).toHaveValue(`Unsent opening ${width} ${theme}`)
      await shot(page, `pending-${width}-${theme}`)
      const fresh = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme })
      const device = await fresh.newPage()
      await apiLogin(device.request, server(), ADMIN.handle, ADMIN.password)
      await device.goto(`${server().url}/cards/${ref.entityId}/chat`)
      await expect(device.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(
        `Unsent opening ${width} ${theme}`
      )
      await device.goto(`${server().url}/chats/${started.chat.id}`)
      await openPanel(device, "This chat")
      await expect(
        device.getByRole("textbox", { name: "This chat's summarization instruction", exact: true })
      ).toHaveText(`Fork direction ${width} ${theme}`)
      await device.goto(`${server().url}/settings/connections/${connection.id}`)
      await expect(device.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
        `Uncommitted connection ${width}`
      )
      await device.getByRole("button", { name: "Edit synthetic", exact: true }).click()
      await expect(device.getByLabel("Advanced model settings (JSON)", { exact: true })).toHaveValue(
        '{"stop":["STILL WRITING"'
      )
      await fresh.close()
    })
  }

for (const scope of ["account", "fork"] as const)
  test(`${scope}: a failed instruction save keeps prose; typing during Save stays a separate draft`, async ({
    page
  }) => {
    let release: (() => void) | undefined
    let fail = true
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
        if (request?.tag === (scope === "account" ? "ChangeGenerationDefaults" : "ChangeLcmSettings")) {
          if (fail) {
            socket.send(
              JSON.stringify({
                _tag: "Exit",
                requestId: request.id,
                exit: {
                  _tag: "Failure",
                  cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Synthetic refusal" } }]
                }
              })
            )
          } else release = () => upstream.send(data)
          return
        }
        upstream.send(data)
      })
      upstream.onMessage((data) => socket.send(data))
    })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    let targetId = "Settings → Chats"
    let chatId = ""
    if (scope === "fork") {
      const ref = await api((client) => client.CreateCard({ label: "Race keeper", name: "Race keeper" }))
      const started = await api((client) =>
        client.StartChat({
          cards: [ref.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "Synthetic opening", speakerEntityId: null }
        })
      )
      chatId = started.chat.id
      targetId = `chat:${chatId}:fork:${started.chat.currentForkId}`
      await page.goto(`${server().url}/chats/${chatId}`)
      await openPanel(page, "This chat")
    } else await page.goto(`${server().url}/settings/chats`)
    const box =
      scope === "account"
        ? page.getByLabel("Summarization instruction", { exact: true })
        : page.getByRole("textbox", { name: "This chat's summarization instruction", exact: true })
    const saveButton = page.getByRole("button", {
      name: scope === "account" ? "Save summarization instruction" : "Save instruction",
      exact: true
    })
    await box.fill("Instruction whose save fails")
    await saveButton.click()
    await expect(page.getByText("Something failed on the server. The details are in the server's log.")).toBeVisible()
    if (scope === "account") await expect(box).toHaveValue("Instruction whose save fails")
    else await expect(box).toHaveText("Instruction whose save fails")
    fail = false
    await box.fill(`Submitted ${scope} instruction`)
    await saveButton.click()
    await expect.poll(() => !!release).toBe(true)
    await box.fill("Text typed during Save")
    release!()
    await expect.poll(() => draftText(targetId, "Summarization instruction")).toBe("Text typed during Save")
    await page.reload()
    if (scope === "fork") {
      await openPanel(page, "This chat")
      await expect(box).toHaveText("Text typed during Save")
    } else await expect(box).toHaveValue("Text typed during Save")
    if (scope === "account")
      expect(await api((client) => Effect.map(client.GetGenerationDefaults(), (defaults) => defaults.lcm?.tail))).toBe(
        `Submitted ${scope} instruction`
      )
    else
      expect(
        await api((client) =>
          Effect.map(
            client.GetLcmSettings({ chatId: chatId as import("@rp/shared/chat.ts").ChatId, leafSlotId: null }),
            (view) => view.resolved.tail
          )
        )
      ).toBe(`Submitted ${scope} instruction`)
  })

test("creation and rename forms keep non-secret text without copying a typed key", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/new`)
  await page.getByLabel("Name", { exact: true }).fill("Unfinished connection")
  await page.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:4321/v1")
  await page.getByLabel("Key", { exact: true }).fill("synthetic-secret-never-drafted")
  await expect
    .poll(async () => JSON.parse((await draftText("connection:new", "Settings")) ?? "{}").baseUrl)
    .toBe("http://127.0.0.1:4321/v1")
  expect(await draftText("connection:new", "Settings")).not.toContain("synthetic-secret")
  await page.reload()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Unfinished connection")
  await expect(page.getByLabel("Key", { exact: true })).toHaveValue("")
  await page.getByLabel("Key", { exact: true }).fill("synthetic-key")
  await page.getByRole("button", { name: "Create connection", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Unfinished connection", exact: true })).toBeVisible()
  const connectionId = new URL(page.url()).pathname.split("/").at(-1)!
  await page.getByRole("button", { name: "Add a model", exact: true }).click()
  await page.getByLabel("Model id", { exact: true }).fill("unfinished-model")
  await expect.poll(() => draftText(`connection:${connectionId}`, "New model id")).toBe("unfinished-model")
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click()
  await page.reload()
  await page.getByRole("button", { name: "Add a model", exact: true }).click()
  await expect(page.getByLabel("Model id", { exact: true })).toHaveValue("unfinished-model")
  await page.getByRole("dialog").getByRole("button", { name: "Add model", exact: true }).click()
  await expect(page.getByRole("button", { name: "Edit unfinished-model", exact: true })).toBeVisible()
  // The embedded model editor stays mounted after Save: its committed base must advance.
  const model = await api((client) =>
    Effect.map(
      client.ListModels({
        connectionId: connectionId as import("@rp/shared/providers.ts").ConnectionId,
        includeHidden: true
      }),
      (models) => models.find((model) => model.key === "unfinished-model")!
    )
  )
  await api((client) =>
    client.ChangeGenerationDefaults({ change: { model: { connection: model.connectionId, model: model.id } } })
  )
  const empty = await api((client) => client.CreateChat({ title: "Inline settings fixture" }))
  await page.goto(`${server().url}/chats/${empty.id}`)
  await openPanel(page, "Model")
  const displayName = page.getByLabel("Display name", { exact: true })
  for (const name of ["First own model save", "Second own model save"]) {
    await displayName.fill(name)
    await page.getByRole("button", { name: "Save model settings", exact: true }).click()
    await expect
      .poll(() =>
        api((client) =>
          Effect.map(
            client.ListModels({ connectionId: model.connectionId, includeHidden: true }),
            (models) => models.find((entry) => entry.id === model.id)?.overrides.name
          )
        )
      )
      .toBe(name)
    await expect(displayName).toHaveValue(name)
  }

  const latest = await api((client) =>
    Effect.map(client.ListModels({ connectionId: model.connectionId, includeHidden: true }), (models) =>
      models.find((entry) => entry.id === model.id)!
    )
  )
  await api((client) =>
    client.EditModel({
      modelId: model.id,
      expectedRowVersion: latest.rowVersion,
      overrides: { name: "Other tab's model name" }
    })
  )
  await displayName.fill("Local edit after another tab saved")
  await page.getByRole("button", { name: "Save model settings", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("changed since you opened it")
  await page.getByRole("button", { name: "Load the latest", exact: true }).click()
  await expect(displayName).toHaveValue("Other tab's model name")

  await page.goto(`${server().url}/library`)
  await page.getByRole("button", { name: "New card", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "New card", exact: true })
  await dialog.getByLabel("Display name", { exact: true }).fill("Unfinished keeper")
  await expect
    .poll(async () => JSON.parse((await draftText("card:new", "Names")) ?? "{}").name)
    .toBe("Unfinished keeper")
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.reload()
  await page.getByRole("button", { name: "New card", exact: true }).click()
  await expect(dialog.getByLabel("Display name", { exact: true })).toHaveValue("Unfinished keeper")
  await dialog.getByRole("button", { name: "Create", exact: true }).click()
  await expect(page).toHaveURL(/\/library\//)
  await expect
    .poll(() =>
      api((client) =>
        Effect.map(client.GetUserDraft({ ownerId, targetId: "card:new", field: "Names" }), (draft) => draft?.status)
      )
    )
    .toBe("committed")
  const refId = new URL(page.url()).pathname.split("/").at(-1)!
  const ref = await api((client) =>
    Effect.map(client.OpenEditor({ refId: refId as import("@rp/shared/library.ts").RefId }), (opened) => opened.ref)
  )
  const started = await api((client) =>
    client.StartChat({
      cards: [ref.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "A synthetic start", speakerEntityId: null }
    })
  )
  await page.goto(`${server().url}/chats/${started.chat.id}`)
  await page.getByRole("heading", { level: 1 }).getByRole("button").click()
  const rename = page.getByRole("dialog", { name: "Rename chat", exact: true })
  await rename.getByLabel("Name", { exact: true }).fill("Unfinished chat name")
  await expect.poll(() => draftText(`chat:${started.chat.id}:rename`, "Name")).toBe("Unfinished chat name")
  await rename.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.reload()
  await page.getByRole("heading", { level: 1 }).getByRole("button").click()
  await expect(rename.getByLabel("Name", { exact: true })).toHaveValue("Unfinished chat name")
  await rename.getByRole("button", { name: "Rename", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Unfinished chat name")
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat", { exact: true }).fill("An unfinished empty chat")
  await expect.poll(() => draftText("chat:new", "Title")).toBe("An unfinished empty chat")
  await page.reload()
  await expect(page.getByLabel("Title of the new chat", { exact: true })).toHaveValue("An unfinished empty chat")
})

test("a refused server draft and interrupted closing save replay the browser copy after reload", async ({ page }) => {
  let fail = true
  let refused = 0
  await page.route("**/library/drafts", (route) => route.abort())
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
      if (fail && request?.tag === "SaveUserDraft") {
        refused++
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: request.id,
            exit: {
              _tag: "Failure",
              cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Draft refused" } }]
            }
          })
        )
        return
      }
      upstream.send(data)
    })
    upstream.onMessage((data) => socket.send(data))
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/new`)
  await page.getByLabel("Name", { exact: true }).fill("Only in this browser until replay")
  await expect.poll(() => refused).toBeGreaterThan(0)
  fail = false
  await page.reload()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Only in this browser until replay")
  await expect
    .poll(async () => JSON.parse((await draftText("connection:new", "Settings")) ?? "{}").name)
    .toBe("Only in this browser until replay")
})
