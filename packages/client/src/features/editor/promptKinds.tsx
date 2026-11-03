import { utilityMacros } from "@rp/shared/macros/builtins/utility.ts"
import { parse, type Node } from "@rp/shared/macros/parse.ts"
import type { PresetPrompt } from "@rp/shared/docs/preset.ts"
import { AboutHint } from "../../ui/AboutHint.tsx"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { registry } from "../chat/macros.ts"

const slots: Record<string, readonly [string, string]> = {
  main: ["Main", "The main instruction for the chat. A card's own prompt can replace it."],
  jailbreak: ["Post-history", "Instructions sent after the chat history. A card's own prompt can replace it."],
  nsfw: ["Auxiliary", "Additional instructions alongside the main prompt."],
  enhanceDefinitions: ["Enhance definitions", "Instructions for expanding the character definitions."]
}
const markers: Record<string, readonly [string, IconName, string]> = {
  worldInfoBefore: ["World Info before", "insert-above", "Lorebook entries placed before the character definitions"],
  worldInfoAfter: ["World Info after", "insert-below", "Lorebook entries placed after the character definitions"],
  charDefinitions: [
    "Definitions",
    "people",
    "Each character's Description, Personality and Scenario, and your persona's Description, from their cards"
  ],
  charDescription: ["Description", "preset", "Each character's Description, from their cards"],
  charPersonality: ["Personality", "reasoning", "Each character's Personality, from their cards"],
  scenario: ["Scenario", "guidance", "Each character's Scenario, from their cards"],
  personaDescription: ["Persona", "model", "Your persona's Description, from its card"],
  dialogueExamples: ["Examples", "type", "Each character's example messages, from their cards"],
  newestMessage: ["Newest message", "continue", "The newest message of the chat"],
  summaries: ["Summaries", "summary", "The chat's summaries of earlier messages"]
}

export function promptKind(prompt: PresetPrompt) {
  if (prompt.identifier === "chatHistory")
    return { label: "Chat history", icon: "chat" as const, hint: "The messages of the chat" }
  const marker = markers[prompt.identifier]
  if (prompt.marker)
    return {
      label: marker?.[0] ?? prompt.name,
      icon: marker?.[1] ?? "insert",
      hint: marker?.[2] ?? "No content source"
    }
  const slot = slots[prompt.identifier]
  return slot || prompt.system_prompt
    ? { label: slot?.[0] ?? prompt.name, hint: slot?.[1] ?? "Built-in instructions for this preset slot." }
    : null
}

const sourceHelp: Record<string, readonly [string, string, string?]> = {
  charDescription: [
    "each character's Description from their cards",
    "Edit Description in each character's card, Definition tab.",
    "Includes notes placed with the definitions."
  ],
  charPersonality: [
    "each character's Personality from their cards",
    "Edit Personality in each character's card, Definition tab.",
    "The preset's personality format applies to the combined text."
  ],
  scenario: [
    "each character's Scenario from their cards",
    "Edit Scenario in each character's card, Definition tab.",
    "The preset's scenario format applies to the combined text."
  ],
  personaDescription: [
    "your persona's Description from its card",
    "Edit Description in your persona's card, Definition tab.",
    "Includes notes placed with the definitions."
  ],
  charDefinitions: [
    "the characters' definitions and your persona's Description from their cards",
    "Edit the characters' Description, Personality and Scenario, and the persona's Description, in their cards' Definition tabs.",
    "Includes notes placed with the definitions; the separate field placeholders stay empty while Definitions is enabled."
  ],
  dialogueExamples: [
    "each character's example messages from their cards",
    "Edit Example messages in each character's card, Definition tab.",
    "Includes lorebook entries placed around examples; nothing is sent when examples are stripped."
  ],
  worldInfoBefore: [
    "lorebook entries placed before the character definitions",
    "Edit the entries in the chat's lorebooks.",
    "Entries move below the history when lorebooks are set to appear only there."
  ],
  worldInfoAfter: [
    "lorebook entries placed after the character definitions",
    "Edit the entries in the chat's lorebooks.",
    "Entries move below the history when lorebooks are set to appear only there."
  ],
  chatHistory: [
    "the chat's messages",
    "Edit the messages in the chat.",
    "Older messages may be replaced by summaries or left out to fit the context; Newest message has its own placement."
  ],
  newestMessage: ["the newest message of the chat", "Edit the message in the chat."],
  summaries: ["the chat's summaries of earlier messages", "Edit the summaries in the chat's Summaries tab."]
}

