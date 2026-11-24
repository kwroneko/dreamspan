import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { ADMIN, serverPerFile, withAdmin } from "./support/server.ts"
import { loginCookie, withCookie, type Client } from "./support/rpc.ts"
import { openPanel, closePanel, openSummarySettings } from "./support/panel.ts"
import { chooseCustomServer, chooseDefaultModelIfNone } from "./support/provider.ts"
import { expectTextBox } from "./support/textbox.ts"

const server = serverPerFile(withAdmin)
test.describe.configure({ mode: "serial" })
let cookie = ""
let ownerId: import("@dreamspan/shared/domain.ts").UserId
const api = <A>(use: (client: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  ownerId = await api((client) => Effect.map(client.Whoami(), (user) => user.id))
})
// Fresh browser storage is what these tests need; authentication itself is
// covered elsewhere. Reuse the file's login instead of spending one per device.
const authenticate = async (page: Page) => {
  const at = cookie.indexOf("=")
  await page.context().addCookies([
    {
      name: cookie.slice(0, at),
      value: cookie.slice(at + 1),
      url: server().url,
      httpOnly: true,
      sameSite: "Strict"
    }
  ])
}
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
      await authenticate(page)
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
      await authenticate(other)
      await other.goto(`${server().url}/settings/chats`)
      await expect(other.getByLabel("Summarization instruction", { exact: true })).toHaveValue(prose)
      await context.close()
      await instruction.fill("x")
      await expect.poll(() => draftText("Settings → Chats", "Summarization instruction")).toBe("x")
      // One small button opens undo and the field's history together.
      await page.getByRole("button", { name: "Undo / history", exact: true }).click()
      await expect(page.getByRole("list", { name: "Field undo history", exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Undo field change", exact: true }).click()
      await expect(instruction).toHaveValue(prose)
      await expect(page.getByRole("list", { name: "Field undo history", exact: true })).toBeVisible()
      await page.keyboard.press("Escape")
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
      await openSummarySettings(page)
      const forkBox = page.getByRole("textbox", { name: "This chat's summarization instruction", exact: true })
      await forkBox.fill(`Fork direction ${width} ${theme}`)
      const targetId = `chat:${started.chat.id}:fork:${started.chat.currentForkId}`
      await expect.poll(() => draftText(targetId, "Summarization instruction")).toBe(`Fork direction ${width} ${theme}`)
      await closePanel(page)
      await openSummarySettings(page)
      await expect(forkBox).toHaveText(`Fork direction ${width} ${theme}`)
      await page.getByRole("button", { name: "Undo / history", exact: true }).scrollIntoViewIfNeeded()
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
        .poll(async () => JSON.parse((await draftText(`connection:${connection.id}`, "Settings")) || "{}").baseUrl)
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
      await page.getByRole("button", { name: "Add a stop string", exact: true }).click()
      await page.getByLabel("Stop string 1", { exact: true }).fill("STILL WRITING")
      await expect
        .poll(async () => JSON.parse((await draftText(`model:${model.id}`, "Custom settings")) ?? "{}").name)
        .toBe("Uncommitted model name")
      await page.reload()
      await expect(page.getByRole("dialog", { name: "Edit synthetic", exact: true })).toBeVisible()
      await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Uncommitted model name")
      await expect(page.getByLabel("Stop string 1", { exact: true })).toHaveValue("STILL WRITING")
      await page.getByLabel("Stop string 1", { exact: true }).scrollIntoViewIfNeeded()
      await shot(page, `model-${width}-${theme}`)
      // A new chat's first message is its pending chat's composer draft (draftchats3, f543b0e9d:
      // the old `pending-chat:<card>` user_field keys are read by nothing and filed to the bin).
      await page.goto(`${server().url}/cards/${ref.entityId}/chat`)
      await expect.poll(() => new URL(page.url()).searchParams.get("draft")).not.toBeNull()
      const pendingChat = new URL(page.url()).searchParams.get("draft") as ChatId
      const pendingText = () =>
        api((client) => Effect.map(client.OpenComposer({ chatId: pendingChat, forkId: null }), (d) => d.content))
      const message = page.getByRole("textbox", { name: "Message", exact: true })
      await expect(message).toBeEditable()
      const opening = `Unsent opening ${width} ${theme}`
      await message.fill(opening)
      await expect.poll(pendingText).toBe(opening)
      await page.reload()
      await expectTextBox(message, opening)
      await message.fill("x")
      await expect.poll(pendingText).toBe("x")
      await page.getByRole("button", { name: "Earlier text in this box", exact: true }).click()
      await page
        .getByRole("dialog", { name: "Earlier text" })
        .getByRole("button")
        .filter({ hasText: `${opening.length} characters` })
        .first()
        .click()
      await expectTextBox(message, opening)
      await expect.poll(pendingText).toBe(opening)
      await page.reload()
      await expectTextBox(message, `Unsent opening ${width} ${theme}`)
      await shot(page, `pending-${width}-${theme}`)
      const fresh = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme })
      const device = await fresh.newPage()
      await authenticate(device)
      // The same new chat is its URL (`?draft=`); a bare /cards/<id>/chat draws a fresh one.
      await device.goto(page.url())
      await expectTextBox(
        device.getByRole("textbox", { name: "Message", exact: true }),
        `Unsent opening ${width} ${theme}`
      )
      await device.goto(`${server().url}/chats/${started.chat.id}`)
      await openSummarySettings(device)
      await expect(
        device.getByRole("textbox", { name: "This chat's summarization instruction", exact: true })
      ).toHaveText(`Fork direction ${width} ${theme}`)
      await device.goto(`${server().url}/settings/connections/${connection.id}`)
      await expect(device.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
        `Uncommitted connection ${width}`
      )
      await device.getByRole("button", { name: "Edit synthetic", exact: true }).click()
      await expect(device.getByLabel("Stop string 1", { exact: true })).toHaveValue("STILL WRITING")
      await fresh.close()
    })
  }

