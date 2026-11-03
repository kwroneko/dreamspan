// Drives SillyTavern's web UI with Playwright. ST builds chat-completion prompts in the
// browser (public/scripts/openai.js, PromptManager.js), so the harness goes through a page.
//
// Functions passed to `page.evaluate` run in the page, where `SillyTavern.getContext()` is
// ST's public extension API; `StContext` types only the parts used here.
import {
  armPreviewOverlap,
  installPreviewOverlap,
  withoutPromptPreviews,
  withPreviewOverlap
} from "./previewIsolation.ts"
import type { Browser, Page } from "@playwright/test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { png } from "../formats/support.ts"
import { CHAT_SEND_DATE, type FixtureSet } from "./fixtures.ts"
import { MACRO_TIME_ZONE, type MacroContextInput, type MacroOutcome, seededRandom } from "./macroVectors.ts"
import { MOCK_MODEL, type MockEndpoint } from "./mock.ts"

interface StContext {
  readonly characters: ReadonlyArray<{ readonly name: string }>
  readonly chat: ReadonlyArray<unknown>
  readonly onlineStatus: string
  readonly selectCharacterById: (id: number) => Promise<void>
  readonly generate: (type: string) => Promise<unknown>
  readonly getPresetManager: (apiId: string) => {
    readonly findPreset: (name: string) => string | undefined
    readonly selectPreset: (value: string) => Promise<void>
  }
  readonly eventSource: { once: (event: string, listener: (...args: ReadonlyArray<unknown>) => void) => void }
  readonly eventTypes: { readonly APP_READY: string }
  readonly getRequestHeaders: (options?: { omitContentType?: boolean }) => Record<string, string>
  readonly chatMetadata: { variables?: Record<string, unknown>; world_info?: string }
  readonly extensionSettings: { variables: { global: Record<string, unknown> } }
  readonly powerUserSettings: { readonly experimental_macro_engine: boolean }
  /** The chat-completion settings in force (`oai_settings`). */
  readonly chatCompletionSettings: Record<string, unknown> & {
    readonly prompts: ReadonlyArray<{ readonly content?: string }>
    readonly prompt_order: ReadonlyArray<{ readonly order: ReadonlyArray<{ readonly enabled: boolean }> }>
  }
  /** ST's macro entry point. With an options object it uses the engine `experimental_macro_engine` selects. */
  readonly substituteParams: (text: string, options: { name1Override: string; name2Override: string }) => string
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

/**
 * A fresh browser context with ST loaded and initialized, in UTC. `now` fixes the page's
 * clock (timers still run).
 */
export const openPage = async (
  browser: Browser,
  url: string,
  options: { readOnly: boolean; now?: number; previewOverlap?: "protected" | "unprotected"; worldInfoHook?: string }
) => {
  const context = await browser.newContext({ timezoneId: MACRO_TIME_ZONE, locale: "en-US" })
  if (options.now !== undefined) await context.clock.setFixedTime(options.now)
  if (options.worldInfoHook) {
    await context.route("**/scripts/world-info.js", async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, body: (await response.text()) + options.worldInfoHook })
    })
  }
  if (options.readOnly) {
    await context.route("**/scripts/PromptManager.js", async (route) => {
      const response = await route.fetch()
      const source = await response.text()
      const isolated = options.previewOverlap === "unprotected" ? source : withoutPromptPreviews(source)
      await route.fulfill({ response, body: options.previewOverlap ? withPreviewOverlap(isolated) : isolated })
    })
    await context.route(WRITES, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
    )
  }
  if (options.previewOverlap) await installPreviewOverlap(context)
  const page = await context.newPage()
  await page.goto(url)
  await page.waitForFunction(() => typeof SillyTavern !== "undefined" && typeof SillyTavern.getContext === "function")
  await page.evaluate(() => {
    const ctx = SillyTavern.getContext()
    return new Promise((resolve) => ctx.eventSource.once(ctx.eventTypes.APP_READY, resolve))
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
            send_date: input.sendDate,
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
        sendDate: CHAT_SEND_DATE,
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

/**
 * Saves a preset in which every setting ST applies from a preset differs from the baseline:
 * numbers + 1, flags flipped, text marked, prompt text marked, every order entry toggled.
 * The settings are ST's own list (`settingsToUpdate` in openai.js, the module instance the
 * page runs), less the connection ones it doesn't apply here. ST applies only the settings
 * a preset has, so a preset loaded over this one shows any it lacks as a poisoned value.
 * Returns how many settings were poisoned.
 */
export const savePoisonPreset = async (browser: Browser, url: string, name: string) => {
  const page = await openPage(browser, url, { readOnly: false })
  try {
    return await page.evaluate(async (name) => {
      const ctx = SillyTavern.getContext()
      const module = "/scripts/openai.js"
      const { settingsToUpdate } = (await import(module)) as {
        settingsToUpdate: Record<string, readonly [string, string, boolean, boolean]>
      }
      const settings = ctx.chatCompletionSettings
      const poison = (value: unknown) =>
        typeof value === "number"
          ? value + 1
          : typeof value === "boolean"
            ? !value
            : typeof value === "string"
              ? `${value} [poison]`
              : undefined
      const preset: Record<string, unknown> = {}
      for (const [key, [, setting, , connection]] of Object.entries(settingsToUpdate)) {
        if (!connection) preset[key] = poison(settings[setting])
      }
      preset.prompts = settings.prompts.map((prompt) => ({ ...prompt, content: `${prompt.content ?? ""} [poison]` }))
      preset.prompt_order = settings.prompt_order.map((list) => ({
        ...list,
        order: list.order.map((entry) => ({ ...entry, enabled: !entry.enabled }))
      }))
      const response = await fetch("/api/presets/save", {
        method: "POST",
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ apiId: "openai", name, preset })
      })
      if (!response.ok) throw new Error(`/api/presets/save: ${response.status}`)
      return Object.values(preset).filter((value) => value !== undefined).length
    }, name)
  } finally {
    await page.context().close()
  }
}

