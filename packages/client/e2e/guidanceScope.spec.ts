// Guidance is a composer choice: separate chats/forks, inherited once by a new fork/chat.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { composerChoice } from "./support/composer.ts"
import { loginCookie, withCookie, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let cookie: Promise<string> | undefined
const rpc = <A>(use: (api: Client) => Effect.Effect<A, unknown>) =>
  (cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)).then((value) => withCookie(server(), value, use))

for (const width of [1440, 390])
  for (const theme of ["light", "dark"]) {
    test(`chat and fork switches, pending inheritance (${width} ${theme})`, async ({ page }, info) => {
      const setup = await rpc((api) =>
        Effect.gen(function* () {
          const card = yield* api.CreateCard({ label: "Synthetic scope character", name: "Lantern keeper" })
          const a = yield* api.StartChat({
            cards: [card.entityId],
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "A shared synthetic opening.", speakerEntityId: null },
            guidance: true
          })
          expect(a.composer.guidance).toBe(true)
          const first = a.chat.currentForkId
          yield* api.SendMessage({
            chatId: a.chat.id,
            parentSlotId: a.entry.slotId,
            branch: false,
            content: "Fork A continues."
          })
          const { fork } = yield* api.CreateFork({ chatId: a.chat.id, fromForkId: first, atSlotId: a.entry.slotId })
          yield* api.SendMessage({
            chatId: a.chat.id,
            forkId: fork.id,
            parentSlotId: a.entry.slotId,
            branch: false,
            content: "Fork B continues."
          })
          const source = yield* api.OpenComposer({ chatId: a.chat.id, forkId: first })
          const copy = yield* api.OpenComposer({ chatId: a.chat.id, forkId: fork.id, copyFrom: source.id })
          expect(copy.guidance).toBe(true)
          expect((yield* api.GetComposerChoice({ chatId: a.chat.id, draftId: copy.id })).guidance).toBe(true)
          yield* api.SetComposerChoice({ chatId: a.chat.id, draftId: copy.id, guidance: false })
          const b = yield* api.CreateChat({ title: "Another synthetic chat" })
          return { a: a.chat.id, first, fork: fork.id, b: b.id, card: card.entityId }
        })
      )
      await page.setViewportSize({ width, height: 844 })
      await page.emulateMedia({ colorScheme: theme as "light" | "dark" })
      await page.addInitScript((theme) => localStorage.setItem("dreamspan.theme", theme), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const toggle = page.getByRole("switch", { name: "Guidance", exact: true })
      const box = page.getByTestId("composer")
      const crop = (name: string) => box.locator("xpath=../..").screenshot({ path: info.outputPath(`${name}.png`) })
      await page.goto(`${server().url}/chats/${setup.a}?fork=${setup.first}`)
      await expect(toggle).toBeChecked()
      await expect(toggle).toBeEnabled()
      await info.attach("chat-a-guidance-on", { body: await crop("chat-a-guidance-on"), contentType: "image/png" })
      // Hold the destination choice read: no visible off/on flash while the fork changes.
      let hold = true
      const held: Array<() => void> = []
      await page.routeWebSocket(/\/rpc$/, (socket) => {
        const upstream = socket.connectToServer()
        socket.onMessage((data) => {
          if (hold && typeof data === "string" && JSON.parse(data).tag === "GetComposerChoice")
            held.push(() => upstream.send(data))
          else upstream.send(data)
        })
      })
      // A fresh socket installs the interception; subsequent branch switches stay in the app.
      await page.reload()
      await expect.poll(() => held.length).toBeGreaterThan(0)
      await expect(box).toBeVisible()
      await expect(box).toBeEditable()
      await expect(toggle).toBeChecked()
      hold = false
      for (const release of held.splice(0)) release()
      await expect(toggle).toBeChecked()
      hold = true
      await page.getByRole("button", { name: "Next branch" }).click()
      await expect.poll(() => held.length).toBeGreaterThan(0)
      await expect(box).toBeVisible()
      await expect(box).toBeEditable()
      await expect(toggle).not.toBeChecked()
      hold = false
      for (const release of held.splice(0)) release()
      await expect(toggle).not.toBeChecked()
      await expect(toggle).toBeEnabled()
      await info.attach("fork-b-guidance-off", { body: await crop("fork-b-guidance-off"), contentType: "image/png" })
      await toggle.click()
      await expect.poll(() => rpc((api) => composerChoice(api, setup.a)).then((choice) => choice.guidance)).toBe(true)
      await page.getByRole("button", { name: "Previous branch" }).click()
      await expect(toggle).toBeChecked()
      await page.goto(`${server().url}/chats/${setup.b}`)
      await expect(toggle).not.toBeChecked()
      await expect(toggle).toBeEnabled()
      await info.attach("chat-b-guidance-off", { body: await crop("chat-b-guidance-off"), contentType: "image/png" })
      await page.goto(`${server().url}/chats/${setup.a}?fork=${setup.first}`)
      await expect(toggle).toBeChecked()
      await page.getByRole("button", { name: "Chat actions", exact: true }).click()
      await page.getByRole("menuitem", { name: "New chat with this cast", exact: true }).click()
      await expect(toggle).toBeChecked()
      await expect(box).toHaveAttribute("placeholder", "Guidance for the next message…")
      // With no source composer, a pending chat starts off even though the last chat was on.
      await page.goto(`${server().url}/cards/${setup.card}/chat`)
      await expect(toggle).not.toBeChecked()
      await expect(toggle).toBeEnabled()
      await info.attach("pending-no-source-off", {
        body: await crop("pending-no-source-off"),
        contentType: "image/png"
      })
    })
  }