for (const scope of ["account", "fork"] as const)
  test(`${scope}: a failed instruction save keeps prose; typing during Save stays a separate draft`, async ({
    page
  }) => {
    let release: (() => void) | undefined
    let fail = true
    let hold = true
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
        if (
          (fail || hold) &&
          request?.tag === (scope === "account" ? "ChangeGenerationDefaults" : "ChangeLcmSettings")
        ) {
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
    await authenticate(page)
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
      await openSummarySettings(page)
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
    hold = false
    release!()
    await expect.poll(() => draftText(targetId, "Summarization instruction")).toBe("Text typed during Save")
    await page.reload()
    if (scope === "fork") {
      await openSummarySettings(page)
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
            client.GetLcmSettings({ chatId: chatId as import("@dreamspan/shared/chat.ts").ChatId, leafSlotId: null }),
            (view) => view.resolved.tail
          )
        )
      ).toBe(`Submitted ${scope} instruction`)
    if (scope === "fork") {
      await page.getByRole("button", { name: "Use account default", exact: true }).click()
      await expect(page.getByRole("link", { name: "the bin, under Recovered text", exact: true })).toBeVisible()
      await expect
        .poll(() =>
          api((client) =>
            Effect.map(
              client.GetUserDraft({ ownerId, targetId, field: "Summarization instruction" }),
              (draft) => draft?.status
            )
          )
        )
        .toBe("discarded")
      expect(
        await api((client) =>
          Effect.map(client.ListRecoveredTexts({ limit: 100, before: null }), (texts) =>
            texts.some((text) => text.content === "Text typed during Save")
          )
        )
      ).toBe(true)
    }
  })

test("creation and rename forms keep non-secret text without copying a typed key", async ({ page }) => {
  await authenticate(page)
  await page.goto(`${server().url}/settings/connections/new`)
  await chooseCustomServer(page)
  await page.getByLabel("Name", { exact: true }).fill("Unfinished connection")
  await page.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:4321/v1")
  await page.getByLabel("API key", { exact: true }).fill("synthetic-secret-never-drafted")
  await expect
    .poll(async () => JSON.parse((await draftText("connection:new", "Settings")) || "{}").baseUrl)
    .toBe("http://127.0.0.1:4321/v1")
  expect(await draftText("connection:new", "Settings")).not.toContain("synthetic-secret")
  await page.reload()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Unfinished connection")
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("")
  await page.getByLabel("API key", { exact: true }).fill("synthetic-key")
  await chooseDefaultModelIfNone(page)
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
        connectionId: connectionId as import("@dreamspan/shared/providers.ts").ConnectionId,
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
    Effect.map(
      client.OpenEditor({ refId: refId as import("@dreamspan/shared/library.ts").RefId }),
      (opened) => opened.ref
    )
  )
  // A lone chat renames in place (Enter renames, Escape keeps the name); the rename dialog,
  // and its draft, is for a chat in a group of several: two chats with the same two characters.
  const companion = await api((client) => client.CreateCard({ label: "Draft companion", name: "Draft companion" }))
  const start = () =>
    api((client) =>
      client.StartChat({
        cards: [ref.entityId, companion.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "A synthetic start", speakerEntityId: null }
      })
    )
  await start()
  const started = await start()
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
  await authenticate(page)
  await page.goto(`${server().url}/settings/connections/new`)
  await page.getByLabel("Name", { exact: true }).fill("Only in this browser until replay")
  await expect.poll(() => refused).toBeGreaterThan(0)
  fail = false
  await page.reload()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Only in this browser until replay")
  await expect
    .poll(async () => JSON.parse((await draftText("connection:new", "Settings")) || "{}").name)
    .toBe("Only in this browser until replay")
})

