// SillyTavern 1.19's chat-completion prompt building, function by function (ARCHITECTURE §15,
// "The one assembly path"; each function names the ST one it follows).
import { speakerLabel } from "./contextMarkup.ts"
import type { LegacyPresetDoc as PresetDoc } from "@dreamspan/shared/docs/preset.ts"
import { budgetTokens, type ImageEstimate } from "@dreamspan/shared/imageTokens.ts"
import { AssemblyFailed, type RequestImage, type Role } from "./types.ts"

/** A prompt of the collection, as ST's PromptManager prepares it. */
export interface StPrompt {
  readonly identifier: string
  readonly role: Role
  readonly content: string
  /** Where the content came from; null when it's empty by construction. */
  readonly piece: number | null
  /** Undefined for the prompts ST merges in by identifier (`new Prompt` doesn't copy the flag). */
  readonly system_prompt: boolean | undefined
  readonly injection_position: "relative" | "absolute"
  readonly injection_depth: number
  readonly injection_order: number
  readonly forbid_overrides: boolean
  /** An intermittent note absent this turn still bounds what can be cached. */
  readonly kind?: Stability
  readonly barrier?: boolean
}

/** A message being composed, before squashing and post-processing. */
export interface StMessage {
  readonly summary?: boolean
  readonly role: Role
  readonly content: string
  readonly name?: string
  /** ST's identifiers squashing leaves alone: the new-chat and new-example markers. */
  readonly tag?: "newMainChat" | "newChat"
  readonly pieces: ReadonlyArray<number>
  readonly kind: Stability
  /** A history message's images, so the budget counts them with its text. */
  readonly images?: ReadonlyArray<RequestImage>
}

/**
 * Whether a message comes back the same in the next turn's request, for cache breakpoints
 * (DESIGN §5.5): the preset's and cards' prompts ahead of the chat (`prefix`), lore pinned
 * above the history until its start moves (`pinned`), the chat's own messages (`history`),
 * and what moves or changes every turn (`volatile`): in-chat prompts and notes, which keep
 * their depth as the chat grows, and the tail.
 */
export type Stability = "prefix" | "summary" | "pinned" | "history" | "volatile"

/** What a message merged from two is, for caching. */
const mergedKind = (a: Stability, b: Stability): Stability =>
  a === "volatile" || b === "volatile"
    ? "volatile"
    : a === "history" || b === "history"
      ? "history"
      : a === "pinned" || b === "pinned"
        ? "pinned"
        : a === "summary" || b === "summary"
          ? "summary"
          : "prefix"

/** Text the pipeline expanded, with the piece it was recorded as. */
export interface Text {
  readonly volatile?: boolean
  readonly text: string
  readonly piece: number
}

/** Whether the order disables this prompt (ST's isPromptDisabledForActiveCharacter). */
export const disabledIn = (doc: PresetDoc) => {
  const disabled = new Set(doc.order.filter((e) => !e.enabled).map((e) => e.identifier))
  return (identifier: string) => disabled.has(identifier)
}

/** ST's own fields of a prompt merged in by identifier: the marker's placement wins, its content doesn't. */
export const merged = (marker: StPrompt | undefined, identifier: string, role: Role, text: Text | null): StPrompt => ({
  identifier,
  role: marker?.role ?? role,
  content: text?.text ?? "",
  piece: text?.piece ?? null,
  system_prompt: undefined,
  injection_position: marker?.injection_position ?? "relative",
  injection_depth: marker?.injection_depth ?? 4,
  injection_order: marker?.injection_order ?? 100,
  forbid_overrides: false
})

/** An extension prompt in the chat (ST's IN_CHAT): a note at its depth and role. */
export interface Injection {
  readonly depth: number
  readonly role: Role
  readonly text: Text
}

/** A message of the path as ST builds it in setOpenAIMessages, newest last. */
export interface ChatLine {
  readonly role: Role
  readonly content: string
  readonly name?: string
  readonly pieces: ReadonlyArray<number>
  readonly kind: Stability
  readonly images?: ReadonlyArray<RequestImage>
}

/**
 * ST's populationInjectionPrompts: in-chat prompts and extension prompts at each depth,
 * grouped by order (higher orders nearer the end), and by role within an order (system
 * nearest the end), joined by newlines. Extension prompts join the order-100 group.
 */
