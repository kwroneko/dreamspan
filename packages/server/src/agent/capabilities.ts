// What a workshop's assistant may do (spec/WORKSHOP.md §3.1, §3.4): the registered capabilities,
// each with its user-facing label, explanation and example and the choices it offers, and ONE
// registered table of defaults. A workshop's own choice (a grant, db/workshopGrants.ts) overrides
// its default. Plugins add, replace or disable entries in either registry.
import { createHash } from "node:crypto"
import type { CapabilityMode, WorkshopCapability } from "@dreamspan/shared/workshopApi.ts"
import { makeRegistry } from "@dreamspan/shared/registry.ts"

export interface CapabilityEntry {
  readonly id: string
  readonly order: number
  readonly label: string
  /** What it lets the assistant do, in plain words. */
  readonly explanation: string
  /** A plain example, for the hover explanation. */
  readonly example?: string
  /** The choices it offers; absent: Off, Ask first and Allowed. */
  readonly modes?: ReadonlyArray<CapabilityMode>
  /**
   * Shown wherever this other capability is offered, though no tool names it: a setting of
   * that capability's tools (`commands.network` beside `commands`).
   */
  readonly alongside?: string
  /** A dialog the client shows before turning it on (the §3.7 consent), with its two buttons. */
  readonly confirm?: {
    readonly title: string
    readonly body: string
    readonly confirmLabel: string
    readonly cancelLabel: string
  }
  /**
   * A library class (spec/WORKSHOP-CARDS.md §2.2): asked once per reply with the four scopes, its
   * question's title, and what it covers in a phrase ("cards"). No tool names it as its
   * capability: the library tools ask it for what's outside view.
   */
  readonly scoped?: { readonly title: string; readonly noun: string }
}

/** The library class each kind of item is under (spec/WORKSHOP-CARDS.md §2.2). */
export const LIBRARY_CLASSES = {
  card: "library.cards",
  lorebook: "library.lorebooks",
  preset: "library.presets",
  note: "library.notes"
} as const
export type LibraryClass = (typeof LIBRARY_CLASSES)[keyof typeof LIBRARY_CLASSES]
export const libraryClassIds: ReadonlyArray<string> = Object.values(LIBRARY_CLASSES)
/** A preset overlay is a preset's, so it's under presets. */
export const classOfKind = (kind: "card" | "lorebook" | "preset" | "note" | "preset_overlay"): LibraryClass =>
  LIBRARY_CLASSES[kind === "preset_overlay" ? "preset" : kind]

/** Allow always grants (spec/WORKSHOP-CARDS.md §2.5): the assistant card's, and every workshop's. */
export interface StandingGrants {
  readonly card?: { readonly name: string; readonly grants: Readonly<Record<string, "allow">> }
  readonly always: Readonly<Record<string, "allow">>
}

/**
 * How a library class stands in one workshop: the most specific choice wins (§2.5). The
 * workshop's own, else the assistant card's Allow always, else the account's, else the default.
 */
export const classStanding = (
  registries: CapabilityRegistries,
  grants: ReadonlyMap<string, CapabilityMode>,
  standing: StandingGrants,
  capability: string
): { readonly mode: CapabilityMode; readonly from: "chat" | "card" | "always" | "default" } => {
  if (grants.has(capability)) return { mode: resolveMode(registries, grants, capability, "read"), from: "chat" }
  if (standing.card?.grants[capability] === "allow") return { mode: "allow", from: "card" }
  if (standing.always[capability] === "allow") return { mode: "allow", from: "always" }
  return { mode: resolveMode(registries, new Map(), capability, "read"), from: "default" }
}

/** The current grant, including an Allow for this reply. An explicit Off takes precedence. */
export const libraryClassMode = (
  registries: CapabilityRegistries,
  access: {
    readonly chat: ReadonlyArray<{ readonly capability: string; readonly mode: CapabilityMode }>
    readonly card: { readonly name: string } | null
    readonly cardGrants: Readonly<Record<string, "allow">>
    readonly always: StandingGrants["always"]
    readonly replyAllowed: ReadonlyArray<string>
  },
  capability: LibraryClass
): CapabilityMode => {
  const standing = classStanding(
    registries,
    new Map(access.chat.map((grant) => [grant.capability, grant.mode])),
    { ...(access.card ? { card: { name: access.card.name, grants: access.cardGrants } } : {}), always: access.always },
    capability
  )
  return standing.mode === "ask" && access.replyAllowed.includes(capability) ? "allow" : standing.mode
}

