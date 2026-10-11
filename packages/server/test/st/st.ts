// Drives SillyTavern's web UI with Playwright. ST builds chat-completion prompts in the
// browser (public/scripts/openai.js, PromptManager.js), so the harness goes through a page.
//
// Functions passed to `page.evaluate` run in the page, where `SillyTavern.getContext()` is
// ST's public extension API; `StContext` types only the parts used here.
import type { Browser, Page } from "@playwright/test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { png } from "../formats/support.ts"
import type { FixtureSet } from "./fixtures.ts"
import { MOCK_MODEL, type MockEndpoint } from "./mock.ts"

interface StCharacter {
  readonly name: string
}

interface StContext {
  readonly characters: ReadonlyArray<StCharacter>
  readonly chat: ReadonlyArray<unknown>
  readonly onlineStatus: string
  readonly selectCharacterById: (id: number) => Promise<void>
  readonly getPresetManager: (apiId: string) => {
    readonly findPreset: (name: string) => string | undefined
    readonly selectPreset: (value: string) => Promise<void>
  }
  readonly eventSource: { once: (event: string, listener: (...args: ReadonlyArray<unknown>) => void) => void }
  readonly eventTypes: Record<string, string>
  readonly getRequestHeaders: (options?: { omitContentType?: boolean }) => Record<string, string>
}

declare const SillyTavern: { getContext: () => StContext }

const PERSONA_AVATAR = "st-diff-persona.png"

/**
 * ST's settings as the harness starts every page: ST's own fresh-install settings, connected
 * to the mock through the custom chat-completion source, with the fixture persona. Written
 * to the data directory once, since ST reads `settings.json` on every page load, and pages
 * that capture never save it back (`openPage`).
 *
 * - Presets don't switch the connection (`bind_preset_to_connection`, on by default):
 *   connection data in presets is out of scope (DESIGN §1.2), and the fixtures' own
 *   endpoints would take requests away from the mock.
 * - The fixture presets' regex scripts are allowed, as a user would allow them, so they
 *   take part in the comparison instead of raising ST's confirmation.
 */
export const writeBaselineSettings = (userDir: string, mockUrl: string, fixtures: FixtureSet) => {
  const path = join(userDir, "settings.json")
  const settings = JSON.parse(readFileSync(path, "utf8"))
  const persona = fixtures.persona
  settings.firstRun = false
  settings.main_api = "openai"
  settings.username = persona.name
  settings.user_avatar = PERSONA_AVATAR
  Object.assign(settings.power_user, {
    auto_connect: true,
    personas: { [PERSONA_AVATAR]: persona.name },
    persona_descriptions: {
      [PERSONA_AVATAR]: { description: persona.description, position: 0, depth: 2, role: 0, lorebook: "", title: "" }
    },
    persona_description: persona.description,
    persona_description_position: 0,
    persona_description_depth: 2,
    persona_description_role: 0,
    persona_description_lorebook: ""
  })
  Object.assign(settings.oai_settings, {
    chat_completion_source: "custom",
    custom_url: mockUrl,
    custom_model: MOCK_MODEL,
    bind_preset_to_connection: false
  })
  settings.extension_settings.preset_allowed_regex = { openai: fixtures.presets.map((preset) => preset.name) }
  writeFileSync(path, JSON.stringify(settings, null, 4))
}

// Endpoints that write ST's data. Pages that capture answer them here, so every capture
// starts from the same files.
const WRITES = /\/api\/[^?]*(save|edit|merge-attributes|delete|rename|create|import|upload)/