test("connection settings typed during Save can be saved again on their own acknowledged base", async ({ page }) => {
  let release: (() => void) | undefined
  let hold = true
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string }) : null
      if (hold && request?.tag === "UpdateConnection") {
        release = () => upstream.send(data)
        return
      }
      upstream.send(data)
    })
    upstream.onMessage((data) => socket.send(data))
  })
  const connection = await api((client) =>
    client.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: "Connection save race",
        baseUrl: "http://127.0.0.1:1/v1",
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      }
    })
  )
  await authenticate(page)
  await page.goto(`${server().url}/settings/connections/${connection.id}`)
  const name = page.getByLabel("Name", { exact: true })
  await name.fill("First submitted connection name")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => !!release).toBe(true)
  await name.fill("Connection name typed during Save")
  hold = false
  release!()
  await expect(page.getByRole("heading", { name: "First submitted connection name", exact: true })).toBeVisible()
  await expect(name).toHaveValue("Connection name typed during Save")
  await expect
    .poll(async () => JSON.parse((await draftText(`connection:${connection.id}`, "Settings")) || "{}").rowVersion)
    .toBe(connection.rowVersion + 1)
  await page.reload()
  await expect(name).toHaveValue("Connection name typed during Save")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Connection name typed during Save", exact: true })).toBeVisible()
  await page.reload()
  await expect(name).toHaveValue("Connection name typed during Save")
})

test("a refused draft save leaves the library fork form available for retry and Cancel", async ({ page }) => {
  let fail = true
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
      if (fail && request?.tag === "SaveUserDraft") {
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
  const card = await api((client) => client.CreateCard({ name: "Fork retry fixture", label: "Fork retry fixture" }))
  await authenticate(page)
  await page.goto(`${server().url}/library/${card.id}`)
  await page.getByRole("button", { name: "Fork", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Fork card", exact: true })
  await dialog.getByLabel("Version (shown as subtitle)", { exact: true }).fill("Unfinished fork version")
  await dialog.getByRole("button", { name: "Fork card", exact: true }).click()
  await expect(dialog.getByText("Something failed on the server. The details are in the server's log.")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled()
  await expect(dialog.getByRole("button", { name: "Fork card", exact: true })).toBeEnabled()
  fail = false
  await dialog.getByRole("button", { name: "Fork card", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page).not.toHaveURL(`${server().url}/library/${card.id}`)
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`${width} ${theme}: conflicting instructions stay visible and can be restored`, async ({ page, browser }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme })
      let hold = false
      let release: (() => void) | undefined
      await page.routeWebSocket(/\/rpc$/, (socket) => {
        const upstream = socket.connectToServer()
        socket.onMessage((data) => {
          const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string }) : null
          if (hold && request?.tag === "SaveUserDraft") release = () => upstream.send(data)
          else upstream.send(data)
        })
        upstream.onMessage((data) => socket.send(data))
      })
      await authenticate(page)
      await page.goto(`${server().url}/settings/chats`)
      const box = page.getByLabel("Summarization instruction", { exact: true })
      const local = `Keep the lighthouse keeper's promises, debts and unresolved questions. ${width} ${theme}`
      await box.fill(local)
      await expect.poll(() => draftText("Settings → Chats", "Summarization instruction")).toBe(local)
      const context = await browser.newContext()
      try {
        const device = await context.newPage()
        await authenticate(device)
        await device.goto(`${server().url}/settings/chats`)
        await expect(device.getByLabel("Summarization instruction", { exact: true })).toHaveValue(local)
        // Keep a save on the old observed base in flight. A clean editor now learns
        // the other device's draft immediately, so merely editing afterwards isn't stale.
        hold = true
        await box.fill(`${local} Continued locally.`)
        await expect.poll(() => !!release).toBe(true)
        const other = `Another device's instruction: retain the journey's language and the keeper's voice. ${width} ${theme}`
        await device.getByLabel("Summarization instruction", { exact: true }).fill(other)
        await expect.poll(() => draftText("Settings → Chats", "Summarization instruction")).toBe(other)
        hold = false
        release!()
        await expect(page.getByText(/Another edit from .* is kept in field undo history/)).toBeVisible()
        await box.fill(`${local} Continued locally, once more.`)
        await expect
          .poll(() => draftText("Settings → Chats", "Summarization instruction"))
          .toBe(`${local} Continued locally, once more.`)
        await page.getByText("Preview the other edit", { exact: true }).click()
        await expect(page.locator("pre").filter({ hasText: other })).toBeVisible()
        await page.getByRole("button", { name: "Use the other edit", exact: true }).scrollIntoViewIfNeeded()
        await shot(page, `conflict-${width}-${theme}`)
        await page.getByRole("button", { name: "Use the other edit", exact: true }).click()
        await expect(box).toHaveValue(other)
        await page.getByRole("button", { name: "Save summarization instruction", exact: true }).click()
        await expect(page.getByRole("link", { name: "the bin, under Recovered text", exact: true })).toBeVisible()
      } finally {
        await context.close()
      }
    })
  }