const ALL_MODES: ReadonlyArray<CapabilityMode> = ["off", "ask", "allow"]

/** Whether commands reach the internet (spec/FILES-AND-ENVIRONMENT.md §3.5): a setting of `commands`. */
export const COMMANDS_NETWORK = "commands.network"

/**
 * Commands without a sandbox (spec/FILES-AND-ENVIRONMENT.md §3.7): a setting of `commands`, offered
 * only to an admin where ALLOW_UNSANDBOXED_COMMANDS is set (api/workshop.ts), Off by default.
 */
export const COMMANDS_UNSANDBOXED = "commands.unsandboxed"

/**
 * Where the server records that the user agreed to a capability's consent (its `confirm`), as
 * the consent text stands now: a grant row of the capability with this target, written with the
 * grant by SetWorkshopGrant only when the user's request says they agreed. Changed text needs a
 * fresh consent; null: the capability has none.
 */
export const consentTarget = (registries: CapabilityRegistries, capability: string): string | null => {
  const confirm = registries.workshopCapabilities.get(capability)?.confirm
  if (!confirm) return null
  const digest = createHash("sha256")
    .update(JSON.stringify([confirm.title, confirm.body, confirm.confirmLabel]))
    .digest("hex")
  return `consent:${digest.slice(0, 32)}`
}

/** The capability of every MCP server's tools; a workshop's choice names the server as its target. */
export const MCP_CAPABILITY = "mcp"

/** Owner question: should opening a side chat allow reading its story, or ask first? */
export const SIDE_STORY_READ_MODE: CapabilityMode = "allow"