export const injectInChat = (
  lines: ReadonlyArray<ChatLine>,
  prompts: ReadonlyArray<StPrompt>,
  injections: ReadonlyArray<Injection>
): Array<ChatLine> => {
  // Newest first, as ST holds them while injecting.
  const messages: Array<ChatLine> = [...lines].reverse()
  const depths = [
    ...new Set([
      ...prompts.filter((p) => p.content || p.barrier).map((p) => p.injection_depth),
      ...injections.map((i) => i.depth)
    ])
  ].sort((a, b) => a - b)
  let inserted = 0
  for (const depth of depths) {
    const atDepth = prompts.filter((p) => p.injection_depth === depth && (p.content || p.barrier))
    const groups = new Map<number, Array<StPrompt>>([[100, []]])
    for (const prompt of atDepth)
      groups.set(prompt.injection_order, [...(groups.get(prompt.injection_order) ?? []), prompt])
    const roleMessages: Array<ChatLine> = []
    for (const order of [...groups.keys()].sort((a, b) => b - a)) {
      const group = groups.get(order)!
      for (const role of ["system", "user", "assistant"] as const) {
        const own = group.filter((p) => p.role === role)
        const extensions = order === 100 ? injections.filter((i) => i.depth === depth && i.role === role) : []
        const parts = [
          ...(own.length > 0
            ? [
                own
                  .map((p) => p.content)
                  .filter(Boolean)
                  .join("\n")
              ]
            : []),
          ...(extensions.length > 0
            ? [
                extensions
                  .map((i) => i.text.text.trim())
                  .filter(Boolean)
                  .join("\n")
              ]
            : [])
        ].filter((x) => x)
        const content = parts.map((x) => x.trim()).join("\n")
        if (content.length === 0 && extensions.length === 0 && !own.some((p) => p.barrier)) continue
        const pieces = [
          ...own.flatMap((p) => (p.piece === null ? [] : [p.piece])),
          ...extensions.map((i) => i.text.piece)
        ]
        roleMessages.push({ role, content, pieces, kind: "volatile" })
      }
    }
    if (roleMessages.length > 0) {
      messages.splice(depth + inserted, 0, ...roleMessages)
      inserted += roleMessages.length
    }
  }
  return messages.reverse()
}

/** Emergency fallback when a local tokenizer cannot run. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

export const tokensOf = (
  message: {
    readonly content: string
    readonly name?: string | undefined
    /** Images count what their estimate says (`image-tokens` stage); unsent ones count nothing. */
    readonly images?: ReadonlyArray<{ readonly estimate?: ImageEstimate | undefined }> | undefined
  },
  countText: (text: string) => number = estimateTokens
) =>
  (message.content.length === 0 ? 0 : countText(message.content + (message.name ?? "")) + 3) +
  (message.images ?? []).reduce((n, image) => n + budgetTokens(image.estimate), 0)

/** ST's parseExampleIntoIndividual: one example block into user and character lines. */
export const parseExampleBlock = (
  block: string,
  user: string,
  char: string,
  prefixNames: boolean
): Array<{ readonly name: "example_user" | "example_assistant"; readonly content: string }> => {
  const lines = block
    .replace(/<START>/i, "{Example Dialogue:}")
    .replace(/\r/gm, "")
    .split("\n")
  const result: Array<{ name: "example_user" | "example_assistant"; content: string }> = []
  let current: Array<string> = []
  let inUser = false
  let inBot = false
  const add = (name: string, as: "example_user" | "example_assistant") => {
    let content = current.join("\n").replace(`${name}:`, "").trim()
    if (prefixNames) content = speakerLabel(name, content)
    result.push({ name: as, content })
    current = []
  }
  // The first line is always the block's heading.
  for (const line of lines.slice(1)) {
    if (line.startsWith(`${user}:`)) {
      inUser = true
      if (inBot) add(char, "example_assistant")
      inBot = false
    } else if (line.startsWith(`${char}:`)) {
      inBot = true
      if (inUser) add(user, "example_user")
      inUser = false
    }
    current.push(line)
  }
  if (inUser) add(user, "example_user")
  else if (inBot) add(char, "example_assistant")
  return result
}

/** ST's parseMesExamples for chat completion: blocks headed by `<START>`. */
export const exampleBlocks = (examples: string) => {
  if (!examples || examples === "<START>") return []
  const text = examples.startsWith("<START>") ? examples : `<START>\n${examples.trim()}`
  return text
    .split(/<START>/gi)
    .slice(1)
    .map((block) => `<START>\n${block.trim()}\n`)
}