/** A fresh browser context with ST loaded and initialized. */
const openPage = async (browser: Browser, url: string, options: { readOnly: boolean }) => {
  const context = await browser.newContext({ timezoneId: "UTC", locale: "en-US" })
  if (options.readOnly) {
    await context.route(WRITES, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
    )
  }
  const page = await context.newPage()
  await page.goto(url)
  await page.waitForFunction(() => typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function")
  await page.evaluate(() => {
    const ctx = SillyTavern.getContext()
    return new Promise((resolve) => ctx.eventSource.once(ctx.eventTypes.APP_READY ?? "app_ready", resolve))
  })
  return page
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

/**
 * Loads the fixtures through ST's HTTP API, the way its UI imports files: the persona's
 * avatar, cards (ST parses our PNGs), World Info files, presets, then one chat per card,
 * saved under the chat name ST gave the card so that selecting the card opens it.
 */
export const loadFixtures = async (browser: Browser, url: string, fixtures: FixtureSet) => {
  const page = await openPage(browser, url, { readOnly: false })
  try {
    await page.evaluate(
      async (input) => {
        const ctx = SillyTavern.getContext()
        const post = async (path: string, body: unknown) => {
          const response = await fetch(path, {
            method: "POST",
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify(body)
          })
          if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
          return (await response.json()) as Record<string, string>
        }
        const upload = async (path: string, fields: Record<string, string>, file: string, fileName: string) => {
          const form = new FormData()
          const bytes = Uint8Array.from(atob(file), (c) => c.charCodeAt(0))
          form.append("avatar", new File([bytes], fileName))
          for (const [key, value] of Object.entries(fields)) form.append(key, value)
          const response = await fetch(path, {
            method: "POST",
            headers: ctx.getRequestHeaders({ omitContentType: true }),
            body: form
          })
          if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
          const result = (await response.json()) as Record<string, string>
          if (result.error) throw new Error(`${path}: ${JSON.stringify(result)}`)
          return result
        }

        await upload("/api/avatars/upload", { overwrite_name: input.personaAvatar }, input.personaPng, "persona.png")
        const avatars = new Map<string, string>()
        for (const card of input.cards) {
          const result = await upload(
            "/api/characters/import",
            { file_type: "png", user_name: input.personaName },
            card.png,
            `${card.name}.png`
          )
          avatars.set(card.name, `${result.file_name}.png`)
        }
        for (const book of input.lorebooks) await upload("/api/worldinfo/import", {}, book.file, `${book.name}.json`)
        for (const preset of input.presets) {
          await post("/api/presets/save", { apiId: "openai", name: preset.name, preset: preset.data })
        }
        for (const chat of input.chats) {
          const avatar = avatars.get(chat.card)
          if (avatar === undefined) throw new Error(`no card ${chat.card}`)
          const character = await post("/api/characters/get", { avatar_url: avatar })
          const header = {
            user_name: input.personaName,
            character_name: chat.card,
            create_date: "2026-01-01@00h00m00s",
            chat_metadata: {}
          }
          const lines = chat.lines.map((line) => ({
            ...line,
            is_system: false,
            send_date: "January 1, 2026 12:00am",
            extra: {}
          }))
          await post("/api/chats/save", {
            ch_name: chat.card,
            file_name: character.chat,
            avatar_url: avatar,
            chat: [header, ...lines]
          })
        }
      },
      {
        personaName: fixtures.persona.name,
        personaAvatar: PERSONA_AVATAR,
        personaPng: base64(png()),
        cards: fixtures.cards.map((card) => ({ name: card.name, png: base64(card.png) })),
        lorebooks: fixtures.lorebooks.map((book) => ({ name: book.name, file: base64(book.file) })),
        presets: fixtures.presets,
        chats: fixtures.chats
      }
    )
  } finally {
    await page.context().close()
  }
}

export interface Capture {
  /** A preset loaded into ST, by name, or null for the baseline settings. */
  readonly preset: string | null
  readonly character: string
  /** What the user sends. */
  readonly message: string
}

const selectPreset = (page: Page, name: string) =>
  page.evaluate(async (name) => {
    const manager = SillyTavern.getContext().getPresetManager("openai")
    const value = manager.findPreset(name)
    if (value === undefined) throw new Error(`no preset ${name}`)
    await manager.selectPreset(value)
  }, name)

/**
 * Opens the character's chat in a fresh page, selects the preset, sends the message and
 * returns the request body the mock received. The page saves nothing, so every capture
 * starts from the same chat and settings.
 */
export const captureRequest = async (browser: Browser, url: string, mock: MockEndpoint, capture: Capture) => {
  const page = await openPage(browser, url, { readOnly: true })
  const errors: Array<string> = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.waitForFunction(() => SillyTavern.getContext().onlineStatus !== "no_connection")
    if (capture.preset !== null) await selectPreset(page, capture.preset)
    await page.evaluate(async (name) => {
      const ctx = SillyTavern.getContext()
      const id = ctx.characters.findIndex((character) => character.name === name)
      if (id < 0) throw new Error(`no character ${name}`)
      await ctx.selectCharacterById(id)
    }, capture.character)
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0)
    const next = mock.nextCompletion()
    await page.fill("#send_textarea", capture.message)
    await page.click("#send_but")
    const recorded = await next
    // The turn completes: the send button comes back once the reply is in.
    await page.locator("#send_but").waitFor({ state: "visible" })
    return recorded.body
  } catch (error) {
    throw new Error(`capture ${JSON.stringify(capture)} failed; page errors: ${JSON.stringify(errors)}`, {
      cause: error
    })
  } finally {
    await page.context().close()
  }
}