export const workshopCapabilities = makeRegistry<CapabilityEntry>([
  // spec/WORKSHOP-CARDS.md §2.2: what the library exposes, a class at a time. What's in view
  // (attached, made here, the workshop's own cast, a story's cast beside it) never asks.
  {
    id: "library.cards",
    order: 10,
    label: "Look through your cards",
    explanation:
      "Searches and reads your characters and personas, with their notes and revisions. Cards you attach, and those it makes here, never ask.",
    example: "Searches your cards for a lighthouse keeper.",
    scoped: { title: "Let the assistant look through your cards?", noun: "cards" }
  },
  {
    id: "library.lorebooks",
    order: 11,
    label: "Look through your lorebooks",
    explanation:
      "Searches and reads your lorebooks, cards' own books included. Lorebooks you attach, and those it makes here, never ask.",
    example: "Lists your lorebooks to find the one about the harbour.",
    scoped: { title: "Let the assistant look through your lorebooks?", noun: "lorebooks" }
  },
  {
    id: "library.presets",
    order: 12,
    label: "Look through your presets",
    explanation: "Searches and reads your prompt presets. Presets you attach, and those it makes here, never ask.",
    example: "Reads your Night preset to compare it with another.",
    scoped: { title: "Let the assistant look through your presets?", noun: "presets" }
  },
  {
    id: "library.notes",
    order: 13,
    label: "Look through your notes",
    explanation: "Searches and reads your shared notes and snippets. The notes of cards in view never ask.",
    example: "Lists your shared notes to find the one on the village.",
    scoped: { title: "Let the assistant look through your notes?", noun: "notes" }
  },
  {
    id: "chats.read",
    order: 15,
    label: "Read your chats",
    explanation: "Reads the messages and notes of your other chats, and your folder import reports.",
    example: "Reads the last ten messages of a story to sum it up. Those messages go to this workshop's model."
  },
  {
    id: "library.write",
    order: 20,
    label: "Create and edit library items",
    explanation:
      "Creates, edits, copies, archives and restores cards, presets, lorebooks and notes in your library, imports files you give it, marks personas and moves notes to the bin. Each change can be undone.",
    example: "Makes a new card for a lighthouse keeper, or rewrites a card's description."
  },
  {
    id: "chats.setup",
    order: 30,
    label: "Set up chats",
    explanation:
      "Starts story chats with your cards and their greetings, and changes their cast, settings and notes. Each can be undone.",
    example: "Starts a chat with Mara that opens on her greeting. No reply is written."
  },
  {
    id: "chats.rewrite",
    order: 40,
    label: "Rewrite chats",
    explanation: "Changes the messages of your chats. Each change can be undone.",
    example: "Renames a character in every message of a story."
  },
  {
    id: "settings",
    order: 50,
    label: "Change your settings",
    explanation: "Changes your app settings. Each change can be undone.",
    example: "Sets your default model for new chats."
  },
  {
    id: "generate",
    order: 60,
    label: "Get replies in other chats",
    explanation: "Has the model write a reply in another chat, which sends that chat to its model.",
    example: "Writes the next reply in your story to try out a new card."
  },
  {
    id: "network",
    order: 70,
    label: "Use the internet",
    explanation: "Searches and opens cards on the card sources you've turned on.",
    example: "Searches cardex for fantasy cards and opens one to read it."
  },
  // spec/FILES-AND-ENVIRONMENT.md §5.2: the agent's files and commands. Reading is part of
  // `files`, since the assistant is useless in a folder it can't read.
  {
    id: "files",
    order: 72,
    label: "Change your files",
    explanation: "Reads, creates and edits files in your Files. Each change can be undone.",
    example: "Writes outline.md in the working folder."
  },
  {
    id: "commands",
    order: 74,
    label: "Run commands",
    explanation:
      "Runs commands in a sandbox that sees only your files and its own home folder. What a command changes is listed, but it can't be undone.",
    example: "Runs python3 to count the words in a draft."
  },
  {
    id: COMMANDS_NETWORK,
    order: 76,
    label: "Internet from commands",
    explanation: "Commands can use the internet. They can't reach this server, your other devices or other accounts.",
    example: "Downloads a public Git repository with git clone.",
    modes: ["off", "allow"],
    alongside: "commands"
  },
  {
    id: COMMANDS_UNSANDBOXED,
    order: 77,
    label: "Run commands without a sandbox",
    explanation:
      "Commands run directly on the server as the app. They can read and change every account's chats, files and keys.",
    example: "Runs a build that needs the server's own tools.",
    modes: ["off", "allow"],
    alongside: "commands",
    confirm: {
      title: "Run commands without a sandbox?",
      body: "Commands will run as the server's app. They can read and change every account's chats, files and keys, and use the server's network and other devices. Changes outside your files can't be undone or restored. Stopping a command, or turning this off, may not end everything it started: it can leave programs running or set to run later on the server.",
      confirmLabel: "Run without a sandbox",
      cancelLabel: "Keep the sandbox"
    }
  },
  {
    id: "plugins.write",
    order: 80,
    label: "Write plugins",
    explanation: "Writes and checks plugins. Nothing it writes runs until it's turned on.",
    example: "Writes a plugin that adds a dice button."
  },
  {
    id: "plugins.apply",
    order: 90,
    label: "Turn plugins on",
    explanation: "Turns a plugin on, so its code runs in the app. It always asks first.",
    example: "Turns on the dice plugin it wrote.",
    modes: ["off", "ask"]
  },
  {
    // spec/SUBAGENTS.md §5.4: a child run inside the reply, never with more than the reply's tools.
    id: "subagents",
    order: 92,
    label: "Start subagents",
    explanation:
      "Hands part of a task to a helper that works on its own and reports back. It can only use what the assistant may use here, asks you first where the assistant would, and its cost counts toward the reply.",
    example: "Starts a helper to look through your cards for every lighthouse keeper and sum them up."
  },
  {
    // spec/TOOL-LOADING.md §6: a card's skills are its author's words, so they're shown first.
    id: "skills.card",
    order: 95,
    label: "Use skills from cards",
    explanation:
      "Follows instructions written in the workshop's card. It asks first and shows them; allowing one here covers that skill only, until it changes.",
    example: "A card's “proofreading” skill tells the assistant how to check a card's spelling.",
    // No standing Allowed: a card's words are shown before they're used, each skill as written.
    modes: ["off", "ask"]
  },
  {
    // spec/MCP.md §5.1: one row per server (`target`), On or Off; enabling is the consent, so
    // there's no Ask first. Its standing comes from the server's Workshops switch, not this table.
    id: MCP_CAPABILITY,
    order: 100,
    label: "MCP servers",
    explanation: "Uses the tools of your MCP servers. Each call sends what the assistant writes in it to the server.",
    modes: ["off", "allow"]
  }
])

