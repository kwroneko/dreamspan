// The request inspector on a realistic synthetic chat (DESIGN §7.4, ARCHITECTURE §15): a preset
// with conditioned prompts, two cast cards and a persona, notes (one on another card's turn, so
// not sent), a lorebook entry its keyword hits, a summary standing in for the oldest messages,
// and a swipe. Each turn is its own block; each part a box naming what it is and where it came
// from. At 1440 and 390, light and dark, with screenshots outside the repository
// (SCREENSHOT_DIR). Every name and text is made up; the provider is a fake on loopback.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ChatId, EntityId, PathEntry, VersionId } from "@dreamspan/shared/chat.ts"
import { valueField } from "@dreamspan/shared/editing.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { type FakeProvider, startProvider } from "./support/provider.ts"
import { asUser } from "./support/rpc.ts"
import { showActions } from "./support/message.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { level1 } from "./support/summaries.ts"
import { scrollPane } from "./support/scrollPane.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
let provider: FakeProvider
let made: { readonly id: ChatId; readonly reply: VersionId; readonly swipe: VersionId }

/** Imports a file into the library as the admin, as the import screen does; returns its ref. */
const importFile = async (name: string, file: unknown): Promise<RefId> => {
  const login = await fetch(`${server().url}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ADMIN)
  })
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!
  const imported = await fetch(`${server().url}/library/import?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { origin: server().url, cookie, "content-type": "application/octet-stream" },
    body: JSON.stringify(file)
  })
  expect(imported.status).toBe(200)
  return ((await imported.json()) as { library: { ref: { id: RefId } } }).library.ref.id
}

const card = (name: string, data: Record<string, string>) => ({
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: { name, ...data }
})

/** ST's default preset with a narrator's Main and prompts its triggers limit to some turns. */
const preset = () => {
  const base = JSON.parse(
    readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
  ) as Record<string, unknown>
  const own = [
    {
      identifier: "quay-impersonation-style",
      name: "Impersonation style",
      role: "system",
      content: "Match {{user}}'s voice from their earlier messages: short, wry, first person.",
      system_prompt: false,
      injection_trigger: ["impersonate"]
    },
    {
      identifier: "quay-reply-length",
      name: "Reply length",
      role: "system",
      content: "Keep replies to two or three paragraphs; end on something {{user}} can answer.",
      system_prompt: false,
      injection_trigger: ["normal", "swipe"]
    }
  ]
  const orders = base.prompt_order as Array<{ character_id: number; order: Array<Record<string, unknown>> }>
  return {
    ...base,
    name: "Quay Nights",
    openai_max_context: 32_000,
    openai_max_tokens: 600,
    prompts: [
      ...(base.prompts as Array<Record<string, unknown>>).map((p) =>
        p.identifier === "main"
          ? {
              ...p,
              content:
                "You are the narrator of a group roleplay with {{user}}. Write grounded, sensory prose.\nNever write dialogue or actions for {{user}}."
            }
          : p
      ),
      ...own
    ],
    prompt_order: orders.map((o) =>
      o.character_id === 100001
        ? { ...o, order: [...o.order, ...own.map((p) => ({ identifier: p.identifier, enabled: true }))] }
        : o
    )
  }
}

/** A note's fields set as one saved revision, as the editor saves it. */
const setFields = (refId: RefId, fields: Record<string, unknown>) =>
  admin((api) =>
    Effect.gen(function* () {
      const opened = yield* api.OpenEditor({ refId })
      const drafts = []
      for (const [key, value] of Object.entries(fields)) {
        drafts.push(
          yield* api.SaveEditorDraft({
            refId,
            field: valueField([key]),
            draftId: null,
            content: JSON.stringify(value),
            expectedRowVersion: null,
            expectedSession: null,
            baseRevisionId: opened.ref.headRevisionId
          })
        )
      }
      yield* api.CommitEditorDrafts({
        refId,
        expectedRowVersion: opened.ref.rowVersion,
        fields: drafts.map((d) => ({ field: d.key.field, draftId: d.id, expectedRowVersion: d.rowVersion })),
        message: null
      })
    })
  )