export interface Composition {
  readonly historyBudget: number
  readonly messages: ReadonlyArray<StMessage>
  readonly historySent: number
  readonly historyTotal: number
  readonly examplesSent: number
  readonly examplesTotal: number
}

/**
 * ST's populateChatCompletion and its budget. Relative prompts go where the collection
 * puts them; the chat history and the examples fill what the budget leaves, newest
 * messages first; control prompts go last. Unlike ST, which sends whatever it had built
 * when the fixed prompts overflow the budget, this fails.
 */
export const compose = (input: {
  readonly collection: ReadonlyArray<StPrompt>
  readonly disabled: (identifier: string) => boolean
  /** The chat with its in-chat injections, oldest first. */
  readonly chat: ReadonlyArray<ChatLine>
  readonly examples: ReadonlyArray<ReadonlyArray<ChatLine>>
  readonly newChat: Text | null
  readonly newExampleChat: Text | null
  /** A context-only filler for impersonation or swipe, after injections as ST adds it. */
  readonly sendIfEmpty: Text | null
  /** Prompts that go last (nothing in production sends one; the tests do). */
  readonly control?: ReadonlyArray<StMessage>
  /** Extension prompts (the summary, notes) put before or after the main prompt in turn (injectToMain). */
  readonly beside: ReadonlyArray<{ readonly message: StMessage; readonly at: "start" | "end" }>
  readonly layer?: ReadonlyArray<StMessage>
  /** Markers the assembler filled itself (a workshop's skill markers), sent where the order has them. */
  readonly filled?: ReadonlyArray<string>
  readonly stableExamples?: boolean
  readonly budget: number
  readonly countText?: (text: string) => number
}): Composition => {
  const countMessage = (message: Parameters<typeof tokensOf>[0]) => tokensOf(message, input.countText)
  const { collection } = input
  const index = (identifier: string) => collection.findIndex((p) => p.identifier === identifier)
  const has = (identifier: string) => index(identifier) !== -1
  const slots = new Map<number, Array<StMessage>>()
  let budget = input.budget - 3
  const spend = (tokens: number) => (budget -= tokens)

  const relative = (identifier: string) => {
    const at = index(identifier)
    if (at === -1) return
    if (input.disabled(identifier) && identifier !== "main") return
    const prompt = collection[at]!
    if (prompt.injection_position === "absolute") return
    const message: StMessage = {
      role: prompt.role,
      content: prompt.content,
      pieces: prompt.piece === null ? [] : [prompt.piece],
      kind: prompt.kind === "pinned" ? "pinned" : prompt.barrier ? "volatile" : (prompt.kind ?? "prefix")
    }
    slots.set(at, [message])
    spend(countMessage(message))
  }
  for (const id of [
    "worldInfoBefore",
    "main",
    "worldInfoAfter",
    "charDefinitions",
    "charDescription",
    "charPersonality",
    "scenario"
  ]) {
    relative(id)
  }
  relative("personaDescription")
  // A workshop's skill markers (spec/WORKSHOP-CONTEXT.md §4.2), only those the assembler filled:
  // a preset prompt that merely has one of their identifiers is sent, or not, as it always was.
  for (const id of input.filled ?? []) relative(id)
  const control = input.control ?? []
  spend(control.reduce((n, m) => n + countMessage(m), 0))
  const userRelative = collection
    .filter((p) => p.system_prompt === false && p.injection_position !== "absolute")
    .map((p) => p.identifier)
  for (const id of ["nsfw", "jailbreak", ...userRelative]) relative(id)
  if (has("enhanceDefinitions")) relative("enhanceDefinitions")
  // The Agent instructions, where the order places them (the stage collects them only then).
  relative("agentInstructions")
  const main = slots.get(index("main"))
  for (const { message, at } of input.beside) {
    if (at === "start") main!.unshift(message)
    else main!.push(message)
    spend(countMessage(message))
  }
  const layer = input.layer ?? []
  spend(layer.reduce((n, m) => n + countMessage(m), 0))
  if (budget < 0) {
    throw new AssemblyFailed({
      reason: "budget",
      message:
        "The preset's prompts and the cards don't fit in the context the preset allows " +
        "(its context size less its response length). Raise the context size, or turn prompts off."
    })
  }

  if (has("summaries")) slots.set(index("summaries"), [...layer])

  let examplesSent = 0
  const sendExamples = () => {
    if (!has("dialogueExamples")) return
    const examples: Array<StMessage> = []
    if (collection[index("dialogueExamples")]?.barrier)
      examples.push({ role: "system", content: "", pieces: [], kind: "volatile" })
    const heading: StMessage | null = input.newExampleChat
      ? {
          role: "system",
          content: input.newExampleChat.text,
          tag: "newChat",
          pieces: [input.newExampleChat.piece],
          kind: input.newExampleChat.volatile ? "volatile" : "prefix"
        }
      : null
    for (const block of input.examples) {
      const messages: Array<StMessage> = block.map((line) => ({ ...line }))
      const cost = (heading ? countMessage(heading) : 0) + messages.reduce((n, m) => n + countMessage(m), 0)
      if (budget - cost < 0) break
      if (heading && (heading.content || heading.kind === "volatile")) examples.push(heading)
      examples.push(...messages.filter((m) => m.content))
      spend(cost)
      examplesSent++
    }
    slots.set(index("dialogueExamples"), examples)
  }

  if (input.stableExamples) sendExamples()

  const historyBudget = budget
  // The chat history, newest first, while the budget lasts.
  let historySent = 0
  if (has("chatHistory")) {
    const history: Array<StMessage> = []
    const newChat: StMessage | null = input.newChat
      ? {
          role: "system",
          content: input.newChat.text,
          tag: "newMainChat",
          pieces: [input.newChat.piece],
          kind: "prefix"
        }
      : null
    const reserved = newChat ? countMessage(newChat) : 0
    spend(reserved)
    if (input.chat.findLast((line) => line.content)?.role === "assistant" && input.sendIfEmpty?.text) {
      const message: StMessage = {
        role: "user",
        content: input.sendIfEmpty.text,
        pieces: [input.sendIfEmpty.piece],
        kind: "volatile"
      }
      if (budget - countMessage(message) >= 0) {
        history.push(message)
        spend(countMessage(message))
      }
    }
    for (let i = input.chat.length - 1; i >= 0; i--) {
      const line = input.chat[i]!
      const message: StMessage = { ...line }
      if (budget - countMessage(message) < 0) break
      if (message.content || message.kind === "volatile") history.unshift(message)
      spend(countMessage(message))
      if (message.kind === "history") historySent++
    }
    spend(-reserved)
    if (newChat && newChat.content) history.unshift(newChat)
    if (layer.length && !has("summaries")) history.splice(newChat && newChat.content ? 1 : 0, 0, ...layer)
    const newestAt = index("newestMessage")
    if (newestAt >= 0 && !input.disabled("newestMessage")) {
      const latest = history.findLastIndex((m) => m.kind === "history")
      if (latest >= 0) slots.set(newestAt, history.splice(latest))
    }
    slots.set(index("chatHistory"), history)
  }

  if (!input.stableExamples) sendExamples()

  const ordered = [...slots.entries()].sort(([a], [b]) => a - b)
  const newestAt = index("newestMessage")
  const afterTail =
    newestAt > index("chatHistory") + 1 && ordered.findLast(([, list]) => list.some((m) => m.content))?.[0] === newestAt
  const messages = ordered.flatMap(([at, list]) => (afterTail && at === newestAt ? [...control, ...list] : list))
  return {
    historyBudget,
    messages: afterTail ? messages : [...messages, ...control],
    historySent,
    historyTotal: input.chat.filter((line) => line.kind === "history").length,
    examplesSent,
    examplesTotal: input.examples.length
  }
}