/** A Summarize extension summary, and the extension's settings for sending it. */
export interface Summary {
  readonly text: string
  readonly template: string
  /** ST's extension_prompt_types: 0 after the main prompt, 1 in-chat, 2 before it. */
  readonly position: number
  readonly depth: number
  /** 0 system, 1 user, 2 assistant. */
  readonly role: number
}

/**
 * Saves the summary on the chat's second message, as the extension does (`extra.memory`),
 * sets its settings, and has the extension read the chat again, as it does when a chat opens.
 */
const summarize = (page: Page, summary: Summary) =>
  page.evaluate(async ({ text, template, position, depth, role }) => {
    const ctx = SillyTavern.getContext() as unknown as {
      chat: Array<{ extra?: Record<string, unknown> }>
      extensionSettings: { memory: Record<string, unknown> }
      eventSource: { emit: (event: string, ...args: Array<unknown>) => Promise<void> }
      eventTypes: Record<string, string>
      getCurrentChatId: () => string
    }
    const message = ctx.chat[1]!
    message.extra = { ...message.extra, memory: text }
    Object.assign(ctx.extensionSettings.memory, { template, position, depth, role })
    await ctx.eventSource.emit(ctx.eventTypes.CHAT_CHANGED!, ctx.getCurrentChatId())
  }, summary)

/** A chat's author's note, as ST keeps it in the chat's metadata (`authors-note.js`). */
export interface AuthorNote {
  readonly text: string
  /** ST's extension_prompt_types: 0 after the main prompt, 1 in-chat, 2 before it. */
  readonly position: number
  readonly depth: number
  /** 0 system, 1 user, 2 assistant. */
  readonly role: number
  /** Sent every this many of the user's messages; 0 never. */
  readonly interval: number
  /** ST's "Include in World Info Scanning" (`extension_settings.note.allowWIScan`). */
  readonly scan?: boolean
}