/** The history: who speaks (null for the user, as Sam) and what was said. */
const HISTORY: ReadonlyArray<readonly [string | null, string]> = [
  [
    "Mira Ashdown",
    "*Mira wipes salt from the ledger's cover and squints at the door.* You're late, Sam. The tide board says the ferry's cancelled, so whatever you're carrying stays here tonight."
  ],
  [null, 'I shake the sleet off my hood. "It\'s for Bram. Sealed, and heavier than it looks."'],
  [
    "Bram Holt",
    "*Bram looks up from the net he's mending, one-handed.* Then set it down gently. Last parcel from the north had a clock in it, and it was still ticking."
  ],
  [null, '"Ticking how?" I put the parcel on the counter, very slowly.'],
  [
    "Mira Ashdown",
    "*Mira leans over it, listening.* Not a clock. Something's scratching. *She slides the ledger away from it, just in case.*"
  ],
  [null, '"Great. Do we open it, or do we throw it in the harbor?"'],
  [
    "Bram Holt",
    "We wait for the bell. Nobody opens northern post after dark; that's the one rule the harbor master still enforces."
  ]
]

const LAST = 'I hold up the quay lantern; it\'s gone out. "Then somebody had better light this before the bell."'

test.setTimeout(300_000)
test.beforeAll(async () => {
  test.setTimeout(300_000)
  provider = await startProvider()
  await importFile(
    "Mira Ashdown.json",
    card("Mira Ashdown", {
      description: "{{char}} keeps the harbor ledger at the Lantern Quay and trusts paper more than people.",
      personality: "Dry, careful, quietly kind.",
      scenario: "A storm night at the Lantern Quay office; the ferry is cancelled.",
      first_mes: "*Mira looks up from the ledger.*"
    })
  )
  await importFile(
    "Bram Holt.json",
    card("Bram Holt", {
      description: "{{char}} mends nets for the quay and knows every rule the harbor master ever made.",
      personality: "Gruff, superstitious, loyal."
    })
  )
  await importFile(
    "Sam Reed.json",
    card("Sam Reed", { description: "{{user}} is a courier who never asks what's in the parcel." })
  )
  const presetRef = await importFile("Quay Nights.json", preset())
  const book = await importFile("Harbor Almanac.json", {
    entries: {
      "0": {
        uid: 0,
        key: ["lantern"],
        keysecondary: [],
        comment: "Quay lanterns",
        content: "Lanterns on the quay are lit at the evening bell; an unlit lantern after dark means bad luck.",
        constant: false,
        selective: true,
        selectiveLogic: 0,
        order: 100,
        position: 1,
        depth: 4,
        role: 0,
        disable: false,
        probability: 100,
        useProbability: true
      }
    }
  })
  const setup = await admin((api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Local model server",
          baseUrl: provider.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-inspector-walkthrough-0042"
      })
      const model = yield* api.AddUserModel({ connectionId: connection.id, key: "fake-small", overrides: {} })
      yield* api.SetGenerationDefaults({
        defaults: { model: { connection: connection.id, model: model.id }, preset: presetRef }
      })
      const cards = yield* api.ListCards()
      const named = (name: string) => cards.find((c) => c.label === name)!.entityId as EntityId
      yield* api.SetPersona({ entityId: named("Sam Reed"), persona: true })
      const started = yield* api.StartChat({
        cards: [named("Mira Ashdown"), named("Bram Holt")],
        persona: named("Sam Reed"),
        greeting: 0,
        first: { _tag: "Send", content: "*I push the door open against the wind.*", speakerEntityId: null }
      })
      const chatId = started.chat.id
      yield* api.ChangeCast({ chatId, slotId: null, change: { _tag: "Lorebook", ref: book, active: true } })
      const bottom = () => api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
      const settled = Effect.gen(function* () {
        for (;;) {
          const path = yield* bottom()
          if (path.entries.at(-1)!.version.status !== "generating") return path.entries.at(-1)!
          yield* Effect.sleep(50)
        }
      })
      let parent = started.entry.slotId
      for (const [speaker, text] of HISTORY) {
        if (speaker === null) {
          const sent = yield* api.SendMessage({ chatId, parentSlotId: parent, branch: false, content: text })
          if (sent._tag !== "Posted") return yield* Effect.die(new Error("a message was queued"))
          parent = sent.entry.slotId
          continue
        }
        const reply = yield* api.Generate({
          chatId,
          parentSlotId: parent,
          branch: false,
          speakerEntityId: named(speaker)
        })
        if (reply._tag !== "Posted") return yield* Effect.die(new Error("a reply was queued"))
        const done = yield* settled
        // The fake provider says the same thing every time; the story is written in.
        yield* api.EditVersion({
          slotId: done.slotId,
          sourceVersionId: done.version.id,
          expectedRowVersion: done.rowVersion,
          content: text
        })
        parent = done.slotId
      }
      return { chatId, entries: (yield* bottom()).entries, bram: named("Bram Holt"), mira: named("Mira Ashdown") }
    })
  )
  // A summary stands in for the greeting and the first exchanges.
  await level1(
    server().dataDir,
    setup.chatId,
    setup.entries.slice(0, 4) as ReadonlyArray<PathEntry>,
    "Sam arrived at the Lantern Quay in a storm with a sealed parcel for Bram; the ferry is cancelled, so Sam stays the night."
  )
  const weather = await admin((api) => api.CreateChatNote({ chatId: setup.chatId, title: "Weather" }))
  await setFields(weather.id, { content: "Sleet off the water all evening; every coat in the office is wet." })
  const injury = await admin((api) => api.CreateChatNote({ chatId: setup.chatId, title: "Bram's hand" }))
  await setFields(injury.id, {
    content: "Bram's left hand is bandaged; he favours it and won't say why.",
    condition: { when: "turn", card: setup.bram }
  })
  made = await admin((api) =>
    Effect.gen(function* () {
      for (const note of [weather, injury])
        yield* api.ChangeCast({
          chatId: setup.chatId,
          slotId: null,
          change: { _tag: "Note", entityId: note.entityId, active: true }
        })
      const sent = yield* api.SendMessage({
        chatId: setup.chatId,
        parentSlotId: setup.entries.at(-1)!.slotId,
        branch: false,
        content: LAST
      })
      if (sent._tag !== "Posted") return yield* Effect.die(new Error("the message was queued"))
      const reply = yield* api.Generate({
        chatId: setup.chatId,
        parentSlotId: sent.entry.slotId,
        branch: false,
        speakerEntityId: setup.mira
      })
      if (reply._tag !== "Posted") return yield* Effect.die(new Error("the reply was queued"))
      for (;;) {
        const path = yield* api.ReadPath({
          chatId: setup.chatId,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 5
        })
        const last = path.entries.at(-1)!
        if (last.version.status !== "generating") {
          const swipe = yield* api.Regenerate({ slotId: last.slotId, expectedRowVersion: last.rowVersion })
          return { id: setup.chatId, reply: reply.entry.version.id, swipe: swipe.version.id }
        }
        yield* Effect.sleep(50)
      }
    })
  )
})
test.afterAll(async () => {
  await provider.stop()
})