export function placeholderHelp(identifier: string, byDefinitions = false): string {
  const help = sourceHelp[identifier]
  if (!help)
    return "This placeholder has no content source in the app, so no text is inserted when a request is built. There is no text to edit here or in the preset."
  const [source, edit, setting] = help
  const detail = byDefinitions
    ? "This content is sent through the enabled Definitions block instead, including notes placed with the definitions."
    : setting
  return [`Each request inserts ${source}; this text isn't from the preset and can't be edited here.`, edit, detail]
    .filter(Boolean)
    .join(" ")
}

export function PlaceholderSource({
  identifier,
  byDefinitions = false,
  heading,
  source,
  about
}: {
  identifier: string
  byDefinitions?: boolean
  heading?: string
  source?: string
  about?: string
}) {
  const kind = promptKind({ identifier, marker: true } as PresetPrompt)
  return (
    <span className="mr-1 mb-1 flex min-w-0 items-start gap-1">
      <span data-placeholder-source className="min-w-0 text-xs leading-5 text-muted italic [overflow-wrap:anywhere]">
        {source ?? kind?.hint}
      </span>
      <AboutHint heading={`${heading ?? kind?.label ?? identifier} source`}>
        {about ?? placeholderHelp(identifier, byDefinitions)}
      </AboutHint>
    </span>
  )
}

export function PromptKindTag({ prompt }: { prompt: PresetPrompt }) {
  const kind = promptKind(prompt)
  if (!kind) return null
  return (
    <Tooltip label={kind.hint}>
      <span
        tabIndex={0}
        data-prompt-kind-tag
        className="prompt-kind-tag min-w-0 max-w-full shrink truncate rounded px-1.5 py-0.5 text-xs"
      >
        {kind.label}
      </span>
    </Tooltip>
  )
}

const deterministicPick = utilityMacros.find((macro) => macro.name === "pick")!.handler

/** Registered random/clock macros rerun in preset text; built-in pick has a stable seed. */
export function volatileMacros(content: string): ReadonlyArray<string> {
  const names = new Set<string>()
  const pending: Array<Node> = [...parse(content)].reverse()
  while (pending.length) {
    const node = pending.pop()!
    if (node.kind === "macro") {
      const entry = registry.get(node.name.toLowerCase())
      // pick's volatile flag stores its draw for display, but its assembly seed is stable.
      if (!node.flags.includes("/") && entry?.volatile && entry.handler !== deterministicPick)
        names.add(`{{${node.name}}}`)
      pending.push(...node.args.flatMap((arg) => arg.nodes).reverse())
    } else if (node.value) pending.push(...[...node.value.nodes].reverse())
  }
  return [...names]
}

export function VolatileBadge({ names }: { names: ReadonlyArray<string> }) {
  if (names.length === 0) return null
  return (
    <Tooltip
      label={`Contains ${names.join(", ")}: the cache stops here, so everything below is sent in full each reply. Move it below the chat history to keep the cache.`}
    >
      <span tabIndex={0} data-volatile-warning className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning">
        Changes every reply
      </span>
    </Tooltip>
  )
}

export function SummariesPlaceholder() {
  return (
    <section
      data-prompt="summaries"
      data-prompt-type="placeholder"
      className="prompt-placeholder my-1 rounded-lg border border-border px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <Icon name="summary" />
        <span className="text-sm font-medium">Summaries</span>
        <PromptKindTag prompt={{ identifier: "summaries", name: "Summaries", marker: true } as PresetPrompt} />
      </div>
      <div className="mt-1">
        <PlaceholderSource identifier="summaries" />
      </div>
    </section>
  )
}