/** Sets the chat's author's note, and has the extension read the chat again, as when it opens. */
const setAuthorNote = (page: Page, note: AuthorNote) =>
  page.evaluate(async ({ text, position, depth, role, interval, scan }) => {
    const ctx = SillyTavern.getContext() as unknown as {
      chatMetadata: Record<string, unknown>
      extensionSettings: { note?: Record<string, unknown> }
      eventSource: { emit: (event: string, ...args: Array<unknown>) => Promise<void> }
      eventTypes: Record<string, string>
      getCurrentChatId: () => string
    }
    Object.assign(ctx.chatMetadata, {
      note_prompt: text,
      note_position: position,
      note_depth: depth,
      note_role: role,
      note_interval: interval
    })
    ctx.extensionSettings.note = { ...ctx.extensionSettings.note, allowWIScan: scan === true }
    await ctx.eventSource.emit(ctx.eventTypes.CHAT_CHANGED!, ctx.getCurrentChatId())
  }, note)

/** Where ST puts the persona's description (`persona_description_positions`), as the page has it set. */
export interface PersonaPlacement {
  /** 0 in the prompt, 2 top and 3 bottom of the author's note, 4 at depth, 9 not sent. */
  readonly position: number
  readonly depth: number
  /** 0 system, 1 user, 2 assistant. */
  readonly role: number
}

/**
 * Moves the persona's description, in the page's settings and in the persona's own descriptor,
 * which ST copies over them when a chat opens.
 */
const setPersonaPlacement = (page: Page, placement: PersonaPlacement) =>
  page.evaluate(({ position, depth, role }) => {
    const user = SillyTavern.getContext().powerUserSettings as unknown as {
      persona_descriptions: Record<string, Record<string, unknown>>
    } & Record<string, unknown>
    Object.assign(user, {
      persona_description_position: position,
      persona_description_depth: depth,
      persona_description_role: role
    })
    for (const descriptor of Object.values(user.persona_descriptions))
      Object.assign(descriptor, { position, depth, role })
  }, placement)

export interface Capture {
  readonly previewOverlap?: "protected" | "unprotected"
  /** Presets loaded into ST one after another, by name; none for the baseline settings. */
  readonly textSwitches?: { pin_examples: boolean; strip_examples: boolean; collapse_newlines: boolean }
  readonly multilineCard?: boolean
  readonly fieldMacros?: boolean
  readonly overMaximum?: boolean
  readonly presets: ReadonlyArray<string>
  readonly character: string
  /** What the user sends, or, for ST's other generation types, none: the chat as it is. */
  readonly message: string
  readonly generate?: "impersonate" | "swipe"
}

/** Selects the character, which opens its chat. */
const openChat = async (page: Page, name: string) => {
  await page.evaluate(async (name) => {
    const ctx = SillyTavern.getContext()
    const id = ctx.characters.findIndex((character) => character.name === name)
    if (id < 0) throw new Error(`no character ${name}`)
    await ctx.selectCharacterById(id)
  }, name)
  await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0)
}

const selectPreset = (page: Page, name: string) =>
  page.evaluate(async (name) => {
    const manager = SillyTavern.getContext().getPresetManager("openai")
    const value = manager.findPreset(name)
    if (value === undefined) throw new Error(`no preset ${name}`)
    await manager.selectPreset(value)
  }, name)

/**
 * The chat-completion settings in force, as a preset file: every setting ST's presets carry
 * (`settingsToUpdate`, connection settings included, since custom_prompt_post_processing is
 * one), with the prompts and the order. What our importer reads from it is what ST applies.
 */
const settingsInForce = (page: Page) =>
  page.evaluate(async () => {
    const module = "/scripts/openai.js"
    const { settingsToUpdate } = (await import(module)) as {
      settingsToUpdate: Record<string, readonly [string, string, boolean, boolean]>
    }
    const settings = SillyTavern.getContext().chatCompletionSettings
    const preset: Record<string, unknown> = {}
    for (const [key, [, setting]] of Object.entries(settingsToUpdate)) preset[key] = settings[setting]
    return JSON.parse(JSON.stringify(preset)) as Record<string, unknown>
  })