const shoot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) })
}

/** Scrolls the turn list until the part box named `name` shows, and returns it. */
const scrollTo = async (page: Page, name: string | RegExp) => {
  const messages = page.getByRole("region", { name: "Messages" })
  const box = messages.getByRole("region", { name }).first()
  await expect
    .poll(async () => {
      if ((await box.count()) && (await box.isVisible())) return true
      await scrollPane(messages.getByRole("list"), { by: 0.5 })
      return false
    })
    .toBe(true)
  // The box at the top of the page's pane, for the screenshot.
  await scrollPane(box, { at: -8 })
  return box
}

/** The page as it shows, scrolled where `scrollTo` left it. */
const shootList = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`) })
}

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  for (const scheme of ["light", "dark"] as const)
    test(`the request of a swipe, part by part, at ${width} ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const tag = `${width}-${scheme}`
      await page.goto(`${server().url}/chats/${made.id}`)
      const reply = page.getByRole("article", { name: "Reply" }).last()
      await expect(reply).toBeVisible()
      await showActions(reply)
      // In More actions unless pinned, like every action but Edit, Continue, Branch and Delete.
      await reply.getByRole("button", { name: "More actions" }).click()
      const button = page.getByRole("menuitem", { name: "Open request inspector" })
      await expect(button).toBeVisible()
      await shoot(page, `${tag}-1-message-button`)
      await button.click()
      await expect(page).toHaveURL(new RegExp(`/context/${made.swipe}\\?fork=[^&]+(&wb=[^&]*)?$`))
      await expect(page.getByText(/^swipe, /)).toBeVisible()
      await shoot(page, `${tag}-2-request-top`)

      // The preset's Main, the cards, the persona: each a titled box with its text verbatim.
      const main = await scrollTo(page, "Preset prompt “Main Prompt”")
      await expect(main).toContainText("You are the narrator of a group roleplay with Sam Reed.")
      await expect(await scrollTo(page, "Card “Mira Ashdown”: description")).toContainText(
        "Mira Ashdown keeps the harbor ledger"
      )
      // Each card's wrapped field in a box of its own, the wrappers framing the field inside it.
      const mira = await scrollTo(page, "Mira Ashdown's description")
      await expect(mira.getByRole("region", { name: "Card “Mira Ashdown”: description" })).toBeVisible()
      await expect(mira.getByRole("region", { name: "Preset: card join prefix" })).toHaveCount(0)
      await expect(mira).toContainText("<Mira Ashdown>")
      await shootList(page, `${tag}-3-cards`)
      // A format prompt that read both cards' personalities: each card's lines in its own box.
      const personality = await scrollTo(page, "Preset: personality format")
      await expect(personality.getByRole("region", { name: "Card “Mira Ashdown”: personality" })).toBeVisible()
      await expect(personality.getByRole("region", { name: "Card “Bram Holt”: personality" })).toBeVisible()
      await expect(
        personality.getByRole("region", { name: "The characters' personalities", exact: true })
      ).toBeVisible()
      await shootList(page, `${tag}-3b-personality`)
      await expect(await scrollTo(page, "Persona “Sam Reed”: description")).toContainText("Sam")
      await shootList(page, `${tag}-3c-persona`)
      const summary = await scrollTo(page, /^Summary, level 1/)
      await expect(summary).toContainText("Sam arrived at the Lantern Quay in a storm")
      await shootList(page, `${tag}-4-summary`)
      await expect(await scrollTo(page, /^Message \d+/)).toBeVisible()
      await shootList(page, `${tag}-5-history`)
      const lore = await scrollTo(page, "Lorebook “Harbor Almanac”: entry 0 “Quay lanterns”")
      await expect(lore).toContainText("an unlit lantern after dark means bad luck")
      await shootList(page, `${tag}-6-lore-and-notes`)
      await expect(await scrollTo(page, "Note “Weather”")).toContainText("Sleet off the water")

      // What this turn left out by its condition.
      const notSent = page.getByRole("region", { name: "Not sent" })
      await expect(notSent).toContainText("Note “Bram's hand”")
      await expect(notSent).toContainText("on Bram Holt's turn; skipped this turn")
      await expect(notSent).toContainText("Preset prompt “Impersonation style”")
      await notSent.scrollIntoViewIfNeeded()
      await shoot(page, `${tag}-7-not-sent`)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    })
