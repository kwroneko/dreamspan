// What a workshop's assistant may do (spec/WORKSHOP.md §3.1, §3.4): the registered capabilities,
// each with its user-facing label, explanation and example and the choices it offers, and ONE
// registered table of defaults. A workshop's own choice (a grant, db/workshopGrants.ts) overrides
// its default. Plugins add, replace or disable entries in either registry.
import type { CapabilityMode, WorkshopCapability } from "@rp/shared/workshopApi.ts"
import { makeRegistry } from "@rp/shared/registry.ts"

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
}

const ALL_MODES: ReadonlyArray<CapabilityMode> = ["off", "ask", "allow"]

/** Owner question: should opening a side chat allow reading its story, or ask first? */
export const SIDE_STORY_READ_MODE: CapabilityMode = "allow"

export const workshopCapabilities = makeRegistry<CapabilityEntry>([
  {
    id: "library.read",
    order: 10,
    label: "Read your library",
    explanation: "Looks up your cards, presets and lorebooks. Always on: the assistant can't help without it.",
    example: "Lists your cards to find one called Mara.",
    modes: ["allow"]
  },
  {
    id: "chats.read",
    order: 15,
    label: "Read your chats",
    explanation: "Reads the messages of your other chats.",
    example: "Reads the last ten messages of a story to sum it up. Those messages go to this workshop's model."
  },
  {
    id: "library.write",
    order: 20,
    label: "Create and edit library items",
    explanation:
      "Creates, edits, copies, archives and restores cards, presets and lorebooks in your library. Each change can be undone.",
    example: "Makes a new card for a lighthouse keeper, or rewrites a card's description."
  },
  {
    id: "chats.setup",
    order: 30,
    label: "Set up chats",
    explanation: "Starts story chats with your cards and their greetings. Each can be undone.",
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
    explanation: "Fetches pages from other sites.",
    example: "Opens a page you linked to read a character's description."
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
    // spec/TOOL-LOADING.md §6: a card's skills are its author's words, so they're shown first.
    id: "skills.card",
    order: 95,
    label: "Use skills from cards",
    explanation:
      "Follows instructions written in the workshop's card. It asks first and shows them; allowing one here covers that skill only, until it changes.",
    example: "A card's “proofreading” skill tells the assistant how to check a card's spelling.",
    // No standing Allowed: a card's words are shown before they're used, each skill as written.
    modes: ["off", "ask"]
  }
])

/**
 * WORKSHOP §10 question 1 (Open): the recommendation, in one place. Reversible changes are
 * allowed, each with Undo; what sends data elsewhere or runs code asks first. The owner's answer
 * changes only this table.
 */
export const capabilityDefaults = makeRegistry<{ readonly id: string; readonly mode: CapabilityMode }>([
  { id: "library.read", mode: "allow" },
  { id: "library.write", mode: "allow" },
  { id: "chats.setup", mode: "allow" },
  { id: "chats.rewrite", mode: "allow" },
  { id: "settings", mode: "allow" },
  { id: "plugins.write", mode: "allow" },
  { id: "chats.read", mode: "ask" },
  { id: "generate", mode: "ask" },
  { id: "network", mode: "ask" },
  { id: "plugins.apply", mode: "ask" },
  { id: "skills.card", mode: "ask" }
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
  entry: CapabilityEntry
): WorkshopCapability => {
  const modes = entry.modes ?? ALL_MODES
  const defaultMode = resolveMode(registries, new Map(), entry.id, "read")
  const mode = resolveMode(registries, grants, entry.id, "read")
  return {
    id: entry.id,
    order: entry.order,
    label: entry.label,
    explanation: entry.explanation,
    ...(entry.example ? { example: entry.example } : {}),
    mode,
    defaultMode,
    modes,
    chosen: grants.has(entry.id) && modes.includes(grants.get(entry.id)!),
    ...(modes.length === 1 ? { always: true } : {})
  }
}