/**
 * Opens the character's chat in a fresh page, selects the presets, sends the message and
 * returns the request body the mock received, and the settings that were in force. The page
 * saves nothing, so every capture starts from the same chat and settings.
 */
export const captureWithSettings = async (
  browser: Browser,
  url: string,
  mock: MockEndpoint,
  capture: Capture,
  /** ST's custom_prompt_post_processing, a connection setting no preset changes here. */
  postProcessing?: string,
  summary?: Summary,
  authorNote?: AuthorNote,
  lorebook?: string,
  persona?: PersonaPlacement
) => {
  let settings: Record<string, unknown> = {}
  const body = await captureRequest(browser, url, mock, capture, async (page) => {
    if (lorebook !== undefined)
      await page.evaluate((name) => {
        SillyTavern.getContext().chatMetadata.world_info = name
      }, lorebook)
    if (summary !== undefined) await summarize(page, summary)
    if (authorNote !== undefined) await setAuthorNote(page, authorNote)
    if (persona !== undefined) await setPersonaPlacement(page, persona)
    if (postProcessing !== undefined) {
      await page.evaluate((value) => {
        ;(SillyTavern.getContext().chatCompletionSettings as Record<string, unknown>).custom_prompt_post_processing =
          value
      }, postProcessing)
    }
    if (capture.textSwitches) {
      await page.evaluate(
        (switches) => Object.assign(SillyTavern.getContext().powerUserSettings, switches),
        capture.textSwitches
      )
    }
    if (capture.multilineCard) {
      await page.evaluate(
        ({ name, tight }) => {
          const card = SillyTavern.getContext().characters.find((c) => c.name === name)! as unknown as Record<
            string,
            unknown
          >
          card.description = "First line\n\n{{char}} last line."
          card.mes_example =
            "<START>\n{{user}}: Example question " +
            (tight ? "lantern ".repeat(80) : "") +
            "\n{{char}}: Example\n\nanswer"
        },
        { name: capture.character, tight: capture.overMaximum === true }
      )
    }
    if (capture.fieldMacros)
      await page.evaluate(() => {
        const settings = SillyTavern.getContext().chatCompletionSettings
        ;(settings as Record<string, unknown>).prompts = settings.prompts.map((p) =>
          (p as { identifier?: string }).identifier === "main"
            ? { ...p, content: "Field macros\n\n{{mesExamplesRaw}}", forbid_overrides: true }
            : p
        )
      })
    if (capture.overMaximum)
      await page.evaluate(() => {
        const ctx = SillyTavern.getContext()
        Object.assign(ctx.chatCompletionSettings, { openai_max_context: 1024, openai_max_tokens: 100 })
        const history = Array.from({ length: 40 }, (_, i) => ({
          name: i % 2 ? "Mira" : "Tobin",
          is_user: i % 2 === 0,
          is_system: false,
          send_date: "2026-01-01T00:00:00.000Z",
          mes: `Older turn ${i}: ${"road ".repeat(32)}`
        }))
        ;(ctx.chat as Array<unknown>).splice(0, ctx.chat.length, ...history)
      })
    if (capture.previewOverlap) await armPreviewOverlap(page, capture.previewOverlap === "protected")
    settings = { ...(await settingsInForce(page)), ...capture.textSwitches }
  })
  return { body, settings }
}

/**
 * Opens the character's chat in a fresh page, selects the presets, sends the message and
 * returns the request body the mock received. The page saves nothing, so every capture
 * starts from the same chat and settings.
 */
