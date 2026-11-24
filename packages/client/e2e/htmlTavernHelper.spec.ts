// Panel reads (spec/HTML-MESSAGES.md §3.4 Tier B, `frames.tavernHelper`), in the built app: an
// imported chat's panel in its third message, once its card's scripts run, reads Tavern
// Helper's calls synchronously: its own message id, the messages up to it and never the one
// after (causal order), the chat's variables and the names. It has no write calls, and a
// change to an earlier message reaches it as MESSAGE_UPDATED. Synthetic data only. At 1440 and
// 390, light and dark, with the layout audit.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { card, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser, loginCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const panel = [
  "The board by the hearth.",
  "",
  "```html",
  "<!doctype html>",
  "<html><head><style>body { margin: 0; color: var(--dreamspan-text) } pre { white-space: pre-wrap }</style></head><body>",
  '<div id="panel">Board</div>',
  '<pre id="results"></pre>',
  '<pre id="updates">0</pre>',
  "<script>",
  "const r = {}",
  "r.id = getCurrentMessageId()",
  "r.last = getLastMessageId()",
  "r.messages = getChatMessages('0-99').map((m) => [m.message_id, m.role, m.name, m.message.split('\\n')[0]])",
  "r.tail = getChatMessages(-1).map((m) => m.message_id)",
  "r.users = getChatMessages('0-99', { role: 'user' }).map((m) => m.message_id)",
  "r.vars = getVariables({ type: 'chat' })",
  "r.messageVars = getVariables({ type: 'message' })",
  "r.names = [SillyTavern.getContext().name1, SillyTavern.getContext().name2]",
  "r.writes = [typeof setChatMessages, typeof triggerSlash, typeof replaceVariables]",
  "document.getElementById('results').textContent = JSON.stringify(r)",
  "let updates = 0",
  "eventOn(tavern_events.MESSAGE_UPDATED, (id) => {",
  "  updates++",
  "  document.getElementById('updates').textContent = updates + ':' + id + ':' + getChatMessages(0)[0].is_hidden",
  "})",
  "document.body.dataset.ran = 'yes'",
  "</script></body></html>",
  "```"
].join("\n")

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a panel reads its message, those before it and the chat's variables at ${width} (${theme})`, async ({
      page
    }, info) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const name = `Hearth ${width} ${theme}`
      const title = `Board ${width} ${theme}`
      const cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
      const run = await admin((api) => api.StartStImport({ unsupported: [] }))
      const files = new Map<string, Uint8Array>([
        [`characters/${name}.png`, card(name, "The fire crackles.")],
        [
          `chats/${name}/${title}.jsonl`,
          jsonl([
            header({ variables: { hp: 12, day: 3 } }),
            message({ name, mes: "The fire crackles.", minute: 1 }),
            message({ name: "Sam", user: true, mes: "Evening.", minute: 2 }),
            message({ name, mes: panel, minute: 3 }),
            message({ name: "Sam", user: true, mes: "A later line.", minute: 4 })
          ])
        ]
      ])
      for (const [path, body] of files) {
        const response = await fetch(
          `${server().url}/st-import/file?${new URLSearchParams({ import: run.importId, path })}`,
          {
            method: "POST",
            headers: { cookie, "content-type": "application/octet-stream" },
            body: new Uint8Array(body)
          }
        )
        expect(response.status).toBe(200)
      }
      await admin((api) => api.FinishStImport({ importId: run.importId, notSent: [] }))
      const chat = await admin((api) =>
        Effect.map(api.ListChats({ limit: 100, before: null }), (chats) => chats.find((c) => c.title === title)!)
      )
      const first = await admin((api) =>
        Effect.map(
          api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 }),
          (window) => window.entries[0]!.slotId
        )
      )
      const delayReads = width === 1440 && theme === "light"
      let holdNext = delayReads
      let held: string | undefined
      let deliver: (() => void) | undefined
      if (delayReads)
        await page.routeWebSocket("**/rpc", (socket) => {
          const peer = socket.connectToServer()
          socket.onMessage((message) => {
            const request = JSON.parse(String(message)) as { tag?: string; id?: string }
            if (holdNext && request.tag === "GetPanelData") {
              holdNext = false
              held = request.id
            }
            peer.send(message)
          })
          peer.onMessage((message) => {
            const response = JSON.parse(String(message)) as { requestId?: string }
            if (held !== undefined && response.requestId === held) {
              deliver = () => socket.send(message)
              held = undefined
            } else socket.send(message)
          })
        })
      await page.goto(`${server().url}/chats/${chat.id}`)
      const article = page.locator("article", { hasText: "The board by the hearth." })
      const inside = article.frameLocator('iframe[title="Panel"]')
      const firstMessage = page.locator(`article[data-slot="${first}"]`)
      const setHidden = (hidden: boolean) => admin((api) => api.SetMessageHidden({ slotId: first, hidden }))
      await expect(inside.locator("#panel")).toHaveText("Board", { timeout: 60_000 })
      // Scripts off: nothing read, nothing run.
      await expect(inside.locator("#results")).toHaveText("")
      await article.getByRole("button", { name: `Run scripts from ${name}`, exact: true }).click()
      const confirm = page.getByRole("alertdialog")
      await expect(confirm).toContainText("can read their message, the ones before it and the chat's variables")
      await confirm.getByRole("button", { name: "Run scripts", exact: true }).click()
      if (delayReads) {
        await expect.poll(() => deliver !== undefined).toBe(true)
        await setHidden(true)
        await expect(firstMessage).toHaveAttribute("data-hidden", "true")
        // Let the 300 ms debounce expire before delivering the initial snapshot.
        await page.waitForTimeout(500)
        deliver!()
      }
      await expect(inside.locator("body")).toHaveAttribute("data-ran", "yes", { timeout: 30_000 })
      const results = JSON.parse((await inside.locator("#results").textContent()) ?? "{}") as Record<string, unknown>
      expect(results).toEqual({
        id: 2,
        last: 2,
        messages: [
          [0, "assistant", name, "The fire crackles."],
          [1, "user", "User", "Evening."],
          [2, "assistant", name, "The board by the hearth."]
        ],
        tail: [2],
        users: [1],
        vars: { hp: 12, day: 3 },
        messageVars: {},
        // No persona in the import: the user is "User", as the chat shows.
        names: ["User", name],
        writes: ["undefined", "undefined", "undefined"]
      })
      await expectLayout(page, info, `html-tavern-${width}-${theme}`, { scope: "[data-testid=messages]" })

      // A change before it reaches it: the first message hidden from the model.
      if (!delayReads) await setHidden(true)
      await expect(inside.locator("#updates")).toHaveText("1:2:true", { timeout: 30_000 })
      if (delayReads) {
        deliver = undefined
        holdNext = true
        await setHidden(false)
        await expect.poll(() => deliver !== undefined).toBe(true)
        await setHidden(true)
        await expect(firstMessage).toHaveAttribute("data-hidden", "true")
        // The second invalidation outlives the debounce while the earlier snapshot is in flight.
        await page.waitForTimeout(500)
        deliver!()
        await expect(inside.locator("#updates")).toHaveText("3:2:true")
      }
    })
