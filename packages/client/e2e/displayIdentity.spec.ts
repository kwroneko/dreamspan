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
  "Escapes \\*literal\\*, entity &amp;, Unicode 😺, [link](javascript:bad()) and ~~unfinished",
  // Regex scripts (review-adapters2): placement scopes, depth limits, captures, markup output.
  "A masked word, ana@example, depth-old and depth-new, prompt-word, off-word, reply-word.",
  "**masked word** inside _formatting_ and `masked word` in code\n\n```\nmasked word in a block\n```",
  '<div class="card">masked word <b>ana@example</b></div>\n\n<details><summary>masked word</summary>depth-old</details>',
  "Partial **masked word and <span>ana@exam",
  // Very long: under and over the display-regex size limit.
  Array.from({ length: 1500 }, (_, i) => `Line ${i} with a masked word, **bold ${i}** and ana@example.`).join("\n\n"),
  "Over the limit: masked word. " + "long text ".repeat(21_000)
]
const script = (id: string, find_regex: string, replace_string: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  find_regex,
  replace_string,
  trim_strings: [] as string[],
  placement: [1, 2],
  disabled: false,
  markdown_only: true,
  prompt_only: false,
  run_on_edit: false,
  substitute_regex: "none" as const,
  min_depth: null as number | null,
  max_depth: null as number | null,
  ...extra
})
const scripts = [
  script("mask", "/masked word/g", "[hidden]"),
  script("capture", "/(\\w+)@(\\w+)/g", '<span class="tag">$2 at $1</span>'),
  script("old-only", "/depth-old/g", "(old)", { min_depth: 2 }),
  script("new-only", "/depth-new/g", "(new)", { max_depth: 1 }),
  script("prompt-only", "/prompt-word/g", "(prompt)", { markdown_only: false, prompt_only: true }),
  script("off", "/off-word/g", "(off)", { disabled: true }),
  script("reply-only", "/reply-word/g", "(reply)", { placement: [2] }),
  script("names", "/{{user}}/g", "(name)", { substitute_regex: "raw" }),
  script("invalid", "/([unclosed/g", "(never)")
]
for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`independent display corpus ${width} ${theme}`, async ({ browser }, info) => {
      test.skip(!baselineDist, "Set DISPLAY_BASELINE_DIST to an independently built archived client.")
      test.setTimeout(480_000)
      const snapshots: Array<ReadonlyArray<string>> = []
      for (const server of [baseline(), current()]) {
        const made = await asUser(server, ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const regex = yield* api.GetGlobalRegex()
            if (regex.scripts.length === 0) yield* api.SetGlobalRegex({ scripts, expectedRevision: regex.revision })
            const chat = yield* api.CreateChat({ title: "Independent display corpus" })
            const slots: import("@dreamspan/shared/chat.ts").SlotId[] = []
            let parent = null as import("@dreamspan/shared/chat.ts").SlotId | null
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
          // Display scripts answer after the first paint: take the settled rendering.
          let html = await body.innerHTML()
          for (let same = 0; same < 3;) {
            await page.waitForTimeout(300)
            const next = await body.innerHTML()
            same = next === html ? same + 1 : 0
            html = next
          }
          rendered.push(html)
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