export const captureRequest = async (
  browser: Browser,
  url: string,
  mock: MockEndpoint,
  capture: Capture,
  beforeSending?: (page: Page) => Promise<void>
) => {
  const page = await openPage(browser, url, {
    readOnly: true,
    ...(capture.previewOverlap ? { previewOverlap: capture.previewOverlap } : {})
  })
  const errors: Array<string> = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.waitForFunction(() => SillyTavern.getContext().onlineStatus !== "no_connection")
    for (const preset of capture.presets) await selectPreset(page, preset)
    await openChat(page, capture.character)
    await beforeSending?.(page)
    const next = mock.nextCompletion()
    if (capture.generate) {
      // ST's own entry point for its generation types; it resolves once the reply is in.
      const generating = page.evaluate(
        (type) =>
          SillyTavern.getContext()
            .generate(type)
            .then(
              () => "",
              (error: unknown) => String(error)
            ),
        capture.generate
      )
      const recorded = await next
      await generating
      return recorded.body
    }
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

/**
 * Expands each text with ST's own macro engine, through `substituteParams`, the entry point
 * ST's prompt building uses, with the character's chat open. With an options object it runs
 * the new engine when `experimental_macro_engine` is on, as it is in a fresh 1.19 install.
 * Before each text the variables are set from its context and `Math.random` is reseeded
 * (`seededRandom`).
 */
export const evaluateMacros = async (
  browser: Browser,
  url: string,
  options: {
    readonly character: string
    readonly now: number
    readonly seed: number
    readonly vectors: ReadonlyArray<{ readonly text: string; readonly context: MacroContextInput }>
  }
): Promise<{
  readonly newEngine: boolean
  /** The settings ST's state macros read: `custom_model`, `openai_max_context`, `openai_max_tokens`. */
  readonly settings: { readonly model: string; readonly maxContextTokens: number; readonly maxResponseTokens: number }
  readonly outcomes: ReadonlyArray<MacroOutcome>
}> => {
  const page = await openPage(browser, url, { readOnly: true, now: options.now })
  try {
    await openChat(page, options.character)
    return await page.evaluate(
      ({ vectors, random, seed }) => {
        const makeRandom = (0, eval)(`(${random})`) as (seed: number) => () => number
        const ctx = SillyTavern.getContext()
        const outcomes = vectors.map(({ text, context }) => {
          Math.random = makeRandom(seed)
          ctx.chatMetadata.variables = { ...context.local }
          ctx.extensionSettings.variables.global = { ...context.global }
          const output = ctx.substituteParams(text, { name1Override: context.user, name2Override: context.char })
          return {
            output,
            local: { ...ctx.chatMetadata.variables },
            global: { ...ctx.extensionSettings.variables.global }
          }
        })
        const oai = ctx.chatCompletionSettings
        return {
          newEngine: ctx.powerUserSettings.experimental_macro_engine,
          settings: {
            model: String(oai.custom_model),
            maxContextTokens: Number(oai.openai_max_context),
            maxResponseTokens: Number(oai.openai_max_tokens)
          },
          outcomes
        }
      },
      { vectors: options.vectors, random: String(seededRandom), seed: options.seed }
    )
  } finally {
    await page.context().close()
  }
}

/**
 * ST's own regex engine on text as it's written (extensions/regex/engine.js
 * `getRegexedString`, as cleanUpMessage, sendMessageAsUser, updateMessage and reasoning.js
 * call it): the preset selected, the character's chat open, each text at its placement,
 * an edit when `edit`. Nothing is saved.
 */
export const evaluateRegex = async (
  browser: Browser,
  url: string,
  input: {
    readonly character: string
    readonly preset: string
    readonly cases: ReadonlyArray<{ readonly text: string; readonly placement: number; readonly edit: boolean }>
  }
) => {
  const page = await openPage(browser, url, { readOnly: true })
  try {
    await selectPreset(page, input.preset)
    await openChat(page, input.character)
    return await page.evaluate(async (cases) => {
      const engine = "/scripts/extensions/regex/engine.js"
      const { getRegexedString } = (await import(engine)) as {
        getRegexedString: (text: string, placement: number, options?: { isEdit?: boolean }) => string
      }
      return cases.map((c) => getRegexedString(c.text, c.placement, c.edit ? { isEdit: true } : {}))
    }, input.cases)
  } finally {
    await page.context().close()
  }
}