/**
 * WORKSHOP §10 question 1 (Open): the recommendation, in one place. Reversible changes are
 * allowed, each with Undo; what sends data elsewhere or runs code asks first. The owner's answer
 * changes only this table.
 */
export const capabilityDefaults = makeRegistry<{ readonly id: string; readonly mode: CapabilityMode }>([
  // Owner [D] (2026-11-24, spec/WORKSHOP-CARDS.md §2.2): beyond what's in view, ask.
  { id: "library.cards", mode: "ask" },
  { id: "library.lorebooks", mode: "ask" },
  { id: "library.presets", mode: "ask" },
  { id: "library.notes", mode: "ask" },
  { id: "library.write", mode: "allow" },
  { id: "chats.setup", mode: "allow" },
  { id: "chats.rewrite", mode: "allow" },
  { id: "settings", mode: "allow" },
  { id: "plugins.write", mode: "allow" },
  // Owner [D] (spec/FILES-AND-ENVIRONMENT.md §5.1, §3.5): tools available without setup, network on.
  { id: "files", mode: "allow" },
  { id: "commands", mode: "allow" },
  { id: COMMANDS_NETWORK, mode: "allow" },
  // Owner [D] (§3.7): Off by default; turned on only through the consent.
  { id: COMMANDS_UNSANDBOXED, mode: "off" },
  // spec/SUBAGENTS.md §13: decided as a recommendation, not asked.
  { id: "subagents", mode: "allow" },
  { id: "chats.read", mode: "ask" },
  { id: "generate", mode: "ask" },
  { id: "network", mode: "ask" },
  { id: "plugins.apply", mode: "ask" },
  { id: "skills.card", mode: "ask" },
  // Each server's own row decides (its Workshops switch, or the workshop's On or Off).
  { id: MCP_CAPABILITY, mode: "allow" }
])

export interface CapabilityRegistries {
  readonly workshopCapabilities: typeof workshopCapabilities
  readonly capabilityDefaults: typeof capabilityDefaults
}

/**
 * How a call of this capability and effect stands, given the workshop's grants. A choice the
 * capability doesn't offer falls back to its nearest stricter one.
 */
export const resolveMode = (
  registries: CapabilityRegistries,
  grants: ReadonlyMap<string, CapabilityMode>,
  capability: string | undefined,
  _effect: string
): CapabilityMode => {
  const entry = capability === undefined ? undefined : registries.workshopCapabilities.get(capability)
  if (!entry || capability === undefined) return "off"
  const modes = entry.modes ?? ALL_MODES
  if (!grants.has(capability) && !registries.capabilityDefaults.get(capability)) return "off"
  const wanted = grants.get(capability) ?? registries.capabilityDefaults.get(capability)?.mode ?? "off"
  if (modes.includes(wanted)) return wanted
  const stricter: ReadonlyArray<CapabilityMode> = wanted === "allow" ? ["ask", "off"] : ["off"]
  return stricter.find((mode) => modes.includes(mode)) ?? "off"
}

/** A capability as the chip shows it in one workshop. */
export const capabilityView = (
  registries: CapabilityRegistries,
  grants: ReadonlyMap<string, CapabilityMode>,
  entry: CapabilityEntry,
  /** A library class's Allow always grants, which stand in for the default (§2.5). */
  standing?: StandingGrants
): WorkshopCapability => {
  const modes = entry.modes ?? ALL_MODES
  const inherited = standing && entry.scoped ? classStanding(registries, new Map(), standing, entry.id) : null
  const defaultMode = inherited?.mode ?? resolveMode(registries, new Map(), entry.id, "read")
  const mode = grants.has(entry.id) || !inherited ? resolveMode(registries, grants, entry.id, "read") : inherited.mode
  return {
    ...(inherited?.from === "card"
      ? { standing: { from: "card" as const, name: standing!.card!.name } }
      : inherited?.from === "always"
        ? { standing: { from: "always" as const } }
        : {}),
    id: entry.id,
    order: entry.order,
    label: entry.label,
    explanation: entry.explanation,
    ...(entry.example ? { example: entry.example } : {}),
    mode,
    defaultMode,
    modes,
    chosen: grants.has(entry.id) && modes.includes(grants.get(entry.id)!),
    ...(entry.confirm ? { confirm: entry.confirm } : {}),
    ...(modes.length === 1 ? { always: true } : {})
  }
}