/** ST's squashSystemMessages: consecutive unnamed system messages become one. */
export const squash = (messages: ReadonlyArray<StMessage>): Array<StMessage> => {
  const out: Array<StMessage> = []
  const squashable = (m: StMessage) => m.role === "system" && m.tag === undefined && m.name === undefined
  for (const message of messages) {
    if (message.role === "system" && !message.content) continue
    const last = out.at(-1)
    if (last && squashable(last) && squashable(message) && Boolean(last.summary) === Boolean(message.summary)) {
      out[out.length - 1] = {
        ...last,
        content: `${last.content}\n${message.content}`,
        pieces: [...last.pieces, ...message.pieces],
        ...(last.images || message.images ? { images: [...(last.images ?? []), ...(message.images ?? [])] } : {}),
        kind: mergedKind(last.kind, message.kind)
      }
    } else {
      out.push(message)
    }
  }
  return out
}

/** ST's `promptPlaceholder` default: the user turn strict post-processing adds where one is needed. */
const PROMPT_PLACEHOLDER = "Let's get started."

interface Names {
  readonly user: string
  readonly char: string
  readonly group: ReadonlyArray<string>
}

/**
 * ST's postProcessPrompt (mergeMessages): names folded into the text, consecutive messages
 * of a role merged, and for the strict modes, system messages after the first turned into
 * user messages, with a placeholder user turn where the API needs one.
 */
