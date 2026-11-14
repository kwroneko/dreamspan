// Independent renderer identity proof. The baseline is built from an archived
// revision, with its own workspace links; it never imports candidate source.
import { test, expect } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
const baselineDist = process.env.DISPLAY_BASELINE_DIST
const current = serverPerFile(withAdmin)
const baseline = serverPerFile({ ...withAdmin, ...(baselineDist ? { CLIENT_DIST: baselineDist } : {}) })
const corpus = [
  "**outer _inner ~~strike~~_** and `**literal**` with {{user}}.",
  "```html\n<script>globalThis.contentExecuted=1</script>\n<div onclick='bad()'>literal</div>\n```\n\n    indented code",
  '<div class="card"><b>Nested <i>HTML</i></b><img src="x" onerror="globalThis.contentExecuted=1"></div>',
  "Streaming **partial _nested",
  "```js\nconst partial = '<script>'",
  "<div><b>partial HTML",
  "Quotes: “outer ‘inner’”\n\n> **quoted**\n> - nested list\n\n1. one\n2. two",
  "Escapes \\*literal\\*, entity &amp;, Unicode 😺, [link](javascript:bad()) and ~~unfinished"
]
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`independent display corpus ${width} ${theme}`, async ({ browser }, info) => {
      test.skip(!baselineDist, "Set DISPLAY_BASELINE_DIST to an independently built archived client.")
      const snapshots: Array<ReadonlyArray<string>> = []
      for (const server of [baseline(), current()]) {
        const made = await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const chat = yield* api.CreateChat({ title: "Independent display corpus" })
            const slots: import("@rp/shared/chat.ts").SlotId[] = []
            let parent = null as import("@rp/shared/chat.ts").SlotId | null
            for (const content of corpus) {
              const sent = yield* api.SendMessage({ chatId: chat.id, parentSlotId: parent, branch: false, content })
              if (sent._tag !== "Posted") throw new Error("Unexpected queue")
              slots.push(sent.entry.slotId)
              parent = sent.entry.slotId
            }
            return { chat, slots }
          })
        )
        const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme })
        const page = await context.newPage()
        await apiLogin(page.request, server, ADMIN.handle, ADMIN.password)
        const rendered: string[] = []
        for (const slot of made.slots) {
          await page.goto(`${server.url}/chats/${made.chat.id}?slot=${slot}`)
          const body = page.locator(`article[data-slot="${slot}"] .markdown`).first()
          await expect(body.locator("[data-source-map]").first()).toBeAttached()
          rendered.push(await body.innerHTML())
        }
        snapshots.push(rendered)
        expect(
          await page.evaluate(() => (globalThis as unknown as { contentExecuted?: number }).contentExecuted)
        ).toBeUndefined()
        await context.close()
      }
      expect(snapshots[1]).toEqual(snapshots[0])
      await info.attach("identical-rendered-corpus", {
        body: JSON.stringify(snapshots),
        contentType: "application/json"
      })
    })