export const postProcess = (
  messages: ReadonlyArray<StMessage>,
  type: PresetDoc["postprocess"],
  names: Names
): Array<StMessage> => {
  const options = {
    merge: { strict: false, placeholders: false, single: false },
    merge_tools: { strict: false, placeholders: false, single: false },
    semi: { strict: true, placeholders: false, single: false },
    semi_tools: { strict: true, placeholders: false, single: false },
    strict: { strict: true, placeholders: true, single: false },
    strict_tools: { strict: true, placeholders: true, single: false },
    single: { strict: true, placeholders: false, single: true }
  } as const
  if (type === "none") return [...messages]
  return mergeMessages(messages, names, options[type])
}

const mergeMessages = (
  input: ReadonlyArray<StMessage>,
  names: Names,
  { strict, placeholders, single }: { strict: boolean; placeholders: boolean; single: boolean }
): Array<StMessage> => {
  const startsWithGroupName = (text: string) => names.group.some((name) => text.startsWith(`${name}: `))
  const messages = input.map((original) => {
    let { content, role } = original
    if (role === "system" && original.name === "example_assistant") {
      if (names.char && !content.startsWith(`${names.char}: `) && !startsWithGroupName(content)) {
        content = speakerLabel(names.char, content)
      }
    }
    if (role === "system" && original.name === "example_user") {
      if (names.user && !content.startsWith(`${names.user}: `)) content = speakerLabel(names.user, content)
    }
    if (original.name && role !== "system" && !content.startsWith(`${original.name}: `)) {
      content = speakerLabel(original.name, content)
    }
    if (single) {
      if (
        role === "assistant" &&
        names.char &&
        !content.startsWith(`${names.char}: `) &&
        !startsWithGroupName(content)
      ) {
        content = speakerLabel(names.char, content)
      }
      if (role === "user" && names.user && !content.startsWith(`${names.user}: `))
        content = speakerLabel(names.user, content)
      role = "user"
    }
    const { name: _name, ...rest } = original
    return { ...rest, role, content }
  })
  const merged: Array<StMessage> = []
  for (const message of messages) {
    const last = merged.at(-1)
    if (last && last.role === message.role && message.content && Boolean(last.summary) === Boolean(message.summary)) {
      merged[merged.length - 1] = {
        ...last,
        content: `${last.content}\n\n${message.content}`,
        pieces: [...last.pieces, ...message.pieces],
        ...(last.images || message.images ? { images: [...(last.images ?? []), ...(message.images ?? [])] } : {}),
        kind: mergedKind(last.kind, message.kind)
      }
    } else {
      merged.push(message)
    }
  }
  if (merged.length === 0) merged.push({ role: "user", content: PROMPT_PLACEHOLDER, pieces: [], kind: "prefix" })
  if (!strict) return merged
  const roles = merged.map((m, i): StMessage => (i > 0 && m.role === "system" ? { ...m, role: "user" } : m))
  if (roles.length > 0 && placeholders) {
    const placeholder: StMessage = { role: "user", content: PROMPT_PLACEHOLDER, pieces: [], kind: "prefix" }
    if (roles[0]!.role === "system" && (roles.length === 1 || roles[1]!.role !== "user")) {
      roles.splice(1, 0, placeholder)
    } else if (roles[0]!.role !== "system" && roles[0]!.role !== "user") {
      roles.unshift(placeholder)
    }
  }
  return mergeMessages(roles, names, { strict: false, placeholders, single: false })
}

/** ST's sanitizeName for the `name` field: OpenAI accepts letters, digits and underscores. */
export const sanitizeName = (name: string) =>
  /^[a-zA-Z0-9_]{1,64}$/.test(name) ? name : name.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 64)
